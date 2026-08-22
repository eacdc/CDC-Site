/**
 * Driving one interpretation turn against a stored quote document.
 *
 * The interpreter itself is pure control flow with the model injected. This is
 * the part that knows about the database: it gathers the context, runs a turn,
 * writes the result back, and remembers what was taught.
 *
 * Kept separate for the reason the interpreter is testable at all — everything
 * here needs Mongo, and none of the decisions do.
 */

import {
  ensureSupplierPortalReady, QuoteDocument, QuoteLine, SupplierGroup, PaperBrandRule, AuditLog,
} from '../../db/mongo.js';
import { paperTypeLabel } from '../../config/paper-vocabulary.js';
import { interpretPaperQuote, rulesFromAnswers, summarisePreviousQuote } from './interpreter.js';
import { sendToOpenAI } from './openai-send.js';
import { BRAND_TYPES } from '../../config/paper-vocabulary.js';

/**
 * Brands whose type is already settled for this supplier.
 *
 * Seeded facts first, then anything learned. Supplier-scoped rules come last so
 * they win on the far side of the Map: if CDC has told us that this supplier's
 * "Prima" means something other than the global reading, that answer is about
 * this supplier and is the better one.
 */
export async function knownBrandsFor(supplierGroupId) {
  await ensureSupplierPortalReady();

  const byBrand = new Map();
  for (const seed of BRAND_TYPES) {
    byBrand.set(seed.brand.toUpperCase(), {
      brand: seed.brand, paperType: seed.canonical, scope: 'GLOBAL',
    });
  }

  const rules = await PaperBrandRule.find({
    $or: [{ scope: 'GLOBAL' }, { supplierGroupId: supplierGroupId || null }],
  }).lean();

  for (const rule of rules.filter((r) => r.scope === 'GLOBAL')) {
    byBrand.set(rule.brand.toUpperCase(), { brand: rule.brand, paperType: rule.paperType, scope: 'GLOBAL' });
  }
  for (const rule of rules.filter((r) => r.scope !== 'GLOBAL')) {
    byBrand.set(rule.brand.toUpperCase(), { brand: rule.brand, paperType: rule.paperType, scope: 'SUPPLIER' });
  }

  return [...byBrand.values()];
}

/**
 * How this supplier's last quote was read.
 *
 * Their format rarely changes month to month, so the previous reading is
 * usually a description of the same document with new prices — and offering it
 * is what stops the second month asking the first month's questions again.
 */
export async function previousInterpretation(supplierGroupId, excludeDocumentId) {
  if (!supplierGroupId) return null;
  await ensureSupplierPortalReady();

  const prior = await QuoteDocument.findOne({
    supplierGroupId,
    _id: { $ne: excludeDocumentId },
    'interpretation.stage': 'INTERPRETED',
  }).sort({ updatedAt: -1 }).select('interpretation.payload').lean();

  return summarisePreviousQuote(prior?.interpretation?.payload);
}

/** The supplier's name, once identification has settled which one it is. */
async function supplierNameFor(supplierGroupId) {
  if (!supplierGroupId) return null;
  await ensureSupplierPortalReady();
  const group = await SupplierGroup.findById(supplierGroupId).select('name').lean();
  return group?.name || null;
}

/**
 * Run one turn: read, or re-read with answers.
 *
 * Answers accumulate on the document rather than replacing, so a third round
 * still knows what the first two settled. Re-reading from scratch with only the
 * newest answer would re-ask the questions already closed.
 */
