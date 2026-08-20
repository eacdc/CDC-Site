/**
 * M4 — the PO checker.
 *
 * Runs on demand for one PO, and as a nightly sweep over the day's POs.
 *
 * Comparison is always against the rate for the PO's **destination plant**. If
 * no quote exists for that plant, the "no current quote" warning is raised —
 * the other plant's rate is never substituted, however tempting, because the
 * two are genuinely different prices.
 *
 * One check blocks and the rest warn. Buying above a supplier's own current
 * quote is the one case with no legitimate reading: the supplier has told us
 * their price in writing and we are paying more than it.
 */

import { ensureSupplierPortalReady, RateHistory, SupplierGroup, ItemMapping } from '../db/mongo.js';
import { assertSite } from '../db/mssql.js';
import { check, SEVERITY } from '../config/validations.js';
import { PO_CHECK, PLANTS } from '../config/constants.js';
import { getPo, openPoLines, posInWindow } from './erp-po.js';
import { getItems, lastPaidRates } from './erp-items.js';
import { groupForLedger } from './supplier-groups.js';
import { itemMatchesSpecKey } from '../lib/spec.js';

/**
 * Check every line of one PO.
 *
 * @param {'KOL'|'AHM'} site
 * @param {number} transactionId
 * @param {Object} opts
 * @param {string} [opts.plant]  defaults to the plant implied by the site
 */
export async function checkPo(site, transactionId, { plant } = {}) {
  assertSite(site);
  await ensureSupplierPortalReady();

  const po = await getPo(site, transactionId);
  if (!po) return null;

  const destinationPlant = plant || plantForSite(site);
  const supplierGroup = await groupForLedger(site, po.header.LedgerID);
  const itemIds = po.lines.map((l) => l.ItemID);

  const [items, lastPaid] = await Promise.all([
    getItems(site, itemIds),
    lastPaidRates(site, itemIds),
  ]);

  const lineResults = [];
  for (const line of po.lines) {
    const item = items.get(line.ItemID);
    const quotes = await currentQuotesForItem(site, item, destinationPlant);
    lineResults.push(checkLine({
      line, item, quotes, supplierGroup,
      lastPaid: lastPaid.get(line.ItemID) || null,
      plant: destinationPlant,
    }));
  }

  return {
    poTransactionId: po.header.TransactionID,
    poVoucherNo: po.header.VoucherNo,
    poDate: po.header.VoucherDate,
    supplierName: po.header.SupplierName,
    supplierGroup: supplierGroup?.name || null,
    plant: destinationPlant,
    lines: lineResults,
    verdict: verdictFor(lineResults),
  };
}

/**
 * Check one PO line against the quotes available for its plant.
 *
 * Exported and pure so it can be tested without a database.
 */
