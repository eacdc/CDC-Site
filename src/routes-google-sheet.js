/**
 * Google Sheet Data API
 * Fetches data from MSSQL and returns 2D arrays suitable for Google Sheets.
 * All endpoints accept ?database=KOL|AHM (default: KOL).
 */
import { Router } from 'express';
import { getPool } from './db.js';
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

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // yesterday
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 6); // 6 months before yesterday

  const formatDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const startDateStr = formatDate(startDate);
  const endDateStr = formatDate(endDate);

  try {
    const pool = await getPool(db);
    const request = pool.request();
    request.input('StartDate', sql.VarChar(20), startDateStr);
    request.input('EndDate', sql.VarChar(20), endDateStr);
    const result = await request.execute('dbo.GetProcessOTIF');
    const recordset = result.recordset ?? [];
    const data = recordsetTo2DArray(recordset);
    return res.json({ data });
  } catch (e) {
    console.error('[google-sheet] process-otif failed:', e);
    return res.status(500).json({ error: e.message || 'Failed to fetch Process OTIF' });
  }
});

export default router;
