/**
 * Google Sheet Data API
 * Fetches data from MSSQL and returns 2D arrays suitable for Google Sheets.
 * All endpoints accept ?database=KOL|AHM (default: KOL).
 */
import { Router } from 'express';
import { getPool, getLongQueryPool, LONG_REQUEST_TIMEOUT_MS } from './db.js';
import sql from 'mssql';

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
 * Converts a recordset (array of row objects) into a 2D array for Google Sheets.
 * First row = column names (headers), following rows = data.
 * @param {Array<Object>} recordset - Rows from MSSQL
 * @returns {Array<Array>} 2D array [headers, ...dataRows]
 */
function recordsetTo2DArray(recordset) {
  if (!recordset || recordset.length === 0) {
    return [];
  }
  const headers = Object.keys(recordset[0]);
  const rows = recordset.map(row => headers.map(col => row[col] ?? ''));
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

export default router;
