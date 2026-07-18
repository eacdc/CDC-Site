/**
 * Shipment ETA Tool API
 * - POST /shipment-eta/upload — multipart Excel file; extracts columns and stores in ShipmentETA
 *                               of the chosen database (KOL or AHM).
 * - GET  /shipment-eta/list   — list rows from BOTH KOL and AHM ShipmentETA tables (combined),
 *                               each tagged with a SourceDatabase. Status is computed via a
 *                               cross-database EXISTS against FinishGoodsTransactionMain in
 *                               BOTH databases (matched in either => 1).
 * Query/body: database=KOL|AHM (default KOL) — used by /upload only.
 * Excel columns: Container Number (If Ocean Shipment), Destination Port,
 *   Destination Arrival Original Planned Date (ETA), Destination Arrival Planned Date (ETA),
 *   Destination Arrival Actual Date, Gate in Actual Date, Origin Departure Actual Date, Link
 */
import { Router } from 'express';
import multer from 'multer';
import { getPool } from './db.js';
import * as XLSX from 'xlsx';

const router = Router();
const DEFAULT_DATABASE = 'KOL';
const ALLOWED_DATABASES = ['KOL', 'AHM'];

// Defensively escape a database identifier for inclusion inside [brackets].
// DB names come from env vars (DB_NAME_KOL / DB_NAME_AHM) but we still escape `]` -> `]]`.
function escapeDbIdent(name) {
  return String(name || '').replace(/]/g, ']]');
}

function getCrossDbNames() {
  const kol = process.env.DB_NAME_KOL;
  const ahm = process.env.DB_NAME_AHM;
  if (!kol || !ahm) {
    const missing = [];
    if (!kol) missing.push('DB_NAME_KOL');
    if (!ahm) missing.push('DB_NAME_AHM');
    const err = new Error(`Missing env var(s): ${missing.join(', ')}. Cross-database matching requires both KOL and AHM database names.`);
    err.statusCode = 500;
    throw err;
  }
  return { kol: escapeDbIdent(kol), ahm: escapeDbIdent(ahm) };
}

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

// Possible Excel header variations (trimmed, lowercased for match).
// Order matters when one key is a prefix/substring of another – more specific keys must
// come before more generic ones so `Array.prototype.findIndex` (which uses
// `n === key || n.includes(key)`) doesn't bind a generic match first.
const HEADER_MAP = [
  { keys: ['container number (if ocean shipment)', 'container number', 'container no'], db: 'ContainerNumber' },
  { keys: ['destination port'], db: 'DestinationPort' },
  { keys: ['destination arrival original planned date (eta)', 'destination arrival original planned date', 'eta original'], db: 'DestinationArrivalOriginalPlannedDate' },
  { keys: ['destination arrival planned date (eta)', 'destination arrival planned date', 'eta'], db: 'DestinationArrivalPlannedDate' },
  { keys: ['destination arrival actual date', 'destination arrival actual'], db: 'DestinationArrivalActualDate' },
  { keys: ['gate in actual date', 'gate in actual', 'gate-in actual date', 'gate in date'], db: 'GateInActualDate' },
  { keys: ['origin departure actual date', 'origin departure actual', 'origin departure date'], db: 'OriginDepartureActualDate' },
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
      const destinationArrivalActual = colIndex.DestinationArrivalActualDate !== undefined ? toStr(row[colIndex.DestinationArrivalActualDate]) : null;
      const gateInActual = colIndex.GateInActualDate !== undefined ? toStr(row[colIndex.GateInActualDate]) : null;
      const originDepartureActual = colIndex.OriginDepartureActualDate !== undefined ? toStr(row[colIndex.OriginDepartureActualDate]) : null;
      const link = colIndex.Link !== undefined ? toStr(row[colIndex.Link]) : null;
      rows.push({ containerNumber, destinationPort, etaOriginal, etaPlanned, destinationArrivalActual, gateInActual, originDepartureActual, link });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No data rows found. Ensure column headers match: Container Number (If Ocean Shipment), Destination Port, Destination Arrival Original Planned Date (ETA), Destination Arrival Planned Date (ETA), Destination Arrival Actual Date, Gate in Actual Date, Origin Departure Actual Date, Link' });
    }
    const pool = await getPool(db);
    let inserted = 0;
    let replaced = 0;
    // Upsert by ContainerNumber: if a row with the same non-empty ContainerNumber
    // already exists in this database's ShipmentETA, delete it first so the new
    // upload replaces it. Rows with NULL/empty ContainerNumber are always inserted
    // (we cannot meaningfully deduplicate them).
    for (const r of rows) {
      const result = await pool.request()
        .input('ContainerNumber', r.containerNumber)
        .input('DestinationPort', r.destinationPort)
        .input('DestinationArrivalOriginalPlannedDate', r.etaOriginal)
        .input('DestinationArrivalPlannedDate', r.etaPlanned)
        .input('DestinationArrivalActualDate', r.destinationArrivalActual)
        .input('GateInActualDate', r.gateInActual)
        .input('OriginDepartureActualDate', r.originDepartureActual)
        .input('Link', r.link)
        .query(`
          DECLARE @replaced INT = 0;
          IF @ContainerNumber IS NOT NULL AND LEN(@ContainerNumber) > 0
          BEGIN
            DELETE FROM dbo.ShipmentETA WHERE ContainerNumber = @ContainerNumber;
            SET @replaced = @@ROWCOUNT;
          END;
          INSERT INTO dbo.ShipmentETA (
            ContainerNumber, DestinationPort,
            DestinationArrivalOriginalPlannedDate, DestinationArrivalPlannedDate,
            DestinationArrivalActualDate, GateInActualDate, OriginDepartureActualDate, Link
          )
          VALUES (
            @ContainerNumber, @DestinationPort,
            @DestinationArrivalOriginalPlannedDate, @DestinationArrivalPlannedDate,
            @DestinationArrivalActualDate, @GateInActualDate, @OriginDepartureActualDate, @Link
          );
          SELECT @replaced AS Replaced;
        `);
      inserted++;
      const rep = result.recordset && result.recordset[0] ? Number(result.recordset[0].Replaced) || 0 : 0;
      replaced += rep;
    }
    // Update Status: 1 if ContainerNumber exists in FinishGoodsTransactionMain.ContainerNo
    // in EITHER database (KOL or AHM), else 0. Cross-database EXISTS so a container
    // appearing in the other plant still flags as Matched.
    const { kol: kolDb, ahm: ahmDb } = getCrossDbNames();
    await pool.request().query(`
      UPDATE dbo.ShipmentETA
      SET Status = CASE
        WHEN EXISTS (
          SELECT 1 FROM [${kolDb}].dbo.FinishGoodsTransactionMain f
          WHERE f.ContainerNo = ShipmentETA.ContainerNumber
        )
          OR EXISTS (
            SELECT 1 FROM [${ahmDb}].dbo.FinishGoodsTransactionMain f
            WHERE f.ContainerNo = ShipmentETA.ContainerNumber
          )
        THEN 1
        ELSE 0
      END
    `);
    const newRows = Math.max(0, inserted - replaced);
    const replacedSuffix = replaced > 0 ? ` ${replaced} existing container(s) were replaced.` : '';
    return res.json({
      success: true,
      inserted,
      replaced,
      newRows,
      message: `Imported ${inserted} row(s) into ShipmentETA (${newRows} new, ${replaced} replaced).${replacedSuffix}`
    });
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
 * GET /api/shipment-eta/list
 * Returns rows from BOTH KOL and AHM ShipmentETA tables, combined.
 * Each row is tagged with `sourceDatabase` ('KOL' or 'AHM').
 * Status is computed via cross-database EXISTS — Matched (1) if the
 * ContainerNumber appears in FinishGoodsTransactionMain in either DB.
 *
 * Note: the legacy `database` query param is accepted but ignored.
 */
