/**
 * Purchase Bills routes — CDC Bills Digitization Platform
 *
 * Mounted at `/api/purchase-bills`. Self-contained from the contractor-po
 * `Bill` model (this module uses `PurchaseBill`).
 *
 * Routes:
 *   POST /cloudinary-sign       — return signed Cloudinary upload params
 *   POST /extract               — call OpenAI vision; return extracted JSON
 *   POST /check-duplicate       — early dedup lookup (3-way)
 *   POST /                      — aggregate + verify + save (409 on dedup)
 *   GET  /                      — search bills (text + filters)
 *   GET  /:id                   — single bill (full)
 *   PATCH /:id                  — manual field corrections + re-verify
 *   POST /:id/replace-image     — replace one slot page image (within 1 month of upload)
 *   POST /:id/approve           — manual approval with comment
 *   GET  /stats/dashboard       — dashboard counts
 *   POST /phash                 — server-side perceptual hash for an image URL
 */

import { Router } from 'express';
import * as XLSX from 'xlsx';
import { v2 as cloudinary } from 'cloudinary';
import { ensurePurchaseBillsReady, PurchaseBill } from './db-purchase-bills.js';
import { extractFromImage } from './lib/openai-vision.js';
import { aggregateAllSlots, buildCanonicalFields } from './lib/purchase-bill-aggregation.js';
import { runVerificationChecks, computeVerificationStatus } from './lib/purchase-bill-verification.js';
import { generatePhash, hammingDistance } from './lib/phash.js';
import {
  billScanPdfFilename,
  buildBillScanPdf,
  collectBillImageUrls,
} from './lib/purchase-bill-pdf.js';
import { extractAllSlotPages } from './lib/purchase-bill-extract-slots.js';
import { enqueue, setQueueModel } from './lib/extraction-queue.js';
import {
  requireCdcBillsAuth,
  requireCdcBillsAdmin,
  requireCdcBillsModify,
} from './middleware/cdc-bills-auth.js';
import { logActivity } from './lib/cdc-bills-activity.js';

const router = Router();

const SLOT_TYPES = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];
/** Image replacement allowed for 30 days after the bill was first uploaded. */
const IMAGE_REPLACE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isWithinImageReplaceWindow(uploadedAt) {
  if (!uploadedAt) return false;
  const uploaded = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(uploaded.getTime())) return false;
  return Date.now() - uploaded.getTime() <= IMAGE_REPLACE_WINDOW_MS;
}

// All purchase-bill data lives on the billing MongoDB (MONGODB_URI_Billing).
// Once connected, wire the queue model so background jobs can run.
let queueModelSet = false;
router.use(async (req, res, next) => {
  try {
    await ensurePurchaseBillsReady();
    if (!queueModelSet) {
      const { PurchaseBill: model } = await import('./db-purchase-bills.js');
      setQueueModel(model);
      queueModelSet = true;
    }
    next();
  } catch (err) {
    console.error('[purchase-bills] billing DB not available:', err?.message || err);
    res.status(503).json({
      error: err?.message || 'Billing database unavailable',
    });
  }
});
router.use(requireCdcBillsAuth);
// Cloudinary config — relies on env vars; safe to call again even if
// already configured by the main routes module.
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ---------- helpers ----------

function pad2(n) { return String(n).padStart(2, '0'); }

function cloudinaryFolder(slotType) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = pad2(now.getMonth() + 1);
  return `cdc-bills/${yyyy}/${mm}/${slotType}`;
}

/**
 * DB helpers injected into the verification engine for the async
 * duplicate checks. We define them once per request to capture the
 * "exclude this id" condition.
 */
