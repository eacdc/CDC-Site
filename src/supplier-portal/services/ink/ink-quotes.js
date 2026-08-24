/**
 * Driving one ink interpretation turn against a stored quote document.
 *
 * The interpreter is pure control flow with the model injected. This is the part
 * that knows about the database: it gathers the context, runs a turn, writes the
 * result back, and remembers what was taught.
 *
 * Kept separate for the reason the interpreter is testable at all — everything
 * here needs Mongo, and none of the decisions do. That split matters more than
 * it looks: three of the last defects in this project were in code that needed a
 * database to exercise and therefore had no test, while the pure logic beside
 * them was covered thoroughly.
 */

import {
  ensureSupplierPortalReady, QuoteDocument, QuoteLine, SupplierGroup, InkTermRule, AuditLog,
} from '../../db/mongo.js';
import { inkLabel, comparisonKey, FAMILY_CHEMISTRY } from '../../config/ink-vocabulary.js';
import { interpretInkQuote, summariseInkQuote, NOT_MEANINGFUL } from './interpreter.js';
import { sendToOpenAI, researchWithOpenAI } from './openai-send.js';

/**
 * Terms already settled for this supplier.
 *
 * Seeded product facts first, then anything learned. Supplier-scoped rules come
 * last so they win: if CDC has said that on THIS supplier's list "TS" means
 * something particular, that answer is about this supplier and is the better
 * one.
 */
export async function knownTermsFor(supplierGroupId) {
  await ensureSupplierPortalReady();

  const byKey = new Map();
  const put = (r) => byKey.set(`${r.subject.toUpperCase()}|${r.field}`, r);

  for (const seed of FAMILY_CHEMISTRY) {
    put({ subject: seed.family, field: 'chemistry', value: seed.chemistry, scope: 'GLOBAL' });
  }

  const rules = await InkTermRule.find({
    $or: [{ scope: 'GLOBAL' }, { supplierGroupId: supplierGroupId || null }],
  }).lean();

  for (const rule of rules.filter((r) => r.scope === 'GLOBAL')) put({ ...rule, scope: 'GLOBAL' });
  for (const rule of rules.filter((r) => r.scope !== 'GLOBAL')) put({ ...rule, scope: 'SUPPLIER' });

  return [...byKey.values()].map((r) => ({
    id: r._id ? String(r._id) : null,
    subject: r.subject,
    field: r.field,
    value: r.value,
    scope: r.scope,
    source: r.source || 'SEED',
  }));
}

/** How this supplier's last ink quote was read, so the next asks less. */
export async function previousInkInterpretation(supplierGroupId, excludeDocumentId) {
  if (!supplierGroupId) return null;
  await ensureSupplierPortalReady();

  const prior = await QuoteDocument.findOne({
    supplierGroupId,
    _id: { $ne: excludeDocumentId },
    materialClass: 'INK_COATING',
    'interpretation.stage': 'INTERPRETED',
  }).sort({ updatedAt: -1 }).select('interpretation.payload').lean();

  return summariseInkQuote(prior?.interpretation?.payload);
}

async function supplierNameFor(supplierGroupId) {
  if (!supplierGroupId) return null;
  await ensureSupplierPortalReady();
  const group = await SupplierGroup.findById(supplierGroupId).select('name').lean();
  return group?.name || null;
}

/**
 * Run one turn: read, or read again with answers.
 *
 * Answers accumulate on the document rather than replacing, so a third round
 * still knows what the first two settled. Re-reading from scratch with only the
 * newest answer would re-ask the questions already closed.
 */
