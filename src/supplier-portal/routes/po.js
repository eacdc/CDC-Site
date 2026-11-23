/**
 * Create PO: purchase orders from approved supplier prices.
 *
 *   GET  /po/reference                 delivery points, terms, company block, next PO number
 *   GET  /po/requisitions              PREQ lines not yet fully on a PO
 *   GET  /po/suppliers                 suppliers with an approved price or a recent PO, as ERP ledgers
 *   GET  /po/items?q=&supplierLedgerId=  items with an approved price
 *   GET  /po/items/:itemId/context?clientId=   prices, last paid and buffer stock for a line
 *
 *   GET  /po/orders?from=&to=          POs in a date range, from the ERP and the tool
 *   POST /po/orders                    check and save a PO: to the ERP, or to wait for approval
 *                                      ({ ..., dryRun: true } returns the rows it would write, writing nothing)
 *   GET  /po/orders/:id                one tool PO, with what its approval page prints
 *   GET  /po/approvals                 tool POs waiting for approval, or approved but not saved
 *   POST /po/orders/:id/approval       upload the signed approval page (field "image"): approves and saves
 *   GET  /po/orders/:id/approval-image a short-lived link to the signed page
 *   POST /po/orders/:id/save           save again a PO whose save failed
 *   POST /po/orders/:id/cancel         drop a PO waiting for approval
 *
 * Front end: eacdc/Create-PO, whose README holds the response shapes.
 */

import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireSite } from '../middleware/auth.js';
import {
  poReference, pendingRequisitions, poSuppliers, poItems, itemContext,
} from '../services/po.js';
import { reqLinesHeldByTool } from '../services/po-save.js';
import {
  actorOf, createOrder, getOrder, approvalQueue, approveOrder, retrySave, cancelOrder,
  approvalImageKey, listOrders,
} from '../services/po-orders.js';
import { uploadBuffer, viewUrl } from '../../lib/r2-storage.js';
import { erpToday } from '../lib/erp-time.js';

const router = Router();
router.use(requireAuth, requireSite);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const SIGNED_PAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

router.get('/reference', async (req, res, next) => {
  try { res.json(await poReference(req.sp.site)); } catch (err) { next(err); }
});

router.get('/requisitions', async (req, res, next) => {
  try {
    const [lines, held] = await Promise.all([pendingRequisitions(req.sp.site), reqLinesHeldByTool(req.sp.site)]);
    // A line on a tool PO waiting for approval is shown, but not offered again.
    res.json({ lines: lines.map((l) => (held.has(l.reqLineId) ? { ...l, inApproval: true } : l)) });
  } catch (err) { next(err); }
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

/** yyyy-mm-dd, or the fallback. */
function dateParam(value, fallback) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return fallback;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

router.get('/orders', async (req, res, next) => {
  try {
    const today = erpToday();
    const to = dateParam(req.query.to, today);
    const from = dateParam(req.query.from, new Date(to.getTime() - 29 * 86400000));
    if (to - from > 366 * 86400000) return res.status(400).json({ error: 'Pick a range of a year or less.' });
    res.json({ from, to, orders: await listOrders(req.sp.site, { from, to }) });
  } catch (err) { next(err); }
});

router.post('/orders', async (req, res, next) => {
  try {
    const order = await createOrder(req.sp.site, req.body || {}, actorOf(req));
    if (order.dryRun) return res.json(order);
    return res.status(201).json({ order });
  } catch (err) { sendError(res, next, err); }
});

router.get('/approvals', async (req, res, next) => {
  try { res.json({ orders: await approvalQueue(req.sp.site) }); } catch (err) { next(err); }
});

router.get('/orders/:id', async (req, res, next) => {
  try { res.json({ order: await getOrder(req.sp.site, req.params.id) }); } catch (err) { sendError(res, next, err); }
});

router.post('/orders/:id/approval', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose the photo or scan of the signed approval page.' });
    if (!SIGNED_PAGE_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Upload a photo (JPG, PNG, HEIC) or a PDF of the signed page.' });
    }
    const stored = await uploadBuffer({
      folder: `supplier-portal/po-approvals/${req.sp.site}`,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });
    const order = await approveOrder(req.sp.site, req.params.id, {
      image: { key: stored.key, contentType: req.file.mimetype, bytes: stored.bytes, fileName: req.file.originalname },
      actor: actorOf(req),
    });
    return res.json({ order });
  } catch (err) { return sendError(res, next, err); }
});

router.get('/orders/:id/approval-image', async (req, res, next) => {
  try {
    res.json({ url: await viewUrl(await approvalImageKey(req.sp.site, req.params.id), 600) });
  } catch (err) { sendError(res, next, err); }
});

router.post('/orders/:id/save', async (req, res, next) => {
  try { res.json({ order: await retrySave(req.sp.site, req.params.id, actorOf(req)) }); } catch (err) { sendError(res, next, err); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try { res.json({ order: await cancelOrder(req.sp.site, req.params.id, actorOf(req)) }); } catch (err) { sendError(res, next, err); }
});

/** A refusal the buyer can act on goes back as itself, with every problem listed. */
function sendError(res, next, err) {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, problems: err.problems || undefined });
  }
  return next(err);
}

export default router;
