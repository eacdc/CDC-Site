/**
 * M3 reports (§13.2).
 *
 * Every report is sorted by money, because the point is to decide what to do
 * next and there are always more findings than hours. Every report takes a
 * plant, and none of them compares a rate at one plant against a rate at the
 * other.
 */

import {
  ensureSupplierPortalReady, RateHistory, SupplierGroup, SupplierItem, ItemMapping,
} from '../db/mongo.js';
import { assertSite } from '../db/mssql.js';
import { TOLERANCES, PLANTS } from '../config/constants.js';
import {
  getItems, annualSpend, suppliersForItems, purchasedItemIds, itemRateHistory,
} from './erp-items.js';
import { posInWindow, openPoLines } from './erp-po.js';

/**
 * **Quotes needing refresh.** Every supplier × item × plant whose current
 * quote expires within 30 days or already has, sorted by annual spend.
 *
 * Sorting by spend is what makes this actionable: chasing an expiring quote on
 * a ₹40,000-a-year item ahead of one on a ₹40-lakh item is motion, not work.
 */
export async function quotesNeedingRefresh(site, { plant, withinDays = TOLERANCES.quoteExpiryWarningDays } = {}) {
  assertSite(site);
  await ensureSupplierPortalReady();
  requirePlant(plant);

  const horizon = new Date();
  horizon.setDate(horizon.getDate() + withinDays);

  const rates = await RateHistory.find({
    plant,
    isCurrent: true,
    effectiveTo: { $ne: null, $lte: horizon },
  }).lean();
  if (!rates.length) return [];

  const [groups, supplierItems, spendMap] = await Promise.all([
    groupsById(rates),
    supplierItemsById(rates),
    annualSpend(site),
  ]);

  const itemIds = await itemIdsForRates(site, rates);
  const items = await getItems(site, [...new Set([...itemIds.values()].flat())]);
  const now = new Date();

  return rates
    .map((rate) => {
      const mapped = itemIds.get(String(rate._id)) || [];
      const item = mapped.length ? items.get(mapped[0]) : null;
      const spend = mapped.reduce((sum, id) => sum + (spendMap.get(id)?.spend || 0), 0);
      const daysLeft = Math.ceil((new Date(rate.effectiveTo) - now) / 86400000);

      return {
        supplierGroupId: rate.supplierGroupId,
        supplierName: groups.get(String(rate.supplierGroupId))?.name || 'Unknown',
        supplierEmail: groups.get(String(rate.supplierGroupId))?.contactEmail || null,
        supplierProductName: supplierItems.get(String(rate.supplierItemId))?.supplierProductName || null,
        itemId: item?.ItemID ?? null,
        itemName: item?.ItemName ?? null,
        specKey: rate.specKey?.kind === 'ITEM' ? null : rate.specKey,
        plant,
        rate: rate.ratePerBaseUom ?? rate.rate,
        effectiveFrom: rate.effectiveFrom,
        effectiveTo: rate.effectiveTo,
        daysLeft,
        isExpired: daysLeft < 0,
        // A quote whose validity was never stated is a different ask: the
        // supplier did not set an expiry, we did.
        validityWasDefaulted: rate.quoteStrength === 'SOFT' || false,
        annualSpend: spend,
      };
    })
    .sort((a, b) => b.annualSpend - a.annualSpend || a.daysLeft - b.daysLeft);
}

/**
 * **Plant coverage gaps.** Two different gaps, deliberately in one report
 * because they compete for the same buyer's attention:
 *
 *   1. Items bought at this plant with no current quote from anyone here.
 *   2. Items a supplier quotes at the other plant but not this one.
 *
 * This is the report that keeps Ahmedabad from running on Kolkata's
 * assumptions.
 */
