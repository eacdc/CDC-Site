/**
 * Interpreting an ink, coating, chemical, plate or consumable quote.
 *
 * The same two operations as the paper route — read the document, read it again
 * with answers — against the ink vocabulary and the ink gate. The one-shot
 * extraction route at `/quotes/:id/extract` is untouched and still serves every
 * other material.
 *
 * "One category at a time" is what this looks like when it reaches the routing
 * table: two sibling paths, no shared abstraction invented before there was
 * anything to share.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import { ensureSupplierPortalReady, QuoteDocument, InkTermRule } from '../db/mongo.js';
import { viewUrl } from '../../lib/r2-storage.js';
import { pdfPageTexts, looksLikePdf } from '../services/extraction/pdf-text.js';
import { pdfPageImages } from '../services/extraction/pdf-render.js';
import { runInkInterpretation, knownTermsFor } from '../services/ink/ink-quotes.js';
import {
  MATERIAL_CLASSES, CHEMISTRIES, INK_ROLES, COLOURS, COATING_FINISHES, CHEMICAL_FUNCTIONS, RATE_UOMS,
} from '../config/ink-vocabulary.js';

const router = Router();
router.use(requireAuth);

/**
 * The values a reviewer picks from when answering.
 *
 * All of them in one call rather than one endpoint per field. A question about
 * chemistry and a question about colour arrive on the same screen, and two
 * round trips to populate one panel is two chances for half of it to be empty.
 */
router.get('/vocabulary', (req, res) => res.json({
  materialClass: MATERIAL_CLASSES.map(pick),
  chemistry: CHEMISTRIES.map(pick),
  role: INK_ROLES.map(pick),
  colour: COLOURS.map((c) => ({ ...pick(c), family: c.family })),
  finish: COATING_FINISHES.map(pick),
  chemicalFunction: CHEMICAL_FUNCTIONS.map(pick),
  rateUom: RATE_UOMS.map((u) => ({ canonical: u, label: u })),
}));

/** What is already known, so a reviewer can see what will not be asked. */
router.get('/terms', async (req, res, next) => {
  try {
    res.json(await knownTermsFor(req.query.supplierGroupId || null));
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
      layout.

      LAYOUT MATTERS MORE HERE THAN IT DID FOR PAPER. On a dealer's quotation the
      manufacturer and the rate unit are stated once in a section heading and
      never on a row — "DIC UV INK / RATE PER KGS", then twenty rows that say
      neither. Only the image reliably says which heading a row sits under, and
      without that every one of those rows loses its unit.

      A PDF IS NOT AN IMAGE. Handing a signed PDF URL to a vision model gets
      `400 You uploaded an unsupported image`; the formats accepted are png,
      jpeg, gif and webp. Every PDF is rasterised first.
    */
    const isPdf = looksLikePdf({ mimeType: doc.mimeType, originalFilename: doc.originalFilename });
    let pages = [];
    let textLayer = null;

    if (isPdf) {
      const bytes = await downloadKey(doc.storageKey);

      try {
        textLayer = await pdfPageTexts(bytes);
      } catch (err) {
        // A scan carries no text layer, and that is not a failure — the images
        // hold everything. Losing the layer is worth a log, not a 500.
        console.warn('[SP][ink] no text layer:', err.message);
      }

      const rendered = await pdfPageImages(bytes).catch((err) => {
        console.warn('[SP][ink] could not render pages:', err.message);
        return null;
      });
      pages = rendered?.pages || [];

      if (!pages.length && !textLayer) {
        return res.status(422).json({
          error: 'This PDF could not be read — it has no text layer and its pages '
            + 'could not be rendered. Upload the pages as images instead.',
        });
      }
    } else {
      pages = await Promise.all(keys.map(async (key, i) => ({
        url: await viewUrl(key), pageNo: i + 1, mimeType: doc.mimeType,
      })));
    }

    const result = await runInkInterpretation({
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
 * undoing one has to be as easy as making it. It matters more here than it did
 * for paper, because some of these rules were proposed by a web search and
 * accepted with one click — the click that is easy to make is the one that most
 * needs an undo.
 */
router.delete('/rules/:id', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const gone = await InkTermRule.findByIdAndDelete(req.params.id).lean();
    if (!gone) return res.status(404).json({ error: 'Rule not found.' });
    return res.json({
      deleted: true, subject: gone.subject, field: gone.field, value: gone.value,
    });
  } catch (err) { return next(err); }
});

function pick(entry) {
  return { canonical: entry.canonical, label: entry.label || entry.canonical };
}

/**
 * Fetch a stored object's bytes through its signed URL.
 *
 * Duplicated from the paper route rather than shared: promoting it would mean
 * exporting from `lib/r2-storage.js`, which is outside the supplier portal and
 * used by CDC's other application. Six lines is a cheaper price than a
 * shared-module change nobody asked for.
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