function buildDbHelpers(excludeId) {
  const exclude = excludeId ? { _id: { $ne: excludeId } } : {};
  return {
    findExistingByDedupKey: async (key) => {
      if (!key) return null;
      return PurchaseBill.findOne({ bill_dedup_key: key, ...exclude }).lean();
    },
    findByTallyVoucher: async (no) => {
      if (!no) return null;
      return PurchaseBill.findOne({ tally_voucher_number: no, ...exclude }).lean();
    },
    findByImageHashCandidates: async (ph) => {
      if (!ph) return [];
      // We narrow by exact phash prefix to keep the candidate set small,
      // then let the caller do Hamming-distance comparison. For now we
      // pull all bills with a non-null phash uploaded in the last year.
      const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000);
      return PurchaseBill.find({
        invoice_image_phash: { $ne: null, $exists: true },
        uploaded_at: { $gte: oneYearAgo },
        ...exclude,
      }, '_id invoice_number invoice_image_phash').lean();
    },
    findSimilarBills: async (gstin, date, amount, tolerance, daysBack) => {
      if (!gstin || !date || amount == null) return [];
      const d = date instanceof Date ? date : new Date(date);
      const start = new Date(d.getTime() - daysBack * 86400 * 1000);
      return PurchaseBill.find({
        supplier_gstin: gstin,
        invoice_date: { $gte: start, $lte: new Date(d.getTime() + 86400 * 1000) },
        grand_total: { $gte: amount - tolerance, $lte: amount + tolerance },
        ...exclude,
      }, '_id invoice_number invoice_date grand_total supplier_name').lean();
    },
  };
}

/**
 * Run the verification engine for a (possibly unsaved) bill and update
 * the bill's status/check_results in-place.
 */
async function verifyAndStamp(bill) {
  const helpers = buildDbHelpers(bill._id);
  const results = await runVerificationChecks(bill, helpers);
  const { status, blocking, warning } = computeVerificationStatus(results);
  bill.check_results = results;
  bill.verification_status = status;
  bill.blocking_failures_count = blocking;
  bill.warning_failures_count = warning;
  return bill;
}

// ============================================================
// POST /cloudinary-sign
// Body: { slot_type: "tally_voucher" | "supplier_invoice" | "eway_bill" | "grn_sheet" }
// Returns signed params so the client can upload directly to Cloudinary.
// ============================================================
router.post('/cloudinary-sign', (req, res) => {
  try {
    const slotType = (req.body?.slot_type || '').toString();
    const allowed = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];
    if (!allowed.includes(slotType)) {
      return res.status(400).json({ error: `slot_type must be one of ${allowed.join(', ')}` });
    }
    if (!process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary not configured on the server.' });
    }
    const folder = cloudinaryFolder(slotType);
    const timestamp = Math.round(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      process.env.CLOUDINARY_API_SECRET,
    );
    return res.json({
      timestamp,
      signature,
      folder,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('[purchase-bills] cloudinary-sign error:', err);
    return res.status(500).json({ error: err.message || 'sign failed' });
  }
});

// ============================================================
// POST /extract
// Body: { cloudinary_url: string, slot_type: string }
// ============================================================
router.post('/extract', async (req, res) => {
  const cloudinaryUrl = req.body?.cloudinary_url;
  const slotType = req.body?.slot_type;
  if (!cloudinaryUrl || !slotType) {
    return res.status(400).json({ error: 'cloudinary_url and slot_type are required' });
  }
  try {
    const result = await extractFromImage(cloudinaryUrl, slotType);
    return res.json(result);
  } catch (err) {
    console.error('[purchase-bills] extract error:', err);
    return res.status(500).json({ error: err.message || 'extract failed' });
  }
});

// ============================================================
// POST /phash — generate perceptual hash for an image URL
// Body: { url: string }
// ============================================================
router.post('/phash', async (req, res) => {
  const url = req.body?.url;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const hash = await generatePhash(url);
    return res.json({ phash: hash });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'phash failed' });
  }
});

