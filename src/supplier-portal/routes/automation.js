/**
 * The scheduled run's API: read context, and add what it read.
 *
 *   GET  /automation/seen/:sha256         has this file been read?
 *   GET  /automation/portal-uploads       quotes uploaded in the portal, unread
 *   GET  /automation/proposals            every proposal, for approved-first matching
 *   POST /automation/quotes               one file + its reading (multipart: file, payload)
 *
 * Add-only. Nothing here can change or remove a record, and nothing here can
 * approve one: that is a reviewer's, through /proposals.
 */

import { Router } from 'express';
import multer from 'multer';
import { requireAutomationKey } from '../middleware/auth.js';
import {
  findBySha, recordRun, proposalsForMatching, pendingPortalUploads,
} from '../services/proposals.js';

const router = Router();
router.use(requireAutomationKey);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/seen/:sha256', async (req, res, next) => {
  try {
    const hit = await findBySha(String(req.params.sha256).toLowerCase());
    res.json({ seen: Boolean(hit), autoQuoteId: hit?._id || null });
  } catch (err) { next(err); }
});

router.get('/portal-uploads', async (req, res, next) => {
  try { res.json({ uploads: await pendingPortalUploads() }); } catch (err) { next(err); }
});

router.get('/proposals', async (req, res, next) => {
  try { res.json({ proposals: await proposalsForMatching() }); } catch (err) { next(err); }
});

router.post('/quotes', upload.single('file'), async (req, res, next) => {
  try {
    let payload;
    try { payload = JSON.parse(req.body?.payload || ''); } catch {
      return res.status(400).json({ error: 'payload must be JSON.' });
    }
    res.status(201).json(await recordRun({ file: req.file, payload }));
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid payload.', issues: err.issues?.slice(0, 20) });
    next(err);
  }
});

export default router;
