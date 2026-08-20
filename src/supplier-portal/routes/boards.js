/**
 * Board rate search.
 *
 * The item-centric comparison does not reach board: a board quote names a
 * grade and a GSM band, not an ItemID, and one band covers many items. These
 * two endpoints are how a buyer asks "grey back, 280 gsm, who is cheapest".
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchBoards, boardGradeOptions } from '../services/boards.js';

const router = Router();
router.use(requireAuth);

/** Grades to offer, each with how many live rows are behind it. */
router.get('/grades', async (req, res, next) => {
  try {
    res.json(await boardGradeOptions({ plant: req.query.plant || null }));
  } catch (err) { next(err); }
});

router.get('/search', async (req, res, next) => {
  try {
    const gsm = Number(req.query.gsm);
    res.json(await searchBoards({
      grade: req.query.grade || null,
      // NaN would be passed straight through as "no GSM asked for", which is
      // the right behaviour for a blank box and the wrong one for "28o".
      gsm: Number.isFinite(gsm) ? gsm : null,
      form: req.query.form || null,
      plant: req.query.plant || null,
      supplyMode: req.query.supplyMode || null,
      includeExpired: req.query.includeExpired === 'true',
    }));
  } catch (err) { next(err); }
});

export default router;