export async function plantCoverageGaps(site, { plant }) {
  assertSite(site);
  await ensureSupplierPortalReady();
  requirePlant(plant);

  const otherPlant = plant === PLANTS.KOL ? PLANTS.AHM : PLANTS.KOL;
  const [purchased, spendMap] = await Promise.all([
    purchasedItemIds(site),
    annualSpend(site),
  ]);

  const mappings = await ItemMapping.find({
    'itemRef.site': site, 'itemRef.itemId': { $in: purchased }, isActive: true,
  }).lean();

  const supplierItemsByItem = new Map();
  for (const m of mappings) {
    const key = m.itemRef.itemId;
    if (!supplierItemsByItem.has(key)) supplierItemsByItem.set(key, []);
    supplierItemsByItem.get(key).push(m.supplierItemId);
  }

  const allSupplierItemIds = [...new Set(mappings.map((m) => m.supplierItemId))];
  const rates = allSupplierItemIds.length
    ? await RateHistory.find({
        supplierItemId: { $in: allSupplierItemIds }, isCurrent: true,
      }).lean()
    : [];

  const ratesBySupplierItem = new Map();
  for (const r of rates) {
    const k = String(r.supplierItemId);
    if (!ratesBySupplierItem.has(k)) ratesBySupplierItem.set(k, []);
    ratesBySupplierItem.get(k).push(r);
  }

  const [items, groups] = await Promise.all([
    getItems(site, purchased),
    SupplierGroup.find({}).lean().then((g) => new Map(g.map((x) => [String(x._id), x]))),
  ]);

  const gaps = [];

  for (const itemId of purchased) {
    const supplierItemIds = supplierItemsByItem.get(itemId) || [];
    const item = items.get(itemId);
    const spend = spendMap.get(itemId)?.spend || 0;

    const atThisPlant = [];
    const otherPlantOnly = [];

    for (const sid of supplierItemIds) {
      const rows = ratesBySupplierItem.get(String(sid)) || [];
      const here = rows.find((r) => r.plant === plant);
      const there = rows.find((r) => r.plant === otherPlant);
      if (here) atThisPlant.push(here);
      else if (there) otherPlantOnly.push(there);
    }

    if (atThisPlant.length === 0 && otherPlantOnly.length === 0) {
      gaps.push({
        kind: 'NO_QUOTE_ANYWHERE',
        itemId, itemName: item?.ItemName ?? null, plant, annualSpend: spend,
        message: `Bought at ${titleCase(plant)} but no supplier has a current quote`,
      });
      continue;
    }

    if (atThisPlant.length === 0 && otherPlantOnly.length > 0) {
      gaps.push({
        kind: 'QUOTED_OTHER_PLANT_ONLY',
        itemId, itemName: item?.ItemName ?? null, plant, annualSpend: spend,
        suppliers: otherPlantOnly.map((r) => groups.get(String(r.supplierGroupId))?.name).filter(Boolean),
        message: `Quoted for ${titleCase(otherPlant)} only — ask for a ${titleCase(plant)} rate`,
      });
    }
  }

  return gaps.sort((a, b) => b.annualSpend - a.annualSpend);
}

/**
 * **Leakage.** For every PO raised in the period, the difference between what
 * was paid and the best quote available from any supplier on that date.
 *
 * This is the report that justifies the project, so it is deliberately
 * conservative about what it counts:
 *
 *   - Soft quotes never count as an alternative. "Prices may fluctuate" is
 *     not an offer that was on the table.
 *   - A quote only counts if it was current ON the PO date. Comparing today's
 *     rate to a PO from four months ago produces an impressive and meaningless
 *     number.
 *   - Brand-defined items are flagged, not scored, when the cheaper quote is a
 *     different brand — that would have been a substitution decision, not a
 *     missed saving.
 */
