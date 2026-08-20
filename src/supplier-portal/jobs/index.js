/**
 * Background jobs.
 *
 * Two run nightly. The delivery-date snapshot is the one that matters most on
 * day one, and it is deliberately started before the scorecard that consumes
 * it exists: the ERP edits `ExpectedDeliveryDate` in place when a supplier
 * pre-informs a change, so commitment stability can only ever be measured from
 * snapshots taken at the time. Every day without it is data that cannot be
 * recovered afterwards.
 */

import {
  ensureSupplierPortalReady, RateHistory, SupplierItem, DeliveryDateSnapshot,
  ItemMapping, AuditLog,
} from '../db/mongo.js';
import { SITES } from '../config/constants.js';
import { openLinesForSnapshot } from '../services/erp-po.js';
import { itemsCreatedSince, getItems } from '../services/erp-items.js';
import { itemSpecTuple, compareSpecTuples } from '../lib/spec.js';
import { refreshHistoricalGroups } from '../services/supplier-groups.js';

/**
 * Snapshot `ExpectedDeliveryDate` on every open PO line.
 *
 * No trigger on `ItemTransactionDetail` — too many concurrent ERP procedures
 * depend on that table for a trigger to be safe. A daily read is enough:
 * commitment stability counts changes, and a change made and reverted within
 * one day is not a commitment anyone relied on.
 */
export async function snapshotDeliveryDates({ sites = SITES } = {}) {
  await ensureSupplierPortalReady();
  const snapshotDate = startOfDay(new Date());
  const summary = {};

  for (const site of sites) {
    try {
      const lines = await openLinesForSnapshot(site);
      if (!lines.length) { summary[site] = { lines: 0 }; continue; }

      const ops = lines.map((line) => ({
        updateOne: {
          filter: { site, transactionDetailId: line.TransactionDetailID, snapshotDate },
          update: {
            $set: {
              site,
              snapshotDate,
              poTransactionId: line.TransactionID,
              poVoucherNo: line.VoucherNo,
              transactionDetailId: line.TransactionDetailID,
              itemId: line.ItemID,
              ledgerId: line.LedgerID,
              expectedDeliveryDate: line.ExpectedDeliveryDate,
              pendingQty: line.PendingQty,
            },
          },
          // Idempotent: running the job twice in a day overwrites rather than
          // duplicating, so a retry after a failure is safe.
          upsert: true,
        },
      }));

      await DeliveryDateSnapshot.bulkWrite(ops, { ordered: false });
      summary[site] = { lines: lines.length };
    } catch (err) {
      console.error(`[SP][jobs] delivery snapshot failed for ${site}:`, err.message);
      summary[site] = { error: err.message };
    }
  }

  return { snapshotDate, summary };
}

/**
 * Commitment stability for a supplier: how often the promised date moved, and
 * by how much in total.
 *
 * Kept separate from on-time percentage on purpose. A supplier who always
 * delivers on the date they most recently promised scores perfectly on
 * on-time and terribly here, and those are two different problems.
 */
export async function commitmentStability(site, { ledgerIds = null, since } = {}) {
  await ensureSupplierPortalReady();
  const filter = { site };
  if (since) filter.snapshotDate = { $gte: since };
  if (ledgerIds?.length) filter.ledgerId = { $in: ledgerIds.map(Number) };

  const rows = await DeliveryDateSnapshot.find(filter)
    .sort({ transactionDetailId: 1, snapshotDate: 1 })
    .lean();

  const byLine = new Map();
  for (const row of rows) {
    const key = row.transactionDetailId;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(row);
  }

  const byLedger = new Map();
  for (const [, history] of byLine) {
    let changes = 0;
    let daysSlipped = 0;
    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1].expectedDeliveryDate;
      const curr = history[i].expectedDeliveryDate;
      if (!prev || !curr) continue;
      const delta = Math.round((new Date(curr) - new Date(prev)) / 86400000);
      if (delta === 0) continue;
      changes += 1;
      daysSlipped += delta;
    }
    if (!changes) continue;

    const ledgerId = history[0].ledgerId;
    if (!byLedger.has(ledgerId)) byLedger.set(ledgerId, { ledgerId, lines: 0, changes: 0, daysSlipped: 0 });
    const entry = byLedger.get(ledgerId);
    entry.lines += 1;
    entry.changes += changes;
    entry.daysSlipped += daysSlipped;
  }

  return [...byLedger.values()].sort((a, b) => b.daysSlipped - a.daysSlipped);
}

/**
 * Nightly refresh.
 *
 *  1. Look for new ItemIDs that are near-clones of already-mapped items, and
 *     attach them as EQUIVALENT — CDC's master genuinely holds duplicates, and
 *     a new duplicate silently splits an item's rate history in two.
 *  2. Expire rate rows past their effectiveTo.
 *  3. Promote PROVISIONAL supplier items with a second sighting or a PO.
 *  4. Refresh which item groups each supplier has historically supplied.
 */
