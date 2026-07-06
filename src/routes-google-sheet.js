/**
 * Google Sheet Data API
 * Fetches data from MSSQL and returns 2D arrays suitable for Google Sheets.
 * All endpoints accept ?database=KOL|AHM (default: KOL).
 */
import { Router } from 'express';
import { getPool, getLongQueryPool, LONG_REQUEST_TIMEOUT_MS } from './db.js';
import sql from 'mssql';
import { ensurePurchaseBillsReady, PurchaseBill } from './db-purchase-bills.js';
import { fetchUnorderedForProcess, mongoRowToProcessCells } from './lib/process-mongo.js';
import Bill from './models/Bill.js';

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

/** End = yesterday, start = 1 calendar month before end (inclusive range for reports). */
function getLastOneMonthDateRange() {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 1);
  return {
    startDateStr: formatDateYYYYMMDD(startDate),
    endDateStr: formatDateYYYYMMDD(endDate),
  };
}

/** Formats a UTC-midnight Date (representing a calendar date) as yyyy-MM-dd. */
function formatDateYYYYMMDD_UTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns "today" (as a UTC-midnight Date) per the Asia/Kolkata calendar date, regardless of server TZ. */
function getTodayInKolkata() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return new Date(Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day)));
}

/**
 * Mirrors the Apps Script date math: last Monday -> last Sunday, relative to
 * "today" in Asia/Kolkata. E.g. if today is Wed, returns the Mon-Sun of the
 * previous full week.
 */
function getLastMondayToSundayRange() {
  const today = getTodayInKolkata();
  const dayOfWeek = today.getUTCDay(); // 0=Sun..6=Sat

  const lastSunday = new Date(today);
  lastSunday.setUTCDate(today.getUTCDate() - dayOfWeek);

  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);

  return {
    startDateStr: formatDateYYYYMMDD_UTC(lastMonday),
    endDateStr: formatDateYYYYMMDD_UTC(lastSunday),
  };
}