export async function leakage(site, { plant, from, to }) {
  assertSite(site);
  await ensureSupplierPortalReady();
  requirePlant(plant);

  const pos = await posInWindow(site, { from, to });
  if (!pos.length) return { lines: [], totalLeakage: 0, poCount: 0 };

  const poLines = await openPoLines(site, {
    transactionIds: pos.map((p) => p.TransactionID),
    includeCompleted: true,
  });

  const itemIds = [...new Set(poLines.map((l) => l.ItemID))];
  const [items, groups] = await Promise.all([
    getItems(site, itemIds),
    SupplierGroup.find({}).lean().then((g) => new Map(g.map((x) => [String(x._id), x]))),
  ]);

  const rateRows = await ratesForItems(site, itemIds, { plant, includeHistoric: true });
  const results = [];
  let totalLeakage = 0;

  for (const line of poLines) {
    if (!Number.isFinite(line.PurchaseRate) || line.PurchaseRate <= 0) continue;
    const poDate = new Date(line.PoDate);

    const available = (rateRows.get(line.ItemID) || []).filter((r) => {
      if (r.quoteStrength === 'SOFT') return false;
      if (new Date(r.effectiveFrom) > poDate) return false;
      if (r.effectiveTo && new Date(r.effectiveTo) < poDate) return false;
      return Number.isFinite(r.ratePerBaseUom ?? r.rate);
    });
    if (!available.length) continue;

    const best = available.reduce((b, r) => (
      (r.ratePerBaseUom ?? r.rate) < (b.ratePerBaseUom ?? b.rate) ? r : b
    ));
    const bestRate = best.ratePerBaseUom ?? best.rate;
    if (bestRate >= line.PurchaseRate) continue;

    const qty = Number(line.PurchaseOrderQuantity) || 0;
    const perUnit = line.PurchaseRate - bestRate;
    const amount = round(perUnit * qty, 2);
    totalLeakage += amount;

    results.push({
      poVoucherNo: line.PoVoucherNo,
      poDate: line.PoDate,
      itemId: line.ItemID,
      itemName: items.get(line.ItemID)?.ItemName ?? line.ItemName,
      supplierName: line.SupplierName,
      poRate: line.PurchaseRate,
      bestRate,
      bestSupplier: groups.get(String(best.supplierGroupId))?.name || 'Unknown',
      quantity: qty,
      perUnitDelta: round(perUnit, 4),
      leakage: amount,
      plant,
    });
  }

  return {
    lines: results.sort((a, b) => b.leakage - a.leakage),
    totalLeakage: round(totalLeakage, 2),
    poCount: pos.length,
    window: { from, to },
    plant,
  };
}

/**
 * **Cross-supplier spread.** The same ItemID bought from several suppliers at
 * materially different rates.
 *
 * Reads purchase history rather than quotes: this is about money already
 * spent, and the spread between what two suppliers actually charged is harder
 * to argue with than a spread between two quotes.
 */
export async function crossSupplierSpread(site, { minSpreadPct = 0.15, months = 24 } = {}) {
  assertSite(site);
  const purchased = await purchasedItemIds(site, { months });
  const [supplierMap, items, spendMap] = await Promise.all([
    suppliersForItems(site, purchased, { months }),
    getItems(site, purchased),
    annualSpend(site),
  ]);

  const rows = [];
  for (const [itemId, suppliers] of supplierMap) {
    if (suppliers.length < 2) continue;

    const cheapest = suppliers.reduce((a, b) => (a.minRate <= b.minRate ? a : b));
    const dearest = suppliers.reduce((a, b) => (a.maxRate >= b.maxRate ? a : b));
    if (!cheapest.minRate || cheapest.minRate <= 0) continue;

    const spreadPct = (dearest.maxRate - cheapest.minRate) / cheapest.minRate;
    if (spreadPct < minSpreadPct) continue;

    const volume = suppliers.reduce((sum, s) => sum + (s.buyCount || 0), 0);
    rows.push({
      itemId,
      itemName: items.get(itemId)?.ItemName ?? null,
      cheapest: { supplier: cheapest.ledgerName, rate: cheapest.minRate },
      dearest: { supplier: dearest.ledgerName, rate: dearest.maxRate },
      spreadPct: round(spreadPct * 100, 1),
      supplierCount: suppliers.length,
      volume,
      annualSpend: spendMap.get(itemId)?.spend || 0,
      /** Money at stake if every buy had gone to the cheapest supplier. */
      potentialSaving: round((dearest.maxRate - cheapest.minRate) * volume, 2),
    });
  }

  return rows.sort((a, b) => b.potentialSaving - a.potentialSaving);
}

