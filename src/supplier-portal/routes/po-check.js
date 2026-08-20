/**
 * PO checking.
 *
 * The sweep endpoint is what the nightly job calls; the same code answers an
 * on-demand check so a buyer sees exactly what the overnight run would say.
 */

import { Router } from 'express';
import { requireAuth, requireSite } from '../middleware/auth.js';
import { checkPo, sweep, openPosAboveCurrentQuote } from '../services/po-check.js';
import { PLANTS, SITE_BY_PLANT } from '../config/constants.js';

const router = Router();
router.use(requireAuth, requireSite);

function plantFor(req) {
  const requested = req.query.plant;
  if (requested) {
    const upper = String(requested).toUpperCase();
    if (!SITE_BY_PLANT[upper]) {
      const err = new Error(`Unknown plant "${requested}".`);
      err.status = 400;
      throw err;
    }
    return upper;
  }
  return req.sp.site === 'AHM' ? PLANTS.AHM : PLANTS.KOL;
}

/** Open POs that a newer quote has overtaken — a renegotiation list. */
router.get('/open-above-quote', async (req, res, next) => {
  try {
    res.json(await openPosAboveCurrentQuote(req.sp.site, { plant: plantFor(req) }));
  } catch (err) { next(err); }
});

/** The sweep. Returns only POs needing attention. */
router.get('/sweep', async (req, res, next) => {
  try {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getTime() - 24 * 3600 * 1000);
    res.json(await sweep(req.sp.site, { from, to, plant: plantFor(req) }));
  } catch (err) { next(err); }
});

// Declared after the fixed paths so "sweep" is never read as a transaction id.
router.get('/:transactionId', async (req, res, next) => {
  try {
    const result = await checkPo(req.sp.site, Number(req.params.transactionId), {
      plant: plantFor(req),
    });
    if (!result) return res.status(404).json({ error: 'Purchase order not found.' });
    return res.json(result);
  } catch (err) { return next(err); }
});

export default router;
