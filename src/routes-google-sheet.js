/**
 * Google Sheet Data API
 * Fetches data from MSSQL and returns 2D arrays suitable for Google Sheets.
 * All endpoints accept ?database=KOL|AHM (default: KOL).
 */
import { Router } from 'express';
import { getPool, getLongQueryPool, LONG_REQUEST_TIMEOUT_MS } from './db.js';
import sql from 'mssql';
import { ensurePurchaseBillsReady, PurchaseBill } from './db-purchase-bills.js';

const router = Router();

const DEFAULT_DATABASE = 'KOL';
const ALLOWED_DATABASES = ['KOL', 'AHM'];

function getDbFromQuery(req) {
  const db = (req.query?.database || DEFAULT_DATABASE).toString().trim().toUpperCase();
  if (!ALLOWED_DATABASES.includes(db)) {
    return null;
  }
  return db;
}

/**
 * Formats a Date object as dd/MM/yyyy (no time component).
 * @param {Date} d
 * @returns {string}
 */
function formatDateDDMMYYYY(d) {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Converts a recordset (array of row objects) into a 2D array for Google Sheets.
 * First row = column names (headers), following rows = data.
 * Date values from MSSQL are formatted as dd/MM/yyyy strings.
 * @param {Array<Object>} recordset - Rows from MSSQL
 * @returns {Array<Array>} 2D array [headers, ...dataRows]
 */
function recordsetTo2DArray(recordset) {
  if (!recordset || recordset.length === 0) {
    return [];
  }
  const headers = Object.keys(recordset[0]);
  const rows = recordset.map(row =>
    headers.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      if (val instanceof Date) return formatDateDDMMYYYY(val);
      return val;
    })
  );
  return [headers, ...rows];
}

function formatDateYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** End = yesterday, start = 6 months before end (inclusive range for reports). */
function getLastSixMonthsDateRange() {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 6);
  return {
    startDateStr: formatDateYYYYMMDD(startDate),
    endDateStr: formatDateYYYYMMDD(endDate),
  };
}

/**
 * Parses a yyyy-MM-dd string into a Date. Returns null on invalid input.
 * @param {string|undefined} s
 * @returns {Date|null}
 */
function parseDateYYYYMMDD(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/**
 * GET /api/google-sheet/process-otif?database=KOL
 * Runs dbo.GetProcessOTIF with StartDate = 6 months ago, EndDate = yesterday.
 * Returns 2D array (headers + rows) for Google Sheets.
 */
router.get('/google-sheet/process-otif', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  // const endDate = new Date();
  // endDate.setDate(endDate.getDate() - 1); // yesterday
  // const startDate = new Date(endDate);
  // startDate.setMonth(startDate.getMonth() - 6); // 6 months before yesterday

  // const formatDate = (d) => {
  //   const y = d.getFullYear();
  //   const m = String(d.getMonth() + 1).padStart(2, '0');
  //   const day = String(d.getDate()).padStart(2, '0');
  //   return `${y}-${m}-${day}`;
  // };
  // const startDateStr = formatDate(startDate);
  // const endDateStr = formatDate(endDate);

  try {
    const pool = await getPool(db);
    const request = pool.request();
    // request.input('StartDate', sql.VarChar(20), startDateStr);
    // request.input('EndDate', sql.VarChar(20), endDateStr);
    const result = await request.execute('dbo.GetProcessOTIFv3');
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    return res.json({ data });
  } catch (e) {
    console.error('[google-sheet] process-otif failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch Process OTIF' });
  }
});



router.get('/google-sheet/process-otif2', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  // const endDate = new Date();
  // endDate.setDate(endDate.getDate() - 1); // yesterday
  // const startDate = new Date(endDate);
  // startDate.setMonth(startDate.getMonth() - 6); // 6 months before yesterday

  // const formatDate = (d) => {
  //   const y = d.getFullYear();
  //   const m = String(d.getMonth() + 1).padStart(2, '0');
  //   const day = String(d.getDate()).padStart(2, '0');
  //   return `${y}-${m}-${day}`;
  // };
  // const startDateStr = formatDate(startDate);
  // const endDateStr = formatDate(endDate);

  try {
    const pool = await getPool(db);
    const request = pool.request();
    // request.input('StartDate', sql.VarChar(20), startDateStr);
    // request.input('EndDate', sql.VarChar(20), endDateStr);
    const result = await request.execute('dbo.GetProcessOTIFv2');
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    return res.json({ data });
  } catch (e) {
    console.error('[google-sheet] process-otif failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch Process OTIF' });
  }
});

