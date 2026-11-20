/**
 * Create PO: purchase orders from approved supplier prices.
 *
 *   GET  /po/reference                 delivery points, terms, company block
 *   GET  /po/requisitions              PREQ lines not yet fully on a PO
 *   GET  /po/suppliers                 suppliers with an approved price, as ERP ledgers
 *   GET  /po/items?q=&supplierLedgerId=  items with an approved price
 *   GET  /po/items/:itemId/context?clientId=   prices, last paid and buffer stock for a line
 *   GET  /po/orders                    POs made with the tool
 *   POST /po/orders                    save - not built yet
 *
 * Front end: eacdc/Create-PO, whose README holds the response shapes. Every
 * read is live from the ERP of the signed-in plant; nothing here writes.
 */

import { Router } from 'express';
import { requireAuth, requireSite } from '../middleware/auth.js';
import {
  poReference, pendingRequisitions, poSuppliers, poItems, itemContext,
} from '../services/po.js';

const router = Router();
router.use(requireAuth, requireSite);

router.get('/reference', async (req, res, next) => {
  try { res.json(await poReference(req.sp.site)); } catch (err) { next(err); }
});

router.get('/requisitions', async (req, res, next) => {
  try { res.json({ lines: await pendingRequisitions(req.sp.site) }); } catch (err) { next(err); }
});

router.get('/suppliers', async (req, res, next) => {
  try { res.json({ suppliers: await poSuppliers(req.sp.site) }); } catch (err) { next(err); }
});

router.get('/items', async (req, res, next) => {
  try {
    const supplierLedgerId = req.query.supplierLedgerId ? Number(req.query.supplierLedgerId) : null;
    res.json({ items: await poItems(req.sp.site, { q: req.query.q || '', supplierLedgerId }) });
  } catch (err) { next(err); }
});

router.get('/items/:itemId/context', async (req, res, next) => {
  try {
    const ctx = await itemContext(req.sp.site, req.params.itemId, {
      clientId: req.query.clientId ? Number(req.query.clientId) : null,
    });
    if (!ctx) return res.status(404).json({ error: 'Item not found.' });
    return res.json(ctx);
  } catch (err) { return next(err); }
});

/** Nothing is stored yet: saving to the ERP is the next step. */
router.get('/orders', (req, res) => res.json({ orders: [] }));

router.post('/orders', (req, res) => res.status(501).json({
  error: 'Saving a PO to the ERP is not switched on yet. Everything else on this screen is live: '
    + 'use Print preview to check the PO, and raise it in the ERP for now.',
}));

export default router;
