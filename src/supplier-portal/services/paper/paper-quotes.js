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
  ensureSupplierPortalReady, QuoteDocument, PaperBrandRule, AuditLog,
} from '../../db/mongo.js';
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
    const [knownBrands, previousSummary] = await Promise.all([
      knownBrandsFor(doc.supplierGroupId),
      previousInterpretation(doc.supplierGroupId, doc._id),
    ]);

    const result = await interpretPaperQuote({
      pages,
      textLayer,
      knownBrands,
      previousSummary,
      answers: allAnswers,
      priorPayload: prior.payload || null,
      supplierGroupId: doc.supplierGroupId || null,
      send,
    });

    await rememberRules(result.rules, { doc, actor });

    const stage = {
      READY: 'INTERPRETED', INCOMPLETE: 'NEEDS_INPUT', INVALID: 'FAILED',
    }[result.stage] || 'FAILED';

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
      },
    });

    return {
      stage,
      understanding: result.understanding || prior.understanding || null,
      notes: result.notes || [],
      questions: result.questions || [],
      payload: result.payload || null,
      modelCalls: result.rounds || 0,
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
