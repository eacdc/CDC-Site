/**
 * What each supplier's own wording was posted to in Indus.
 *
 * Supplier Portal v2 phase 1 read CDC Bills' GRN bills and paired every
 * supplier line with the PI line it was posted as. That pairing is the best
 * evidence there is for a quotation: when Henkel quotes "Technomelt Q 718" and
 * their last three bills said "TECHNOMELT Q 718" posted as Art Paper - Main
 * Glue, no name or rate test comes close. On the August 2026 quotes the
 * matcher missed 96 lines that the bills named.
 *
 * Only confident pairings are used (the bill reader's own confidence), and a
 * bill line is evidence for its own supplier only: another supplier's
 * "Gloss Varnish" says nothing about this one's.
 *
 * Read-only: PurchaseBillLines is read with a projection, nothing is written.
 */

// The namespace, not named imports: the models are assigned on connect.
import * as billDb from '../../bill-lines/db.js';
import { nameFeatures, contradicts } from '../../bill-lines/line-match.js';
import { normaliseName, nameSimilarity, differentModelNumber } from '../lib/text.js';

/** A bill pairing below this was a guess, and a guess is not history. */
const PAIRING_CONFIDENT = 0.85;
/** Name agreement a quote line needs with a billed line to be taken as it. */
export const HISTORY_ACCEPT = 0.85;
/** How far clear of a different item the best must be. */
const HISTORY_CLEAR = 0.05;

/**
 * Every confident bill line, flat. Small enough to hold in memory: about two
 * thousand lines per thousand bills.
 */
export async function loadBillHistory() {
  await billDb.connectBillLines();
  const docs = await billDb.BillLineSet.find({ status: { $ne: 'FAILED' } }, {
    site: 1, 'bill.supplierName': 1, 'bill.supplierGstin': 1, 'bill.invoiceDate': 1,
    'extracted.supplierName': 1, 'extracted.supplierGstin': 1,
    'lines.description': 1, 'lines.gsm': 1, 'lines.size': 1, 'lines.kind': 1, 'lines.suggestion': 1,
  }).lean();
  return historyEntries(docs);
}

/** PurchaseBillLines documents to history entries. */
export function historyEntries(docs = []) {
  const out = [];
  for (const d of docs) {
    for (const l of d.lines || []) {
      if (l.kind !== 'GOODS' || !l.suggestion?.itemId || !(l.suggestion.confidence >= PAIRING_CONFIDENT)) continue;
      // A line posted as several PI lines (one grade, several sizes) names none of them.
      if (l.suggestion.group?.length > 1) continue;
      out.push({
        site: d.site,
        supplierName: d.extracted?.supplierName || d.bill?.supplierName || null,
        gstin: (d.extracted?.supplierGstin || d.bill?.supplierGstin || '').toUpperCase() || null,
        date: d.bill?.invoiceDate || null,
        description: l.description || '',
        gsm: l.gsm || null,
        size: l.size || null,
        itemId: Number(l.suggestion.itemId),
        itemName: l.suggestion.itemName || '',
      });
    }
  }
  return out;
}

const SUPPLIER_STOP = new Set(['PVT', 'LTD', 'LIMITED', 'PRIVATE', 'LLP', 'AND', 'THE', 'CO', 'COMPANY',
  'INDUSTRIES', 'TRADING', 'TRADERS', 'ENTERPRISE', 'ENTERPRISES', 'INTERNATIONAL', 'INDIA', 'M', 'S', 'MS']);
const supplierTokens = (s) => normaliseName(s).split(' ').filter((t) => t.length > 2 && !SUPPLIER_STOP.has(t));

/**
 * Is a bill from this supplier? By GSTIN when both sides have one - a GSTIN is
 * an identifier - and otherwise by the name: every distinctive word of the
 * shorter name present in the longer, at least one of them.
 */
export function sameSupplier(entry, { gstins = [], names = [] } = {}) {
  const ids = gstins.map((g) => String(g || '').toUpperCase()).filter(Boolean);
  if (entry.gstin && ids.length) return ids.includes(entry.gstin);
  const theirs = supplierTokens(entry.supplierName);
  if (!theirs.length) return false;
  return names.some((n) => {
    const ours = supplierTokens(n);
    if (!ours.length) return false;
    const [short, long] = ours.length <= theirs.length ? [ours, new Set(theirs)] : [theirs, new Set(ours)];
    return short.every((t) => long.has(t));
  });
}

/**
 * The Indus item this supplier's own bills say a quote line is, or null.
 *
 * Taken only when the quote names it as the bills did (HISTORY_ACCEPT), the
 * Indus item does not contradict the quote (colour, size, GSM), and no other
 * item comes within HISTORY_CLEAR. A GSM band is a paper price, not an item,
 * and is left to the paper reader.
 *
 * @param {Array}  entries   from loadBillHistory()
 * @param {Object} input     { site, supplier: {gstins, names}, line }
 * @returns {{itemId, itemName, score, entry, considered}|null}
 */
export function billHistoryMatch(entries, { site, supplier, line }) {
  const raw = line?.raw || {};
  const gsmFrom = Number(raw.gsmFrom) || null;
  const gsmTo = Number(raw.gsmTo) || null;
  if (gsmFrom && gsmTo !== gsmFrom) return null;

  // A pack ("- 26kg", "(5 LTR)") is how the quote sells it, not what it is,
  // and its number would read as a grade number that the bill does not share.
  const query = [raw.productName, raw.brand, raw.grade, raw.productCode].filter(Boolean).join(' ')
    .replace(/\d+(?:\.\d+)?\s*(?:kgs?|ltrs?|l|ml|gms?|g)\b/gi, ' ');
  if (!query.trim()) return null;
  const quoteFeatures = nameFeatures(query, { gsm: gsmFrom, sizePairs: true });

  const bestByItem = new Map();
  let considered = 0;
  for (const e of entries) {
    if (site && e.site && e.site !== site) continue;
    if (!sameSupplier(e, supplier)) continue;
    considered += 1;
    if (contradicts(quoteFeatures, nameFeatures(e.itemName, { indus: true }), { allSizes: true })) continue;
    if (differentModelNumber(query, e.itemName) || differentModelNumber(query, e.description)) continue;
    const score = nameSimilarity(query, e.description);
    const held = bestByItem.get(e.itemId);
    if (!held || score > held.score) bestByItem.set(e.itemId, { itemId: e.itemId, itemName: e.itemName, score, entry: e });
  }

  const ranked = [...bestByItem.values()].sort((a, b) => b.score - a.score);
  const [best, runnerUp] = ranked;
  if (!best || best.score < HISTORY_ACCEPT) return null;
  if (runnerUp && best.score - runnerUp.score < HISTORY_CLEAR) return null;
  return { ...best, considered };
}
