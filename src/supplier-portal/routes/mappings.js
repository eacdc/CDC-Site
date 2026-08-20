/**
 * The mapping queue.
 *
 * The initial pass is ~546 items, and the speed of this screen decides whether
 * the project lands. The API is shaped for that: one call returns everything a
 * decision needs — the quote line, its source crop, and ranked candidates with
 * last-paid rate and purchase count — so the client never has to fetch again
 * mid-decision.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import {
  ensureSupplierPortalReady, MappingQueue, QuoteLine, QuoteDocument,
  SupplierItem, SupplierGroup, ItemMapping,
} from '../db/mongo.js';
import { resolveQueueEntry } from '../services/matching.js';
import { viewUrl } from '../../lib/r2-storage.js';

const router = Router();
router.use(requireAuth);

/**
 * The queue, highest-value first.
 *
 * Priority is the annual spend on the candidate items. Working the queue in
 * spend order means the money is mapped first even if the tail is never
 * finished.
 */
router.get('/queue', requireSite, async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { status = 'OPEN', reason, limit = 25, skip = 0 } = req.query;

    const filter = { site: req.sp.site, status };
    if (reason) filter.reason = reason;

    const [entries, total] = await Promise.all([
      MappingQueue.find(filter).sort({ priority: -1, createdAt: 1 })
        .skip(Number(skip)).limit(Math.min(Number(limit), 100)).lean(),
      MappingQueue.countDocuments(filter),
    ]);

    const hydrated = await Promise.all(entries.map(hydrateEntry));
    return res.json({ entries: hydrated, total, site: req.sp.site });
  } catch (err) { return next(err); }
});

/** One entry, fully hydrated — what the two-pane worker screen renders. */
router.get('/queue/:id', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const entry = await MappingQueue.findById(req.params.id).lean();
    if (!entry) return res.status(404).json({ error: 'Queue entry not found.' });
    return res.json(await hydrateEntry(entry));
  } catch (err) { return next(err); }
});

/**
 * Resolve an entry.
 *
 * `NO_CDC_ITEM` is a first-class outcome, not a failure. CDC does not stock
 * everything its suppliers sell; the line keeps its rate history as a
 * benchmark and never returns to the queue.
 */
router.post('/queue/:id/resolve', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const { itemId, status = 'RESOLVED', note, relation } = req.body || {};
    if (!['RESOLVED', 'NO_CDC_ITEM', 'DEFERRED'].includes(status)) {
      return res.status(400).json({ error: 'status must be RESOLVED, NO_CDC_ITEM or DEFERRED.' });
    }
    const result = await resolveQueueEntry({
      queueId: req.params.id,
      itemId,
      status,
      relation,
      actor: req.sp.actor,
      note,
    });
    return res.json(result);
  } catch (err) { return next(err); }
});

router.get('/queue-stats', requireSite, async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const byStatus = await MappingQueue.aggregate([
      { $match: { site: req.sp.site } },
      { $group: { _id: { status: '$status', reason: '$reason' }, count: { $sum: 1 }, spend: { $sum: '$priority' } } },
    ]);

    const open = byStatus.filter((r) => r._id.status === 'OPEN');
    res.json({
      site: req.sp.site,
      openCount: open.reduce((s, r) => s + r.count, 0),
      openSpend: open.reduce((s, r) => s + (r.spend || 0), 0),
      byStatus: byStatus.map((r) => ({ ...r._id, count: r.count, spend: r.spend })),
    });
  } catch (err) { next(err); }
});

/** Existing mappings, for review and for undoing a wrong one. */
router.get('/', requireSite, async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { supplierGroupId, itemId, limit = 100, skip = 0 } = req.query;

    const filter = { 'itemRef.site': req.sp.site, isActive: true };
    if (itemId) filter['itemRef.itemId'] = Number(itemId);
    if (supplierGroupId) {
      const items = await SupplierItem.find({ supplierGroupId }).select('_id').lean();
      filter.supplierItemId = { $in: items.map((i) => i._id) };
    }

    const [mappings, total] = await Promise.all([
      ItemMapping.find(filter).sort({ createdAt: -1 })
        .skip(Number(skip)).limit(Math.min(Number(limit), 500)).lean(),
      ItemMapping.countDocuments(filter),
    ]);

    const supplierItems = await SupplierItem.find({
      _id: { $in: mappings.map((m) => m.supplierItemId) },
    }).lean();
    const byId = new Map(supplierItems.map((s) => [String(s._id), s]));

    res.json({
      mappings: mappings.map((m) => ({
        ...m,
        supplierItem: byId.get(String(m.supplierItemId)) || null,
      })),
      total,
    });
  } catch (err) { next(err); }
});

/**
 * Retire a mapping.
 *
 * Deactivated rather than deleted: a mapping that turned out to be wrong is
 * evidence about how the matcher behaves, and the rate history written under
 * it still needs an explanation.
 */
router.delete('/:id', requireRole('APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { AuditLog } = await import('../db/mongo.js');
    const before = await ItemMapping.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Mapping not found.' });

    await ItemMapping.updateOne({ _id: req.params.id }, { $set: { isActive: false } });

    await AuditLog.create({
      action: 'MAPPING_RETIRED',
      entity: 'itemMapping',
      entityId: req.params.id,
      site: before.itemRef?.site,
      actor: req.sp.actor,
      before,
      reason: req.body?.reason || null,
    });

    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/**
 * Attach the context a decision needs.
 *
 * The source crop matters more than it looks: a coordinator deciding in five
 * seconds needs to see the printed line, not a transcription of it.
 */
async function hydrateEntry(entry) {
  const [line, supplierItem] = await Promise.all([
    QuoteLine.findById(entry.quoteLineId).lean(),
    SupplierItem.findById(entry.supplierItemId).lean(),
  ]);

  let document = null;
  let group = null;
  let sourceUrl = null;

  if (line) {
    document = await QuoteDocument.findById(line.quoteDocumentId).lean();
    if (document) {
      group = await SupplierGroup.findById(document.supplierGroupId).lean();
      const key = line.sourceCrop?.key || document.storageKey;
      if (key) {
        try { sourceUrl = await viewUrl(key); } catch { sourceUrl = null; }
      }
    }
  }

  return {
    ...entry,
    line,
    supplierItem,
    supplierGroup: group ? { _id: group._id, name: group.name } : null,
    document: document ? {
      _id: document._id,
      originalFilename: document.originalFilename,
      docType: document.docType,
      effectiveFrom: document.effectiveFrom,
    } : null,
    sourceUrl,
    sourceCrop: line?.sourceCrop || null,
  };
}

export default router;
