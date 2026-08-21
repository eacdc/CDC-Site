/**
 * Quote upload, extraction, review and approval.
 *
 * The review step is not a formality. Extraction is fast and mostly right, and
 * "mostly right" written silently into a rate table is worse than slow — a
 * wrong rate is invisible until someone buys against it.
 */

import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import {
  ensureSupplierPortalReady, QuoteDocument, QuoteLine, SupplierGroup,
  SupplierItem, UomNormalisation, AuditLog,
} from '../db/mongo.js';
import {
  sha256Of, checkDuplicate, extractDocument, approveDocument,
  runMagnitudeChecks, normaliseLine, confirmIdentification, reidentifyDocument, setDocumentUom,
  deleteDocument, purgeAllQuotes, paperInterpretationCheck,
  requoteFromDocument,
} from '../services/quotes.js';

/**
 * Whether this request may delete live rates.
 *
 * Roles live at `req.sp.user.roles`, and ADMIN passes everything — the same
 * rule `requireRole` applies. Reading them from the wrong place would have
 * silently denied force to everyone, which reads as "the button is broken".
 */
function canForce(req) {
  const held = req.sp?.user?.roles || [];
  return held.includes('ADMIN') || held.includes('APPROVER');
}
import { matchDocument } from '../services/matching.js';
import { uomOverridesFrom } from '../lib/uom.js';
import { normaliseName } from '../lib/text.js';
import { createUploadUrl, viewUrl, uploadBuffer } from '../../lib/r2-storage.js';
import { generatePhash } from '../../lib/phash.js';

const router = Router();
router.use(requireAuth);

