/**
 * The matching engine (M2).
 *
 * Tiers run in strict order and stop at the first that yields a unique result.
 * The ordering is not arbitrary — it is cheapest-and-most-certain first:
 *
 *   Tier 0  Candidate restriction     free, and removes most ambiguity
 *   Tier 1  Supplier product code     free, no AI, no human — makes month 2 free
 *   Tier 2  Rate anchor               free, and remarkably strong
 *   Tier 3  Spec tuple                free, for attribute-generated names
 *   Tier 4  Name similarity           free, weakest signal
 *   Tier 5  LLM adjudication          costs money, needs context to work
 *
 * The tier that matters most is Tier 2. CDC's last-paid rate and the quoted
 * rate agreeing to within half a percent is near-conclusive evidence, and it
 * survives what text matching cannot:
 *
 *   CrownJewel TS        ↔ "BROWN JEWEL TS"        (supplier typo)
 *   DP WASH              ↔ "WASH DP"               (word order reversed)
 *   BOTTCHER-ROLL O PASTE ↔ "BÖTTCHER PRO ROL-O-PAST" (diacritic + truncation)
 *
 * None of those three would clear a name-similarity threshold. All three match
 * their last-paid rate exactly.
 */

import {
  ensureSupplierPortalReady, SupplierItem, ItemMapping, MappingQueue, AuditLog,
} from '../db/mongo.js';
import { TOLERANCES, ITEM_LEVEL_GROUPS } from '../config/constants.js';
import { assertSite } from '../db/mssql.js';
import { matchingCandidates, annualSpend } from './erp-items.js';
import { ledgerIdsForSite } from './supplier-groups.js';
import { normaliseName, nameSimilarity } from '../lib/text.js';
import { itemSpecTuple, quoteSpecTuple, compareSpecTuples } from '../lib/spec.js';
import { getProvider } from './extraction/provider.js';

/**
 * Match one quote line to a CDC item.
 *
 * @param {Object} input
 * @param {'KOL'|'AHM'} input.site
 * @param {Object} input.line            a stored quoteLine
 * @param {Object} input.supplierItem    its supplier item identity
 * @param {Object} input.group           the supplier group
 * @param {Array}  input.candidates      from `loadCandidates()`
 * @param {Array}  [input.alreadyMapped] this supplier's existing mappings
 * @param {boolean} [input.allowLlm]
 * @returns {Promise<MatchResult>}
 *
 * @typedef {Object} MatchResult
 * @property {'PRODUCT_CODE'|'RATE_ANCHOR'|'SPEC_TUPLE'|'NAME_SIMILARITY'|'LLM'|null} method
 * @property {number|null} itemId
 * @property {number} confidence
 * @property {string} rationale
 * @property {Array} rankedCandidates  always populated, for the queue
 * @property {string|null} queueReason
 */