export async function runInkInterpretation({
  documentId, pages = [], textLayer = null, answers = [], actor = null,
  send = sendToOpenAI, research = researchWithOpenAI,
} = {}) {
  await ensureSupplierPortalReady();

  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);

  const prior = doc.interpretation || {};
  const allAnswers = [...(prior.answers || []), ...answers];

  await QuoteDocument.updateOne({ _id: doc._id }, {
    $set: { 'interpretation.stage': 'INTERPRETING', 'interpretation.lastRunAt': new Date() },
  });

  try {
    const [knownTerms, previousSummary, supplierName] = await Promise.all([
      knownTermsFor(doc.supplierGroupId),
      previousInkInterpretation(doc.supplierGroupId, doc._id),
      supplierNameFor(doc.supplierGroupId),
    ]);

    const result = await interpretInkQuote({
      pages,
      textLayer,
      knownTerms,
      previousSummary,
      answers: allAnswers,
      priorPayload: prior.payload || null,
      supplierGroupId: doc.supplierGroupId || null,
      /*
        What identification already settled, so the gate does not ask a question
        the document answered on its letterhead.
      */
      documentFacts: {
        plant: (doc.plantScope || [])[0] || null,
        supplierName: supplierName || null,
      },
      // Terms CDC has ruled on, including the ones ruled meaningless. Both kinds
      // have to stop being asked, or every month reopens the same seven.
      settledTerms: knownTerms.map((t) => t.subject),
      send,
      research,
    });

    await rememberInkRules(result.rules, { doc, actor });

    const stage = {
      READY: 'INTERPRETED', INCOMPLETE: 'NEEDS_INPUT', INVALID: 'FAILED',
    }[result.stage] || 'FAILED';

    /*
      READY is permission to begin, not the end of the job. On the paper side
      this step was missing at first: the payload sat unread in
      `interpretation.payload` while the table under the panel went on showing
      the old extraction, so answering seven questions changed nothing on screen
      — which reads as the answers having been ignored.
    */
    const linesWritten = stage === 'INTERPRETED' ? await storeInkLines(doc, result.payload) : 0;

    await QuoteDocument.updateOne({ _id: doc._id }, {
      $set: {
        'interpretation.stage': stage,
        // A turn that needed no model call carries no new understanding; keeping
        // the previous one beats blanking a panel somebody is reading.
        'interpretation.understanding': result.understanding || prior.understanding || null,
        'interpretation.notes': result.notes || [],
        'interpretation.questions': result.questions || [],
        'interpretation.payload': result.payload || prior.payload || null,
        'interpretation.answers': allAnswers,
        'interpretation.rounds': (prior.rounds || 0) + 1,
        'interpretation.modelCalls': (prior.modelCalls || 0) + (result.rounds || 0),
        'interpretation.error': result.stage === 'INVALID' ? describeErrors(result.errors) : null,
        ...(stage === 'INTERPRETED' ? { status: 'EXTRACTED', materialClass: 'INK_COATING' } : {}),
      },
    });

    return {
      stage,
      understanding: result.understanding || prior.understanding || null,
      notes: result.notes || [],
      questions: result.questions || [],
      payload: result.payload || null,
      modelCalls: result.rounds || 0,
      linesWritten,
      errors: result.errors || [],
    };
  } catch (err) {
    await QuoteDocument.updateOne({ _id: doc._id }, {
      $set: { 'interpretation.stage': 'FAILED', 'interpretation.error': err.message },
    });
    throw err;
  }
}

/**
 * Write the interpreted payload out as quote lines.
 *
 * The interpreted lines REPLACE any extracted ones. They are a reading of the
 * same document by a better process, not an addition to it, and leaving both
 * would leave two prices per product with no way to tell which is current.
 */
export async function storeInkLines(doc, payload) {
  const lines = payload?.lines || [];
  if (!lines.length) return 0;

  await QuoteLine.deleteMany({ quoteDocumentId: doc._id });

  const docs = lines.map((line, index) => inkLineToQuoteLine(doc._id, line, index));
  await QuoteLine.insertMany(docs, { ordered: false });
  return docs.length;
}

/**
 * One interpreted line as a stored quote line. Pure, so the mapping can be
 * checked without a database — which is where the last three defects were.
 */
export function inkLineToQuoteLine(documentId, line, index = 0) {
  return {
    quoteDocumentId: documentId,
    lineNo: line.lineNo ?? index + 1,

    /*
      `raw` keeps what the document printed, `normalised` what it means.

      THE COMPARISON KEY IS STORED, not recomputed at search time. It is what
      decides whether two rows are ever shown together, and a row whose key is
      null is invisible in every search — so it has to be visible in the stored
      record too, where a person can see it is empty. Recomputing it silently on
      each search would hide that.
    */
    raw: {
      productName: line.productName ?? null,
      productCode: line.productCode ?? null,
      section: line.section ?? null,

      uom: line.rateUom ?? null,
      rate: line.rateText ?? (line.rate != null ? String(line.rate) : null),

      materialClass: line.materialClass ?? null,
      chemistry: line.chemistry ?? null,
      role: line.role ?? null,
      colour: line.colour ?? null,
      baseNumber: line.baseNumber ?? null,
      finish: line.finish ?? null,
      coatingProperty: line.coatingProperty ?? null,
      chemicalFunction: line.chemicalFunction ?? null,

      /*
        The maker, kept out of the comparison key on purpose and stored anyway.
        Without it "who is cheapest on DIC Radicure" is unanswerable, and Print
        Sales is a dealer — the same DIC ink can arrive through three of them.
      */
      manufacturer: line.manufacturer ?? null,
      brand: line.family ?? null,

      /*
        Pack size, which is NOT the rate unit. "(20 LTR)" beside a per-litre rate
        means a 4,400 can, and conflating the two is a twenty-fold error that
        wins every comparison it appears in.
      */
      // Stringified to match the rest of `raw`, which holds what the document
      // printed. Mongoose would cast it anyway; doing it here keeps the pure
      // mapping's output identical to what lands in the database, which is the
      // only reason testing the mapping without a database proves anything.
      packSize: line.pack?.size != null ? String(line.pack.size) : null,
      packUom: line.pack?.uom ?? null,

      comparisonKey: comparisonKey(line),
      notes: describeInkLine(line),
    },

    normalised: {
      rate: line.rate ?? null,
      /*
        The rate unit is stored as read and never converted. Five bases appear
        across these documents — kg, litre, piece, m², unit — and they do not
        interconvert: a plate at 382 a piece and a varnish at 400 a kilo are two
        numbers that must never be sorted against each other.
      */
      uom: line.rateUom ?? null,
      ratePerBaseUom: line.rate ?? null,
      conversionNote: null,
    },

    extractionConfidence: line.confidence ?? null,
    flags: [
      ...(line.basis === 'TAUGHT' ? ['taught'] : []),
      ...(line.basis === 'SECTION' ? ['from section heading'] : []),
      ...(line.basis === 'RESEARCHED' ? ['researched'] : []),
      ...(line.previousRate != null ? [`was ${line.previousRate}`] : []),
      // Said plainly, because it is the one failure this category can hide.
      ...(comparisonKey(line) ? [] : ['not comparable']),
    ],
    checks: [],
  };
}

