/**
 * The matching rules applied to one read line: shared by match.mjs (a new
 * quote) and refresh.mjs (an undecided line, after the rules changed), so the
 * two always propose the same way.
 *
 * Read-only: Indus and bill history. No model calls.
 */

import { imp } from './common.mjs';

const { normaliseLine } = await imp('supplier-portal/services/quotes.js');
const { matchLine } = await imp('supplier-portal/services/matching.js');
const { matchingCandidates, getItem } = await imp('supplier-portal/services/erp-items.js');
const { loadBillHistory } = await imp('supplier-portal/services/bill-history.js');
const { quoteSpecTuple, buildSpecKey, specKeyString, itemMatchesSpecKey } = await imp('supplier-portal/lib/spec.js');
const { resolvePaperType } = await imp('supplier-portal/config/paper-vocabulary.js');
const { applyBilledTypes } = await imp('supplier-portal/services/paper/billed-types.js');

const PAPER_GROUPS = [2, 14];
const OTHER_GROUPS = [3, 4, 5, 6, 8];

/**
 * GSM as a number. Readers copy what is printed, so "058" or "250 gsm" arrive
 * as text, and the server takes numbers only: the first submit used to fail.
 */
export const gsmNumber = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The supplier as matching knows it, or null when the reading names none. */
export const supplierGroup = (supplier) => (supplier?.name || supplier?.gstin
  ? { name: supplier.name || '', gstins: supplier.gstin ? [supplier.gstin] : [] }
  : null);

/** Bill history and Indus candidates, loaded once per run. */
export async function rulesContext() {
  const billHistory = await loadBillHistory().catch(() => []);
  const cache = new Map();
  const candidatesFor = (site, paper) => {
    const key = `${site}:${paper}`;
    if (!cache.has(key)) cache.set(key, matchingCandidates(site, { itemGroupIds: paper ? PAPER_GROUPS : OTHER_GROUPS }));
    return cache.get(key);
  };
  return { billHistory, candidatesFor };
}

/** Paper types the bills settle for these read lines, as the paper reader would. */
export function billedTypes(ctx, lines) {
  return applyBilledTypes({ lines: lines.map((l) => ({ ...l, paperType: resolvePaperType(l.productName) })) }, ctx.billHistory).payload.lines;
}

/**
 * Apply the rules to one read line (reading.json's shape).
 *
 * @returns {{ line, rate, proposal, judge }} the line, its rate and the
 *   proposal as the server takes them, and what the session needs to judge it
 *   when the rules settled nothing (`judge` is null when they did)
 */
export async function applyRules(ctx, { site, l, paper, group, proposals, typed = null }) {
  const raw = {
    productName: l.productName, productCode: l.productCode || null, brand: l.brand || null, grade: l.grade || null,
    gsmFrom: l.gsmFrom ?? null, gsmTo: l.gsmTo ?? null, packSize: l.packSize || null,
    rate: l.rate != null ? String(l.rate) : null, uom: l.uom || null, text: l.notes || null,
  };
  const normalised = normaliseLine(raw, new Map());
  const candidates = await ctx.candidatesFor(site, paper);
  const m = await matchLine({ site, line: { raw, normalised }, supplierItem: null, group, candidates, billHistory: ctx.billHistory, proposals });

  let itemName = null;
  if (m.itemId) {
    itemName = candidates.find((c) => Number(c.ItemID) === Number(m.itemId))?.ItemName
      || (await getItem(site, m.itemId))?.ItemName || null;
  }

  let specItems = null;
  if (paper) {
    const key = buildSpecKey(quoteSpecTuple({ raw, normalised }));
    if (key.kind !== 'ITEM') {
      const hits = candidates.filter((c) => itemMatchesSpecKey(c, key));
      specItems = { key: specKeyString(key), count: hits.length, items: hits.slice(0, 10).map((c) => ({ itemId: c.ItemID, itemName: c.ItemName, lastPaidRate: c.LastPaidRate })) };
    }
  }

  const ev = m.proposalEvidence || {};
  const evidence = [
    ...(m.rationale ? [{ kind: m.method === 'BILL_HISTORY' ? 'BILL' : m.method === 'RATE_ANCHOR' ? 'RATE' : m.method === 'APPROVED_MAPPING' ? 'APPROVED' : 'RULES', text: m.rationale }] : []),
    ...(ev.approvedElsewhere || []).map((a) => ({ kind: 'APPROVED', text: `${a.supplier} "${a.wording}" was approved as ${a.itemId} ${a.itemName || ''}` })),
    ...(ev.unapproved || []).map((a) => ({ kind: 'UNAPPROVED', text: `${a.supplier} "${a.wording}" was proposed as ${a.itemId} ${a.itemName || ''}, not yet approved` })),
    ...(typed?.paperTypeBasis === 'BILLED' ? [{ kind: 'BILL', text: `Paper type ${typed.paperType} from CDC's bills for "${typed.paperTypeBilledAs}"` }] : []),
  ].slice(0, 20);
  const alternatives = (m.rankedCandidates || []).slice(0, 5)
    .filter((c) => Number(c.itemId) !== Number(m.itemId))
    .map((c) => ({ itemId: Number(c.itemId), itemName: c.itemName || null, lastPaidRate: c.lastPaidRate ?? null }));

  const rate = { rate: normalised.rate ?? null, uom: normalised.uom ?? null, ratePerBaseUom: normalised.ratePerBaseUom ?? null, flags: normalised.flags || [] };
  return {
    line: {
      productName: l.productName, productCode: l.productCode || null, brand: l.brand || null, grade: l.grade || null,
      gsmFrom: l.gsmFrom ?? null, gsmTo: l.gsmTo ?? null, sizeText: l.sizeText || null,
      packSize: l.packSize || null, rateText: raw.rate, uom: l.uom || null, notes: l.notes || null,
    },
    rate,
    proposal: {
      itemId: m.itemId ? Number(m.itemId) : null,
      itemName,
      band: m.band || null,
      method: m.method || 'NONE',
      confidence: m.confidence ?? null,
      rationale: m.rationale || null,
      evidence,
      alternatives,
      question: null,
    },
    judge: m.itemId || m.band ? null : {
      read: l, rate, paperType: typed?.paperType || null, rulesSaid: m.rationale, queueReason: m.queueReason,
      candidates: (m.rankedCandidates || []).slice(0, 8), billedAs: m.billedAs || {}, specItems,
      approvedElsewhere: ev.approvedElsewhere || [], unapproved: ev.unapproved || [],
    },
  };
}

/** One printed row of what the rules said. */
export function describe(lineNo, productName, p) {
  const what = p.itemId ?? (p.band ? 'band' : '-');
  const name = p.itemName || (p.band ? `${p.band.quality} ${p.band.gsmFrom}-${p.band.gsmTo} GSM` : '');
  return `  ${String(lineNo).padStart(3)} ${productName.slice(0, 45).padEnd(45)} ${p.method.padEnd(16)} ${what} ${name}`;
}
