/**
 * Shipment ETA Tool API
 * - POST /shipment-eta/upload — multipart Excel file; extracts columns and stores in ShipmentETA
 * - GET  /shipment-eta/list   — list all rows from ShipmentETA
 * Query/body: database=KOL|AHM (default KOL).
 * Excel columns: Container Number (If Ocean Shipment), Destination Port,
 *   Destination Arrival Original Planned Date (ETA), Destination Arrival Planned Date (ETA), Link
 */
import { Router } from 'express';
import multer from 'multer';
import { getPool } from './db.js';
import * as XLSX from 'xlsx';

const router = Router();
const DEFAULT_DATABASE = 'KOL';
const ALLOWED_DATABASES = ['KOL', 'AHM'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const ok = name.endsWith('.xlsx') || name.endsWith('.xls') || (file.mimetype && (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ));
    if (ok) return cb(null, true);
    cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
  }
});

function getDbFromReq(req) {
  const db = (req.query?.database || req.body?.database || DEFAULT_DATABASE).toString().trim().toUpperCase();
  return ALLOWED_DATABASES.includes(db) ? db : null;
}

// Possible Excel header variations (trimmed, lowercased for match)
const HEADER_MAP = [
  { keys: ['container number (if ocean shipment)', 'container number', 'container no'], db: 'ContainerNumber' },
  { keys: ['destination port'], db: 'DestinationPort' },
  { keys: ['destination arrival original planned date (eta)', 'destination arrival original planned date', 'eta original'], db: 'DestinationArrivalOriginalPlannedDate' },
  { keys: ['destination arrival planned date (eta)', 'destination arrival planned date', 'eta'], db: 'DestinationArrivalPlannedDate' },
  { keys: ['link', 'links', 'url'], db: 'Link' }
];

function findColumnIndex(headers) {
  const normalized = headers.map(h => (h != null ? String(h).trim().toLowerCase() : ''));
  const index = {};
  for (const { keys, db } of HEADER_MAP) {
    for (const key of keys) {
      const i = normalized.findIndex(n => n === key || (n && n.includes(key)));
      if (i !== -1) {
        index[db] = i;
        break;
      }
    }
  }
  return index;
}

function toStr(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

/**
 * POST /api/shipment-eta/upload
 * multipart: file (Excel), database (optional)
 */
router.post('/shipment-eta/upload', upload.single('file'), async (req, res) => {
  const db = getDbFromReq(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No Excel file uploaded. Use field name "file".' });
  }
  console.log('[shipment-eta] POST /upload database=', db, 'file=', req.file?.originalname);
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!data || data.length < 2) {
      return res.status(400).json({ error: 'Excel must have a header row and at least one data row' });
    }
    const headers = data[0];
    const colIndex = findColumnIndex(headers);
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!Array.isArray(row)) continue;
      const containerNumber = colIndex.ContainerNumber !== undefined ? toStr(row[colIndex.ContainerNumber]) : null;
      const destinationPort = colIndex.DestinationPort !== undefined ? toStr(row[colIndex.DestinationPort]) : null;
      const etaOriginal = colIndex.DestinationArrivalOriginalPlannedDate !== undefined ? toStr(row[colIndex.DestinationArrivalOriginalPlannedDate]) : null;
      const etaPlanned = colIndex.DestinationArrivalPlannedDate !== undefined ? toStr(row[colIndex.DestinationArrivalPlannedDate]) : null;
      const link = colIndex.Link !== undefined ? toStr(row[colIndex.Link]) : null;
      rows.push({ containerNumber, destinationPort, etaOriginal, etaPlanned, link });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No data rows found. Ensure column headers match: Container Number (If Ocean Shipment), Destination Port, Destination Arrival Original Planned Date (ETA), Destination Arrival Planned Date (ETA), Link' });
    }
    const pool = await getPool(db);
    let inserted = 0;
    for (const r of rows) {
      await pool.request()
        .input('ContainerNumber', r.containerNumber)
        .input('DestinationPort', r.destinationPort)
        .input('DestinationArrivalOriginalPlannedDate', r.etaOriginal)
        .input('DestinationArrivalPlannedDate', r.etaPlanned)
        .input('Link', r.link)
        .query(`
          INSERT INTO dbo.ShipmentETA (ContainerNumber, DestinationPort, DestinationArrivalOriginalPlannedDate, DestinationArrivalPlannedDate, Link)
          VALUES (@ContainerNumber, @DestinationPort, @DestinationArrivalOriginalPlannedDate, @DestinationArrivalPlannedDate, @Link)
        `);
      inserted++;
    }
    // Update Status: 1 if ContainerNumber exists in FinishGoodsTransactionMain.ContainerNo, else 0 (EXISTS avoids join quirks)
    await pool.request().query(`
      UPDATE dbo.ShipmentETA
      SET Status = CASE
        WHEN EXISTS (SELECT 1 FROM dbo.FinishGoodsTransactionMain f WHERE f.ContainerNo = ShipmentETA.ContainerNumber) THEN 1
        ELSE 0
      END
    `);
    return res.json({ success: true, inserted, message: `Inserted ${inserted} row(s) into ShipmentETA.` });
  } catch (e) {
    if (e.code === 'EREQUEST' && e.message && e.message.includes('Invalid object name')) {
      return res.status(500).json({
        error: 'Table ShipmentETA does not exist. Run backend/scripts/shipment-eta-create-table.sql on your database first.'
      });
    }
    console.error('[shipment-eta] upload failed:', e);
    return res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

/**
 * GET /api/shipment-eta/list?database=KOL
 */
router.get('/shipment-eta/list', async (req, res) => {
  const db = getDbFromReq(req);
  if (!db) {
    return res.status(400).json({ error: 'database must be KOL or AHM' });
  }
  console.log('[shipment-eta] GET /list database=', db);
  try {
    const pool = await getPool(db);
    const result = await pool.request().query(`
      SELECT s.Id, s.ContainerNumber, s.DestinationPort,
             s.DestinationArrivalOriginalPlannedDate, s.DestinationArrivalPlannedDate, s.Link, s.CreatedAt,
             CASE WHEN EXISTS (SELECT 1 FROM dbo.FinishGoodsTransactionMain f WHERE f.ContainerNo = s.ContainerNumber) THEN 1 ELSE 0 END AS Status
      FROM dbo.ShipmentETA s
      ORDER BY s.Id DESC
    `);

    console.log('result####################', JSON.stringify(result, null, 2) );
    // mssql driver may return column names as Status or status depending on server/driver; read both
    const rows = (result.recordset || []).map(r => {
      const statusVal = r.Status !== undefined && r.Status !== null ? r.Status : r.status;
      return {
        id: r.Id,
        containerNumber: r.ContainerNumber,
        destinationPort: r.DestinationPort,
        destinationArrivalOriginalPlannedDate: r.DestinationArrivalOriginalPlannedDate,
        destinationArrivalPlannedDate: r.DestinationArrivalPlannedDate,
        link: r.Link,
        status: statusVal != null ? Number(statusVal) : 0,
        createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : null
      };
    });
    console.log('[shipment-eta] list ok rows=', rows.length);
    return res.json(rows);
  } catch (e) {
    console.error('[shipment-eta] list failed:', e);
    console.error('[shipment-eta] list failed:', e);
    if (e.code === 'EREQUEST' && e.message && e.message.includes('Invalid object name')) {
      return res.status(500).json({
        error: 'Table ShipmentETA does not exist. Run backend/scripts/shipment-eta-create-table.sql on your database first.'
      });
    }
    return res.status(500).json({ error: e.message || 'List failed' });
  }
});

export default router;
