/**
 * Live ERP reference data.
 *
 * Everything here is read fresh on every request. These lists are exactly the
 * ones that differ between the two databases — warehouse IDs, employee ledger
 * IDs, charge ledger IDs — so caching them would be the fastest route to
 * writing an Ahmedabad voucher with Kolkata's IDs.
 */

import { Router } from 'express';
import { requireAuth, requireSite } from '../middleware/auth.js';
import {
  warehouses, employeeLedgers, chargeLedgers, purchaseLedgers, erpUsers,
  supplierLedgers, getLedger, ledgerTypes,
} from '../services/erp-ledgers.js';
import { ITEM_GROUPS, ITEM_SUBGROUPS, PLANTS, SITES } from '../config/constants.js';
import { VALIDATIONS } from '../config/validations.js';

const router = Router();
router.use(requireAuth, requireSite);

router.get('/warehouses', async (req, res, next) => {
  try { res.json(await warehouses(req.sp.site)); } catch (err) { next(err); }
});

router.get('/employee-ledgers', async (req, res, next) => {
  try { res.json(await employeeLedgers(req.sp.site)); } catch (err) { next(err); }
});

router.get('/charge-ledgers', async (req, res, next) => {
  try { res.json(await chargeLedgers(req.sp.site)); } catch (err) { next(err); }
});

router.get('/purchase-ledgers', async (req, res, next) => {
  try { res.json(await purchaseLedgers(req.sp.site)); } catch (err) { next(err); }
});

router.get('/users', async (req, res, next) => {
  try { res.json(await erpUsers(req.sp.site)); } catch (err) { next(err); }
});

router.get('/supplier-ledgers', async (req, res, next) => {
  try { res.json(await supplierLedgers(req.sp.site)); } catch (err) { next(err); }
});

/**
 * What LedgerTypes this database actually has, and which count as suppliers.
 * The check for "are any suppliers being excluded by the type filter?" — a
 * question that otherwise looks like "was this supplier ever set up?".
 */
router.get('/ledger-types', async (req, res, next) => {
  try { res.json(await ledgerTypes(req.sp.site)); } catch (err) { next(err); }
});

router.get('/ledgers/:ledgerId', async (req, res, next) => {
  try {
    const ledger = await getLedger(req.sp.site, req.params.ledgerId);
    if (!ledger) return res.status(404).json({ error: 'Ledger not found.' });
    return res.json(ledger);
  } catch (err) { return next(err); }
});

/**
 * Static reference the UI needs to render labels and legends. Sent from the
 * server so the client never keeps its own copy of an ERP convention that
 * might drift.
 */
router.get('/reference', (req, res) => {
  res.json({
    sites: SITES,
    plants: PLANTS,
    itemGroups: ITEM_GROUPS,
    itemSubGroups: ITEM_SUBGROUPS,
    validations: Object.fromEntries(
      Object.entries(VALIDATIONS).map(([code, def]) => [code, {
        severity: def.severity, scope: def.scope, message: def.message,
      }]),
    ),
  });
});

export default router;