export function checkLine({ line, item, quotes = [], supplierGroup, lastPaid, plant }) {
  const poRate = Number(line.PurchaseRate);
  const checks = [];

  const usable = quotes.filter((q) => Number.isFinite(q.rate));
  const firm = usable.filter((q) => q.quoteStrength !== 'SOFT' && !q.isExpired);
  const best = firm.length ? firm.reduce((a, b) => (a.rate <= b.rate ? a : b)) : null;

  const ownQuote = supplierGroup
    ? usable.find((q) => String(q.supplierGroupId) === String(supplierGroup._id))
    : null;

  // PO003 — nothing to compare against at this plant. Deliberately raised
  // rather than reaching for the other plant's rate.
  checks.push(check('PO003', usable.length > 0, {
    message: usable.length ? undefined : `No supplier has a current quote for this item at ${titleCase(plant)}`,
  }));

  // PO002 — above the supplier's own written price. The only BLOCK here.
  if (ownQuote && Number.isFinite(poRate)) {
    const over = (poRate - ownQuote.rate) / ownQuote.rate;
    checks.push(check('PO002', over <= PO_CHECK.aboveOwnQuotePct, {
      message: over > PO_CHECK.aboveOwnQuotePct
        ? `PO rate ₹${poRate} is ${(over * 100).toFixed(1)}% above ${supplierGroup.name}'s own quote of ₹${ownQuote.rate}`
        : undefined,
      actualValue: poRate,
      expectedValue: ownQuote.rate,
    }));

    // PO005 — a soft quote is never grounds for a failure, only a note.
    if (ownQuote.quoteStrength === 'SOFT') {
      checks.push(check('PO005', true, {
        message: `${supplierGroup.name}'s quote is marked SOFT — indicative only`,
      }));
    }
    // PO004 — the comparison was made against an expired quote.
    if (ownQuote.isExpired) {
      checks.push(check('PO004', false, {
        message: `${supplierGroup.name}'s quote expired on ${formatDate(ownQuote.effectiveTo)}`,
        actualValue: ownQuote.effectiveTo,
      }));
    }
  }

  // PO001 — above the market's best.
  if (best && Number.isFinite(poRate)) {
    const over = (poRate - best.rate) / best.rate;
    checks.push(check('PO001', over <= PO_CHECK.aboveBestQuotePct, {
      message: over > PO_CHECK.aboveBestQuotePct
        ? `PO rate ₹${poRate} is ${(over * 100).toFixed(1)}% above the best quote (₹${best.rate} from ${best.supplierName})`
        : undefined,
      actualValue: poRate,
      expectedValue: best.rate,
    }));
  }

  // PO006 — a large move from what was last paid.
  if (lastPaid?.rate && Number.isFinite(poRate)) {
    const delta = Math.abs(poRate - lastPaid.rate) / lastPaid.rate;
    checks.push(check('PO006', delta <= PO_CHECK.vsLastPaidPct, {
      message: delta > PO_CHECK.vsLastPaidPct
        ? `PO rate ₹${poRate} differs from last paid ₹${lastPaid.rate} by ${(delta * 100).toFixed(1)}%`
        : undefined,
      actualValue: poRate,
      expectedValue: lastPaid.rate,
    }));
  }

  // PO007 — a supplier outside their usual groups. Not wrong, but worth a look.
  if (supplierGroup && item?.ItemGroupID) {
    const known = supplierGroup.historicalItemGroupIds || [];
    checks.push(check('PO007', !known.length || known.includes(item.ItemGroupID), {
      message: known.length && !known.includes(item.ItemGroupID)
        ? `${supplierGroup.name} has not supplied group ${item.ItemGroupID} before`
        : undefined,
    }));
  }

  // PO008 — the PO's unit disagrees with the item master's purchase unit.
  // Blocking, because every downstream quantity and value is computed in that
  // unit and a mismatch makes all of them wrong.
  if (item?.PurchaseUnit && line.PurchaseUnit) {
    const same = String(item.PurchaseUnit).trim().toUpperCase() === String(line.PurchaseUnit).trim().toUpperCase();
    checks.push(check('PO008', same, {
      message: same ? undefined : `PO is in ${line.PurchaseUnit} but the item's PurchaseUnit is ${item.PurchaseUnit}`,
      actualValue: line.PurchaseUnit,
      expectedValue: item.PurchaseUnit,
    }));
  }

  return {
    transactionDetailId: line.TransactionDetailID,
    itemId: line.ItemID,
    itemName: item?.ItemName ?? line.ItemName ?? null,
    quantity: line.PurchaseOrderQuantity,
    uom: line.PurchaseUnit,
    poRate,
    bestQuote: best ? { rate: best.rate, supplier: best.supplierName } : null,
    ownQuote: ownQuote ? { rate: ownQuote.rate, isExpired: ownQuote.isExpired, strength: ownQuote.quoteStrength } : null,
    lastPaid,
    plant,
    checks,
    verdict: verdictFor([{ checks }]),
  };
}

/**
 * A one-line verdict for the PO, which is what a buyer reads first.
 */
export function verdictFor(lineResults) {
  const all = lineResults.flatMap((l) => l.checks || []);
  const failed = all.filter((c) => !c.passed);
  const blocking = failed.filter((c) => c.severity === SEVERITY.BLOCK);
  const warnings = failed.filter((c) => c.severity === SEVERITY.WARN);

  if (blocking.length) {
    return { level: 'BLOCK', summary: blocking[0].message, blocking: blocking.length, warnings: warnings.length };
  }
  if (warnings.length) {
    return { level: 'WARN', summary: warnings[0].message, blocking: 0, warnings: warnings.length };
  }
  return { level: 'OK', summary: 'Priced in line with current quotes', blocking: 0, warnings: 0 };
}

/**
 * Current quotes for an item at one plant, in the shape the checker wants.
 *
 * Spec-level rates are included: a film PO priced against a {type, micron}
 * quote is exactly the case the spec keys exist for.
 */