export async function matchLine({
  site, line, supplierItem, group, candidates, alreadyMapped = [], allowLlm = true,
}) {
  assertSite(site);
  const quoteRate = line.normalised?.ratePerBaseUom ?? line.normalised?.rate ?? null;
  const productName = line.raw?.productName || supplierItem?.supplierProductName || '';

  // ── Tier 1: supplier product code ────────────────────────────────────────
  // If this code already has an active mapping, we are done. Zero cost, zero
  // AI, and it is what makes the second month's quotes free.
  const existing = await existingMapping(supplierItem, site);
  if (existing) {
    return result({
      method: 'PRODUCT_CODE',
      itemId: existing.itemRef.itemId,
      confidence: 1,
      rationale: `Already mapped via ${existing.method} on ${formatDate(existing.verifiedAt || existing.createdAt)}`,
      rankedCandidates: [],
    });
  }

  if (!candidates?.length) {
    return result({
      method: null, itemId: null, confidence: 0,
      rationale: 'No candidate items with purchase history in this supplier\'s groups',
      rankedCandidates: [], queueReason: 'NO_CANDIDATE',
    });
  }

  // ── Tier 2: rate anchor ──────────────────────────────────────────────────
  const anchored = rateAnchor(candidates, quoteRate);
  if (anchored.unique) {
    const c = anchored.matches[0];
    return result({
      method: 'RATE_ANCHOR',
      itemId: c.ItemID,
      confidence: 0.97,
      rationale: `Last paid ₹${c.LastPaidRate} matches the quoted ₹${quoteRate} within ${(TOLERANCES.rateAnchorPct * 100).toFixed(1)}%`,
      rankedCandidates: rank(candidates, { line, quoteRate }).slice(0, 8),
    });
  }

  // Several candidates at the same rate is genuine ambiguity — often CDC
  // duplicate master rows for one product. It goes to a human, but with the
  // rate evidence attached so the decision is quick.
  if (anchored.matches.length > 1) {
    return result({
      method: null, itemId: null, confidence: 0,
      rationale: `${anchored.matches.length} items share this last-paid rate — likely duplicate master rows`,
      rankedCandidates: anchored.matches.map(toCandidateRow).slice(0, 8),
      queueReason: 'AMBIGUOUS',
    });
  }

  // ── Tier 3: spec tuple ───────────────────────────────────────────────────
  const quoteTuple = quoteSpecTuple(line);
  const specMatches = specTupleMatch(candidates, quoteTuple);
  if (specMatches.unique) {
    const { candidate, comparison } = specMatches.matches[0];
    return result({
      method: 'SPEC_TUPLE',
      itemId: candidate.ItemID,
      confidence: 0.93,
      rationale: `All ${comparison.compared} stated attributes agree (${describeTuple(quoteTuple)})`,
      rankedCandidates: rank(candidates, { line, quoteRate }).slice(0, 8),
    });
  }

  // ── Tier 4: name similarity within sub-group ─────────────────────────────
  const scored = rank(candidates, { line, quoteRate });
  const best = scored[0];
  const runnerUp = scored[1];

  if (best && best.score >= TOLERANCES.nameSimilarityAccept) {
    // "Unique" means clear of the runner-up, not merely above the threshold.
    // Two candidates both at 0.85 is a coin toss, and a coin toss belongs to a
    // human.
    const isClear = !runnerUp || best.score - runnerUp.score >= 0.05;
    if (isClear) {
      return result({
        method: 'NAME_SIMILARITY',
        itemId: best.itemId,
        confidence: round(best.score, 3),
        rationale: `Name similarity ${best.score} to "${best.itemName}"${best.sameSubGroup ? ' in the same sub-group' : ''}`,
        rankedCandidates: scored.slice(0, 8),
      });
    }
  }

  // ── Tier 5: LLM adjudication ─────────────────────────────────────────────
  if (allowLlm) {
    try {
      const adjudication = await adjudicate({
        line, productName, group, candidates: scored.slice(0, 8), alreadyMapped,
      });

      if (adjudication.cdcItemId && adjudication.confidence >= TOLERANCES.llmConfidenceAccept) {
        return result({
          method: 'LLM',
          itemId: adjudication.cdcItemId,
          confidence: adjudication.confidence,
          rationale: adjudication.rationale,
          rankedCandidates: scored.slice(0, 8),
        });
      }

      return result({
        method: null, itemId: null, confidence: adjudication.confidence,
        rationale: adjudication.rationale,
        rankedCandidates: scored.slice(0, 8),
        // The model answering "none of these" is a different situation from it
        // being unsure, and the queue reason says which.
        queueReason: adjudication.cdcItemId ? 'LOW_CONFIDENCE' : 'NO_CANDIDATE',
      });
    } catch (err) {
      // An adjudication failure must not lose the line. It falls through to
      // the queue with whatever the cheaper tiers found.
      console.warn('[SP][matching] LLM adjudication failed:', err.message);
    }
  }

  return result({
    method: null, itemId: null,
    confidence: best ? round(best.score, 3) : 0,
    rationale: best
      ? `Best name similarity was ${best.score}, below the ${TOLERANCES.nameSimilarityAccept} threshold`
      : 'No candidate scored above zero',
    rankedCandidates: scored.slice(0, 8),
    queueReason: 'LOW_CONFIDENCE',
  });
}