/** The one-line summary a reviewer reads in the table. */
function describeInkLine(line) {
  const parts = [];
  if (line.materialClass) parts.push(inkLabel(line.materialClass));
  if (line.chemistry) parts.push(inkLabel(line.chemistry));
  if (line.colour) parts.push(inkLabel(line.colour));
  if (line.finish) parts.push(inkLabel(line.finish));
  if (line.chemicalFunction) parts.push(inkLabel(line.chemicalFunction));
  if (line.role && line.role !== 'PRESS_READY') parts.push(inkLabel(line.role));
  if (line.baseNumber) parts.push(`base ${line.baseNumber}`);
  if (line.coatingProperty) parts.push(line.coatingProperty.toLowerCase().replace(/_/g, ' '));

  // The pack, spelled out, because the rate beside it is per unit and the two
  // are easy to read as one number.
  if (line.pack?.size && line.pack?.uom) parts.push(`${line.pack.size} ${line.pack.uom} pack`);

  if (line.plate?.lengthMm && line.plate?.widthMm) {
    parts.push(`${line.plate.lengthMm} × ${line.plate.widthMm}`
      + (line.plate.thicknessMm ? ` × ${line.plate.thicknessMm}mm` : ''));
  }

  return parts.join(' · ') || null;
}

/**
 * Persist what this round taught.
 *
 * Upserted per subject, field and scope so a correction corrects rather than
 * stacking a second contradictory rule beside the first — the unique index
 * enforces it, and this is the write that respects it.
 *
 * A dismissal is stored like any other answer. "RL means nothing" has to
 * survive, or the same seven questions arrive with every monthly list.
 */
async function rememberInkRules(rules = [], { doc, actor } = {}) {
  const worth = rules.filter((r) => r.subject && r.value);
  if (!worth.length) return 0;

  await InkTermRule.bulkWrite(worth.map((rule) => ({
    updateOne: {
      filter: {
        subject: rule.subject,
        field: rule.field || null,
        supplierGroupId: rule.supplierGroupId || null,
      },
      update: {
        $set: {
          subject: rule.subject,
          field: rule.field || null,
          value: rule.value,
          kind: rule.kind || null,
          scope: rule.scope || 'SUPPLIER',
          supplierGroupId: rule.supplierGroupId || null,
          source: rule.source || 'PERSON',
          sourceNote: rule.sourceNote || null,
          learnedFrom: doc?._id || null,
          learnedBy: actor || null,
        },
      },
      upsert: true,
    },
  })), { ordered: false });

  await AuditLog.create({
    action: 'INK_RULES_LEARNED',
    entity: 'quoteDocument',
    entityId: String(doc?._id || ''),
    actor,
    after: { rules: worth },
  });

  return worth.length;
}

/** Rules that came from a search rather than a person, for review. */
export function researchedRules(rules = []) {
  return rules.filter((r) => r.source === 'RESEARCH' && r.value !== NOT_MEANINGFUL);
}

/** A few errors, not all of them, and never a wall of repeated text. */
function describeErrors(errors = []) {
  if (!errors.length) return null;
  const head = errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ');
  return errors.length > 3 ? `${head} (and ${errors.length - 3} more)` : head;
}
