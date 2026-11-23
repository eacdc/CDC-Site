/**
 * The dashboards on the review page: every quote line for one Indus item, and
 * every line from one supplier, with the numbers a buyer reads first.
 *
 * Read-only: Mongo for the quote lines, Indus for the item and what CDC paid.
 *
 * A line counts once, as its standing record (currentProposals), however
 * often it was refreshed. "Pending" is a line with an item or band proposed
 * and no decision yet. The proposal may still be wrong, so a pending rate is
 * shown but never counts as an approved price, a best rate or a rank.
 *
 * Rates are compared per base unit (lib/uom.js), and only within one unit: a
 * rate per kg and a rate per piece are not cheaper or dearer than each other.
 */

import {
  ensureSupplierPortalReady, AutoQuote, MappingProposal, withSuppliers,
} from '../db/mongo.js';
import { currentProposals } from '../models/proposals.js';
import { normaliseRate } from '../lib/uom.js';
import {
  getItem, getItems, lastPaidRates, itemRateHistory,
} from './erp-items.js';
import { PAPER_GROUP_IDS, itemInBand, bandLabel } from './paper/band.js';
import { offerQuote } from './proposals.js';

/** The fields a dashboard reads off a line; evidence and alternatives are left behind. */
const LINE_FIELDS = 'autoQuoteId refreshOf site supplier lineNo line rate proposal.itemId proposal.itemName '
  + 'proposal.method proposal.confidence proposal.band status decision createdAt';
const QUOTE_FIELDS = 'fileName documentDate effectiveFrom terms materialClass createdAt';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const round = (v, places = 1) => Math.round(v * 10 ** places) / 10 ** places;
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/** One supplier across quotes: by GSTIN when the quote gives one, else by name. */
export const supplierKey = (s = {}) => String(s?.gstin || s?.name || '').trim().toUpperCase();

