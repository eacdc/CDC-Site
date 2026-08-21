/**
 * Interpreting a paper or board quote, as a conversation.
 *
 * Two endpoints and they are the same operation: read the document. The second
 * carries answers to the questions the first asked.
 *
 * The one-shot extraction route at `/quotes/:id/extract` is untouched and still
 * serves every other material. This is the paper path only, which is what "one
 * category at a time" means when it reaches the routing table.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import { ensureSupplierPortalReady, QuoteDocument, PaperBrandRule } from '../db/mongo.js';
import { viewUrl } from '../../lib/r2-storage.js';
import { pdfPageTexts, looksLikePdf } from '../services/extraction/pdf-text.js';
import { runInterpretation, knownBrandsFor } from '../services/paper/paper-quotes.js';
import { canonicalPaperTypes } from '../config/paper-vocabulary.js';

const router = Router();
router.use(requireAuth);

/** The types a reviewer picks from when answering. */
router.get('/types', (req, res) => res.json(canonicalPaperTypes()));

/** What is already known, so a reviewer can see what will not be asked. */
router.get('/brands', async (req, res, next) => {
  try {
    res.json(await knownBrandsFor(req.query.supplierGroupId || null));
  } catch (err) { next(err); }
});

/**
 * Read a document, or read it again with answers.
 *
 * Answers are additive on the document, so a third round still knows what the
 * first two settled.
 */
router.post('/:id/interpret', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const doc = await QuoteDocument.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Quote document not found.' });

    if (doc.status === 'APPROVED') {
      return res.status(409).json({
        error: 'This quote is approved and its rates are written. Use "read this file again" '
          + 'to create a replacement rather than reinterpreting this one.',
      });
    }

    const keys = [doc.storageKey, ...(doc.pageKeys || [])].filter(Boolean);
    if (!keys.length) {
      return res.status(409).json({ error: 'This document has no stored file to read.' });
    }

    /*
      Both the page images and the text layer go to the model, and they do
      different jobs: the text layer has the exact characters, the image has the
      layout. Krishna Vanijya's list needs both — its section headings land far
      from their rows in the extracted text, and only the image says which
      heading a row sits under.
    */
    const pages = await Promise.all(keys.map(async (key, i) => ({
      url: await viewUrl(key), pageNo: i + 1, mimeType: doc.mimeType,
    })));

    let textLayer = null;
    if (looksLikePdf({ mimeType: doc.mimeType, originalFilename: doc.originalFilename })) {
      try {
        textLayer = await pdfPageTexts(await downloadKey(doc.storageKey));
      } catch (err) {
        // A scan has no text layer, and that is not a failure — the images
        // carry everything. Losing the layer is worth a log, not a 500.
        console.warn('[SP][paper] no text layer:', err.message);
      }
    }

    const result = await runInterpretation({
      documentId: doc._id,
      pages,
      textLayer,
      answers: Array.isArray(req.body?.answers) ? req.body.answers : [],
      actor: req.sp.actor,
    });

    return res.json(result);
  } catch (err) { return next(err); }
});

/**
 * Forget a learned rule.
 *
 * A rule that fires silently every month is the danger this design carries, so
 * undoing one has to be as easy as making it. Without this the only remedy for
 * a mis-click would be editing the database.
 */
router.delete('/rules/:id', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const gone = await PaperBrandRule.findByIdAndDelete(req.params.id).lean();
    if (!gone) return res.status(404).json({ error: 'Rule not found.' });
    return res.json({ deleted: true, brand: gone.brand, paperType: gone.paperType });
  } catch (err) { return next(err); }
});

/**
 * Fetch a stored object's bytes through its signed URL.
 *
 * The same helper `quotes.js` keeps, duplicated rather than shared: promoting
 * it would mean exporting from `lib/r2-storage.js`, which is outside the
 * supplier portal and used by CDC's other application. Six lines is a cheaper
 * price than a shared-module change nobody asked for.
 */
async function downloadKey(key) {
  if (!key) return null;
  const response = await fetch(await viewUrl(key));
  if (!response.ok) {
    throw new Error(`Could not read the stored file back (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export default router;