// Worksheets are parsed in-process from the buffer, so they arrive as a normal
// multipart upload rather than through the presigned path.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Presigned PUT straight to storage, for images and PDFs. */
router.post('/upload-url', async (req, res, next) => {
  try {
    const { contentType, contentLength } = req.body || {};
    const result = await createUploadUrl({
      folder: 'supplier-portal/quotes', contentType, contentLength,
    });
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * Register an uploaded document.
 *
 * Nothing here is required but the file. Who sent it, which plant it prices,
 * when it takes effect and on what terms are all printed on the page, and
 * extraction reads them — asking the uploader first made them do the
 * extractor's job, slowly and with a dropdown of eighty supplier names to pick
 * the wrong one from.
 *
 * Anything the caller does send is kept and wins over what is read: an upload
 * from the supplier portal itself already knows whose quote it is.
 *
 * The duplicate check runs here, before extraction, so a re-upload costs
 * nothing but a hash comparison.
 */
router.post('/', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const {
      supplierGroupId, docType, storageKey, pageKeys = [], originalFilename,
      mimeType, sha256, plantScope, plantScopeBasis, cdcEntityScope,
      quoteStrength, ledgerRef, supersedesDocId, isPartialUpdate,
    } = req.body || {};

    if (!storageKey && !pageKeys.length) {
      return res.status(400).json({ error: 'No uploaded file was referenced.' });
    }

    if (supplierGroupId) {
      const group = await SupplierGroup.findById(supplierGroupId).lean();
      if (!group) return res.status(404).json({ error: 'Supplier group not found.' });
    }

    // Perceptual hashes are computed per page so a rescan of one page of a
    // multi-page price list is still recognised.
    const perceptualHashes = [];
    for (const key of [storageKey, ...pageKeys].filter(Boolean)) {
      try {
        const hash = await generatePhash(await viewUrl(key));
        if (hash) perceptualHashes.push(hash);
      } catch (err) {
        console.warn('[SP][quotes] could not hash page:', err.message);
      }
    }

    const dedup = await checkDuplicate({ sha256, perceptualHashes });
    if (dedup.isBlocked) {
      return res.status(409).json({
        error: 'This document has already been uploaded.',
        checks: dedup.checks,
        existingDocumentId: dedup.exactMatch?._id,
      });
    }

    const doc = await QuoteDocument.create({
      supplierGroupId: supplierGroupId || null,
      ledgerRef: ledgerRef || undefined,
      docType: docType || docTypeFor({ mimeType, originalFilename }),
      quoteStrength: quoteStrength || 'FIRM',
      storageKey,
      pageKeys,
      originalFilename,
      mimeType,
      sha256,
      perceptualHashes,
      plantScope: plantScope || [],
      // If the uploader did not state a plant scope, that fact is recorded
      // rather than papered over — the review screen asks.
      plantScopeBasis: plantScopeBasis || (plantScope?.length ? 'STATED' : 'ASSUMED'),
      cdcEntityScope: cdcEntityScope || 'ALL',
      supersedesDocId: supersedesDocId || null,
      isPartialUpdate: Boolean(isPartialUpdate),
      status: 'UPLOADED',
      uploadedBy: req.sp.actor,
      checks: dedup.checks,
    });

    return res.status(201).json({ document: doc, checks: dedup.checks });
  } catch (err) { return next(err); }
});

/**
 * A document type from the file itself.
 *
 * A guess, and a replaceable one — the review screen shows it and a reviewer
 * can change it. It exists so that "upload the file" really is the whole
 * interaction: docType gates nothing except which extraction path runs, and
 * getting it wrong on a PDF costs a dropdown change, not a re-upload.
 */
function docTypeFor({ mimeType, originalFilename }) {
  const text = `${mimeType || ''} ${originalFilename || ''}`;
  if (/spreadsheet|excel|\.xlsx?$|\.csv$/i.test(text)) return 'WORKSHEET';
  if (/\.eml$|\.msg$|message\/rfc822/i.test(text)) return 'EMAIL';
  if (/proforma|\bpi\b/i.test(text)) return 'PROFORMA_INVOICE';
  return 'PRICE_LIST';
}

/**
 * Upload a quote in one call: store it, read it, identify it.
 *
 * The file comes through the API rather than going straight to storage on a
 * presigned URL. That costs a hop through this process — 25 MB at CDC's volume
 * is nothing — and buys three things:
 *
 *  - **It works without configuring CORS on the bucket.** A browser PUT to
 *    `*.r2.cloudflarestorage.com` is a cross-origin request and fails with a
 *    bare "Load failed" until the bucket's CORS policy names the frontend
 *    origin. That is a Cloudflare dashboard setting nobody remembers, and its
 *    failure mode tells the user nothing.
 *  - **The buffer is already here.** A worksheet is parsed from it, and a PDF's
 *    text layer is read from it, with no download back out of storage.
 *  - **One request, one answer.** The client uploads and gets back what the
 *    document turned out to be, instead of orchestrating three calls and
 *    holding partial state if one of them fails.
 */
async function uploadQuoteFile(req, res, next) {
  try {
    await ensureSupplierPortalReady();
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const sha256 = sha256Of(req.file.buffer);
    const dedup = await checkDuplicate({ sha256 });
    if (dedup.isBlocked) {
      return res.status(409).json({
        error: 'This document has already been uploaded.',
        checks: dedup.checks,
        existingDocumentId: dedup.exactMatch?._id,
      });
    }

    // A prior upload of this exact file that never produced anything is not a
    // duplicate to preserve — it is a failed attempt at the thing being
    // retried. Clearing it keeps the list showing work, not wreckage.
    if (dedup.supersedesFailed) {
      await deleteDocument({
        documentId: dedup.supersedesFailed,
        actor: req.sp.actor,
        reason: 'Replaced by a re-upload of the same file after the first attempt failed',
      }).catch((err) => console.warn('[SP][quotes] could not clear the failed upload:', err.message));
    }

    const stored = await uploadBuffer({
      folder: 'supplier-portal/quotes',
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });
    const storageKey = stored.key || stored;

    const doc = await QuoteDocument.create({
      supplierGroupId: req.body.supplierGroupId || null,
      docType: req.body.docType
        || docTypeFor({ mimeType: req.file.mimetype, originalFilename: req.file.originalname }),
      storageKey,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      sha256,
      plantScope: req.body.plantScope ? JSON.parse(req.body.plantScope) : [],
      plantScopeBasis: req.body.plantScope ? 'STATED' : 'ASSUMED',
      status: 'UPLOADED',
      uploadedBy: req.sp.actor,
      checks: dedup.checks,
    });

    const result = await extractDocument(doc._id, {
      site: req.sp.site,
      buffer: req.file.buffer,
      // Images still need a URL the vision provider can fetch. A PDF does not:
      // its text is read from the buffer above.
      pages: [{ url: await viewUrl(storageKey), pageNo: 1, mimeType: req.file.mimetype }],
      hints: { priceColumn: req.body.priceColumn, sheetName: req.body.sheetName },
    });

    return res.status(201).json({ documentId: doc._id, ...result });
  } catch (err) { return next(err); }
}

const uploadGuards = [requireSite, requireRole('BUYER', 'APPROVER'), upload.single('file')];

router.post('/file', ...uploadGuards, uploadQuoteFile);
// The same handler under its old name. `/worksheet` predates this route
// handling every format, and a deployed frontend may still be calling it.
router.post('/worksheet', ...uploadGuards, uploadQuoteFile);

/**
 * Run extraction on a registered document, then identify it.
 *
 * The two are one call because they are one question — "what is this?" — and
 * splitting them would let a client stop halfway and file a document with
 * lines but no supplier.
 */
router.post('/:id/extract', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const doc = await QuoteDocument.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Quote document not found.' });
    if (doc.status === 'APPROVED') {
      return res.status(409).json({
        error: 'This quote is approved and its rates are written. Re-extracting would '
          + 'replace the lines those rates came from.',
      });
    }

    const keys = [doc.storageKey, ...(doc.pageKeys || [])].filter(Boolean);
    if (!keys.length) {
      return res.status(409).json({ error: 'This document has no stored file to re-read.' });
    }

    const pages = await Promise.all(keys.map(async (key, i) => ({
      url: await viewUrl(key), pageNo: i + 1, mimeType: doc.mimeType,
    })));

    // A worksheet is parsed from bytes, not from a URL. On the upload path the
    // buffer is already in hand; on a re-extract it has to come back out of
    // storage, and without this a re-run of a worksheet fails on the one thing
    // a re-run is for.
    const isWorksheet = doc.docType === 'WORKSHEET'
      || /spreadsheet|excel|\.xlsx?$|\.csv$/i.test(`${doc.mimeType || ''} ${doc.originalFilename || ''}`);
    const buffer = isWorksheet ? await downloadKey(doc.storageKey) : null;

    const result = await extractDocument(doc._id, {
      site: req.sp.site,
      pages,
      buffer,
      hints: { ...(req.body || {}) },
    });
    return res.json(result);
  } catch (err) { return next(err); }
});