/** The rate per base unit, or null when the quote's unit could not be read. */
export function comparableRate(rate) {
  const v = Number(rate?.ratePerBaseUom);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** How far `rate` is above (+) or below (−) `base`, in %. */
export function gapPct(rate, base) {
  return Number.isFinite(rate) && Number.isFinite(base) && base > 0 ? round(((rate - base) / base) * 100) : null;
}

/** APPROVED, REJECTED, PENDING (an item or band proposed), or UNMAPPED (nothing proposed). */
export function lineStatus(p) {
  if (p.status === 'APPROVED' || p.status === 'REJECTED') return p.status;
  return p.proposal?.itemId || p.proposal?.band?.quality ? 'PENDING' : 'UNMAPPED';
}

/** What a line is: the decision once approved, otherwise what was proposed. */
export function lineTarget(p) {
  const from = p.status === 'APPROVED' ? p.decision : p.proposal;
  return {
    itemId: from?.itemId ? Number(from.itemId) : null,
    itemName: from?.itemName || null,
    band: from?.band?.quality ? from.band : null,
  };
}

/** The quote facts shown beside a line's rate. */
export function quoteFacts(quote) {
  if (!quote) return null;
  return {
    ...offerQuote(quote),
    freight: text(quote.terms?.freight),
    gst: text(quote.terms?.gst),
    materialClass: quote.materialClass || null,
    receivedAt: quote.createdAt || null,
  };
}

/** One line as the dashboards show it. */
export function lineRow(p, quote = null) {
  const t = lineTarget(p);
  return {
    id: String(p._id),
    quoteId: String(p.autoQuoteId),
    lineNo: p.lineNo ?? null,
    supplier: { name: p.supplier?.name || null, gstin: p.supplier?.gstin || null, key: supplierKey(p.supplier) },
    productName: p.line?.productName || '',
    rateText: p.line?.rateText ?? null,
    rate: p.rate?.rate ?? null,
    uom: p.rate?.uom || null,
    comparable: comparableRate(p.rate),
    flags: p.rate?.flags || [],
    status: lineStatus(p),
    itemId: t.itemId,
    itemName: t.itemName,
    band: t.band ? bandLabel(t.band) : null,
    method: p.proposal?.method || null,
    confidence: p.proposal?.confidence ?? null,
    receivedAt: quote?.createdAt || p.createdAt || null,
    decidedAt: p.decision?.at || null,
    decidedBy: p.decision?.by || null,
    note: p.decision?.note || null,
    quote: quoteFacts(quote),
  };
}

const newestFirst = (a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0);

/** Each supplier's newest row. */
export function latestBySupplier(rows = []) {
  const latest = new Map();
  for (const r of [...rows].sort(newestFirst)) if (!latest.has(r.supplier.key)) latest.set(r.supplier.key, r);
  return [...latest.values()];
}

/** The unit most of the priced rows are in: the one rates are compared in. */
export function mainUom(rows = []) {
  const counts = new Map();
  for (const r of rows) if (r.comparable != null && r.uom) counts.set(r.uom, (counts.get(r.uom) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** A PO rate per base unit, like a quote's, so the two can be set side by side. */
export function paidRate(po) {
  if (!po || !Number.isFinite(Number(po.rate))) return null;
  const n = normaliseRate({ rate: Number(po.rate), uom: po.uom });
  return n.ratePerBaseUom == null ? null : { ...po, rate: n.ratePerBaseUom, uom: n.uom, rateAsPaid: Number(po.rate), uomAsPaid: po.uom };
}

/**
 * Where a row's rate stands among other suppliers' approved rates in its unit:
 * rank 1 is cheapest. `of` counts the row itself, so 1 of 1 is the only quote.
 */
export function rankIn(row, others = []) {
  if (row.comparable == null) return null;
  const rates = others.filter((o) => o.uom === row.uom && o.comparable != null).map((o) => o.comparable);
  const cheapest = rates.length ? Math.min(...rates) : null;
  return {
    rank: 1 + rates.filter((r) => r < row.comparable).length,
    of: rates.length + 1,
    cheapestOther: cheapest,
    gapToCheapest: gapPct(row.comparable, cheapest),
  };
}

/** The KPIs at the top of the item dashboard. */
export function itemSummary(rows = [], paid = null) {
  const approved = latestBySupplier(rows.filter((r) => r.status === 'APPROVED'));
  const pending = rows.filter((r) => r.status === 'PENDING');
  const uom = mainUom(approved) || mainUom(rows);
  const priced = approved.filter((r) => r.comparable != null && r.uom === uom).sort((a, b) => a.comparable - b.comparable);
  const best = priced[0] || null;
  // Shown apart from the approved best, and marked as not yet checked.
  const bestPending = latestBySupplier(pending).filter((r) => r.comparable != null && r.uom === uom)
    .sort((a, b) => a.comparable - b.comparable)[0] || null;
  const timed = approved.filter((r) => Number.isFinite(r.quote?.deliveryDays)).sort((a, b) => a.quote.deliveryDays - b.quote.deliveryDays);
  const keys = (list) => new Set(list.map((r) => r.supplier.key));
  const paidInUnit = paid && paid.uom === uom ? paid : null;
  return {
    uom,
    best: best && { rate: best.comparable, supplier: best.supplier.name, receivedAt: best.receivedAt },
    lastPaid: paid,
    bestVsPaid: best && paidInUnit ? gapPct(best.comparable, paidInUnit.rate) : null,
    bestPending: bestPending && { rate: bestPending.comparable, supplier: bestPending.supplier.name, receivedAt: bestPending.receivedAt },
    bestPendingVsPaid: bestPending && paidInUnit ? gapPct(bestPending.comparable, paidInUnit.rate) : null,
    suppliers: { approved: keys(approved).size, pending: keys(pending).size, total: keys([...approved, ...pending]).size },
    pending: pending.length,
    fastest: timed[0] ? { days: timed[0].quote.deliveryDays, text: timed[0].quote.delivery, supplier: timed[0].supplier.name } : null,
    spread: priced.length > 1 ? gapPct(priced.at(-1).comparable, best.comparable) : null,
  };
}

/** The KPIs and chart data at the top of the supplier dashboard. */
export function supplierSummary(rows = [], { months = 12, now = new Date() } = {}) {
  const status = { APPROVED: 0, PENDING: 0, UNMAPPED: 0, REJECTED: 0 };
  for (const r of rows) status[r.status] += 1;
  const quotes = new Map();
  for (const r of rows) if (!quotes.has(r.quoteId)) quotes.set(r.quoteId, r);
  const live = rows.filter((r) => r.status === 'APPROVED' || r.status === 'PENDING');
  const items = new Set(live.map((r) => (r.itemId ? `I${r.itemId}` : r.band ? `B${r.band}` : null)).filter(Boolean));

  const ranked = rows.filter((r) => r.status === 'APPROVED' && r.rank);
  const ranks = { first: 0, second: 0, third: 0, alone: 0 };
  for (const r of ranked) {
    if (r.rank.of === 1) ranks.alone += 1;
    else if (r.rank.rank === 1) ranks.first += 1;
    else if (r.rank.rank === 2) ranks.second += 1;
    else ranks.third += 1;
  }

  const days = [...quotes.values()].map((r) => r.quote?.deliveryDays).filter(Number.isFinite);
  const credit = new Map();
  for (const r of quotes.values()) if (r.quote?.credit) credit.set(r.quote.credit, (credit.get(r.quote.credit) || 0) + 1);
  const gaps = (st) => rows.filter((r) => r.status === st && Number.isFinite(r.paidGap)).map((r) => r.paidGap);
  const mean = (list) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  const vsPaid = gaps('APPROVED');
  const vsPaidPending = gaps('PENDING');

  const byMonth = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    byMonth.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, quotes: 0 });
  }
  for (const r of quotes.values()) {
    const d = new Date(r.receivedAt);
    const m = byMonth.find((b) => b.month === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    if (m) m.quotes += 1;
  }

  const last = [...quotes.values()].sort(newestFirst)[0];
  return {
    quotes: quotes.size,
    lastQuoteAt: last?.receivedAt || null,
    lines: rows.length,
    status,
    items: items.size,
    cheapest: { count: ranks.first, compared: ranked.length - ranks.alone },
    ranks,
    avgDeliveryDays: mean(days),
    credit: [...credit.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    vsPaid: mean(vsPaid),
    vsPaidLines: vsPaid.length,
    vsPaidPending: mean(vsPaidPending),
    vsPaidPendingLines: vsPaidPending.length,
    byMonth,
  };
}

/** The standing record of every quote line at a site. */
async function siteLines(site) {
  return withSuppliers(currentProposals(await MappingProposal.find({ site }).select(LINE_FIELDS).lean()));
}

async function quotesById(lines) {
  const ids = [...new Set(lines.map((p) => String(p.autoQuoteId)))];
  const quotes = await AutoQuote.find({ _id: { $in: ids } }).select(QUOTE_FIELDS).lean();
  return new Map(quotes.map((q) => [String(q._id), q]));
}

/** The driver returns ItemID as text, so Indus maps may be keyed either way. */
const byItemId = (map, id) => map.get(Number(id)) ?? map.get(String(id)) ?? null;

/** True when a line is for this Indus item: as the item itself, or through a band over it. */
function lineCovers(p, item) {
  const t = lineTarget(p);
  if (t.itemId === Number(item.ItemID)) return 'ITEM';
  return t.band && PAPER_GROUP_IDS.includes(Number(item.ItemGroupID)) && itemInBand(item, t.band) ? 'BAND' : null;
}

const itemFacts = (it) => ({
  itemId: Number(it.ItemID),
  itemCode: it.ItemCode || null,
  itemName: it.ItemName,
  group: it.ItemGroupName || null,
  subGroup: it.ItemSubGroupName || null,
  quality: it.Quality || null,
  gsm: it.GSM || null,
  mill: it.Manufecturer || null,
  sizeW: it.SizeW || null,
  sizeL: it.SizeL || null,
  unit: it.StockUnit || null,
  purchaseUnit: it.PurchaseUnit || null,
});

/**
 * Every quote line for one Indus item, approved, pending and rejected, with
 * the KPIs, the rates over time and what CDC paid on POs.
 */
export async function itemDashboard({ site, itemId }) {
  await ensureSupplierPortalReady();
  const item = await getItem(site, Number(itemId));
  if (!item) throw fail(404, 'That item is not in Indus at this site.');
  const lines = (await siteLines(site)).map((p) => ({ p, via: lineCovers(p, item) })).filter((x) => x.via);
  const quotes = await quotesById(lines.map((x) => x.p));
  const rows = lines.map(({ p, via }) => ({ ...lineRow(p, quotes.get(String(p.autoQuoteId))), via })).sort(newestFirst);

  const [paidMap, history] = await Promise.all([
    lastPaidRates(site, [item.ItemID]),
    itemRateHistory(site, item.ItemID, { months: 24 }),
  ]);
  const paid = paidRate(byItemId(paidMap, item.ItemID));
  const summary = itemSummary(rows, paid);
  const poHistory = history.map((h) => paidRate({
    rate: h.PurchaseRate, uom: h.PurchaseUnit, date: h.VoucherDate, voucherNo: h.VoucherNo, supplierName: h.LedgerName,
  })).filter((h) => h && h.uom === summary.uom);

  return { item: itemFacts(item), summary, rows, poHistory };
}

/** Suppliers with quote lines at a site, newest quote first, narrowed by name or GSTIN. */
export async function supplierList({ site, q = '', limit = 50 }) {
  await ensureSupplierPortalReady();
  const needle = String(q || '').trim().toUpperCase();
  const lines = await withSuppliers(currentProposals(await MappingProposal.find({ site })
    .select('autoQuoteId refreshOf supplier status createdAt').lean()));
  const bySupplier = new Map();
  for (const p of [...lines].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    const key = supplierKey(p.supplier);
    if (!key) continue;
    const s = bySupplier.get(key) || {
      key, name: p.supplier?.name || null, gstin: p.supplier?.gstin || null, lines: 0, pending: 0, quotes: new Set(), lastAt: p.createdAt,
    };
    s.lines += 1;
    if (p.status === 'UNAPPROVED') s.pending += 1;
    s.quotes.add(String(p.autoQuoteId));
    bySupplier.set(key, s);
  }
  return [...bySupplier.values()]
    .filter((s) => !needle || `${s.name || ''} ${s.gstin || ''}`.toUpperCase().includes(needle))
    .slice(0, Math.min(Number(limit) || 50, 200))
    .map(({ quotes, ...s }) => ({ ...s, quotes: quotes.size }));
}

/**
 * Every line one supplier quoted at a site, each with its rank among the
 * other suppliers' approved rates for the same item, its gap to the cheapest
 * of them and to what CDC last paid.
 */
export async function supplierDashboard({ site, key }) {
  await ensureSupplierPortalReady();
  const want = String(key || '').trim().toUpperCase();
  const all = await siteLines(site);
  const mine = all.filter((p) => supplierKey(p.supplier) === want);
  if (!mine.length) throw fail(404, 'No quote lines from that supplier at this site.');

  const quotes = await quotesById(mine);
  const rows = mine.map((p) => lineRow(p, quotes.get(String(p.autoQuoteId)))).sort(newestFirst);
  const itemIds = [...new Set(rows.filter((r) => r.itemId && r.status !== 'UNMAPPED').map((r) => r.itemId))];
  const [items, paidMap] = await Promise.all([getItems(site, itemIds), lastPaidRates(site, itemIds)]);

  // Other suppliers' approved lines, newest per supplier, for each item this one quoted.
  const othersApproved = all.filter((p) => p.status === 'APPROVED' && supplierKey(p.supplier) !== want);
  const othersFor = new Map();
  for (const id of itemIds) {
    const item = byItemId(items, id);
    const hits = othersApproved.filter((p) => (item ? lineCovers(p, item) : lineTarget(p).itemId === id));
    othersFor.set(id, latestBySupplier(hits.map((p) => lineRow(p))));
  }

  for (const r of rows) {
    if (!r.itemId) continue;
    const item = byItemId(items, r.itemId);
    if (item && !r.itemName) r.itemName = item.ItemName;
    if (r.status === 'APPROVED' || r.status === 'PENDING') {
      r.rank = rankIn(r, othersFor.get(r.itemId) || []);
      const paid = paidRate(byItemId(paidMap, r.itemId));
      if (paid && paid.uom === r.uom && r.comparable != null) {
        r.lastPaid = paid;
        r.paidGap = gapPct(r.comparable, paid.rate);
      }
    }
  }

  const named = [...rows].sort(newestFirst)[0].supplier;
  return { supplier: { key: want, name: named.name, gstin: named.gstin }, summary: supplierSummary(rows), rows };
}