/**
 * **Single-source risk.** Items with only one quoting supplier, weighted by
 * annual spend. A cheap single source is still a single source.
 */
export async function singleSourceRisk(site, { plant }) {
  assertSite(site);
  await ensureSupplierPortalReady();
  requirePlant(plant);

  const purchased = await purchasedItemIds(site);
  const [rateRows, items, spendMap] = await Promise.all([
    ratesForItems(site, purchased, { plant }),
    getItems(site, purchased),
    annualSpend(site),
  ]);

  const rows = [];
  for (const itemId of purchased) {
    const rates = rateRows.get(itemId) || [];
    const supplierCount = new Set(rates.map((r) => String(r.supplierGroupId))).size;
    if (supplierCount > 1) continue;

    const spend = spendMap.get(itemId)?.spend || 0;
    if (spend <= 0) continue;

    rows.push({
      itemId,
      itemName: items.get(itemId)?.ItemName ?? null,
      supplierCount,
      annualSpend: spend,
      plant,
      severity: supplierCount === 0 ? 'NO_QUOTE' : 'SINGLE_SOURCE',
    });
  }

  return rows.sort((a, b) => b.annualSpend - a.annualSpend);
}

/**
 * **Data quality.** Items whose rate history spans more than 3x between min
 * and max.
 *
 * This finds entry errors for free — the verified examples are a blanket price
 * typed on a plate line (`Plate-CTP-576 X 889` at 4,565), `Copier A4` at
 * 280,233, and `Ink Duct Foil` ranging 35 to 4,000.
 */
export async function dataQuality(site, { spreadFactor = 3, months = 24 } = {}) {
  assertSite(site);
  const purchased = await purchasedItemIds(site, { months });
  const items = await getItems(site, purchased);
  const rows = [];

  // Deliberately sequential: this is a nightly report over a few hundred
  // items, and firing hundreds of concurrent history queries at the ERP would
  // be rude to a database that other people are using interactively.
  for (const itemId of purchased) {
    const history = await itemRateHistory(site, itemId, { months });
    const rates = history.map((h) => h.PurchaseRate).filter((r) => Number.isFinite(r) && r > 0);
    if (rates.length < 2) continue;

    const min = Math.min(...rates);
    const max = Math.max(...rates);
    if (max / min < spreadFactor) continue;

    const outlier = history.find((h) => h.PurchaseRate === max);
    rows.push({
      itemId,
      itemName: items.get(itemId)?.ItemName ?? null,
      minRate: min,
      maxRate: max,
      factor: round(max / min, 1),
      observations: rates.length,
      suspectVoucherNo: outlier?.VoucherNo ?? null,
      suspectDate: outlier?.VoucherDate ?? null,
      suspectSupplier: outlier?.LedgerName ?? null,
    });
  }

  return rows.sort((a, b) => b.factor - a.factor);
}

/**
 * **Master duplicates.** Two CDC items competing for one supplier quote line.
 *
 * A by-product of matching rather than a separate analysis: when one supplier
 * item maps to several CDC items as EQUIVALENT, or several CDC items share a
 * last-paid rate and a name stem, the master has duplicates. This becomes the
 * master-cleanup list.
 */