/**
 * Read an approved quote's file again as a new document that supersedes it.
 *
 * The way out of a dead end: an approved quote cannot be deleted, because its
 * rates are live, and re-uploading the identical file is caught as a duplicate
 * of that same approved quote. Without this, the only way to re-read a quote
 * with a better extractor was to have never approved it.
 *
 * The original is untouched. Approving the replacement closes it, through the
 * same path a real re-quote from the supplier would take.
 */
router.post('/:id/requote', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const { documentId, supersedes } = await requoteFromDocument({
      documentId: req.params.id,
      actor: req.sp.actor,
      reason: req.body?.reason || null,
    });

    const doc = await QuoteDocument.findById(documentId).lean();
    const keys = [doc.storageKey, ...(doc.pageKeys || [])].filter(Boolean);
    const pages = await Promise.all(keys.map(async (key, i) => ({
      url: await viewUrl(key), pageNo: i + 1, mimeType: doc.mimeType,
    })));

    const isWorksheet = doc.docType === 'WORKSHEET'
      || /spreadsheet|excel|\.xlsx?$|\.csv$/i.test(`${doc.mimeType || ''} ${doc.originalFilename || ''}`);
    const buffer = isWorksheet ? await downloadKey(doc.storageKey) : null;

    const result = await extractDocument(documentId, {
      site: req.sp.site,
      pages,
      buffer,
      hints: { ...(req.body || {}) },
    });

    return res.status(201).json({ documentId, supersedes, ...result });
  } catch (err) { return next(err); }
});