/**
 * GET /api/google-sheet/job-gp-per-impression?database=KOL
 * Runs rpt_job_gp_per_impression_v11 with StartDate = 6 months ago, EndDate = yesterday.
 * Returns 2D array (headers + rows) for Google Sheets.
 */
router.get('/google-sheet/job-gp-per-impression', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  const { startDateStr, endDateStr } = getLastSixMonthsDateRange();
  const startedAt = Date.now();

  try {
    console.log('[google-sheet] job-gp-per-impression start', {
      db,
      startDate: startDateStr,
      endDate: endDateStr,
      requestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });

    const pool = await getLongQueryPool(db);
    const result = await pool
      .request()
      .input('StartDate', sql.VarChar(10), startDateStr)
      .input('EndDate', sql.VarChar(10), endDateStr)
      .query('EXEC rpt_job_gp_per_impression_v11 @StartDate, @EndDate');

    const elapsedMs = Date.now() - startedAt;
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    console.log('[google-sheet] job-gp-per-impression done', {
      db,
      rows: Math.max(0, data.length - 1),
      elapsedMs,
    });
    return res.json({ data, startDate: startDateStr, endDate: endDateStr });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] job-gp-per-impression failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch Job GP per Impression' });
  }
});

/**
 * GET /api/google-sheet/machine-schedule?database=KOL&machineId=123
 * Runs dbo.GetMachineScheduleData with @MachineID.
 * Returns 2D array (headers + rows) for Google Sheets.
 */
router.get('/google-sheet/machine-schedule', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  const machineId = req.query?.machineId;
  if (machineId === undefined || machineId === null || String(machineId).trim() === '') {
    return res.status(400).json({ error: 'machineId is required' });
  }
  const machineIdStr = String(machineId).trim();
  const machineIdNum = parseInt(machineIdStr, 10);
  const isNumeric = !Number.isNaN(machineIdNum) && String(machineIdNum) === machineIdStr;

  try {
    const pool = await getPool(db);
    const request = pool.request();
    if (isNumeric) {
      request.input('MachineID', sql.Int, machineIdNum);
    } else {
      request.input('MachineID', sql.NVarChar(50), machineIdStr);
    }
    const result = await request.execute('dbo.GetMachineScheduleData');
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    return res.json({ data });
  } catch (e) {
    console.error('[google-sheet] machine-schedule failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch Machine Schedule Data' });
  }
});

/**
 * GET /api/google-sheet/delivery-otif?database=KOL
 * Runs getdeliveryotif with StartDate = 6 months ago, EndDate = today.
 * Returns 2D array (headers + rows) for Google Sheets.
 */
router.get('/google-sheet/delivery-otif', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  const now = new Date();
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - 6);

  const startDateStr = formatDateYYYYMMDD(startDate);
  const endDateStr = formatDateYYYYMMDD(endDate);
  const startedAt = Date.now();

  try {
    console.log('[google-sheet] delivery-otif start', {
      db,
      startDate: startDateStr,
      endDate: endDateStr,
      requestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });

    const pool = await getLongQueryPool(db);
    const result = await pool
      .request()
      .input('StartDate', sql.VarChar(10), startDateStr)
      .input('EndDate', sql.VarChar(10), endDateStr)
      .query('EXEC getdeliveryotif @StartDate, @EndDate');

    const elapsedMs = Date.now() - startedAt;
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    console.log('[google-sheet] delivery-otif done', {
      db,
      rows: Math.max(0, data.length - 1),
      elapsedMs,
    });
    return res.json({ data, startDate: startDateStr, endDate: endDateStr });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] delivery-otif failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch Delivery OTIF' });
  }
});