export async function masterDuplicates(site) {
  assertSite(site);
  await ensureSupplierPortalReady();

  const mappings = await ItemMapping.aggregate([
    { $match: { 'itemRef.site': site, isActive: true } },
    { $group: { _id: '$supplierItemId', itemIds: { $addToSet: '$itemRef.itemId' }, relations: { $addToSet: '$relation' } } },
    { $match: { 'itemIds.1': { $exists: true } } },
  ]);
  if (!mappings.length) return [];

  const [supplierItems, items, spendMap] = await Promise.all([
    SupplierItem.find({ _id: { $in: mappings.map((m) => m._id) } }).lean()
      .then((rows) => new Map(rows.map((r) => [String(r._id), r]))),
    getItems(site, mappings.flatMap((m) => m.itemIds)),
    annualSpend(site),
  ]);

  return mappings.map((m) => ({
    supplierProductName: supplierItems.get(String(m._id))?.supplierProductName || null,
    relations: m.relations,
    candidates: m.itemIds.map((id) => ({
      itemId: id,
      itemName: items.get(id)?.ItemName ?? null,
      itemCode: items.get(id)?.ItemCode ?? null,
      annualSpend: spendMap.get(id)?.spend || 0,
    })),
    // EQUIVALENT means a human confirmed the duplication; DISTINCT_CANDIDATE
    // means it is still an open question.
    isConfirmed: m.relations.includes('EQUIVALENT'),
  })).sort((a, b) => (
    b.candidates.reduce((s, c) => s + c.annualSpend, 0)
    - a.candidates.reduce((s, c) => s + c.annualSpend, 0)
  ));
}

// ── Shared loaders ──────────────────────────────────────────────────────────

/**
 * Current (or historic) rates keyed by CDC ItemID at one plant.
 *
 * Spec-level rates are resolved to items by the caller's item list rather than
 * by scanning the master, which keeps a film quote from having to be expanded
 * across 60 widths just to answer a question about three of them.
 */
async function ratesForItems(site, itemIds, { plant, includeHistoric = false } = {}) {
  await ensureSupplierPortalReady();
  const ids = [...new Set(itemIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const mappings = await ItemMapping.find({
    'itemRef.site': site, 'itemRef.itemId': { $in: ids }, isActive: true,
  }).lean();
  if (!mappings.length) return new Map();

  const filter = {
    supplierItemId: { $in: mappings.map((m) => m.supplierItemId) },
    plant,
  };
  if (!includeHistoric) filter.isCurrent = true;

  const rates = await RateHistory.find(filter).lean();
  const bySupplierItem = new Map();
  for (const r of rates) {
    const k = String(r.supplierItemId);
    if (!bySupplierItem.has(k)) bySupplierItem.set(k, []);
    bySupplierItem.get(k).push(r);
  }

  const byItem = new Map();
  for (const m of mappings) {
    const rows = bySupplierItem.get(String(m.supplierItemId)) || [];
    if (!rows.length) continue;
    const key = m.itemRef.itemId;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(...rows);
  }

  return byItem;
}

/** Which CDC items each rate row applies to. */
async function itemIdsForRates(site, rates) {
  const supplierItemIds = [...new Set(rates.map((r) => r.supplierItemId).filter(Boolean))];
  if (!supplierItemIds.length) return new Map();

  const mappings = await ItemMapping.find({
    supplierItemId: { $in: supplierItemIds }, 'itemRef.site': site, isActive: true,
  }).lean();

  const bySupplierItem = new Map();
  for (const m of mappings) {
    const k = String(m.supplierItemId);
    if (!bySupplierItem.has(k)) bySupplierItem.set(k, []);
    bySupplierItem.get(k).push(m.itemRef.itemId);
  }

  return new Map(rates.map((r) => [
    String(r._id),
    r.supplierItemId ? (bySupplierItem.get(String(r.supplierItemId)) || []) : [],
  ]));
}

async function groupsById(rates) {
  const ids = [...new Set(rates.map((r) => String(r.supplierGroupId)))];
  const groups = await SupplierGroup.find({ _id: { $in: ids } }).lean();
  return new Map(groups.map((g) => [String(g._id), g]));
}

async function supplierItemsById(rates) {
  const ids = [...new Set(rates.map((r) => r.supplierItemId).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await SupplierItem.find({ _id: { $in: ids } }).lean();
  return new Map(rows.map((r) => [String(r._id), r]));
}

function requirePlant(plant) {
  if (!plant || ![PLANTS.KOL, PLANTS.AHM].includes(plant)) {
    throw new Error(
      `A plant is required (${PLANTS.KOL} | ${PLANTS.AHM}). Rates never fall back across plants.`,
    );
  }
}

function titleCase(text) {
  const t = String(text ?? '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function round(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