export async function nightlyRefresh({ sites = SITES, since } = {}) {
  await ensureSupplierPortalReady();
  const lookback = since || new Date(Date.now() - 2 * 86400000);
  const summary = { expired: 0, promoted: 0, equivalents: [], bySite: {} };

  summary.expired = await expireStaleRates();
  summary.promoted = await promoteProvisionalItems();

  for (const site of sites) {
    try {
      const equivalents = await attachNearCloneItems(site, lookback);
      await refreshHistoricalGroups(site);
      summary.bySite[site] = { newEquivalents: equivalents.length };
      summary.equivalents.push(...equivalents);
    } catch (err) {
      console.error(`[SP][jobs] nightly refresh failed for ${site}:`, err.message);
      summary.bySite[site] = { error: err.message };
    }
  }

  await AuditLog.create({
    action: 'NIGHTLY_REFRESH',
    entity: 'job',
    entityId: 'nightly-refresh',
    actor: 'system',
    after: summary,
  });

  return summary;
}

/** Close rate rows whose validity has run out. */
async function expireStaleRates() {
  const result = await RateHistory.updateMany(
    { isCurrent: true, effectiveTo: { $ne: null, $lt: new Date() } },
    { $set: { isCurrent: false } },
  );
  return result.modifiedCount || 0;
}

/**
 * Promote PROVISIONAL supplier items.
 *
 * A second sighting, or any PO against a mapped item, says this is part of the
 * supplier's real catalogue rather than a one-off project line. Only then does
 * it earn a place in the mapping queue.
 */
async function promoteProvisionalItems() {
  const provisional = await SupplierItem.find({ status: 'PROVISIONAL' }).lean();
  const toPromote = provisional.filter(
    (item) => (item.seenInDocIds?.length || 0) > 1 || (item.poSightings || 0) > 0,
  );
  if (!toPromote.length) return 0;

  await SupplierItem.updateMany(
    { _id: { $in: toPromote.map((i) => i._id) } },
    { $set: { status: 'ACTIVE' } },
  );
  return toPromote.length;
}

/**
 * Attach new ItemIDs that duplicate an already-mapped item.
 *
 * The new row is attached as EQUIVALENT rather than replacing the mapping:
 * CDC's master genuinely has several ItemIDs for one product and any of them
 * is a correct answer. Reporting the suspicion is what turns this into the
 * master-cleanup list.
 */
async function attachNearCloneItems(site, since) {
  const created = await itemsCreatedSince(site, since);
  if (!created.length) return [];

  const mappings = await ItemMapping.find({ 'itemRef.site': site, isActive: true }).lean();
  if (!mappings.length) return [];

  const mappedItems = await getItems(site, mappings.map((m) => m.itemRef.itemId));
  const found = [];

  for (const item of created) {
    const tuple = itemSpecTuple(item);

    for (const mapping of mappings) {
      const existing = mappedItems.get(mapping.itemRef.itemId);
      if (!existing || existing.ItemGroupID !== item.ItemGroupID) continue;

      const comparison = compareSpecTuples(tuple, itemSpecTuple(existing));
      // Three attributes agreeing with nothing disagreeing is a duplicate, not
      // a coincidence.
      if (comparison.compared < 3 || comparison.mismatches.length) continue;

      const already = await ItemMapping.findOne({
        supplierItemId: mapping.supplierItemId,
        'itemRef.site': site,
        'itemRef.itemId': item.ItemID,
      }).lean();
      if (already) continue;

      await ItemMapping.create({
        supplierItemId: mapping.supplierItemId,
        itemRef: { site, itemId: item.ItemID },
        relation: 'EQUIVALENT',
        confidence: comparison.score,
        method: 'SPEC_TUPLE',
        evidence: {
          matchedOn: 'NIGHTLY_NEAR_CLONE',
          notes: `New ItemID ${item.ItemID} matches mapped ItemID ${existing.ItemID} on ${comparison.compared} attributes`,
        },
        isActive: true,
      });

      found.push({
        newItemId: item.ItemID,
        newItemName: item.ItemName,
        duplicateOfItemId: existing.ItemID,
        duplicateOfItemName: existing.ItemName,
        matchedAttributes: comparison.compared,
      });
      break;
    }
  }

  return found;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Schedule both jobs.
 *
 * `setInterval` rather than a cron dependency: this server already runs long
 * and the schedule is "once a day, roughly", not "at 02:00 exactly". The first
 * snapshot runs shortly after boot so a deploy never loses a day.
 */
export function scheduleJobs() {
  if (process.env.SP_DISABLE_JOBS === 'true') {
    console.log('[SP][jobs] disabled by SP_DISABLE_JOBS');
    return null;
  }

  const DAY = 24 * 3600 * 1000;

  const snapshotTimer = setInterval(() => {
    snapshotDeliveryDates().catch((err) => console.error('[SP][jobs] snapshot failed:', err));
  }, DAY);

  const refreshTimer = setInterval(() => {
    nightlyRefresh().catch((err) => console.error('[SP][jobs] nightly refresh failed:', err));
  }, DAY);

  // Neither timer should keep the process alive on its own.
  snapshotTimer.unref?.();
  refreshTimer.unref?.();

  // Run the snapshot soon after boot. It is the one job whose data cannot be
  // reconstructed later, so missing a day to a restart matters.
  const initial = setTimeout(() => {
    snapshotDeliveryDates().catch((err) => console.error('[SP][jobs] initial snapshot failed:', err));
  }, 60_000);
  initial.unref?.();

  console.log('[SP][jobs] scheduled: delivery-date snapshot and nightly refresh');
  return { snapshotTimer, refreshTimer };
}