// ── Tier 0: candidate restriction ───────────────────────────────────────────

/**
 * Load the candidate universe for a supplier group.
 *
 * Restricted to items with purchase history in the groups this supplier has
 * actually supplied. That single filter removes ink-kitchen mixes (made
 * in-house, never bought), dead master rows, and most duplicate-ItemID
 * ambiguity — 6,295 active items become 546 in scope.
 */
export async function loadCandidates(site, group, { itemGroupIds } = {}) {
  assertSite(site);
  const ledgerIds = group ? ledgerIdsForSite(group, site) : [];
  const groups = itemGroupIds
    || (group?.historicalItemGroupIds?.length
      ? group.historicalItemGroupIds.filter((g) => ITEM_LEVEL_GROUPS.includes(g))
      : ITEM_LEVEL_GROUPS);

  const candidates = await matchingCandidates(site, {
    itemGroupIds: groups.length ? groups : ITEM_LEVEL_GROUPS,
  });

  // The supplier's own history is a strong prior but not a filter: a supplier
  // quoting something new is normal, and restricting to what they have sold
  // before would make every new product unmatched by construction.
  const ownLedgers = new Set(ledgerIds);
  return candidates.map((c) => ({
    ...c,
    _suppliedByThisGroup: ownLedgers.has(c.LastSupplierLedgerId),
  }));
}

// ── Tier 2: rate anchor ─────────────────────────────────────────────────────

/**
 * Candidates whose last-paid rate equals the quoted rate within ±0.5%.
 *
 * Exact equality is deliberately not required: CDC's last-paid figure carries
 * the ERP's rounding and the quote carries the supplier's, and half a percent
 * is wide enough for both without admitting a genuinely different price.
 */
export function rateAnchor(candidates, quoteRate, tolerance = TOLERANCES.rateAnchorPct) {
  if (!Number.isFinite(quoteRate) || quoteRate <= 0) return { matches: [], unique: false };

  const matches = candidates.filter((c) => {
    const paid = Number(c.LastPaidRate);
    if (!Number.isFinite(paid) || paid <= 0) return false;
    return Math.abs(paid - quoteRate) / paid <= tolerance;
  });

  return { matches, unique: matches.length === 1 };
}

// ── Tier 3: spec tuple ──────────────────────────────────────────────────────

/**
 * Candidates whose parsed attributes agree with the quote's.
 *
 * A match needs at least two stated attributes in agreement and no
 * disagreements. One attribute is not a spec match — every 10-micron film in
 * the master would qualify.
 */
export function specTupleMatch(candidates, quoteTuple, { minCompared = 2 } = {}) {
  const matches = [];

  for (const candidate of candidates) {
    const comparison = compareSpecTuples(quoteTuple, itemSpecTuple(candidate));
    if (comparison.compared >= minCompared && comparison.mismatches.length === 0) {
      matches.push({ candidate, comparison });
    }
  }

  // Prefer the comparison that agreed on the most fields.
  matches.sort((a, b) => b.comparison.compared - a.comparison.compared);
  const topCount = matches[0]?.comparison.compared;
  const tied = matches.filter((m) => m.comparison.compared === topCount);

  return { matches: tied, unique: tied.length === 1 };
}

// ── Tier 4: scoring ─────────────────────────────────────────────────────────

/**
 * Score and rank candidates. Used both for Tier 4 and to populate the queue,
 * so a human always sees the same ordering the machine considered.
 *
 * The boosts encode what a coordinator actually weighs: a same-sub-group item
 * this supplier has sold before, bought recently and often, is far more likely
 * than a textually similar item nobody has touched in two years.
 */