router.get('/shipment-eta/list', async (req, res) => {
  console.log('[shipment-eta] GET /list (combined KOL + AHM)');
  let kolDb, ahmDb;
  try {
    ({ kol: kolDb, ahm: ahmDb } = getCrossDbNames());
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message });
  }

  try {
    // Either pool works since both DBs share the same SQL login. Use KOL by convention.
    const pool = await getPool('KOL');
    const result = await pool.request().query(`
      ;WITH combined AS (
        SELECT 'KOL' AS SourceDatabase, s.Id, s.ContainerNumber, s.DestinationPort,
               s.DestinationArrivalOriginalPlannedDate, s.DestinationArrivalPlannedDate,
               s.DestinationArrivalActualDate, s.GateInActualDate, s.OriginDepartureActualDate,
               s.Link, s.CreatedAt
        FROM [${kolDb}].dbo.ShipmentETA s
        UNION ALL
        SELECT 'AHM' AS SourceDatabase, s.Id, s.ContainerNumber, s.DestinationPort,
               s.DestinationArrivalOriginalPlannedDate, s.DestinationArrivalPlannedDate,
               s.DestinationArrivalActualDate, s.GateInActualDate, s.OriginDepartureActualDate,
               s.Link, s.CreatedAt
        FROM [${ahmDb}].dbo.ShipmentETA s
      )
      SELECT c.SourceDatabase, c.Id, c.ContainerNumber, c.DestinationPort,
             c.DestinationArrivalOriginalPlannedDate, c.DestinationArrivalPlannedDate,
             c.DestinationArrivalActualDate, c.GateInActualDate, c.OriginDepartureActualDate,
             c.Link, c.CreatedAt,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM [${kolDb}].dbo.FinishGoodsTransactionMain f
                 WHERE f.ContainerNo = c.ContainerNumber
               )
                 OR EXISTS (
                   SELECT 1 FROM [${ahmDb}].dbo.FinishGoodsTransactionMain f
                   WHERE f.ContainerNo = c.ContainerNumber
                 )
               THEN 1 ELSE 0
             END AS Status
      FROM combined c
      ORDER BY c.CreatedAt DESC, c.Id DESC
    `);

    // mssql driver may return column names as Status or status depending on server/driver; read both
    const rows = (result.recordset || []).map(r => {
      const statusVal = r.Status !== undefined && r.Status !== null ? r.Status : r.status;
      return {
        sourceDatabase: r.SourceDatabase || r.sourceDatabase || null,
        id: r.Id,
        containerNumber: r.ContainerNumber,
        destinationPort: r.DestinationPort,
        destinationArrivalOriginalPlannedDate: r.DestinationArrivalOriginalPlannedDate,
        destinationArrivalPlannedDate: r.DestinationArrivalPlannedDate,
        destinationArrivalActualDate: r.DestinationArrivalActualDate,
        gateInActualDate: r.GateInActualDate,
        originDepartureActualDate: r.OriginDepartureActualDate,
        link: r.Link,
        status: statusVal != null ? Number(statusVal) : 0,
        createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : null
      };
    });
    console.log('[shipment-eta] list ok rows=', rows.length);
    return res.json(rows);
  } catch (e) {
    console.error('[shipment-eta] list failed:', e);
    if (e.code === 'EREQUEST' && e.message && e.message.includes('Invalid object name')) {
      return res.status(500).json({
        error: 'Table ShipmentETA does not exist in one or both databases. Run backend/scripts/shipment-eta-create-table.sql on each database first.'
      });
    }
    return res.status(500).json({ error: e.message || 'List failed' });
  }
});

export default router;
