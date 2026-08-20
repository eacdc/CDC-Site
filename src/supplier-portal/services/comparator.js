/**
 * M3 — the quote comparator.
 *
 * The question this answers is the one nobody at CDC could answer before:
 * "what is the best rate available for this item right now?"
 *
 * Plant is a parameter on every function here, never an attribute of a result.
 * Rates differ materially by plant — NR Agarwal quotes Kolkata and Ahmedabad
 * roughly ₹4,000/MT apart for the same grade — and a supplier will often quote
 * only one of them. Nothing in this module falls back across plants.
 *
 * Three display states are kept distinct, because only one of them is
 * actionable:
 *
 *   QUOTED      a current rate exists for this plant           → show the rate
 *   NOT_AT_PLANT the supplier quotes this item, other plant only → "ask for a
 *                                                                  rate here"
 *   NOT_QUOTED  the supplier has never quoted this item        → blank
 *
 * Collapsing NOT_AT_PLANT into NOT_QUOTED loses the only one worth acting on.
 */

import {
  ensureSupplierPortalReady, RateHistory, ItemMapping, SupplierItem,
  SupplierGroup, ItemClassification,
} from '../db/mongo.js';
import { assertSite } from '../db/mssql.js';
import { PLANTS, rankingMode } from '../config/constants.js';
import { searchItems, getItems, lastPaidRates, itemRateHistory, annualSpend } from './erp-items.js';
import { itemMatchesSpecKey } from '../lib/spec.js';
import { normaliseName } from '../lib/text.js';

export const QUOTE_STATE = {
  QUOTED: 'QUOTED',
  NOT_AT_PLANT: 'NOT_AT_PLANT',
  NOT_QUOTED: 'NOT_QUOTED',
};

/**
 * Search for items, matching on CDC's own fields and on the supplier product
 * names mapped to them.
 *
 * The second half matters more than it looks: a buyer searching "sicura" is
 * looking for `UV Ink - Process-Cyan`, whose CDC name contains no such word.
 * The mapping is what makes the supplier's vocabulary searchable.
 */
export async function search(site, term, { limit = 50, itemGroupIds = null } = {}) {
  assertSite(site);
  await ensureSupplierPortalReady();
  const text = String(term ?? '').trim();
  if (!text) return [];

  const [direct, viaSupplierNames] = await Promise.all([
    searchItems(site, text, { limit, itemGroupIds }),
    itemsMatchingSupplierName(site, text, limit),
  ]);

  const byId = new Map(direct.map((r) => [r.ItemID, { ...r, matchedVia: 'CDC_NAME' }]));
  const extraIds = viaSupplierNames.filter((id) => !byId.has(id));

  if (extraIds.length) {
    const extra = await getItems(site, extraIds);
    for (const [id, row] of extra) {
      byId.set(id, { ...row, matchedVia: 'SUPPLIER_NAME' });
    }
  }

  return [...byId.values()].slice(0, limit);
}

/** ItemIDs whose mapped supplier products match the search text. */
async function itemsMatchingSupplierName(site, text, limit) {
  const normalised = normaliseName(text);
  if (!normalised) return [];

  const items = await SupplierItem
    .find({ normalisedName: { $regex: escapeRegex(normalised) } })
    .select('_id')
    .limit(limit * 4)
    .lean();
  if (!items.length) return [];

  const mappings = await ItemMapping.find({
    supplierItemId: { $in: items.map((i) => i._id) },
    'itemRef.site': site,
    isActive: true,
  }).select('itemRef').lean();

  return [...new Set(mappings.map((m) => m.itemRef.itemId))];
}

/**
 * The full comparison view for one item at one plant.
 *
 * @param {'KOL'|'AHM'} site
 * @param {number} itemId
 * @param {Object} opts
 * @param {string} opts.plant  KOLKATA | AHMEDABAD
 */
