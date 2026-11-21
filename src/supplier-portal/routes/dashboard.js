/**
 * The review page's dashboards. Read-only, for any signed-in user, at the
 * site sent in X-SP-Site.
 *
 *   GET /dashboard/item/:itemId     every quote line for an Indus item, with KPIs, rates over time and PO rates
 *   GET /dashboard/suppliers?q=     suppliers with quote lines, newest first
 *   GET /dashboard/supplier/:key    every line from one supplier (key: GSTIN, else name), ranked against the others
 */

import { Router } from 'express';
import { requireAuth, requireSite } from '../middleware/auth.js';
import { itemDashboard, supplierList, supplierDashboard } from '../services/dashboard.js';

const router = Router();
router.use(requireAuth, requireSite);

router.get('/item/:itemId', async (req, res, next) => {
  try { res.json(await itemDashboard({ site: req.sp.site, itemId: req.params.itemId })); } catch (err) { next(err); }
});

router.get('/suppliers', async (req, res, next) => {
  try { res.json({ suppliers: await supplierList({ site: req.sp.site, q: req.query.q, limit: req.query.limit }) }); } catch (err) { next(err); }
});

router.get('/supplier/:key', async (req, res, next) => {
  try { res.json(await supplierDashboard({ site: req.sp.site, key: req.params.key })); } catch (err) { next(err); }
});

export default router;
