/**
 * Reviewing what the scheduled run proposed.
 *
 *   GET  /proposals/quotes                 quotes with lines waiting (?all=1 for every quote)
 *   GET  /proposals/quotes/:id             one quote: its file and every line
 *   GET  /proposals/:id/band-choices       a paper line: the Indus qualities and mills in its GSM range (?gsmFrom&gsmTo)
 *   POST /proposals/:id/band-preview       { band } -> how many Indus items it covers, a few of them named
 *   POST /proposals/:id/decision           { action: APPROVE | CHANGE | BAND | REJECT, itemId?, band?, note? }
 *   GET  /proposals/compare/:itemId        approved prices for an item, cheapest first
 *
 * A decision is the only change any of these records ever takes, and it needs
 * a signed-in APPROVER: the automation key does not open this router.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import {
  listQuotes, quoteForReview, decide, compareItem, bandChoicesFor, previewBand,
} from '../services/proposals.js';

const router = Router();
router.use(requireAuth);

router.get('/quotes', async (req, res, next) => {
  try {
    res.json({ quotes: await listQuotes({ site: req.query.site || null, open: req.query.all !== '1' }) });
  } catch (err) { next(err); }
});

router.get('/quotes/:id', async (req, res, next) => {
  try { res.json(await quoteForReview(req.params.id)); } catch (err) { next(err); }
});

router.get('/:id/band-choices', async (req, res, next) => {
  try {
    const { gsmFrom = null, gsmTo = null } = req.query;
    res.json(await bandChoicesFor(req.params.id, { gsmFrom: gsmFrom || null, gsmTo: gsmTo || null }));
  } catch (err) { next(err); }
});

router.post('/:id/band-preview', async (req, res, next) => {
  try { res.json(await previewBand(req.params.id, req.body?.band || {})); } catch (err) { next(err); }
});

router.post('/:id/decision', requireRole('APPROVER'), async (req, res, next) => {
  try {
    const {
      action, itemId = null, band = null, note = null,
    } = req.body || {};
    res.json({ proposal: await decide({ id: req.params.id, action, itemId, band, note, actor: req.sp.actor }) });
  } catch (err) { next(err); }
});

router.get('/compare/:itemId', requireSite, async (req, res, next) => {
  try { res.json({ offers: await compareItem({ site: req.sp.site, itemId: req.params.itemId }) }); } catch (err) { next(err); }
});

export default router;
