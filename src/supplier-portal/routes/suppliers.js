/**
 * Suppliers.
 *
 * Suppliers come from the ERP's supplier ledgers — one each, created by Sync.
 * Nobody creates one by hand in the normal course of things; the manual create
 * below survives for the trader who quotes but has no ledger at all.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import { ensureSupplierPortalReady, SupplierGroup, AuditLog } from '../db/mongo.js';
import {
  listGroups, searchGroups, reconcileLedgers, refreshHistoricalGroups, mergeGroups,
} from '../services/supplier-groups.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    res.json(await listGroups({ includeInternal: req.query.includeInternal === 'true' }));
  } catch (err) { next(err); }
});

/**
 * Type-ahead for the confirmation screen.
 *
 * Registered before `/:id` — Express matches in order, and `/search` would
 * otherwise be read as an id and 404 against a cast error.
 */
router.get('/search', async (req, res, next) => {
  try {
    res.json(await searchGroups(req.query.q, {
      limit: Math.min(Number(req.query.limit) || 20, 50),
    }));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const group = await SupplierGroup.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: 'Supplier group not found.' });
    return res.json(group);
  } catch (err) { return next(err); }
});

router.post('/', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { name, aliases, ledgerRefs, isInternal, contactEmail, defaultValidityDays } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'A supplier needs a name.' });

    const group = await SupplierGroup.create({
      name: name.trim(),
      aliases: aliases || [],
      ledgerRefs: ledgerRefs || [],
      isInternal: Boolean(isInternal),
      contactEmail: contactEmail || null,
      defaultValidityDays: defaultValidityDays || undefined,
    });

    await AuditLog.create({
      action: 'SUPPLIER_GROUP_CREATED',
      entity: 'supplierGroup',
      entityId: String(group._id),
      actor: req.sp.actor,
      after: group.toObject(),
    });

    return res.status(201).json(group);
  } catch (err) { return next(err); }
});

router.patch('/:id', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const before = await SupplierGroup.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Supplier group not found.' });

    const allowed = ['name', 'aliases', 'ledgerRefs', 'isInternal',
      'contactEmail', 'defaultValidityDays', 'notes'];
    const update = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)),
    );

    const after = await SupplierGroup.findByIdAndUpdate(
      req.params.id, { $set: update }, { new: true },
    ).lean();

    await AuditLog.create({
      action: 'SUPPLIER_GROUP_UPDATED',
      entity: 'supplierGroup',
      entityId: req.params.id,
      actor: req.sp.actor,
      before,
      after,
    });

    return res.json(after);
  } catch (err) { return next(err); }
});

/**
 * Sync suppliers from the ERP. Every supplier ledger gets a supplier record,
 * and each ledger's GSTIN is copied onto it. Idempotent — a second run creates
 * nothing and simply picks up ledgers added since the first.
 */
router.post('/reconcile', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    res.json(await reconcileLedgers(req.sp.site));
  } catch (err) { next(err); }
});

router.post('/refresh-history', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try { res.json(await refreshHistoricalGroups(req.sp.site)); } catch (err) { next(err); }
});

/** Merge two groups discovered to be the same firm — SR Graphic and Neographic. */
router.post('/merge', requireRole('APPROVER'), async (req, res, next) => {
  try {
    const { sourceId, targetId } = req.body || {};
    if (!sourceId || !targetId) {
      return res.status(400).json({ error: 'Both sourceId and targetId are required.' });
    }
    const result = await mergeGroups(sourceId, targetId, { actor: req.sp.actor });
    await AuditLog.create({
      action: 'SUPPLIER_GROUP_MERGED',
      entity: 'supplierGroup',
      entityId: String(targetId),
      actor: req.sp.actor,
      after: result,
    });
    return res.json(result);
  } catch (err) { return next(err); }
});

export default router;