// ============================================================
// POST /check-duplicate
// Body: { supplier_gstin?, invoice_number?, tally_voucher_number?,
//         grand_total?, invoice_date? }
// ============================================================
router.post('/check-duplicate', async (req, res) => {
  try {
    const b = req.body || {};
    const supplier_gstin = b.supplier_gstin ? String(b.supplier_gstin).trim().toUpperCase() : null;
    const invoice_number = b.invoice_number ? String(b.invoice_number).trim() : null;
    const tally_voucher_number = b.tally_voucher_number ? String(b.tally_voucher_number).trim() : null;
    const grand_total = b.grand_total != null ? Number(b.grand_total) : null;
    const invoice_date = b.invoice_date ? new Date(b.invoice_date) : null;

    let exact_duplicate = null;
    let voucher_duplicate = null;
    let similar_matches = [];

    if (supplier_gstin && invoice_number) {
      const dedupKey = `${supplier_gstin}_${invoice_number.toUpperCase()}`;
      const hit = await PurchaseBill.findOne({ bill_dedup_key: dedupKey })
        .select('_id uploaded_by uploaded_at tally_voucher_number invoice_number');
      if (hit) {
        exact_duplicate = {
          bill_id: String(hit._id),
          uploaded_by: hit.uploaded_by,
          uploaded_at: hit.uploaded_at,
          voucher_no: hit.tally_voucher_number,
          invoice_no: hit.invoice_number,
        };
      }
    }

    if (tally_voucher_number) {
      const hit = await PurchaseBill.findOne({ tally_voucher_number })
        .select('_id uploaded_by uploaded_at tally_voucher_number invoice_number');
      if (hit) {
        voucher_duplicate = {
          bill_id: String(hit._id),
          uploaded_by: hit.uploaded_by,
          uploaded_at: hit.uploaded_at,
          voucher_no: hit.tally_voucher_number,
          invoice_no: hit.invoice_number,
        };
      }
    }

    if (supplier_gstin && invoice_date && grand_total != null && !Number.isNaN(grand_total)) {
      const ninetyDaysAgo = new Date(invoice_date.getTime() - 90 * 86400 * 1000);
      const ninetyAhead = new Date(invoice_date.getTime() + 86400 * 1000);
      const TOL = 10;
      const rows = await PurchaseBill.find({
        supplier_gstin,
        invoice_date: { $gte: ninetyDaysAgo, $lte: ninetyAhead },
        grand_total: { $gte: grand_total - TOL, $lte: grand_total + TOL },
      })
        .select('_id uploaded_by uploaded_at tally_voucher_number invoice_number grand_total invoice_date')
        .limit(5);
      similar_matches = rows
        .filter(r => !exact_duplicate || String(r._id) !== exact_duplicate.bill_id)
        .map(r => ({
          bill_id: String(r._id),
          uploaded_by: r.uploaded_by,
          uploaded_at: r.uploaded_at,
          voucher_no: r.tally_voucher_number,
          invoice_no: r.invoice_number,
          grand_total: r.grand_total,
          invoice_date: r.invoice_date,
        }));
    }

    return res.json({ exact_duplicate, voucher_duplicate, similar_matches });
  } catch (err) {
    console.error('[purchase-bills] check-duplicate error:', err);
    return res.status(500).json({ error: err.message || 'check-duplicate failed' });
  }
});

// ============================================================
// POST / — create a new bill
// Body: {
//   set_type: "grn" | "non_grn",
//   uploaded_by: string,
//   slots: { tally_voucher: { pages: [...] }, supplier_invoice: {...}, ... }
// }
// ============================================================
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const setType = body.set_type;
    if (!['grn', 'non_grn'].includes(setType)) {
      return res.status(400).json({ error: 'set_type must be "grn" or "non_grn"' });
    }
    if (!body.slots) {
      return res.status(400).json({ error: 'slots are required' });
    }

    // ---------------------------------------------------------------
    // Save immediately with status "pending_extraction" so the upload
    // user can move on. The background queue handles extraction +
    // verification asynchronously.
    // ---------------------------------------------------------------

    // Store raw slot pages (no extraction yet).
    const rawSlots = {};
    for (const [slotName, slot] of Object.entries(body.slots || {})) {
      rawSlots[slotName] = { pages: slot?.pages || [], aggregated_fields: {} };
    }

    const draft = {
      set_type: setType,
      uploaded_by: req.cdcBillsUser?.displayName || body.uploaded_by || 'anonymous',
      uploaded_at: new Date(),
      slots: rawSlots,
      verification_status: 'pending_extraction',
    };

    try {
      const saved = await PurchaseBill.create(draft);
      // Enqueue background extraction — returns immediately
      enqueue(saved._id);
      logActivity({ req, action: 'upload_bill', billId: saved._id, details: { set_type: setType } });
      return res.status(201).json({ _id: saved._id, verification_status: 'pending_extraction' });
    } catch (err) {
      if (err && err.code === 11000) {
        const keyPattern = err.keyPattern || {};
        return res.status(409).json({
          error: 'duplicate',
          conflict_field: keyPattern.bill_dedup_key ? 'bill_dedup_key' : 'tally_voucher_number',
        });
      }
      throw err;
    }
  } catch (err) {
    console.error('[purchase-bills] POST / error:', err);
    return res.status(500).json({ error: err.message || 'save failed' });
  }
});