export async function itemDetail(site, itemId, { plant, historyMonths = 24 } = {}) {
  assertSite(site);
  await ensureSupplierPortalReady();
  if (!plant) throw new Error('itemDetail needs a plant — rates never cross plants.');

  const items = await getItems(site, [itemId]);
  const item = items.get(Number(itemId));
  if (!item) return null;

  const [paidMap, history, spendMap, classification] = await Promise.all([
    lastPaidRates(site, [itemId]),
    itemRateHistory(site, itemId, { months: historyMonths }),
    annualSpend(site, { itemGroupIds: [item.ItemGroupID] }),
    ItemClassification.findOne({ 'itemRef.site': site, 'itemRef.itemId': Number(itemId) }).lean(),
  ]);

  const quotes = await quotesForItem(site, item, { plant });
  const lastPaid = paidMap.get(Number(itemId)) || null;

  const mode = rankingMode({
    itemOverride: classification?.rankingMode,
    itemSubGroupId: item.ItemSubGroupID,
    itemGroupId: item.ItemGroupID,
  });

  const best = bestQuote(quotes);
  const spend = spendMap.get(Number(itemId)) || null;

  return {
    item: {
      itemId: item.ItemID,
      itemCode: item.ItemCode,
      name: item.ItemName,
      description: item.ItemDescription,
      groupId: item.ItemGroupID,
      groupName: item.ItemGroupName,
      subGroupId: item.ItemSubGroupID,
      subGroupName: item.ItemSubGroupName,
      stockUnit: item.StockUnit,
      purchaseUnit: item.PurchaseUnit,
      hsnId: item.ProductHSNID,
    },
    plant,
    rankingMode: mode,
    lastPaid,
    quotes,
    best,
    /**
     * Delta against last paid, which is the number a buyer acts on. Positive
     * means the best current quote is cheaper than the last purchase.
     */
    deltaVsLastPaid: best && lastPaid
      ? {
          rupees: round(lastPaid.rate - best.rate, 2),
          percent: lastPaid.rate ? round(((lastPaid.rate - best.rate) / lastPaid.rate) * 100, 2) : null,
        }
      : null,
    purchaseHistory: history,
    sparkline: buildSparkline(history),
    annualSpend: spend?.spend ?? null,
    purchaseCount: spend?.purchaseCount ?? null,
  };
}

/**
 * Current quotes for an item at a plant, from every supplier.
 *
 * Rates reach an item two ways and both are collected: directly, through a
 * supplier-item mapping; and through a spec key, where one film or foil line
 * prices many ItemIDs. A spec-level rate is marked as such so a buyer knows
 * the supplier quoted the spec rather than this exact width.
 */
export async function quotesForItem(site, item, { plant }) {
  await ensureSupplierPortalReady();
  const itemId = Number(item.ItemID ?? item);

  const mappings = await ItemMapping.find({
    'itemRef.site': site, 'itemRef.itemId': itemId, isActive: true,
  }).lean();
  const supplierItemIds = mappings.map((m) => m.supplierItemId);

  // Everything current for these supplier items, at ANY plant. The other
  // plant's rows are needed to tell NOT_AT_PLANT from NOT_QUOTED.
  const [directRates, specRates] = await Promise.all([
    supplierItemIds.length
      ? RateHistory.find({ supplierItemId: { $in: supplierItemIds }, isCurrent: true }).lean()
      : [],
    RateHistory.find({
      isCurrent: true,
      'specKey.kind': { $in: ['FILM_SPEC', 'FOIL_GRADE', 'PAPER_BAND'] },
    }).lean(),
  ]);

  const applicableSpecRates = specRates.filter((r) => itemMatchesSpecKey(item, r.specKey));
  const all = [...directRates, ...applicableSpecRates];
  if (!all.length) return [];

  const groups = await SupplierGroup.find({
    _id: { $in: [...new Set(all.map((r) => String(r.supplierGroupId)))] },
  }).lean();
  const groupById = new Map(groups.map((g) => [String(g._id), g]));

  const supplierItems = await SupplierItem.find({
    _id: { $in: [...new Set(all.map((r) => r.supplierItemId).filter(Boolean))] },
  }).lean();
  const supplierItemById = new Map(supplierItems.map((s) => [String(s._id), s]));

  // One row per supplier group: its rate at this plant, or the fact that it
  // only quotes the other one.
  const bySupplier = new Map();

  for (const rate of all) {
    const group = groupById.get(String(rate.supplierGroupId));
    // CDC Printers (Ahmedabad) is an inter-unit transfer, not a supplier, and
    // must never appear in a benchmark.
    if (!group || group.isInternal) continue;

    const key = String(rate.supplierGroupId);
    const existing = bySupplier.get(key);

    if (rate.plant === plant) {
      const row = toQuoteRow(rate, group, supplierItemById);
      // A later effectiveFrom wins if two rows somehow share the key.
      if (!existing || existing.state !== QUOTE_STATE.QUOTED
          || new Date(rate.effectiveFrom) > new Date(existing.effectiveFrom)) {
        bySupplier.set(key, row);
      }
      continue;
    }

    // A rate for the other plant only. Recorded as its own state — this is the
    // row that feeds "ask this supplier for an Ahmedabad rate", which is a
    // different request from "your quote has expired".
    if (!existing) {
      bySupplier.set(key, {
        ...toQuoteRow(rate, group, supplierItemById),
        state: QUOTE_STATE.NOT_AT_PLANT,
        rate: null,
        quotedAtPlant: rate.plant,
        displayNote: `not quoted (${titleCase(rate.plant)} only)`,
      });
    }
  }

  return [...bySupplier.values()].sort(byRateThenName);
}