async function currentQuotesForItem(site, item, plant) {
  if (!item) return [];
  await ensureSupplierPortalReady();

  const mappings = await ItemMapping.find({
    'itemRef.site': site, 'itemRef.itemId': item.ItemID, isActive: true,
  }).lean();

  const [direct, specRates] = await Promise.all([
    mappings.length
      ? RateHistory.find({
          supplierItemId: { $in: mappings.map((m) => m.supplierItemId) },
          plant,
          isCurrent: true,
        }).lean()
      : [],
    RateHistory.find({
      plant, isCurrent: true, 'specKey.kind': { $in: ['FILM_SPEC', 'FOIL_GRADE', 'PAPER_BAND'] },
    }).lean(),
  ]);

  const rows = [...direct, ...specRates.filter((r) => itemMatchesSpecKey(item, r.specKey))];
  if (!rows.length) return [];

  const groups = await SupplierGroup.find({
    _id: { $in: [...new Set(rows.map((r) => String(r.supplierGroupId)))] },
  }).lean();
  const byId = new Map(groups.map((g) => [String(g._id), g]));
  const now = new Date();

  return rows
    // An inter-unit transfer is not a supplier and must not set the benchmark.
    .filter((r) => !byId.get(String(r.supplierGroupId))?.isInternal)
    .map((r) => ({
      supplierGroupId: r.supplierGroupId,
      supplierName: byId.get(String(r.supplierGroupId))?.name || 'Unknown',
      rate: r.ratePerBaseUom ?? r.rate,
      quoteStrength: r.quoteStrength,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      isExpired: r.effectiveTo ? new Date(r.effectiveTo) < now : false,
      isSpecLevel: Boolean(r.specKey && r.specKey.kind !== 'ITEM'),
    }));
}

/**
 * The nightly sweep over POs raised in a window.
 *
 * Returns only POs that need attention. A clean PO produces no row — a queue
 * that lists everything is a queue nobody reads.
 */
export async function sweep(site, { from, to, plant } = {}) {
  assertSite(site);
  const end = to || new Date();
  const start = from || new Date(end.getTime() - 24 * 3600 * 1000);

  const pos = await posInWindow(site, { from: start, to: end });
  const results = [];

  for (const po of pos) {
    const result = await checkPo(site, po.TransactionID, { plant });
    if (result && result.verdict.level !== 'OK') results.push(result);
  }

  return {
    window: { from: start, to: end },
    plant: plant || plantForSite(site),
    checked: pos.length,
    needingAttention: results.length,
    results: results.sort((a, b) => severityRank(b.verdict.level) - severityRank(a.verdict.level)),
  };
}

/**
 * Open POs whose rate is now above a newer quote. Different from the sweep:
 * this catches a PO that was fine when raised and has since been overtaken,
 * which is a renegotiation opportunity rather than an error.
 */
export async function openPosAboveCurrentQuote(site, { plant } = {}) {
  assertSite(site);
  const destinationPlant = plant || plantForSite(site);
  const lines = await openPoLines(site, { months: 6 });
  const itemIds = [...new Set(lines.map((l) => l.ItemID))];
  const items = await getItems(site, itemIds);

  const results = [];
  for (const line of lines) {
    if (!Number.isFinite(line.PurchaseRate) || line.PendingQty <= 0) continue;
    const item = items.get(line.ItemID);
    const quotes = await currentQuotesForItem(site, item, destinationPlant);
    const firm = quotes.filter((q) => q.quoteStrength !== 'SOFT' && !q.isExpired && Number.isFinite(q.rate));
    if (!firm.length) continue;

    const best = firm.reduce((a, b) => (a.rate <= b.rate ? a : b));
    if (best.rate >= line.PurchaseRate) continue;

    results.push({
      poVoucherNo: line.PoVoucherNo,
      transactionDetailId: line.TransactionDetailID,
      itemId: line.ItemID,
      itemName: item?.ItemName ?? line.ItemName,
      supplierName: line.SupplierName,
      poRate: line.PurchaseRate,
      bestRate: best.rate,
      bestSupplier: best.supplierName,
      pendingQty: line.PendingQty,
      /** What is still recoverable — the received part is already spent. */
      exposureOnPending: round((line.PurchaseRate - best.rate) * line.PendingQty, 2),
      plant: destinationPlant,
    });
  }

  return results.sort((a, b) => b.exposureOnPending - a.exposureOnPending);
}

function plantForSite(site) {
  return site === 'AHM' ? PLANTS.AHM : PLANTS.KOL;
}

function severityRank(level) {
  return { BLOCK: 2, WARN: 1, OK: 0 }[level] ?? 0;
}

function titleCase(text) {
  const t = String(text ?? '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatDate(date) {
  if (!date) return 'an unknown date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function round(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