/**
 * Parse a Tally voucher number like `PUR/70/26-27` into its FY year and
 * serial. Returns null for unparseable values.
 */
function parseVoucherNumber(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^.*?\/\s*(\d+)\s*\/\s*(\d{2})-(\d{2})\s*$/i);
  if (!m) return null;
  return { serial: parseInt(m[1], 10), fyStart: parseInt(m[2], 10) };
}

/**
 * Comparator for sorting bills by voucher number descending — newest FY
 * first, then highest serial first. Bills with no voucher (or unparseable)
 * fall to the end.
 */
function compareByVoucherDesc(a, b) {
  const pa = parseVoucherNumber(a.tally_voucher_number);
  const pb = parseVoucherNumber(b.tally_voucher_number);
  if (pa && pb) {
    if (pa.fyStart !== pb.fyStart) return pb.fyStart - pa.fyStart;
    return pb.serial - pa.serial;
  }
  if (pa) return -1;
  if (pb) return 1;
  return 0;
}

/**
 * Build a Mongo filter object from the standard search query params.
 * Shared between the paginated list (`GET /`) and the Excel export.
 */
function buildSearchFilter(query = {}) {
  const { q, supplier_gstin, set_type, status, from, to } = query;
  const filter = {};
  if (set_type && ['grn', 'non_grn'].includes(set_type)) filter.set_type = set_type;
  if (status) filter.verification_status = status;
  if (supplier_gstin) filter.supplier_gstin = String(supplier_gstin).trim().toUpperCase();
  if (from || to) {
    filter.invoice_date = {};
    if (from) filter.invoice_date.$gte = new Date(from);
    if (to) filter.invoice_date.$lte = new Date(to);
  }
  if (q && String(q).trim()) {
    const text = String(q).trim();
    const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { supplier_name: re },
      { supplier_gstin: re },
      { invoice_number: re },
      { tally_voucher_number: re },
      { grn_voucher_number: re },
      { po_numbers: re },
    ];
  }
  return filter;
}

// ============================================================
// GET /
// Query: q, supplier_gstin, set_type, status, from, to, page, limit
// ============================================================
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = buildSearchFilter(req.query);

    const [rows, total] = await Promise.all([
      PurchaseBill.find(filter)
        .select('-slots -check_results')
        .sort({ uploaded_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PurchaseBill.countDocuments(filter),
    ]);

    logActivity({ req, action: 'search_bills', details: { page, total } });
    return res.json({ rows, total, page, limit });
  } catch (err) {
    console.error('[purchase-bills] GET / error:', err);
    return res.status(500).json({ error: err.message || 'search failed' });
  }
});