/** "dd/MM/yyyy hh:mm A" in Asia/Kolkata, matching Utilities.formatDate(now, "Asia/Kolkata", "dd/MM/yyyy hh:mm a"). */
function formatTimestampIST(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${lookup.day}/${lookup.month}/${lookup.year} ${lookup.hour}:${lookup.minute} ${(lookup.dayPeriod || '').toUpperCase()}`;
}

// Columns rounded to whole numbers (quantities) vs 2 decimals (rates/costs),
// mirroring the qtyColumns / rateCostColumns lists in the original Apps Script.
const GP_REPORT_QTY_COLUMNS = new Set([
  'OrderQty', 'GPN Qty', 'Del Qty',
  'Planned Print Imp', 'Actual Print Imp', 'Final Print Imp',
  'Foil Issued', 'TotalBookedPaperWt', 'IssuedWt',
]);

const GP_REPORT_RATE_COST_COLUMNS = new Set([
  'Unit Price', 'Total Bill Value',
  'IssuedCost', 'Booked Kraft Cost', 'Booked Lam Film Cost',
  'Booked Adhesive Cost', 'Booked Coating Cost',
  'Plate Amount', 'Notional Pack&Del',
  'Delivery Cost',
  'Notional-ContCost', 'Addl Manual Total Cost',
  'Total Cost', 'GP', 'GP/Imp',
]);

function roundMoney(num) {
  return Number(Number(num).toFixed(2));
}

/**
 * Bulk-fetch finalized contractor cost per job number from MongoDB Bills.
 * One aggregation round-trip for all jobs in the report (not per-job queries).
 * @param {string[]} jobNumbers
 * @returns {Promise<Map<string, number>>}
 */
async function fetchContractorCostByJobNumbers(jobNumbers) {
  const uniqueJobNumbers = [...new Set(jobNumbers.filter(Boolean))];
  if (uniqueJobNumbers.length === 0) return new Map();

  const rows = await Bill.aggregate([
    {
      $match: {
        $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }],
        'jobs.jobNumber': { $in: uniqueJobNumbers },
      },
    },
    { $unwind: '$jobs' },
    { $match: { 'jobs.jobNumber': { $in: uniqueJobNumbers } } },
    { $unwind: '$jobs.ops' },
    {
      $group: {
        _id: '$jobs.jobNumber',
        totalCost: { $sum: { $ifNull: ['$jobs.ops.totalValue', 0] } },
      },
    },
  ]);

  return new Map(rows.map(r => [String(r._id).trim(), Number(r.totalCost) || 0]));
}

/**
 * Builds the 2D array (headers + rows) for the weekly GP% report, replicating
 * the Apps Script `getmachineschedule()` row-processing logic:
 *  - quantity columns rounded to whole numbers
 *  - rate/cost columns rounded to 2 decimals
 *  - Notional-ContCost populated from MongoDB contractor bills (when map provided)
 *  - Total Cost / GP / GP/Imp recomputed to include contractor + addl manual cost
 *  - an extra "GP %" column appended, computed as (BillValue - TotalCost) / BillValue
 * @param {import('mssql').IResult<any>} result
 * @param {Map<string, number>} [contractorCostByJob]
 */
function buildGpReportData(result, contractorCostByJob = new Map()) {
  const recordset = result.recordset ?? [];
  const columnNames = recordset.columns
    ? Object.keys(recordset.columns)
    : (recordset.length > 0 ? Object.keys(recordset[0]) : []);

  const headers = [...columnNames, 'GP %'];
  const idx = (name) => columnNames.indexOf(name);
  const jobCardNoIdx = idx('JobCardNo');
  const billValueIdx = idx('Total Bill Value');
  const totalCostIdx = idx('Total Cost');
  const gpIdx = idx('GP');
  const gpImpIdx = idx('GP/Imp');
  const finalPrintImpIdx = idx('Final Print Imp');
  const notionalContCostIdx = idx('Notional-ContCost');
  const addlManualCostIdx = idx('Addl Manual Total Cost');

  const rows = recordset.map(record => {
    const jobNumber = jobCardNoIdx !== -1
      ? String(record[columnNames[jobCardNoIdx]] ?? '').trim()
      : '';
    const contractorCost = contractorCostByJob.get(jobNumber) || 0;

    const enrichedRecord = { ...record };
    if (notionalContCostIdx !== -1) {
      enrichedRecord[columnNames[notionalContCostIdx]] = contractorCost;
    }

    const row = columnNames.map(colName => {
      const value = enrichedRecord[colName];
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return formatDateDDMMYYYY(value);

      const num = Number(value);
      if (typeof value !== 'boolean' && value !== '' && !Number.isNaN(num)) {
        if (GP_REPORT_QTY_COLUMNS.has(colName)) return Math.round(num);
        if (GP_REPORT_RATE_COST_COLUMNS.has(colName)) return Number(num.toFixed(2));
      }
      return value;
    });

    const billValue = billValueIdx !== -1 ? parseFloat(row[billValueIdx]) : NaN;
    const spTotalCost = totalCostIdx !== -1
      ? parseFloat(record[columnNames[totalCostIdx]])
      : 0;
    const addlManualCost = addlManualCostIdx !== -1
      ? parseFloat(row[addlManualCostIdx]) || 0
      : 0;
    const contCost = roundMoney(contractorCost);

    const newTotalCost = roundMoney(
      (Number.isNaN(spTotalCost) ? 0 : spTotalCost) + contCost + addlManualCost,
    );

    if (totalCostIdx !== -1) {
      row[totalCostIdx] = newTotalCost;
    }

    if (gpIdx !== -1 && !Number.isNaN(billValue)) {
      row[gpIdx] = roundMoney(billValue - newTotalCost);
    }

    if (gpImpIdx !== -1 && finalPrintImpIdx !== -1) {
      const finalPrintImp = parseFloat(row[finalPrintImpIdx]);
      if (!Number.isNaN(finalPrintImp) && finalPrintImp !== 0 && !Number.isNaN(billValue)) {
        row[gpImpIdx] = roundMoney((billValue - newTotalCost) / finalPrintImp);
      } else {
        row[gpImpIdx] = '';
      }
    }

    let gpPercent = '';
    if (!Number.isNaN(billValue) && billValue !== 0) {
      gpPercent = roundMoney((billValue - newTotalCost) / billValue);
    }
    row.push(gpPercent);
    return row;
  });

  return [headers, ...rows];
}

/**
 * Optional startDate/endDate query override (yyyy-MM-dd). Returns { error } on invalid input.
 * @param {import('express').Request} req
 * @returns {{ startDateStr: string, endDateStr: string } | { error: string } | null}
 */
function resolveGpReportDateRangeFromQuery(req) {
  const hasStart = req.query?.startDate != null && String(req.query.startDate).trim() !== '';
  const hasEnd = req.query?.endDate != null && String(req.query.endDate).trim() !== '';
  if (!hasStart && !hasEnd) return null;

  const customStart = parseDateYYYYMMDD(String(req.query.startDate ?? ''));
  const customEnd = parseDateYYYYMMDD(String(req.query.endDate ?? ''));
  if (!customStart || !customEnd) {
    return { error: 'startDate and endDate must both be valid yyyy-MM-dd values' };
  }
  if (customStart > customEnd) {
    return { error: 'startDate must be on or before endDate' };
  }
  return {
    startDateStr: formatDateYYYYMMDD_UTC(customStart),
    endDateStr: formatDateYYYYMMDD_UTC(customEnd),
  };
}

/**
 * Runs rpt_job_gp_per_impression_v11, enriches with Mongo contractor cost, builds sheet rows.
 * @param {string} db
 * @param {string} startDateStr
 * @param {string} endDateStr
 * @param {{ onlyWithContractorCost?: boolean }} [options]
 */
async function executeGpReportWithContractorCost(db, startDateStr, endDateStr, options = {}) {
  const { onlyWithContractorCost = false } = options;
  const pool = await getLongQueryPool(db);
  const result = await pool
    .request()
    .input('StartDate', sql.VarChar(10), startDateStr)
    .input('EndDate', sql.VarChar(10), endDateStr)
    .query('EXEC rpt_job_gp_per_impression_v11 @StartDate, @EndDate');

  const recordset = result.recordset ?? [];
  const jobNumbers = recordset.map(r => String(r.JobCardNo ?? '').trim());

  let contractorCostByJob = new Map();
  try {
    contractorCostByJob = await fetchContractorCostByJobNumbers(jobNumbers);
  } catch (mongoErr) {
    console.error('[google-sheet] contractor cost lookup failed, defaulting to 0:', mongoErr);
  }

  const filteredRecordset = onlyWithContractorCost
    ? recordset.filter(r => {
        const jobNumber = String(r.JobCardNo ?? '').trim();
        return (contractorCostByJob.get(jobNumber) || 0) > 0;
      })
    : recordset;

  const data = buildGpReportData(
    { recordset: filteredRecordset, columns: result.columns },
    contractorCostByJob,
  );

  const contractorCostSummary = [...contractorCostByJob.entries()]
    .filter(([, cost]) => cost > 0)
    .map(([jobNumber, contractorCost]) => ({
      jobNumber,
      contractorCost: roundMoney(contractorCost),
    }))
    .sort((a, b) => a.jobNumber.localeCompare(b.jobNumber));

  return {
    data,
    totalSqlRows: recordset.length,
    rowsReturned: Math.max(0, data.length - 1),
    jobsWithContractorCostInRange: filteredRecordset.length,
    contractorCostSummary,
    contractorCostByJob,
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
 * GET /api/google-sheet/job-gp-per-impression-weekly?database=KOL
 *
 * Replicates the Apps Script `getmachineschedule()` function that used to run
 * inside the "Master" Google Sheet via JDBC:
 *  - Date range = last Monday -> last Sunday (the previous full week), IST.
 *  - Runs rpt_job_gp_per_impression_v11(@StartDate, @EndDate).
 *  - Quantity columns rounded to whole numbers; rate/cost columns to 2 decimals.
 *  - Appends a "GP %" column computed as (Total Bill Value - Total Cost) / Total Bill Value.
 *  - Enriches Notional-ContCost from MongoDB Bills and recomputes Total Cost / GP / GP/Imp.
 *
 * Returns { data, startDate, endDate, updatedAt } where `data` is a 2D array
 * (headers + rows) ready to be written into a sheet via setValues().
 * The Apps Script side should call this endpoint with UrlFetchApp instead of
 * connecting to the DB directly, then continue with its own PDF generation step.
 */
router.get('/google-sheet/job-gp-per-impression-weekly', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  const { startDateStr, endDateStr } = getLastMondayToSundayRange();
  const startedAt = Date.now();

  try {
    console.log('[google-sheet] job-gp-per-impression-weekly start', {
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

    const recordset = result.recordset ?? [];
    const jobNumbers = recordset.map(r => String(r.JobCardNo ?? '').trim());

    let contractorCostByJob = new Map();
    try {
      contractorCostByJob = await fetchContractorCostByJobNumbers(jobNumbers);
    } catch (mongoErr) {
      console.error('[google-sheet] contractor cost lookup failed, defaulting to 0:', mongoErr);
    }

    const data = buildGpReportData(result, contractorCostByJob);
    const updatedAt = formatTimestampIST(new Date());
    const elapsedMs = Date.now() - startedAt;

    console.log('[google-sheet] job-gp-per-impression-weekly done', {
      db,
      rows: Math.max(0, data.length - 1),
      jobsWithContractorCost: contractorCostByJob.size,
      elapsedMs,
    });

    return res.json({
      data,
      startDate: startDateStr,
      endDate: endDateStr,
      updatedAt,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] job-gp-per-impression-weekly failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch weekly Job GP per Impression' });
  }
});

/**
 * GET /api/google-sheet/job-gp-per-impression-contractor-test?database=KOL
 *
 * Test endpoint for validating contractor-cost enrichment:
 *  - Default date range = last 1 calendar month (yesterday back 1 month).
 *  - Optional ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD to override.
 *  - Returns ONLY jobs that have billed contractor cost in MongoDB (> 0).
 *  - Includes a flat `contractorCostSummary` for easy Postman inspection.
 */
router.get('/google-sheet/job-gp-per-impression-contractor-test', async (req, res) => {
  const db = getDbFromQuery(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }

  const customRange = resolveGpReportDateRangeFromQuery(req);
  if (customRange?.error) {
    return res.status(400).json({ error: customRange.error });
  }
  const { startDateStr, endDateStr } = customRange || getLastOneMonthDateRange();
  const startedAt = Date.now();

  try {
    console.log('[google-sheet] job-gp-per-impression-contractor-test start', {
      db,
      startDate: startDateStr,
      endDate: endDateStr,
      requestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });

    const report = await executeGpReportWithContractorCost(db, startDateStr, endDateStr, {
      onlyWithContractorCost: true,
    });

    const elapsedMs = Date.now() - startedAt;
    console.log('[google-sheet] job-gp-per-impression-contractor-test done', {
      db,
      totalSqlRows: report.totalSqlRows,
      rowsReturned: report.rowsReturned,
      jobsWithContractorCost: report.contractorCostSummary.length,
      elapsedMs,
    });

    return res.json({
      data: report.data,
      startDate: startDateStr,
      endDate: endDateStr,
      updatedAt: formatTimestampIST(new Date()),
      summary: {
        totalSqlRows: report.totalSqlRows,
        rowsWithContractorCost: report.jobsWithContractorCostInRange,
        rowsReturned: report.rowsReturned,
        uniqueJobsWithContractorCostInMongo: report.contractorCostSummary.length,
      },
      contractorCostSummary: report.contractorCostSummary,
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] job-gp-per-impression-contractor-test failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch contractor-cost GP test report' });
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
 * GET /api/google-sheet/process?database=KOL
 * Runs GetCoordinatorChecklist with StartDate = 6 months ago, EndDate = today,
 * then appends MongoDB ArtworkUnordered rows (same columns) for MIS reporting.
 * Returns 2D array (headers + rows) for Google Sheets.
 */
router.get('/google-sheet/process', async (req, res) => {
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

  const PROCESS_FALLBACK_HEADERS = [
    'Client Name',
    'PO number',
    'PO Date',
    'Sale order number',
    'Sale order Date',
    'JobCard Number',
    'Jobcard Date',
    'Division',
    'File status',
    'PrepressPerson Allocated',
    'SalesEmployeeID',
    'Sales Name',
    'CoordinatorUserID',
    'Coordinator Name',
    'Paper Allocation Status',
    'Paper Allocation Date',
    'FileName',
    'FileReceivedDate',
  ];

  try {
    console.log('[google-sheet] process start', {
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
      .query('EXEC GetCoordinatorChecklist @StartDate, @EndDate');

    const recordset = result.recordset ?? [];
    const headers = recordset.length > 0
      ? Object.keys(recordset[0])
      : PROCESS_FALLBACK_HEADERS;

    const sqlRows = recordset.map(row =>
      headers.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        if (val instanceof Date) return formatDateDDMMYYYY(val);
        return val;
      }),
    );

    let mongoRows = [];
    let mongoError = null;
    try {
      const unordered = await fetchUnorderedForProcess({
        database: db,
        startDate,
        endDate,
      });
      mongoRows = unordered.map(row => mongoRowToProcessCells(headers, row));
      console.log('[google-sheet] process mongo unordered', { count: mongoRows.length });
    } catch (mongoErr) {
      mongoError = mongoErr?.message || String(mongoErr);
      console.error('[google-sheet] process mongo unordered failed:', mongoErr);
    }

    const data = [headers, ...sqlRows, ...mongoRows];
    const elapsedMs = Date.now() - startedAt;
    console.log('[google-sheet] process done', {
      db,
      sqlRows: sqlRows.length,
      mongoRows: mongoRows.length,
      totalRows: Math.max(0, data.length - 1),
      elapsedMs,
    });

    return res.json({
      data,
      startDate: startDateStr,
      endDate: endDateStr,
      sqlRowCount: sqlRows.length,
      mongoRowCount: mongoRows.length,
      ...(mongoError ? { mongoWarning: mongoError } : {}),
    });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[google-sheet] process failed:', { elapsedMs, error: e });
    return res.status(500).json({ error: e.message || 'Failed to fetch Process data' });
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