export function rank(candidates, { line, quoteRate }) {
  const productName = line?.raw?.productName || '';
  const productCode = line?.raw?.productCode || '';
  const query = [productName, productCode].filter(Boolean).join(' ');

  return candidates
    .map((c) => {
      const base = nameSimilarity(query, `${c.ItemName || ''} ${c.ItemDescription || ''}`);
      let score = base;
      const reasons = [];

      const sameSubGroup = subGroupHint(line, c);
      if (sameSubGroup) { score += 0.05; reasons.push('same sub-group'); }
      if (c._suppliedByThisGroup) { score += 0.04; reasons.push('this supplier supplies it'); }

      // Rate proximity short of the anchor tolerance is still evidence.
      if (Number.isFinite(quoteRate) && Number.isFinite(c.LastPaidRate) && c.LastPaidRate > 0) {
        const delta = Math.abs(c.LastPaidRate - quoteRate) / c.LastPaidRate;
        if (delta <= 0.05) { score += 0.08; reasons.push(`within ${(delta * 100).toFixed(1)}% of last paid`); }
        else if (delta >= 3) { score -= 0.10; reasons.push('rate is implausibly far from last paid'); }
      }

      if ((c.PurchaseCount || 0) >= 10) { score += 0.02; reasons.push('bought regularly'); }

      return {
        itemId: c.ItemID,
        itemName: c.ItemName,
        itemCode: c.ItemCode,
        subGroupName: c.ItemSubGroupName,
        lastPaidRate: c.LastPaidRate,
        lastSupplier: c.LastSupplierName,
        purchaseCount: c.PurchaseCount,
        spend: c.SpendInWindow,
        sameSubGroup,
        score: round(Math.max(0, Math.min(1, score)), 4),
        rationale: reasons.join('; ') || `name similarity ${round(base, 3)}`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Sub-group agreement, used as a boost and never as a filter.
 *
 * The master's sub-groups carry known defects — Carton Boxes sits under
 * Packing Materials through a dropped minus sign, Paper carries no sub-group
 * at all, and "Consumable Item" is a junk drawer. Treating sub-group as a hard
 * filter would silently exclude the right answer.
 */
function subGroupHint(line, candidate) {
  const hint = normaliseName(line?.raw?.notes || line?.raw?.productName || '');
  const subGroup = normaliseName(candidate.ItemSubGroupName || '');
  if (!hint || !subGroup) return false;
  return subGroup.split(' ').some((token) => token.length > 3 && hint.includes(token));
}

// ── Tier 5: LLM adjudication ────────────────────────────────────────────────

/**
 * Ask the model, with the context that makes the answer worth having.
 *
 * A coordinator does not string-match. They know this supplier only sells
 * inks, that there is an open PO for exactly this, and that ₹1,850 is not
 * plausible for something last bought at ₹285. The candidates are therefore
 * sent with their last-paid rate, last supplier, purchase count and sub-group,
 * along with what this supplier is already mapped to. Without that context the
 * model confidently invents mappings.
 */
async function adjudicate({ line, productName, group, candidates, alreadyMapped }) {
  const provider = getProvider();
  return provider.adjudicate({
    line: {
      supplier: group?.name || null,
      productName,
      productCode: line.raw?.productCode || null,
      packSize: line.raw?.packSize || null,
      quotedRate: line.normalised?.rate ?? null,
      quotedUom: line.normalised?.uom ?? null,
      ratePerBaseUom: line.normalised?.ratePerBaseUom ?? null,
      rawText: line.raw?.text || null,
    },
    candidates: candidates.map((c) => ({
      cdcItemId: c.itemId,
      itemName: c.itemName,
      subGroup: c.subGroupName,
      lastPaidRate: c.lastPaidRate,
      lastSupplier: c.lastSupplier,
      purchaseCount: c.purchaseCount,
    })),
    mapped: alreadyMapped.map((m) => ({
      supplierProduct: m.supplierProductName,
      cdcItemId: m.itemRef?.itemId,
      cdcItemName: m.itemName,
    })),
  });
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Existing active mapping for a supplier item at a site. */
async function existingMapping(supplierItem, site) {
  if (!supplierItem?._id) return null;
  await ensureSupplierPortalReady();
  return ItemMapping.findOne({
    supplierItemId: supplierItem._id,
    'itemRef.site': site,
    isActive: true,
    relation: { $in: ['EXACT', 'EQUIVALENT'] },
  }).lean();
}

/**
 * Persist a match: either a mapping, or a queue entry.
 *
 * A mapping binds the supplier item permanently, not just this month's quote.
 * That is the whole economics of the system — the first pass is 546 decisions,
 * every pass after it is a handful.
 */
export async function persistMatch({
  site, line, supplierItem, group, match, spendByItem, actor = 'system',
}) {
  await ensureSupplierPortalReady();
  assertSite(site);

  if (match.itemId && match.method) {
    const mapping = await ItemMapping.create({
      supplierItemId: supplierItem._id,
      itemRef: { site, itemId: match.itemId },
      relation: 'EXACT',
      confidence: match.confidence,
      method: match.method,
      evidence: {
        matchedOn: match.method,
        quoteRate: line.normalised?.rate ?? null,
        lastPaidRate: match.rankedCandidates?.find((c) => c.itemId === match.itemId)?.lastPaidRate ?? null,
        rationale: match.rationale,
      },
      verifiedBy: match.method === 'HUMAN' ? actor : null,
      verifiedAt: match.method === 'HUMAN' ? new Date() : null,
      isActive: true,
    });

    await AuditLog.create({
      action: 'MAPPING_CREATED',
      entity: 'itemMapping',
      entityId: String(mapping._id),
      site,
      actor,
      after: { supplierItem: supplierItem.supplierProductName, itemId: match.itemId, method: match.method },
      reason: match.rationale,
    });

    return { mapping, queued: null };
  }

  // PROVISIONAL supplier items do not enter the queue. A one-off project item
  // — a hologram, a set of pencils — must not consume verification effort that
  // belongs to the 546 items CDC buys every month.
  if (supplierItem.status === 'PROVISIONAL') {
    return { mapping: null, queued: null, skippedReason: 'PROVISIONAL' };
  }

  const priority = (match.rankedCandidates || [])
    .reduce((sum, c) => sum + (spendByItem?.get(c.itemId)?.spend || c.spend || 0), 0);

  const queued = await MappingQueue.create({
    supplierItemId: supplierItem._id,
    quoteLineId: line._id,
    reason: match.queueReason || 'LOW_CONFIDENCE',
    site,
    candidates: (match.rankedCandidates || []).slice(0, 8).map((c) => ({
      itemId: c.itemId,
      itemName: c.itemName,
      itemCode: c.itemCode,
      subGroupName: c.subGroupName,
      lastPaidRate: c.lastPaidRate,
      lastSupplier: c.lastSupplier,
      purchaseCount: c.purchaseCount,
      score: c.score,
      rationale: c.rationale,
    })),
    priority,
    status: 'OPEN',
  });

  return { mapping: null, queued };
}

/**
 * Resolve a queue entry from the human queue.
 *
 * `NO_CDC_ITEM` is a legitimate terminal state, not a failure. Quoted lines
 * with no CDC equivalent still hold rate history — a useful benchmark — and
 * they never re-enter the queue.
 */
export async function resolveQueueEntry({ queueId, itemId, status, actor, note, relation = 'EXACT' }) {
  await ensureSupplierPortalReady();
  const entry = await MappingQueue.findById(queueId);
  if (!entry) throw new Error(`Queue entry ${queueId} not found`);
  if (entry.status !== 'OPEN' && entry.status !== 'DEFERRED') {
    throw new Error(`Queue entry ${queueId} is already ${entry.status}`);
  }

  let mapping = null;
  if (status === 'RESOLVED') {
    if (!Number.isFinite(Number(itemId))) {
      throw new Error('Resolving a queue entry needs the CDC ItemID it resolves to.');
    }
    mapping = await ItemMapping.create({
      supplierItemId: entry.supplierItemId,
      itemRef: { site: entry.site, itemId: Number(itemId) },
      relation,
      confidence: 1,
      method: 'HUMAN',
      evidence: { matchedOn: 'HUMAN', notes: note || null },
      verifiedBy: actor,
      verifiedAt: new Date(),
      isActive: true,
    });
    await SupplierItem.updateOne({ _id: entry.supplierItemId }, { $set: { status: 'ACTIVE' } });
  }

  entry.status = status;
  entry.resolvedTo = status === 'RESOLVED' ? Number(itemId) : null;
  entry.resolvedBy = actor;
  entry.resolvedAt = new Date();
  entry.note = note || entry.note;
  await entry.save();

  await AuditLog.create({
    action: 'MAPPING_QUEUE_RESOLVED',
    entity: 'mappingQueue',
    entityId: String(entry._id),
    site: entry.site,
    actor,
    after: { status, itemId: entry.resolvedTo },
    reason: note || null,
  });

  return { entry: entry.toObject(), mapping };
}

/**
 * Run matching across every unmapped line on a document.
 *
 * Candidates and spend are loaded once for the whole document rather than per
 * line: the candidate query is the expensive part, and it is identical for
 * every line of one supplier's quote.
 */
export async function matchDocument({ site, documentId, group, actor = 'system', allowLlm = true }) {
  await ensureSupplierPortalReady();
  assertSite(site);
  const { QuoteLine } = await import('../db/mongo.js');

  const lines = await QuoteLine.find({ quoteDocumentId: documentId, supersededByLineId: null }).lean();
  if (!lines.length) return { matched: 0, queued: 0, skipped: 0 };

  const [candidates, spendByItem] = await Promise.all([
    loadCandidates(site, group),
    annualSpend(site),
  ]);

  const alreadyMapped = await mappedItemsForGroup(site, group?._id);

  let matched = 0; let queued = 0; let skipped = 0;

  for (const line of lines) {
    if (!line.supplierItemId) { skipped += 1; continue; }
    const supplierItem = await SupplierItem.findById(line.supplierItemId).lean();
    if (!supplierItem) { skipped += 1; continue; }

    const match = await matchLine({
      site, line, supplierItem, group, candidates, alreadyMapped, allowLlm,
    });

    const outcome = await persistMatch({
      site, line, supplierItem, group, match, spendByItem, actor,
    });

    if (outcome.mapping) matched += 1;
    else if (outcome.queued) queued += 1;
    else skipped += 1;
  }

  return { matched, queued, skipped, lineCount: lines.length };
}

/** What this supplier group is already mapped to, as context for the model. */
async function mappedItemsForGroup(site, supplierGroupId) {
  if (!supplierGroupId) return [];
  await ensureSupplierPortalReady();
  const items = await SupplierItem.find({ supplierGroupId }).select('_id supplierProductName').lean();
  if (!items.length) return [];

  const mappings = await ItemMapping.find({
    supplierItemId: { $in: items.map((i) => i._id) },
    'itemRef.site': site,
    isActive: true,
  }).lean();

  const nameById = new Map(items.map((i) => [String(i._id), i.supplierProductName]));
  return mappings.map((m) => ({
    supplierProductName: nameById.get(String(m.supplierItemId)),
    itemRef: m.itemRef,
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function result(fields) {
  return {
    method: null, itemId: null, confidence: 0, rationale: '',
    rankedCandidates: [], queueReason: null, ...fields,
  };
}

function toCandidateRow(c) {
  return {
    itemId: c.ItemID,
    itemName: c.ItemName,
    itemCode: c.ItemCode,
    subGroupName: c.ItemSubGroupName,
    lastPaidRate: c.LastPaidRate,
    lastSupplier: c.LastSupplierName,
    purchaseCount: c.PurchaseCount,
    spend: c.SpendInWindow,
    score: 0.5,
    rationale: 'Shares the anchored last-paid rate with other candidates',
  };
}

function describeTuple(tuple) {
  return Object.entries(tuple)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'no attributes';
}

function formatDate(date) {
  if (!date) return 'an earlier date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
