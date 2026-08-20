/**
 * Supplier Portal API.
 *
 * Mounted at `/api/supplier-portal` by `src/server.js`. Every route below is
 * relative to that prefix.
 *
 *   POST   /auth/login              internal user sign-in
 *   POST   /auth/logout
 *   GET    /auth/me
 *
 *   GET    /erp/warehouses          live ERP reference data
 *   GET    /erp/employee-ledgers
 *   GET    /erp/charge-ledgers
 *   GET    /erp/purchase-ledgers
 *   GET    /erp/users
 *
 *   GET    /suppliers               supplier groups
 *   POST   /suppliers
 *   PATCH  /suppliers/:id
 *   POST   /suppliers/reconcile     map unassigned ledgers to groups
 *   POST   /suppliers/merge
 *
 *   POST   /quotes/upload-url       presigned upload
 *   POST   /quotes                  register an uploaded document
 *   POST   /quotes/:id/extract
 *   GET    /quotes/:id              document + lines for review
 *   PATCH  /quotes/:id/lines/:lineId  correct an extracted line
 *   POST   /quotes/:id/match        run the matching engine
 *   POST   /quotes/:id/approve      write rate history
 *   GET    /quotes                  list
 *
 *   GET    /items/search
 *   GET    /items/:itemId           the item detail centrepiece
 *
 *   GET    /mappings/queue
 *   POST   /mappings/queue/:id/resolve
 *   GET    /mappings/queue/stats
 *
 *   GET    /reports/refresh-needed
 *   GET    /reports/plant-gaps
 *   GET    /reports/leakage
 *   GET    /reports/spread
 *   GET    /reports/single-source
 *   GET    /reports/data-quality
 *   GET    /reports/master-duplicates
 *
 *   GET    /po-check/:transactionId
 *   GET    /po-check/sweep/run
 *   GET    /po-check/open-above-quote
 *
 *   POST   /receiving/document-sets
 *   POST   /receiving/document-sets/:id/extract
 *   POST   /receiving/document-sets/:id/match
 *   POST   /receiving/document-sets/:id/post
 */

import { Router } from 'express';
import authRoutes from './auth.js';
import erpRoutes from './erp.js';
import supplierRoutes from './suppliers.js';
import boardRoutes from './boards.js';
import quoteRoutes from './quotes.js';
import itemRoutes from './items.js';
import mappingRoutes from './mappings.js';
import reportRoutes from './reports.js';
import poCheckRoutes from './po-check.js';
import receivingRoutes from './receiving.js';
import { ensureSupplierPortalReady } from '../db/mongo.js';

const router = Router();

/**
 * The Mongo connection is established on the first request rather than at boot
 * so that a missing `MONGODB_URI_SupplierPortal` disables this module instead
 * of stopping the whole server, which serves several unrelated applications.
 */
router.use(async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    return next();
  } catch (err) {
    return res.status(503).json({
      error: 'Supplier Portal storage is not available.',
      detail: err.message,
    });
  }
});

router.get('/health', (req, res) => res.json({ status: 'ok', module: 'supplier-portal' }));

router.use('/auth', authRoutes);
router.use('/erp', erpRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/boards', boardRoutes);
router.use('/quotes', quoteRoutes);
router.use('/items', itemRoutes);
router.use('/mappings', mappingRoutes);
router.use('/reports', reportRoutes);
router.use('/po-check', poCheckRoutes);
router.use('/receiving', receivingRoutes);

/**
 * Error handler.
 *
 * Validation failures carry their checks through to the client — a client that
 * knows *which* check blocked can tell the user, and a bare 400 cannot.
 */
router.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[SP] Unhandled error:', err);
  res.status(status).json({
    error: err.message || 'Something went wrong.',
    ...(err.checks ? { checks: err.checks } : {}),
  });
});

export default router;