// ============================================================
// GET /export.xlsx — Excel export of all rows matching the search filters
// ============================================================
router.get('/export.xlsx', requireCdcBillsAdmin, async (req, res) => {
  try {
    const filter = buildSearchFilter(req.query);
    // We fetch with a fast index-friendly sort and then re-sort in JS by
    // (FY DESC, serial DESC) because Mongo can't natively understand the
    // PUR/<serial>/<FY> structure of a voucher number string.
    const rows = await PurchaseBill.find(filter)
      .select('-slots -check_results')
      .sort({ uploaded_at: -1 })
      .limit(5000)
      .lean();
    rows.sort(compareByVoucherDesc);

    const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const isoMinute = (d) =>
      d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '';

    const sheet = rows.map((b) => ({
      'Uploaded At': isoMinute(b.uploaded_at),
      'Uploaded By': b.uploaded_by || '',
      'Set Type': b.set_type === 'grn' ? 'GRN' : 'Non-GRN',
      'Status': b.verification_status || '',
      'Tally Voucher': b.tally_voucher_number || '',
      'Tally Voucher Date': isoDate(b.tally_voucher_date),
      'Client Invoice': b.invoice_number || '',
      'Client Invoice Date': isoDate(b.invoice_date),
      'Supplier Name': b.supplier_name || '',
      'Supplier GSTIN': b.supplier_gstin || '',
      'CDC Unit': b.cdc_unit || '',
      'GRN Voucher': b.grn_voucher_number || '',
      'GRN Voucher Date': isoDate(b.grn_voucher_date),
      'PO Numbers': Array.isArray(b.po_numbers) ? b.po_numbers.join(', ') : '',
      'Eway Bill': b.eway_bill_number || '',
      'Vehicle': b.vehicle_number || '',
      'Tax Type': b.tax_type || '',
      'Taxable Value': b.taxable_value ?? '',
      'CGST': b.cgst_amount ?? '',
      'SGST': b.sgst_amount ?? '',
      'IGST': b.igst_amount ?? '',
      'Round Off': b.round_off ?? '',
      'Grand Total': b.grand_total ?? '',
    }));

    const ws = XLSX.utils.json_to_sheet(sheet);
    // Reasonable column widths so the file is usable without manual resizing
    ws['!cols'] = [
      { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 22 },
      { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 12 },
      { wch: 32 }, { wch: 18 }, { wch: 16 }, { wch: 16 },
      { wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 12 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bills');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="CDC-Bills-${ts}.xlsx"`);
    logActivity({ req, action: 'export_excel', details: { rowCount: rows.length } });
    return res.send(buf);
  } catch (err) {
    console.error('[purchase-bills] export error:', err);
    return res.status(500).json({ error: err.message || 'export failed' });
  }
});

// ============================================================
// GET /missing-vouchers
// Query: fy (required, YY-YY), prefix (default "PUR"), from, to
//
// Returns the set of Tally voucher serial numbers in [from..to] for the
// given FY that are NOT present in the database. Useful for catching
// bills the user forgot to upload.
//
// Voucher format expected: <PREFIX>/<SERIAL>/<FY>   e.g. PUR/70/26-27
// ============================================================
router.get('/missing-vouchers', requireCdcBillsAdmin, async (req, res) => {
  try {
    const fy = String(req.query.fy || '').trim();
    const prefix = String(req.query.prefix || 'PUR').trim();
    const from = parseInt(req.query.from, 10);
    const to = parseInt(req.query.to, 10);

    if (!fy) return res.status(400).json({ error: 'fy is required (e.g. 26-27)' });
    if (!/^\d{2}-\d{2}$/.test(fy)) {
      return res.status(400).json({ error: 'fy must be in YY-YY format (e.g. 26-27)' });
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      return res
        .status(400)
        .json({ error: 'from and to must be non-negative integers with from <= to' });
    }
    if (to - from > 50_000) {
      return res.status(400).json({ error: 'range too large (max 50,000 serials)' });
    }

    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedFy = fy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow optional whitespace and leading zeros in the serial.
    const re = new RegExp(`^\\s*${escapedPrefix}\\s*/\\s*(\\d+)\\s*/\\s*${escapedFy}\\s*$`, 'i');

    const docs = await PurchaseBill.find({
      tally_voucher_number: { $regex: re },
    })
      .select('_id tally_voucher_number')
      .lean();

    const presentMap = new Map(); // serial -> bill_id (first match wins)
    for (const d of docs) {
      const m = String(d.tally_voucher_number || '').match(re);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!presentMap.has(n)) presentMap.set(n, String(d._id));
    }

    const missing = [];
    const present = [];
    for (let n = from; n <= to; n++) {
      if (presentMap.has(n)) {
        present.push({ serial: n, bill_id: presentMap.get(n) });
      } else {
        missing.push(n);
      }
    }

    return res.json({
      fy,
      prefix,
      from,
      to,
      total_in_range: to - from + 1,
      present_count: present.length,
      missing_count: missing.length,
      missing,
      present,
    });
  } catch (err) {
    console.error('[purchase-bills] missing-vouchers error:', err);
    return res.status(500).json({ error: err.message || 'missing-vouchers failed' });
  }
});

// ============================================================
// GET /stats/dashboard
// ============================================================
router.get('/stats/dashboard', requireCdcBillsAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [today, thisWeek, thisMonth, byStatus, topByCount, topByValue, needsReview] = await Promise.all([
      PurchaseBill.countDocuments({ uploaded_at: { $gte: startOfDay } }),
      PurchaseBill.countDocuments({ uploaded_at: { $gte: startOfWeek } }),
      PurchaseBill.countDocuments({ uploaded_at: { $gte: startOfMonth } }),
      PurchaseBill.aggregate([
        { $group: { _id: '$verification_status', count: { $sum: 1 } } },
      ]),
      PurchaseBill.aggregate([
        { $match: { supplier_name: { $ne: null } } },
        { $group: { _id: '$supplier_name', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      PurchaseBill.aggregate([
        { $match: { supplier_name: { $ne: null }, grand_total: { $ne: null } } },
        { $group: { _id: '$supplier_name', total: { $sum: '$grand_total' } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ]),
      PurchaseBill.countDocuments({ verification_status: 'needs_review' }),
    ]);

    const statusCounts = { verified: 0, verified_with_warnings: 0, needs_review: 0, rejected: 0 };
    for (const row of byStatus) {
      if (row._id) statusCounts[row._id] = row.count;
    }

    return res.json({
      uploads: { today, this_week: thisWeek, this_month: thisMonth },
      by_status: statusCounts,
      pending_review: needsReview,
      top_suppliers_by_count: topByCount.map(s => ({ supplier_name: s._id, count: s.count })),
      top_suppliers_by_value: topByValue.map(s => ({ supplier_name: s._id, total: s.total })),
    });
  } catch (err) {
    console.error('[purchase-bills] dashboard error:', err);
    return res.status(500).json({ error: err.message || 'dashboard failed' });
  }
});

// ============================================================
// GET /:id/scan-pdf — merge all slot images into one PDF download
// ============================================================
router.get('/:id/scan-pdf', async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id).lean();
    if (!bill) return res.status(404).json({ error: 'not found' });

    const urls = collectBillImageUrls(bill);
    if (urls.length === 0) {
      return res.status(400).json({ error: 'No images on this bill' });
    }

    const pdfBytes = await buildBillScanPdf(urls);
    const filename = billScanPdfFilename(bill);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    logActivity({ req, action: 'download_scan_pdf', billId: bill._id });
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('[purchase-bills] scan-pdf error:', err);
    return res.status(500).json({ error: err.message || 'PDF generation failed' });
  }
});

// ============================================================
// GET /:id/status — lightweight poll endpoint used by the frontend
// to check when background extraction finishes
// ============================================================
router.get('/:id/status', async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id)
      .select('_id verification_status supplier_name invoice_number tally_voucher_number blocking_failures_count')
      .lean();
    if (!bill) return res.status(404).json({ error: 'not found' });
    return res.json(bill);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'status lookup failed' });
  }
});