export async function runInterpretation({
  documentId, pages = [], textLayer = null, answers = [], actor = null, send = sendToOpenAI,
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
    const [knownBrands, previousSummary, supplierName] = await Promise.all([
      knownBrandsFor(doc.supplierGroupId),
      previousInterpretation(doc.supplierGroupId, doc._id),
      supplierNameFor(doc.supplierGroupId),
    ]);

    const result = await interpretPaperQuote({
      pages,
      textLayer,
      knownBrands,
      previousSummary,
      answers: allAnswers,
      priorPayload: prior.payload || null,
      supplierGroupId: doc.supplierGroupId || null,
      /*
        What identification already settled, so the gate does not ask again.
        CDC saw "PLANT 98% sure Kolkata" in one panel and "Which plant do these
        rates apply to?" in the one above it — two readings of the same page
        that had never been introduced.
      */
      documentFacts: {
        plant: (doc.plantScope || [])[0] || null,
        supplierName: supplierName || null,
      },
      /*
        The plant this half owns, when the uploaded file priced both. The
        reading covers the whole file — it is one PDF — so without this each
        half is handed every line: a 24-product NR list became 48 rows under
        Kolkata and the same 48 under Ahmedabad.
      */
      ownedPlant: doc.splitPlant || (doc.plantScope || [])[0] || null,
      // Terms CDC has already ruled on, including the ones ruled "not a paper
      // type". Both kinds have to stop being asked.
      settledTokens: knownBrands.map((b) => b.brand),
      send,
    });

    await rememberRules(result.rules, { doc, actor });

    const stage = {
      READY: 'INTERPRETED', INCOMPLETE: 'NEEDS_INPUT', INVALID: 'FAILED',
    }[result.stage] || 'FAILED';

    /*
      READY is permission to begin, not the end of the job. Until this ran, the
      payload sat in `interpretation.payload` and the table under the panel went
      on showing the old extraction — so answering seven questions changed
      nothing on screen, which reads as the answers having been ignored.
    */
    const linesWritten = stage === 'INTERPRETED'
      ? await storePaperLines(doc, result.payload)
      : 0;

    await QuoteDocument.updateOne({ _id: doc._id }, {
      $set: {
        'interpretation.stage': stage,
        // A turn that needed no model call carries no new understanding; keeping
        // the previous one beats blanking the panel a reviewer is reading.
        'interpretation.understanding': result.understanding || prior.understanding || null,
        'interpretation.notes': result.notes || [],
        'interpretation.questions': result.questions || [],
        'interpretation.payload': result.payload || prior.payload || null,
        'interpretation.answers': allAnswers,
        'interpretation.rounds': (prior.rounds || 0) + 1,
        'interpretation.modelCalls': (prior.modelCalls || 0) + (result.rounds || 0),
        'interpretation.error': result.stage === 'INVALID'
          ? describeErrors(result.errors)
          : null,
        // The document is understood but nobody has approved it yet, and the
        // status a reviewer sees should say which of those is true.
        ...(stage === 'INTERPRETED' ? { status: 'EXTRACTED', materialClass: 'PAPER_BOARD' } : {}),
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
 * The step that was missing. `checkHandoff` returning READY was treated as the
 * end of the job, and it is not — it is permission to begin. The payload sat in
 * `interpretation.payload` and nothing read it, so the table under the panel
 * went on showing whatever the old one-shot extraction had produced. A reviewer
 * answered seven questions and watched nothing change, which is worse than an
 * error: it looks like the answers were ignored.
 *
 * The interpreted lines REPLACE the extracted ones. They are a reading of the
 * same document by a better process, not an addition to it, and leaving both
 * would leave two prices per product with no way to tell which is current.
 *
 * @returns {Promise<number>} lines written
 */
export async function storePaperLines(doc, payload) {
  const lines = payload?.lines || [];
  if (!lines.length) return 0;

  await QuoteLine.deleteMany({ quoteDocumentId: doc._id });

  const docs = lines.map((line, index) => paperLineToQuoteLine(doc._id, line, index));
  await QuoteLine.insertMany(docs, { ordered: false });
  return docs.length;
}

/**
 * One interpreted line as a stored quote line. Pure, so the mapping can be
 * checked without a database — which is where the last three defects were.
 */
export function paperLineToQuoteLine(documentId, line, index = 0) {
  return {
    quoteDocumentId: documentId,
    lineNo: line.lineNo ?? index + 1,

    /*
      `raw` keeps what the document printed, `normalised` what it means. The
      interpreter has already done the conversion, so unlike the extraction path
      there is nothing to parse here — but the printed text still goes in raw,
      because a reviewer checking "115 & ABOVE" against 115/null needs both and
      a rate that cannot be traced to a line on the page is not auditable.
    */
    raw: {
      productName: line.productName ?? null,
      uom: line.rateUom ?? null,
      rate: line.rateText ?? (line.rate != null ? String(line.rate) : null),
      gsmFrom: line.gsmFrom != null ? String(line.gsmFrom) : null,
      gsmTo: line.gsmTo != null ? String(line.gsmTo) : null,
      productForm: line.form ?? null,
      mill: line.mill ?? null,
      brand: line.brand ?? null,
      // The canonical paper type lands in `grade`, which is the field the board
      // search already reads. FBB, CBB, GREY_BACK.
      grade: line.paperType ?? null,
      shade: line.shade ?? null,
      bulk: line.bulk ?? null,
      /*
        Kraft's price identity. It was reaching the notes sentence and nowhere
        else, which is the same failure as a paper type that never lands in
        `grade`: visible to a reader, invisible to a search.
      */
      bf: line.bf ?? null,
      supplyMode: line.supplyMode ?? null,
      /*
        The plant the row itself named, kept even though the document already
        has one. It is the audit trail for the split: a Kolkata document holding
        a row marked AHMEDABAD is a visible fault rather than a price that
        merely looks a little low.
      */
      plant: line.plant ?? null,
      notes: describeLine(line),
    },

    normalised: {
      rate: line.rate ?? null,
      // MT is stored as itself rather than converted to a per-kg figure: the
      // document said per tonne, and a rate silently divided by 1000 is one
      // nobody can check against the page.
      uom: line.rateUom === 'MT' ? 'MT' : 'KG',
      ratePerBaseUom: line.rate ?? null,
      conversionNote: line.derivation ? 'derived — see notes' : null,
    },

    extractionConfidence: line.confidence ?? null,
    flags: [
      ...(line.paperTypeBasis === 'TAUGHT' ? ['type taught'] : []),
      ...(line.derivation ? ['derived rate'] : []),
      ...(line.gsmFrom == null && line.gsmTo == null ? ['no gsm band'] : []),
    ],
    checks: [],
  };
}

/**
 * The one-line summary a reviewer reads in the table.
 *
 * A derived rate shows its arithmetic, because a number that cannot show where
 * it came from is one nobody can check — and roughly thirty of the kraft rows
 * are computed rather than printed.
 */
function describeLine(line) {
  const parts = [];
  if (line.paperType) parts.push(paperTypeLabel(line.paperType));
  if (line.shade === 'NATURAL') parts.push('natural shade');
  if (line.bulk === 'HIGH') parts.push('high bulk');
  if (line.bf) parts.push(`${line.bf} BF`);
  if (line.supplyMode) parts.push(line.supplyMode.toLowerCase().replace('_', ' '));

  if (line.derivation?.base != null) {
    const adj = (line.derivation.adjustments || [])
      .map((a) => `${a.amount < 0 ? '−' : '+'}${Math.abs(a.amount)} ${a.reason || ''}`.trim())
      .join(' ');
    parts.push(`${line.derivation.base} ${adj}`.trim());
  }

  return parts.join(' · ') || null;
}

/**
 * Persist what this round taught.
 *
 * Upserted per brand and scope so a correction corrects rather than stacking a
 * second contradictory rule beside the first — the unique index enforces it,
 * and this is the write that respects it.
 */
async function rememberRules(rules = [], { doc, actor } = {}) {
  if (!rules.length) return 0;

  await PaperBrandRule.bulkWrite(rules.map((rule) => ({
    updateOne: {
      filter: { brand: rule.brand, supplierGroupId: rule.supplierGroupId || null },
      update: {
        $set: {
          brand: rule.brand,
          paperType: rule.paperType,
          scope: rule.scope,
          supplierGroupId: rule.supplierGroupId || null,
          learnedFrom: doc?._id || null,
          learnedBy: actor || null,
        },
      },
      upsert: true,
    },
  })), { ordered: false });

  await AuditLog.create({
    action: 'PAPER_RULES_LEARNED',
    entity: 'quoteDocument',
    entityId: String(doc?._id || ''),
    actor,
    after: { rules },
  });

  return rules.length;
}

/** A few errors, not all of them, and never a wall of repeated text. */
function describeErrors(errors = []) {
  if (!errors.length) return null;
  const head = errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ');
  return errors.length > 3 ? `${head} (and ${errors.length - 3} more)` : head;
}