/**
 * GET /api/google-sheet/cdc-bills-mis
 *
 * MIS report for CDC Bills (MongoDB `PurchaseBills` collection).
 * Returns a 2D array (headers + rows) for Google Sheets.
 *
 * Query params (all optional):
 *   startDate=YYYY-MM-DD   default: 6 months ago
 *   endDate=YYYY-MM-DD     default: today (inclusive of full day)
 *   cdcUnit=<unit>         exact match (case-insensitive)
 *   setType=grn|non_grn
 *   verificationStatus=pending_extraction|verified|verified_with_warnings|needs_review|rejected
 */
router.get('/google-sheet/cdc-bills-mis', async (req, res) => {
  const startedAt = Date.now();

  // ---- parse / default the date range (on uploaded_at) ----
  const now = new Date();
  const defaultEnd = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const defaultStart = new Date(defaultEnd);
  defaultStart.setUTCMonth(defaultStart.getUTCMonth() - 6);

  const startDate = parseDateYYYYMMDD(req.query?.startDate) || defaultStart;
  const endDateRaw = parseDateYYYYMMDD(req.query?.endDate) || defaultEnd;
  // Make end-date inclusive of the entire day.
  const endDate = new Date(endDateRaw);
  endDate.setUTCHours(23, 59, 59, 999);

  if (startDate > endDate) {
    return res.status(400).json({ error: 'startDate must be on or before endDate' });
  }

  // ---- optional filters ----
  const cdcUnit = (req.query?.cdcUnit || '').toString().trim();
  const setType = (req.query?.setType || '').toString().trim().toLowerCase();
  const verificationStatus = (req.query?.verificationStatus || '').toString().trim();

  const ALLOWED_SET_TYPES = ['grn', 'non_grn'];
  if (setType && !ALLOWED_SET_TYPES.includes(setType)) {
    return res.status(400).json({ error: `setType must be one of: ${ALLOWED_SET_TYPES.join(', ')}` });
  }
  const ALLOWED_STATUSES = [
    'pending_extraction', 'verified', 'verified_with_warnings', 'needs_review', 'rejected',
  ];
  if (verificationStatus && !ALLOWED_STATUSES.includes(verificationStatus)) {
    return res.status(400).json({ error: `verificationStatus must be one of: ${ALLOWED_STATUSES.join(', ')}` });
  }

  try {
    await ensurePurchaseBillsReady();
  } catch (err) {
    console.error('[google-sheet] cdc-bills-mis: billing DB unavailable:', err?.message || err);
    return res.status(503).json({ error: err?.message || 'Billing database unavailable' });
  }

  try {
    const query = {
      uploaded_at: { $gte: startDate, $lte: endDate },
    };
    if (cdcUnit) {
      query.cdc_unit = new RegExp(`^${cdcUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }
    if (setType) query.set_type = setType;
    if (verificationStatus) query.verification_status = verificationStatus;

    console.log('[google-sheet] cdc-bills-mis start', {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      cdcUnit: cdcUnit || null,
      setType: setType || null,
      verificationStatus: verificationStatus || null,
    });

    const projection = {
      uploaded_at: 1,
      uploaded_by: 1,
      cdc_unit: 1,
      set_type: 1,
      verification_status: 1,
      blocking_failures_count: 1,
      warning_failures_count: 1,
      tally_voucher_number: 1,
      tally_voucher_date: 1,
      tally_ref_bill_no: 1,
      tally_ref_bill_date: 1,
      grn_voucher_number: 1,
      grn_voucher_date: 1,
      invoice_number: 1,
      invoice_date: 1,
      supplier_name: 1,
      supplier_gstin: 1,
      supplier_state: 1,
      buyer_name: 1,
      buyer_gstin: 1,
      po_numbers: 1,
      taxable_value: 1,
      cgst_amount: 1,
      sgst_amount: 1,
      igst_amount: 1,
      round_off: 1,
      grand_total: 1,
      tax_type: 1,
      eway_bill_number: 1,
      eway_bill_date: 1,
      vehicle_number: 1,
      manually_reviewed_by: 1,
      manually_reviewed_at: 1,
      manually_overridden: 1,
      review_comment: 1,
    };

    const bills = await PurchaseBill.find(query, projection)
      .sort({ uploaded_at: -1 })
      .lean();

    // Fixed column order so consumers (Google Sheets) get stable columns
    // even when some fields are missing/null across documents.
    const columns = [
      ['Bill ID',                  b => b._id ? String(b._id) : ''],
      ['Uploaded At',              b => b.uploaded_at ? formatDateDDMMYYYY(b.uploaded_at) : ''],
      ['Uploaded By',              b => b.uploaded_by || ''],
      ['CDC Unit',                 b => b.cdc_unit || ''],
      ['Set Type',                 b => b.set_type === 'grn' ? 'GRN' : (b.set_type === 'non_grn' ? 'Non-GRN' : (b.set_type || ''))],
      ['Verification Status',      b => b.verification_status || ''],
      ['Blocking Failures',        b => b.blocking_failures_count ?? 0],
      ['Warning Failures',         b => b.warning_failures_count ?? 0],
      ['Tally Voucher Number',     b => b.tally_voucher_number || ''],
      ['Tally Voucher Date',       b => b.tally_voucher_date ? formatDateDDMMYYYY(b.tally_voucher_date) : ''],
      ['Tally Ref Bill No',        b => b.tally_ref_bill_no || ''],
      ['Tally Ref Bill Date',      b => b.tally_ref_bill_date ? formatDateDDMMYYYY(b.tally_ref_bill_date) : ''],
      ['GRN Voucher Number',       b => b.grn_voucher_number || ''],
      ['GRN Voucher Date',         b => b.grn_voucher_date ? formatDateDDMMYYYY(b.grn_voucher_date) : ''],
      ['Invoice Number',           b => b.invoice_number || ''],
      ['Invoice Date',             b => b.invoice_date ? formatDateDDMMYYYY(b.invoice_date) : ''],
      ['Supplier Name',            b => b.supplier_name || ''],
      ['Supplier GSTIN',           b => b.supplier_gstin || ''],
      ['Supplier State',           b => b.supplier_state || ''],
      ['Buyer Name',               b => b.buyer_name || ''],
      ['Buyer GSTIN',              b => b.buyer_gstin || ''],
      ['PO Numbers',               b => Array.isArray(b.po_numbers) ? b.po_numbers.join(', ') : ''],
      ['Taxable Value',            b => b.taxable_value ?? ''],
      ['CGST',                     b => b.cgst_amount ?? ''],
      ['SGST',                     b => b.sgst_amount ?? ''],
      ['IGST',                     b => b.igst_amount ?? ''],
      ['Round Off',                b => b.round_off ?? ''],
      ['Grand Total',              b => b.grand_total ?? ''],
      ['Tax Type',                 b => b.tax_type || ''],
      ['E-Way Bill Number',        b => b.eway_bill_number || ''],
      ['E-Way Bill Date',          b => b.eway_bill_date ? formatDateDDMMYYYY(b.eway_bill_date) : ''],
      ['Vehicle Number',           b => b.vehicle_number || ''],
      ['Manually Reviewed By',     b => b.manually_reviewed_by || ''],
      ['Manually Reviewed At',     b => b.manually_reviewed_at ? formatDateDDMMYYYY(b.manually_reviewed_at) : ''],
      ['Manually Overridden',      b => b.manually_overridden ? 'Yes' : 'No'],
      ['Review Comment',           b => b.review_comment || ''],
    ];

    const headers = columns.map(c => c[0]);
    const rows = bills.map(b => columns.map(c => {
      const v = c[1](b);
      return v === null || v === undefined ? '' : v;
    }));
    const data = [headers, ...rows];

    const elapsedMs = Date.now() - startedAt;
    console.log('[google-sheet] cdc-bills-mis done', {
      rows: rows.length,
      elapsedMs,
    });

    return res.json({
      data,
      startDate: formatDateYYYYMMDD(startDate),
      endDate: formatDateYYYYMMDD(endDateRaw),
      rowCount: rows.length,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] cdc-bills-mis failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch CDC Bills MIS' });
  }
});

export default router;