function toQuoteRow(rate, group, supplierItemById) {
  const supplierItem = rate.supplierItemId
    ? supplierItemById.get(String(rate.supplierItemId))
    : null;
  const expired = rate.effectiveTo ? new Date(rate.effectiveTo) < new Date() : false;

  return {
    supplierGroupId: rate.supplierGroupId,
    supplierName: group.name,
    supplierProductName: supplierItem?.supplierProductName || null,
    supplierProductCode: supplierItem?.supplierProductCode || null,
    state: QUOTE_STATE.QUOTED,
    rate: rate.ratePerBaseUom ?? rate.rate,
    quotedRate: rate.rate,
    uom: rate.uom,
    plant: rate.plant,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    isExpired: expired,
    quoteStrength: rate.quoteStrength,
    isDerived: rate.isDerived,
    derivationNote: rate.derivationNote,
    /** Spec-level rates price the spec, not this exact width. */
    isSpecLevel: Boolean(rate.specKey && rate.specKey.kind !== 'ITEM'),
    specKey: rate.specKey?.kind === 'ITEM' ? null : rate.specKey,
    quoteDocumentId: rate.quoteDocumentId,
    quoteLineId: rate.quoteLineId,
  };
}

/**
 * The best available quote.
 *
 * Expired and soft quotes are excluded from "best" but stay in the list. A
 * soft quote is a usable benchmark and a poor basis for a decision, and
 * silently ranking one as best would make it look like a commitment.
 */
export function bestQuote(quotes = []) {
  const usable = quotes.filter(
    (q) => q.state === QUOTE_STATE.QUOTED
      && Number.isFinite(q.rate)
      && !q.isExpired
      && q.quoteStrength !== 'SOFT',
  );
  if (!usable.length) return null;
  return usable.reduce((best, q) => (q.rate < best.rate ? q : best));
}

/**
 * Compare an item across both plants, side by side. Used by the "all plants"
 * mode, which is the only place the two are shown together — and even there
 * they are two columns, never one merged number.
 */
export async function itemDetailAllPlants(itemDetailArgs) {
  const { itemIdKol, itemIdAhm } = itemDetailArgs;
  const [kolkata, ahmedabad] = await Promise.all([
    itemIdKol ? itemDetail('KOL', itemIdKol, { plant: PLANTS.KOL }) : null,
    itemIdAhm ? itemDetail('AHM', itemIdAhm, { plant: PLANTS.AHM }) : null,
  ]);
  return { kolkata, ahmedabad };
}

/**
 * Group quotes for display under the brand-vs-spec rule.
 *
 * Spec-defined items (BOPP film, GI wire, gum powder) rank suppliers outright.
 * Brand-defined items (Siegwerk Sicura 770HS Cyan, Henkel Technomelt) rank
 * within brand — Siegwerk cyan at 810 and SKT Enviro NEO cyan at 308 are not
 * the same purchase, and putting them in one ranking says they are.
 */
export function groupForRanking(quotes, mode) {
  if (mode === 'SPEC') {
    return {
      mode,
      ranked: [...quotes].sort(byRateThenName),
      byBrand: null,
      crossBrandNote: null,
    };
  }

  const byBrand = new Map();
  for (const q of quotes) {
    const brand = q.supplierName || 'Unknown';
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(q);
  }

  return {
    mode,
    ranked: null,
    byBrand: [...byBrand.entries()]
      .map(([brand, rows]) => ({ brand, quotes: rows.sort(byRateThenName) }))
      .sort((a, b) => a.brand.localeCompare(b.brand)),
    crossBrandNote:
      'Cross-brand prices are shown separately: substituting a brand is a technical decision, not a price decision.',
  };
}

function byRateThenName(a, b) {
  // Rows with no rate at this plant sort last: they are information, not
  // offers, and putting a blank at the top of a price list reads as "free".
  if (a.state !== QUOTE_STATE.QUOTED && b.state === QUOTE_STATE.QUOTED) return 1;
  if (b.state !== QUOTE_STATE.QUOTED && a.state === QUOTE_STATE.QUOTED) return -1;
  if (Number.isFinite(a.rate) && Number.isFinite(b.rate) && a.rate !== b.rate) return a.rate - b.rate;
  return String(a.supplierName).localeCompare(String(b.supplierName));
}

/** Monthly min/avg/max from PO history, for the 12-month sparkline. */
function buildSparkline(history = []) {
  const byMonth = new Map();
  for (const row of history) {
    if (!row.VoucherDate || !Number.isFinite(row.PurchaseRate)) continue;
    const d = new Date(row.VoucherDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(row.PurchaseRate);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rates]) => ({
      month,
      min: Math.min(...rates),
      max: Math.max(...rates),
      avg: round(rates.reduce((s, r) => s + r, 0) / rates.length, 2),
      count: rates.length,
    }));
}

function titleCase(text) {
  const t = String(text ?? '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