// ============================================================
// GET /:id
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id).lean();
    if (!bill) return res.status(404).json({ error: 'not found' });
    logActivity({ req, action: 'view_bill', billId: bill._id });
    return res.json(bill);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'lookup failed' });
  }
});

// ============================================================
// PATCH /:id — partial update; re-runs verification
// Body: { canonical?: {...}, slots?: {...}, manually_overridden?: boolean }
// ============================================================
router.patch('/:id', requireCdcBillsModify, async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id);
    if (!bill) return res.status(404).json({ error: 'not found' });

    const body = req.body || {};

    if (body.slots) {
      // If caller already supplies aggregated_fields for each slot (manual
      // edits from the Extracted-data tab) we skip re-extraction and just
      // re-aggregate + re-verify. Otherwise we run the full extraction
      // pipeline for any page that has no extracted_fields yet.
      const alreadyAggregated = Object.values(body.slots).every(
        (s) => s && typeof s === 'object' && s.aggregated_fields && typeof s.aggregated_fields === 'object',
      );
      if (alreadyAggregated) {
        // Preserve existing per-page extracted_fields on the bill to keep
        // history, but treat the new aggregated_fields as the source of truth.
        const merged = {};
        for (const [slotName, slot] of Object.entries(body.slots)) {
          merged[slotName] = {
            pages: Array.isArray(slot.pages) && slot.pages.length
              ? slot.pages
              : (bill.slots?.[slotName]?.pages ?? []),
            aggregated_fields: slot.aggregated_fields ?? {},
          };
        }
        bill.slots = merged;
        bill.markModified('slots');
      } else {
        const slotsWithExtraction = await extractAllSlotPages(body.slots);
        const aggregatedSlots = aggregateAllSlots(slotsWithExtraction);
        bill.slots = aggregatedSlots;
        bill.markModified('slots');
      }
      const canonical = buildCanonicalFields(bill.slots, { setType: bill.set_type });
      Object.assign(bill, canonical);
    }
    if (body.canonical && typeof body.canonical === 'object') {
      // Allow direct overrides of canonical fields (manual correction)
      const allowed = [
        'tally_voucher_number', 'tally_voucher_date', 'tally_ref_bill_no', 'tally_ref_bill_date',
        'grn_voucher_number', 'grn_voucher_date',
        'invoice_number', 'invoice_date',
        'supplier_name', 'supplier_gstin', 'supplier_pan', 'supplier_state',
        'buyer_gstin', 'buyer_name', 'po_numbers',
        'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount',
        'round_off', 'grand_total', 'tax_type',
        'eway_bill_number', 'eway_bill_date', 'eway_valid_until', 'vehicle_number',
        'cdc_unit',
      ];
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(body.canonical, k)) {
          bill[k] = body.canonical[k];
        }
      }
      // Re-compute dedup key when supplier_gstin or invoice_number change.
      if (bill.supplier_gstin && bill.invoice_number) {
        bill.bill_dedup_key = `${String(bill.supplier_gstin).trim().toUpperCase()}_${String(bill.invoice_number).trim().toUpperCase()}`;
      }
    }

    if (typeof body.manually_overridden === 'boolean') {
      bill.manually_overridden = body.manually_overridden;
    }

    // Re-run verification.
    await verifyAndStamp(bill);

    try {
      await bill.save();
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: 'duplicate after edit', keyPattern: err.keyPattern });
      }
      throw err;
    }
    logActivity({ req, action: 'edit_bill', billId: bill._id });
    return res.json(bill);
  } catch (err) {
    console.error('[purchase-bills] PATCH error:', err);
    return res.status(500).json({ error: err.message || 'update failed' });
  }
});