/** Fetch a stored object's bytes through its signed URL. */
async function downloadKey(key) {
  if (!key) return null;
  const response = await fetch(await viewUrl(key));
  if (!response.ok) {
    throw new Error(`Could not read the stored file back (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Delete a quote document.
 *
 * Approved quotes are refused by the service — their rates are live. Anything
 * else is a mistake somebody should be able to undo, rather than a permanent
 * row in a list everyone has to read past.
 */
/**
 * Delete every quote and everything derived from it.
 *
 * Registered before `/:id` — Express matches in order, and "purge-all" would
 * otherwise be read as a document id. APPROVER-only: it removes rate history,
 * which is what the comparison and the PO check answer from.
 */
router.post('/purge-all', requireRole('APPROVER'), async (req, res, next) => {
  try {
    // A typed confirmation rather than a boolean. The client cannot send this
    // by accident, and neither can a stray request.
    if (req.body?.confirm !== 'DELETE ALL QUOTES') {
      return res.status(400).json({
        error: 'To delete every quote, send confirm: "DELETE ALL QUOTES".',
      });
    }
    return res.json(await purgeAllQuotes({
      actor: req.sp.actor,
      reason: req.body?.reason,
      includeMappings: req.body?.includeMappings === true,
    }));
  } catch (err) { return next(err); }
});

router.delete('/:id', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const result = await deleteDocument({
      documentId: req.params.id,
      actor: req.sp.actor,
      reason: req.body?.reason,
      // Removing live rates is an APPROVER decision, not a BUYER one.
      force: req.body?.force === true && canForce(req),
    });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

/**
 * Confirm or correct what the document was read as.
 *
 * Every field is optional. Sending `{}` accepts the proposal as it stands,
 * which is the common case and is the point of the whole flow.
 */
router.patch('/:id/identification', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const doc = await confirmIdentification({
      documentId: req.params.id,
      actor: req.sp.actor,
      ...(req.body || {}),
    });
    return res.json({ document: doc, checks: doc.checks });
  } catch (err) { return next(err); }
});

/**
 * Re-run identification without re-extracting.
 *
 * Worth having on its own: a reviewer who has just created the missing
 * supplier group wants the document matched against it, and paying for a
 * second vision call to find that out would be absurd.
 */
router.post('/:id/identify', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const result = await reidentifyDocument({ documentId: req.params.id, site: req.sp.site });
    return res.json(result);
  } catch (err) { return next(err); }
});

/**
 * Set the unit for a document whose rows print none, and re-normalise its
 * rates. Board price lists routinely omit it — "RATE FOR 90 DAYS" over figures
 * that are per tonne — and one answer settles every row.
 */
router.patch('/:id/uom', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const { uom } = req.body || {};
    if (!uom?.trim()) return res.status(400).json({ error: 'A unit is required.' });
    const result = await setDocumentUom({
      documentId: req.params.id, uom, actor: req.sp.actor,
    });
    return res.json(result);
  } catch (err) { return next(err); }
});

/** The review payload: document, lines and the supplier's existing items. */
router.get('/:id', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const doc = await QuoteDocument.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Quote document not found.' });

    const [lines, group] = await Promise.all([
      QuoteLine.find({ quoteDocumentId: doc._id, supersededByLineId: null }).sort({ lineNo: 1 }).lean(),
      SupplierGroup.findById(doc.supplierGroupId).lean(),
    ]);

    /*
      The paper check is computed rather than stored, because its truth changes
      when interpretation succeeds — an event that touches neither extraction
      nor the stored checks. Appending it here means the review screen shows the
      same reason the approve endpoint will give, instead of a button that
      refuses without saying why.
    */
    const paperCheck = paperInterpretationCheck(doc);

    const keys = [doc.storageKey, ...(doc.pageKeys || [])].filter(Boolean);
    return res.json({
      document: paperCheck
        ? { ...doc, checks: [...(doc.checks || []), paperCheck] }
        : doc,
      supplierGroup: group,
      lines,
      pageUrls: await Promise.all(keys.map((key) => viewUrl(key))),
    });
  } catch (err) { return next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { status, supplierGroupId, limit = 50, skip = 0 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (supplierGroupId) filter.supplierGroupId = supplierGroupId;

    const [documents, total] = await Promise.all([
      QuoteDocument.find(filter).sort({ uploadedAt: -1 })
        .skip(Number(skip)).limit(Math.min(Number(limit), 200)).lean(),
      QuoteDocument.countDocuments(filter),
    ]);
    res.json({ documents, total });
  } catch (err) { next(err); }
});

/**
 * Correct an extracted line.
 *
 * The original is superseded rather than overwritten, so what the document
 * actually said stays recoverable. A reviewer's correction and a bad
 * extraction look identical afterwards otherwise.
 */
router.patch('/:id/lines/:lineId', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const original = await QuoteLine.findOne({
      _id: req.params.lineId, quoteDocumentId: req.params.id,
    }).lean();
    if (!original) return res.status(404).json({ error: 'Quote line not found.' });

    const raw = { ...original.raw, ...(req.body?.raw || {}) };
    const overrides = uomOverridesFrom(await UomNormalisation.find({}).lean());
    const normalised = normaliseLine(raw, overrides);

    const replacement = await QuoteLine.create({
      quoteDocumentId: original.quoteDocumentId,
      lineNo: original.lineNo,
      raw,
      normalised,
      specKey: req.body?.specKey || original.specKey,
      supplierItemId: req.body?.supplierItemId ?? original.supplierItemId,
      extractionConfidence: 1,
      flags: [...normalised.flags, 'HUMAN_CORRECTED'],
      // Corrections clear the extraction's own checks; they were raised
      // against text that no longer stands.
      checks: [],
      editedFromLineId: original._id,
      sourceCrop: original.sourceCrop,
    });

    await QuoteLine.updateOne({ _id: original._id }, { $set: { supersededByLineId: replacement._id } });

    await AuditLog.create({
      action: 'QUOTE_LINE_CORRECTED',
      entity: 'quoteLine',
      entityId: String(original._id),
      actor: req.sp.actor,
      before: original.raw,
      after: raw,
      reason: req.body?.reason || null,
    });

    return res.json(replacement);
  } catch (err) { return next(err); }
});

/**
 * Attach a supplier item identity to a line.
 *
 * This is what makes the mapping permanent: the identity belongs to the
 * supplier's catalogue, not to this month's document.
 */
router.post('/:id/lines/:lineId/supplier-item', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const line = await QuoteLine.findById(req.params.lineId);
    if (!line) return res.status(404).json({ error: 'Quote line not found.' });

    const doc = await QuoteDocument.findById(line.quoteDocumentId).lean();
    // A supplier item belongs to a supplier's catalogue. Creating one before
    // the supplier is settled would put it in nobody's.
    if (!doc?.supplierGroupId) {
      return res.status(409).json({
        error: 'Confirm which supplier sent this quote before mapping its lines.',
      });
    }
    const productName = req.body?.supplierProductName || line.raw?.productName;
    const productCode = req.body?.supplierProductCode || line.raw?.productCode || null;
    if (!productName) return res.status(400).json({ error: 'A supplier product name is required.' });

    // Matched on code where the supplier gives one, on the normalised name
    // where they do not.
    const query = productCode
      ? { supplierGroupId: doc.supplierGroupId, supplierProductCode: productCode }
      : { supplierGroupId: doc.supplierGroupId, normalisedName: normaliseName(productName) };

    const existing = await SupplierItem.findOne(query);
    let supplierItem = existing;

    if (existing) {
      // A second sighting promotes a PROVISIONAL item: it is part of the
      // supplier's real catalogue rather than a one-off project line.
      const update = {
        $set: { lastSeenAt: new Date(), supplierProductName: productName },
        $addToSet: { seenInDocIds: doc._id },
      };
      if (existing.status === 'PROVISIONAL'
          && !existing.seenInDocIds.some((id) => String(id) === String(doc._id))) {
        update.$set.status = 'ACTIVE';
      }
      await SupplierItem.updateOne({ _id: existing._id }, update);
      supplierItem = await SupplierItem.findById(existing._id);
    } else {
      supplierItem = await SupplierItem.create({
        supplierGroupId: doc.supplierGroupId,
        supplierProductCode: productCode,
        supplierProductName: productName,
        normalisedName: normaliseName(productName),
        defaultUom: line.normalised?.uom || null,
        defaultPackQty: line.normalised?.packQty || null,
        defaultPackUom: line.normalised?.packUom || null,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        seenInDocIds: [doc._id],
        status: 'PROVISIONAL',
      });
    }

    line.supplierItemId = supplierItem._id;
    await line.save();

    return res.json({ line, supplierItem });
  } catch (err) { return next(err); }
});

/** Run the matching engine across the document's lines. */
router.post('/:id/match', requireSite, requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const doc = await QuoteDocument.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Quote document not found.' });

    // Matching is scoped to what this supplier has historically supplied, so
    // without a supplier it would compare an ink quote against the whole item
    // master. Confirming identification first is not a formality here.
    if (!doc.supplierGroupId) {
      return res.status(409).json({
        error: 'Confirm which supplier sent this quote before matching its lines.',
        checks: (doc.checks || []).filter((c) => c.code === 'EXT009'),
      });
    }

    const group = await SupplierGroup.findById(doc.supplierGroupId).lean();
    const result = await matchDocument({
      site: req.sp.site,
      documentId: doc._id,
      group,
      actor: req.sp.actor,
      allowLlm: req.body?.allowLlm !== false,
    });

    // The magnitude guard runs after matching, because it compares against the
    // last-paid rate of the item a line was just matched to.
    const magnitudeChecks = await runMagnitudeChecks(req.sp.site, doc._id);

    return res.json({ ...result, magnitudeChecks });
  } catch (err) { return next(err); }
});

/**
 * Approve, and write rate history.
 *
 * A blocking check cannot be overridden. A warning can, with a reason — the
 * point of the override is the sentence, not the click.
 */
router.post('/:id/approve', requireRole('APPROVER'), async (req, res, next) => {
  try {
    const result = await approveDocument({
      documentId: req.params.id,
      actor: req.sp.actor,
      overrides: req.body?.overrides || [],
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/:id/reject', requireRole('BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const doc = await QuoteDocument.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'REJECTED' } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Quote document not found.' });

    await AuditLog.create({
      action: 'QUOTE_REJECTED',
      entity: 'quoteDocument',
      entityId: req.params.id,
      actor: req.sp.actor,
      reason: req.body?.reason || null,
    });

    return res.json(doc);
  } catch (err) { return next(err); }
});

export default router;
