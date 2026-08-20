/**
 * Item search and the item detail screen — the centrepiece of the comparator.
 *
 * Every route here takes a plant. The default is the plant implied by the
 * user's site, and it is always echoed back so the UI can state which plant is
 * being shown rather than leaving a buyer to assume.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import { ensureSupplierPortalReady, ItemClassification, AuditLog } from '../db/mongo.js';
import { search, itemDetail, quotesForItem, groupForRanking } from '../services/comparator.js';
import { getItems } from '../services/erp-items.js';
import { PLANTS, SITE_BY_PLANT } from '../config/constants.js';

const router = Router();
router.use(requireAuth, requireSite);

/** The plant for this request, defaulting to the one the site implies. */
function plantFor(req) {
  const requested = req.query.plant || req.body?.plant;
  if (requested) {
    const upper = String(requested).toUpperCase();
    if (!SITE_BY_PLANT[upper]) {
      const err = new Error(`Unknown plant "${requested}". Expected ${PLANTS.KOL} or ${PLANTS.AHM}.`);
      err.status = 400;
      throw err;
    }
    return upper;
  }
  return req.sp.site === 'AHM' ? PLANTS.AHM : PLANTS.KOL;
}

router.get('/search', async (req, res, next) => {
  try {
    const { q, limit, groups } = req.query;
    const itemGroupIds = groups
      ? String(groups).split(',').map(Number).filter(Number.isFinite)
      : null;
    const results = await search(req.sp.site, q, {
      limit: Number(limit) || 50,
      itemGroupIds,
    });
    res.json({ plant: plantFor(req), site: req.sp.site, results });
  } catch (err) { next(err); }
});

router.get('/:itemId', async (req, res, next) => {
  try {
    const plant = plantFor(req);
    const detail = await itemDetail(req.sp.site, Number(req.params.itemId), { plant });
    if (!detail) return res.status(404).json({ error: 'Item not found.' });

    return res.json({
      ...detail,
      // Grouped for display under the brand-vs-spec rule, so the UI does not
      // have to know which items are substitutable.
      ranking: groupForRanking(detail.quotes, detail.rankingMode),
    });
  } catch (err) { return next(err); }
});

router.get('/:itemId/quotes', async (req, res, next) => {
  try {
    const plant = plantFor(req);
    const items = await getItems(req.sp.site, [Number(req.params.itemId)]);
    const item = items.get(Number(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    return res.json({ plant, quotes: await quotesForItem(req.sp.site, item, { plant }) });
  } catch (err) { return next(err); }
});

/**
 * Override the brand-vs-spec classification for one item.
 *
 * The sub-group defaults are workable but the purchase team knows the
 * exceptions — the question they answer is "would a buyer accept a different
 * brand at the same spec without asking anyone?"
 */
router.put('/:itemId/classification', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { rankingMode, note } = req.body || {};
    if (!['BRAND', 'SPEC'].includes(rankingMode)) {
      return res.status(400).json({ error: 'rankingMode must be BRAND or SPEC.' });
    }

    const itemRef = { site: req.sp.site, itemId: Number(req.params.itemId) };
    const before = await ItemClassification.findOne({
      'itemRef.site': itemRef.site, 'itemRef.itemId': itemRef.itemId,
    }).lean();

    const after = await ItemClassification.findOneAndUpdate(
      { 'itemRef.site': itemRef.site, 'itemRef.itemId': itemRef.itemId },
      { $set: { itemRef, rankingMode, setBy: req.sp.actor, note: note || null } },
      { new: true, upsert: true },
    ).lean();

    await AuditLog.create({
      action: 'ITEM_CLASSIFICATION_SET',
      entity: 'itemClassification',
      entityId: String(after._id),
      site: req.sp.site,
      actor: req.sp.actor,
      before,
      after,
      reason: note || null,
    });

    return res.json(after);
  } catch (err) { return next(err); }
});

export default router;