// ============================================================
// POST /:id/replace-image — swap one page image, re-extract + re-verify
// Body: { slot_type, page_no, cloudinary_url, cloudinary_public_id, replaced_by? }
// Allowed only within 30 days of bill.uploaded_at.
// ============================================================
router.post('/:id/replace-image', requireCdcBillsModify, async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id);
    if (!bill) return res.status(404).json({ error: 'not found' });

    if (!isWithinImageReplaceWindow(bill.uploaded_at)) {
      return res.status(403).json({
        error: 'Image replacement is only allowed within 30 days of the original upload.',
      });
    }

    const body = req.body || {};
    const slotType = String(body.slot_type || '').trim();
    const pageNo = Number(body.page_no);
    const cloudinaryUrl = body.cloudinary_url ? String(body.cloudinary_url).trim() : '';
    const cloudinaryPublicId = body.cloudinary_public_id
      ? String(body.cloudinary_public_id).trim()
      : '';

    if (!SLOT_TYPES.includes(slotType)) {
      return res.status(400).json({ error: `slot_type must be one of ${SLOT_TYPES.join(', ')}` });
    }
    if (!Number.isInteger(pageNo) || pageNo < 1) {
      return res.status(400).json({ error: 'page_no must be a positive integer' });
    }
    if (!cloudinaryUrl || !cloudinaryPublicId) {
      return res.status(400).json({ error: 'cloudinary_url and cloudinary_public_id are required' });
    }

    const slot = bill.slots?.[slotType];
    const pages = Array.isArray(slot?.pages) ? slot.pages : [];
    const pageIdx = pages.findIndex((p) => Number(p.page_no) === pageNo);
    if (pageIdx < 0) {
      return res.status(404).json({ error: `No page ${pageNo} in slot ${slotType}` });
    }

    const now = new Date();
    pages[pageIdx] = {
      page_no: pageNo,
      cloudinary_url: cloudinaryUrl,
      cloudinary_public_id: cloudinaryPublicId,
      uploaded_at: now,
      extracted_fields: {},
      extraction_model: undefined,
      classification_passed: undefined,
      classification_confidence: undefined,
    };
    bill.slots[slotType] = { ...slot, pages };
    bill.markModified('slots');

    const slotsWithExtraction = await extractAllSlotPages(bill.slots);
    const aggregatedSlots = aggregateAllSlots(slotsWithExtraction);
    bill.slots = aggregatedSlots;
    bill.markModified('slots');

    const canonical = buildCanonicalFields(bill.slots, { setType: bill.set_type });
    Object.assign(bill, canonical);

    if (slotType === 'supplier_invoice' && pageNo === 1) {
      const firstPage = aggregatedSlots.supplier_invoice?.pages?.[0];
      if (firstPage?.cloudinary_url) {
        try {
          bill.invoice_image_phash = await generatePhash(firstPage.cloudinary_url);
        } catch (phashErr) {
          console.warn('[purchase-bills] replace-image phash failed:', phashErr?.message);
        }
      }
    }

    await verifyAndStamp(bill);

    try {
      await bill.save();
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: 'duplicate after image replacement', keyPattern: err.keyPattern });
      }
      throw err;
    }

    logActivity({ req, action: 'replace_image', billId: bill._id, details: { slotType, pageNo } });
    return res.json(bill);
  } catch (err) {
    console.error('[purchase-bills] replace-image error:', err);
    return res.status(500).json({ error: err.message || 'image replacement failed' });
  }
});

