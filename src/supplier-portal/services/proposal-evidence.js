/**
 * What earlier proposals say about a new quote line: approved first.
 *
 * Reviewers' decisions are the best evidence there is, better than the bills,
 * and they are used in layers, because one supplier's "Gloss Varnish" can be
 * another's different product:
 *
 *   1. This supplier, the same wording, APPROVED       -> that item, directly
 *   2. Another supplier, similar wording, APPROVED     -> strong evidence
 *   3. Any supplier, similar wording, still UNAPPROVED -> weak evidence, a backup
 *   4. This supplier, the same wording, REJECTED       -> never propose that item again
 *
 * A changed decision rejects the item first proposed as well: the reviewer
 * said it was not that one.
 *
 * Pure: the caller loads the proposals.
 */

import { normaliseName, nameSimilarity } from '../lib/text.js';
import { sameSupplier } from './bill-history.js';

/** Wording this close is the same line, quoted again. */
export const SAME_WORDING = 0.95;
/** Wording this close is worth showing as evidence. */
export const SIMILAR_WORDING = 0.8;

const wording = (l = {}) => [l.productName, l.productCode, l.brand, l.grade].filter(Boolean).join(' ');

/** Two GSM bands that do not overlap are different papers, whatever the name. */
function gsmClash(a = {}, b = {}) {
  const [af, at, bf, bt] = [a.gsmFrom, a.gsmTo ?? a.gsmFrom, b.gsmFrom, b.gsmTo ?? b.gsmFrom].map((v) => (v == null ? null : Number(v)));
  if (af == null || bf == null) return false;
  return (at ?? Infinity) < bf || (bt ?? Infinity) < af;
}

/**
 * @param {Array}  proposals  from /automation/proposals
 * @param {Object} input      { site, supplier: {gstins, names}, line: {productName, productCode, brand, grade, gsmFrom, gsmTo} }
 * @returns {{ bind: Object|null, excludeItemIds: number[], approvedElsewhere: Array, unapproved: Array }}
 */
export function proposalEvidence(proposals = [], { site, supplier, line }) {
  const text = wording(line);
  const out = { bind: null, excludeItemIds: [], approvedElsewhere: [], unapproved: [] };
  if (!normaliseName(text)) return out;

  const own = [];
  for (const p of proposals) {
    if (p.site !== site || gsmClash(line, p.line)) continue;
    const score = nameSimilarity(text, wording(p.line));
    if (score < SIMILAR_WORDING) continue;
    const mine = sameSupplier({ supplierName: p.supplier?.name, gstin: (p.supplier?.gstin || '').toUpperCase() || null }, supplier);
    const row = { ...p, score };
    if (mine && score >= SAME_WORDING) own.push(row);
    else if (p.status === 'APPROVED') out.approvedElsewhere.push(row);
    else if (p.status === 'UNAPPROVED' && p.proposal?.itemId) out.unapproved.push(row);
  }

  const rejected = new Set();
  for (const p of own) {
    if (p.status === 'REJECTED' && p.proposal?.itemId) rejected.add(Number(p.proposal.itemId));
    if (p.decision?.action === 'CHANGE' && p.proposal?.itemId) rejected.add(Number(p.proposal.itemId));
  }
  out.excludeItemIds = [...rejected];

  // The newest approval wins: a later reviewer saw the earlier one. A paper
  // line approved as a band binds to that band, not to an item.
  const approved = own.filter((p) => p.status === 'APPROVED'
    && (p.decision?.band?.quality || (p.decision?.itemId && !rejected.has(Number(p.decision.itemId)))))
    .sort((a, b) => String(b.decision?.at || b.createdAt).localeCompare(String(a.decision?.at || a.createdAt)));
  if (approved.length) {
    const p = approved[0];
    out.bind = p.decision.band?.quality
      ? { itemId: null, itemName: null, band: p.decision.band, proposal: p }
      : { itemId: Number(p.decision.itemId), itemName: p.decision.itemName || p.proposal?.itemName || null, proposal: p };
  } else {
    // This supplier's own still-unapproved readings are backup evidence too.
    out.unapproved.push(...own.filter((p) => p.status === 'UNAPPROVED' && p.proposal?.itemId));
  }

  const strip = (p) => ({
    itemId: Number(p.decision?.itemId ?? p.proposal?.itemId), itemName: p.decision?.itemName || p.proposal?.itemName || null,
    supplier: p.supplier?.name || null, wording: wording(p.line), score: Math.round(p.score * 1000) / 1000,
  });
  const usable = (rows) => rows.map(strip).filter((r) => Number.isFinite(r.itemId) && !rejected.has(r.itemId))
    .sort((a, b) => b.score - a.score).slice(0, 5);
  out.approvedElsewhere = usable(out.approvedElsewhere);
  out.unapproved = usable(out.unapproved);
  return out;
}