// ============================================================
// POST /:id/approve — manual approval; requires comment
// Body: { reviewer: string, comment: string }
// ============================================================
router.post('/:id/approve', requireCdcBillsModify, async (req, res) => {
  try {
    const { reviewer, comment } = req.body || {};
    if (!comment || !String(comment).trim()) {
      return res.status(400).json({ error: 'comment is required for manual approval' });
    }
    const bill = await PurchaseBill.findById(req.params.id);
    if (!bill) return res.status(404).json({ error: 'not found' });

    bill.manually_reviewed_by = req.cdcBillsUser?.displayName || reviewer || 'anonymous';
    bill.manually_reviewed_at = new Date();
    bill.review_comment = String(comment).trim();
    bill.manually_overridden = true;
    // Promote status: needs_review/verified_with_warnings -> approved (we
    // record this by setting verification_status to 'verified' but keep
    // manually_overridden=true so the UI can show the approval badge).
    bill.verification_status = 'verified';
    await bill.save();
    logActivity({ req, action: 'approve_bill', billId: bill._id });
    return res.json(bill);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'approval failed' });
  }
});

// ============================================================
// POST /:id/reprocess — re-queue a bill stuck in needs_review with no data
// ============================================================
router.post('/:id/reprocess', requireCdcBillsModify, async (req, res) => {
  try {
    const bill = await PurchaseBill.findById(req.params.id);
    if (!bill) return res.status(404).json({ error: 'not found' });
    bill.verification_status = 'pending_extraction';
    bill.extraction_error = null;
    bill.check_results = [];
    bill.blocking_failures_count = 0;
    bill.warning_failures_count = 0;
    await bill.save();
    enqueue(bill._id);
    logActivity({ req, action: 'reprocess_bill', billId: bill._id });
    return res.json({ _id: String(bill._id), verification_status: 'pending_extraction' });
  } catch (err) {
    console.error('[purchase-bills] reprocess error:', err);
    return res.status(500).json({ error: err.message || 'reprocess failed' });
  }
});

// ============================================================
// DELETE /:id — permanently delete a bill record
// ============================================================
router.delete('/:id', requireCdcBillsModify, async (req, res) => {
  try {
    const bill = await PurchaseBill.findByIdAndDelete(req.params.id);
    if (!bill) return res.status(404).json({ error: 'not found' });
    console.log(`[purchase-bills] deleted bill ${req.params.id} (${bill.invoice_number || 'no invoice #'})`);
    logActivity({ req, action: 'delete_bill', billId: req.params.id });
    return res.json({ deleted: true, _id: req.params.id });
  } catch (err) {
    console.error('[purchase-bills] DELETE error:', err);
    return res.status(500).json({ error: err.message || 'delete failed' });
  }
});

export default router;
