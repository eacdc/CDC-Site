/**
 * Raw Material QC Tool API
 * - POST /raw-qc/grn-pending — list GRNs not yet QC'd (ItemTransactionMain, VoucherDate >= 2026-02-22)
 * - POST /raw-qc/inspection-parameters — get parameters for a GRN (ItemGroupParameters + ItemMaster standard values)
 * - POST /raw-qc/save-inspection — save QC (RawMaterialQCMain + RawMaterialQCDetail) with ValidationStatus
 * - POST /raw-qc/reports/inspector-performance — dashboard by user/date
 * - POST /raw-qc/reports/grn-entries — GRN search: QC entries by voucher no or transactionId
 * ItemGroupParameters: ensure table has IsDeleted (INT, default 0) for soft delete. If missing: ALTER TABLE ItemGroupParameters ADD IsDeleted INT NOT NULL DEFAULT 0;
 * RawMaterialQCDetail: add ValidationStatus column if missing: ALTER TABLE RawMaterialQCDetail ADD ValidationStatus NVARCHAR(50) NULL;
 * RawMaterialQCMain: add TransactionDetailID (INT NULL) so completion is per line; run backend/scripts/raw-qc-add-TransactionDetailID.sql
 */
import { Router } from 'express';
import { getPool } from './db.js';
import sql from 'mssql';

const router = Router();
const GRN_VOUCHER_ID = -14;
const PENDING_GRN_CUTOFF_DATE = '2026-03-23';

function getDb(body = {}) {
  const db = (body.database || '').toString().trim().toUpperCase();
  return db === 'KOL' || db === 'AHM' ? db : null;
}

/**
 * Parse standard value from ItemMaster.ItemDescription for a given parameter.
 * Format: "Quality:Grey Back, GSM:250, Manufecturer:Dev Priya, CertificationType:NONE, SizeW:485, SizeL:795, Caliper:1.3"
 * Returns the string value after "ParameterName:" (trimmed), or null if not found.
 */
function parseStandardFromItemDescription(itemDescription, parameterName) {
  if (!itemDescription || typeof itemDescription !== 'string') return null;
  const s = itemDescription.trim();
  if (!s) return null;
  const name = (parameterName || '').toString().trim();
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*:\\s*([^,]*)', 'i');
  const m = s.match(re);
  if (!m || m[1] === undefined) return null;
  const value = m[1].trim();
  console.log('value#################', value);
  return value === '' ? null : value;
}

/**
 * Compute ValidationStatus for one detail row.
 * - tolerance: standard from ItemDescription (or itemStandardValue), tolerance from param; range = standard ± tolerance; if actual in range then Ok else Not Ok
 * - dropdown: exact actualValue
 * - value: NA
 */
function computeValidationStatus(paramType, paramToleranceValue, actualValue, standardFromItemDesc, itemStandardValue) {
  console.log('standardFromItemDesc#################', standardFromItemDesc);
  console.log('itemStandardValue#################', itemStandardValue);
  const typeVal = (paramType || '').toString().toLowerCase();
  const actual = (actualValue != null ? String(actualValue).trim() : '');
  if (typeVal === 'value') return 'NA';
  if (typeVal === 'dropdown') return actual || 'NA';
  if (typeVal === 'tolerance') {
    const standardRaw = standardFromItemDesc != null ? standardFromItemDesc : (itemStandardValue != null ? itemStandardValue : null);
    // console.log('standardRaw#################', standardRaw);
    const standard = standardRaw != null ? parseFloat(String(standardRaw)) : NaN;
    console.log('standard#################', standard);
    const tolerance = paramToleranceValue != null && paramToleranceValue !== '' ? parseFloat(String(paramToleranceValue)) : NaN;
    console.log('tolerance#################', tolerance);
    const actualNum = actual !== '' ? parseFloat(actual) : NaN;
    console.log('actualNum#################', actualNum);
    // console.log('low#################', low);
    // console.log('high#################', high);
    if (Number.isNaN(standard) || Number.isNaN(tolerance) || Number.isNaN(actualNum)) return 'NA';
    const low = standard - ((tolerance/100) * (standard));
    const high = standard + ((tolerance/100) * (standard));
    console.log('low#################', low);
    console.log('high#################', high);
    return (actualNum >= low && actualNum <= high) ? 'Ok' : 'Not Ok';
  }
  return 'NA';
}

/**
 * POST /api/raw-qc/grn-pending
 * Body: { database: 'KOL'|'AHM' }
 * Returns one row per item (per ItemTransactionDetail) for pending GRNs.
 * Each row: TransactionID, TransactionDetailID, VoucherDate, VoucherNo, Vendor (LedgerName), ItemName, ItemType, ReceiptQuantity.
 */
router.post('/raw-qc/grn-pending', async (req, res) => {
  const db = getDb(req.body || {});
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request()
      .input('VoucherIdGrn', sql.Int, GRN_VOUCHER_ID)
      .input('CutoffDate', sql.Date, PENDING_GRN_CUTOFF_DATE)
      .query(`
        ;WITH PendingBase AS (
          SELECT
            m.TransactionID,
            d.TransactionDetailID,
            m.VoucherDate,
            m.VoucherNo,
            lm.LedgerName AS Vendor,
            COALESCE(im.ItemName, im.ItemDescription) AS ItemName,
            im.ItemType,
            d.ReceiptQuantity,
            d.ItemGroupID,
            ISNULL(im.Quality, '') AS Quality,
            ISNULL(im.GSM, 0) AS GSM
          FROM ItemTransactionMain m
          INNER JOIN ItemTransactionDetail d ON d.TransactionID = m.TransactionID
            AND (d.IsDeleted = 0 OR d.IsDeleted IS NULL)
            AND (d.IsDeletedTransaction = 0 OR d.IsDeletedTransaction IS NULL)
            AND d.ItemGroupID IN (2, 14)
            AND d.ChallanWeight > 200
          LEFT JOIN WarehouseMaster wm ON d.WarehouseID = wm.WarehouseID
          LEFT JOIN ItemMaster im ON d.ItemID = im.ItemID
          LEFT JOIN LedgerMaster lm ON m.LedgerID = lm.LedgerID
          WHERE m.VoucherID = @VoucherIdGrn
            AND CAST(m.VoucherDate AS DATE) >= @CutoffDate
            AND (m.IsDeleted = 0 OR m.IsDeleted IS NULL)
            AND (m.IsDeletedTransaction = 0 OR m.IsDeletedTransaction IS NULL)
            AND (wm.WarehouseName IS NULL OR wm.WarehouseName NOT LIKE '%tangra%')
            AND NOT EXISTS (
              SELECT 1 FROM RawMaterialQCMain qc
              WHERE qc.TransactionID = d.TransactionID
                AND (qc.TransactionDetailID = d.TransactionDetailID OR qc.TransactionDetailID IS NULL)
            )
        ),
        Classified AS (
          SELECT
            pb.*,
            CASE
              WHEN pb.ItemGroupID = 14
                AND (
                  (pb.Quality LIKE '%binding%' AND pb.Quality LIKE '%board%')
                  OR (pb.Quality LIKE '%hard%' AND pb.Quality LIKE '%board%')
                  OR (pb.ItemName LIKE '%mill%' AND pb.ItemName LIKE '%board%')
                  OR (pb.ItemName LIKE '%hard%' AND pb.ItemName LIKE '%board%')
                ) THEN 'Paper - Binding Board'
              WHEN pb.ItemGroupID = 14 AND pb.GSM > 0 AND pb.GSM <= 42 THEN 'Paper - Bible'
              WHEN pb.ItemGroupID = 14
                AND (pb.Quality LIKE '%gumm%' OR pb.Quality LIKE '%sticker%' OR pb.Quality LIKE '%adhesive%')
                THEN 'Paper - Sticker Sheet'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%grey%' AND pb.Quality LIKE '%back%' THEN 'Paper - Grey Back'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%white%' AND pb.Quality LIKE '%back%' THEN 'Paper - White Back'
              WHEN pb.ItemGroupID = 14
                AND (pb.Quality LIKE '%map%' OR pb.Quality LIKE '%news%' OR pb.Quality LIKE '%ssp%')
                THEN 'Paper - Map'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%fbb%' THEN 'Paper - FBB'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%cbb%' THEN 'Paper - CBB'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%gloss%' THEN 'Paper - Gloss'
              WHEN pb.ItemGroupID = 14 AND pb.Quality LIKE '%matte%' THEN 'Paper - MAT'
              WHEN pb.ItemGroupID = 14 THEN 'Paper - Other'

              WHEN pb.ItemGroupID = 2
                AND (
                  (pb.Quality LIKE '%binding%' AND pb.Quality LIKE '%board%')
                  OR (pb.Quality LIKE '%hard%' AND pb.Quality LIKE '%board%')
                  OR (pb.ItemName LIKE '%mill%' AND pb.ItemName LIKE '%board%')
                  OR (pb.ItemName LIKE '%hard%' AND pb.ItemName LIKE '%board%')
                ) THEN 'Reel - Binding Board'
              WHEN pb.ItemGroupID = 2 AND pb.GSM > 0 AND pb.GSM <= 42 THEN 'Reel - Bible'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%grey%' AND pb.Quality LIKE '%back%' THEN 'Reel - Grey Back'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%white%' AND pb.Quality LIKE '%back%' THEN 'Reel - White Back'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%kraft%' THEN 'Reel - Kraft'
              WHEN pb.ItemGroupID = 2
                AND (pb.Quality LIKE '%map%' OR pb.Quality LIKE '%news%' OR pb.Quality LIKE '%ssp%')
                THEN 'Reel - Map'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%fbb%' THEN 'Reel - FBB'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%cbb%' THEN 'Reel - CBB'
              WHEN pb.ItemGroupID = 2 AND pb.Quality LIKE '%gloss%' THEN 'Reel - Gloss'
              WHEN pb.ItemGroupID = 2 THEN 'Reel - Other'
              ELSE 'Other'
            END AS ClassifiedGroup
          FROM PendingBase pb
        )
        SELECT
          TransactionID,
          TransactionDetailID,
          VoucherDate,
          VoucherNo,
          Vendor,
          ItemName,
          ItemType,
          ReceiptQuantity
        FROM Classified
        WHERE ClassifiedGroup NOT IN ('Paper - Other', 'Reel - Other')
        ORDER BY VoucherDate DESC, TransactionID DESC, TransactionDetailID
      `);
    const rows = result.recordset || [];
    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('[raw-qc] grn-pending error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch pending GRNs' });
  }
});

/**
 * POST /api/raw-qc/item-types
 * Body: { database }
 * Returns distinct ItemGroupID and ItemType from ItemMaster for ItemGroupID IN (2, 14).
 */
router.post('/raw-qc/item-types', async (req, res) => {
  const db = getDb(req.body || {});
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request().query(`
      SELECT DISTINCT ItemGroupID, ItemType
      FROM ItemMaster
      WHERE ItemGroupID IN (2, 14)
        AND (IsDeleted = 0 OR IsDeleted IS NULL)
        AND ItemType IS NOT NULL
        AND LTRIM(RTRIM(ISNULL(ItemType, ''))) <> ''
      ORDER BY ItemType, ItemGroupID
    `);
    const rows = (result.recordset || []).map(r => ({
      itemGroupId: r.ItemGroupID ?? r.itemgroupid,
      itemType: r.ItemType ?? r.itemtype ?? '',
    }));
    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('[raw-qc] item-types error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch item types' });
  }
});

/**
 * POST /api/raw-qc/parameter
 * Body: { database, itemGroupId, parameter, type, value }
 * type: tolerance | value | dropdown
 * value: for value=null, for tolerance=number, for dropdown=selections joined by /
 * Inserts into ItemGroupParameters.
 */
router.post('/raw-qc/parameter', async (req, res) => {
  const { database, itemGroupId, parameter, type, value } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const igid = parseInt(itemGroupId, 10);
  if (Number.isNaN(igid)) {
    return res.status(400).json({ status: false, error: 'Valid itemGroupId is required' });
  }
  const paramName = (parameter || '').toString().trim();
  if (!paramName) {
    return res.status(400).json({ status: false, error: 'Parameter name is required' });
  }
  const typeVal = (type || '').toString().toLowerCase();
  if (!['tolerance', 'value', 'dropdown'].includes(typeVal)) {
    return res.status(400).json({ status: false, error: 'Type must be tolerance, value, or dropdown' });
  }
  let valueToStore = null;
  if (typeVal === 'tolerance') {
    const num = parseFloat(value);
    if (Number.isNaN(num)) {
      return res.status(400).json({ status: false, error: 'Value for tolerance type must be a number' });
    }
    valueToStore = String(value).trim();
  } else if (typeVal === 'dropdown' && value != null && String(value).trim() !== '') {
    valueToStore = String(value).trim();
  }
  try {
    const pool = await getPool(db);
    await pool.request()
      .input('ItemGroupID', sql.Int, igid)
      .input('Parameter', sql.NVarChar(255), paramName)
      .input('Type', sql.NVarChar(50), typeVal)
      .input('Value', sql.NVarChar(500), valueToStore)
      .query(`
        INSERT INTO ItemGroupParameters (ItemGroupID, Parameter, Type, Value, IsDeleted, CreatedOn, ModifiedOn)
        VALUES (@ItemGroupID, @Parameter, @Type, @Value, 0, GETDATE(), GETDATE())
      `);
    return res.json({ status: true, message: 'Parameter added successfully' });
  } catch (err) {
    console.error('[raw-qc] parameter insert error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to add parameter' });
  }
});

/**
 * POST /api/raw-qc/parameters-by-group
 * Body: { database, itemGroupId }
 * Returns all parameters (including soft-deleted) for the item group for the "Modify item group" UI.
 */
router.post('/raw-qc/parameters-by-group', async (req, res) => {
  const { database, itemGroupId } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const igid = parseInt(itemGroupId, 10);
  if (Number.isNaN(igid)) {
    return res.status(400).json({ status: false, error: 'Valid itemGroupId is required' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request()
      .input('ItemGroupID', sql.Int, igid)
      .query(`
        SELECT ID, ItemGroupID, Parameter, Type, Value, IsDeleted, CreatedOn, ModifiedOn
        FROM ItemGroupParameters
        WHERE ItemGroupID = @ItemGroupID
        ORDER BY ID
      `);
    const rows = (result.recordset || []).map(r => ({
      id: r.ID ?? r.id,
      itemGroupId: r.ItemGroupID ?? r.itemgroupid,
      parameter: r.Parameter ?? r.parameter ?? '',
      type: (r.Type ?? r.type ?? '').toString().toLowerCase(),
      value: r.Value ?? r.value ?? null,
      isDeleted: r.IsDeleted ?? r.isdeleted ?? 0,
      createdOn: r.CreatedOn ?? r.createdon,
      modifiedOn: r.ModifiedOn ?? r.modifiedon,
    }));
    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('[raw-qc] parameters-by-group error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch parameters' });
  }
});

/**
 * PATCH /api/raw-qc/parameter/:id
 * Body: { database, parameter?, type?, value? }
 */
router.patch('/raw-qc/parameter/:id', async (req, res) => {
  const { id } = req.params;
  const { database, parameter, type, value } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const pid = parseInt(id, 10);
  if (Number.isNaN(pid)) {
    return res.status(400).json({ status: false, error: 'Valid parameter id is required' });
  }
  const updates = [];
  const pool = await getPool(db);
  const request = pool.request().input('ID', sql.Int, pid);
  if (parameter != null && String(parameter).trim() !== '') {
    updates.push('Parameter = @Parameter');
    request.input('Parameter', sql.NVarChar(255), String(parameter).trim());
  }
  if (type != null && ['tolerance', 'value', 'dropdown'].includes(String(type).toLowerCase())) {
    updates.push('Type = @Type');
    request.input('Type', sql.NVarChar(50), String(type).toLowerCase());
  }
  if (value !== undefined) {
    updates.push('Value = @Value');
    request.input('Value', sql.NVarChar(500), value != null ? String(value).trim() : null);
  }
  if (updates.length === 0) {
    return res.status(400).json({ status: false, error: 'No fields to update' });
  }
  updates.push('ModifiedOn = GETDATE()');
  try {
    await request.query(`
      UPDATE ItemGroupParameters
      SET ${updates.join(', ')}
      WHERE ID = @ID
    `);
    return res.json({ status: true, message: 'Parameter updated successfully' });
  } catch (err) {
    console.error('[raw-qc] parameter update error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to update parameter' });
  }
});

/**
 * POST /api/raw-qc/parameter/:id/delete
 * Body: { database }
 * Soft-delete: set IsDeleted = 1.
 */
router.post('/raw-qc/parameter/:id/delete', async (req, res) => {
  const { id } = req.params;
  const { database } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const pid = parseInt(id, 10);
  if (Number.isNaN(pid)) {
    return res.status(400).json({ status: false, error: 'Valid parameter id is required' });
  }
  try {
    const pool = await getPool(db);
    await pool.request()
      .input('ID', sql.Int, pid)
      .query(`
        UPDATE ItemGroupParameters
        SET IsDeleted = 1, ModifiedOn = GETDATE()
        WHERE ID = @ID
      `);
    return res.json({ status: true, message: 'Parameter deleted successfully' });
  } catch (err) {
    console.error('[raw-qc] parameter delete error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to delete parameter' });
  }
});

/**
 * POST /api/raw-qc/inspection-parameters
 * Body: { database, transactionId, transactionDetailId }
 * Resolves ItemGroupID and ItemID from ItemTransactionDetail for the given (TransactionID, TransactionDetailID),
 * then returns parameters from ItemGroupParameters.
 */
router.post('/raw-qc/inspection-parameters', async (req, res) => {
  const { database, transactionId, transactionDetailId } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const tid = parseInt(transactionId, 10);
  if (Number.isNaN(tid)) {
    return res.status(400).json({ status: false, error: 'Valid transactionId is required' });
  }
  const detailId = transactionDetailId != null && transactionDetailId !== '' ? parseInt(transactionDetailId, 10) : null;
  if (detailId == null || Number.isNaN(detailId)) {
    return res.status(400).json({ status: false, error: 'Valid transactionDetailId is required' });
  }
  try {
    const pool = await getPool(db);
    const detailResult = await pool.request()
      .input('TransactionID', sql.Int, tid)
      .input('TransactionDetailID', sql.Int, detailId)
      .query(`
        SELECT ItemGroupID, ItemID
        FROM ItemTransactionDetail
        WHERE TransactionID = @TransactionID AND TransactionDetailID = @TransactionDetailID
          AND (IsDeleted = 0 OR IsDeleted IS NULL)
          AND (IsDeletedTransaction = 0 OR IsDeletedTransaction IS NULL)
      `);
    const detailRow = detailResult.recordset && detailResult.recordset[0];
    if (!detailRow) {
      return res.json({ status: true, data: [], itemGroupId: null, itemId: null });
    }
    const itemGroupId = detailRow.ItemGroupID ?? detailRow.itemgroupid;
    const itemId = detailRow.ItemID ?? detailRow.itemid;

    let itemDescription = null;
    if (itemId != null) {
      const itemRow = await pool.request()
        .input('ItemID', sql.Int, itemId)
        .query(`SELECT ItemDescription FROM ItemMaster WHERE ItemID = @ItemID`);
      const itemRec = itemRow.recordset && itemRow.recordset[0];
      itemDescription = itemRec && (itemRec.ItemDescription ?? itemRec.itemdescription);
    }

    const paramResult = await pool.request()
      .input('ItemGroupID', sql.Int, itemGroupId)
      .query(`
        SELECT ID, ItemGroupID, Parameter, Type, Value, CreatedOn, ModifiedOn
        FROM ItemGroupParameters
        WHERE ItemGroupID = @ItemGroupID
          AND (IsDeleted = 0 OR IsDeleted IS NULL)
        ORDER BY ID
      `);
    const params = (paramResult.recordset || []).map((r, idx) => {
      const paramName = (r.Parameter ?? r.parameter ?? '').toString().trim();
      const targetValue = paramName ? parseStandardFromItemDescription(itemDescription, paramName) : null;
      return {
        id: r.ID ?? r.id,
        itemGroupId: r.ItemGroupID ?? r.itemgroupid,
        parameter: paramName,
        type: r.Type ?? r.type ?? 'Text',
        value: r.Value ?? r.value ?? null,
        parameterOrder: idx + 1,
        standardValue: (r.Value ?? r.value) != null ? String(r.Value ?? r.value) : null,
        targetValue: targetValue != null && targetValue !== '' ? String(targetValue) : null,
      };
    });
    return res.json({
      status: true,
      data: params,
      itemGroupId: itemGroupId != null ? Number(itemGroupId) : null,
      itemId: itemId != null ? Number(itemId) : null,
    });
  } catch (err) {
    console.error('[raw-qc] inspection-parameters error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch parameters' });
  }
});

/**
 * POST /api/raw-qc/save-inspection
 * Body: { database, userId, transactionId, transactionDetailId, voucherNo, voucherDate, items }
 * items: [{ parameterName, parameterId?, standardValue, actualValue, unit?, parameterOrder? }]
 * ValidationStatus: tolerance = Ok/Not Ok from standard±tolerance; dropdown = actualValue; value = NA
 */
router.post('/raw-qc/save-inspection', async (req, res) => {
  const { database, userId, transactionId, transactionDetailId, voucherNo, voucherDate, items } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const tid = parseInt(transactionId, 10);
  const uid = parseInt(userId, 10);
  const detailId = transactionDetailId != null && transactionDetailId !== '' ? parseInt(transactionDetailId, 10) : null;
  if (Number.isNaN(tid)) {
    return res.status(400).json({ status: false, error: 'Valid transactionId is required' });
  }
  if (detailId == null || Number.isNaN(detailId)) {
    return res.status(400).json({ status: false, error: 'Valid transactionDetailId is required' });
  }
  if (Number.isNaN(uid)) {
    return res.status(400).json({ status: false, error: 'Valid userId is required' });
  }
  if (!voucherNo || !voucherDate) {
    return res.status(400).json({ status: false, error: 'voucherNo and voucherDate are required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: false, error: 'items array is required and must not be empty' });
  }
  try {
    const pool = await getPool(db);
    const voucherDateVal = voucherDate instanceof Date ? voucherDate : new Date(voucherDate);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const mainResult = await transaction.request()
        .input('TransactionID', sql.Int, tid)
        .input('TransactionDetailID', sql.Int, detailId)
        .input('VoucherNo', sql.NVarChar(100), String(voucherNo))
        .input('VoucherDate', sql.Date, voucherDateVal)
        .input('UserId', sql.Int, uid)
        .query(`
          INSERT INTO RawMaterialQCMain (TransactionID, TransactionDetailID, VoucherNo, VoucherDate, UserId)
          OUTPUT INSERTED.Id
          VALUES (@TransactionID, @TransactionDetailID, @VoucherNo, @VoucherDate, @UserId)
        `);
      const mainId = mainResult.recordset && mainResult.recordset[0] && mainResult.recordset[0].Id;
      if (!mainId) {
        await transaction.rollback();
        return res.status(500).json({ status: false, error: 'Failed to insert RawMaterialQCMain' });
      }

      const detailRow = await transaction.request()
        .input('TransactionID', sql.Int, tid)
        .input('TransactionDetailID', sql.Int, detailId)
        .query(`
          SELECT ItemGroupID, ItemID
          FROM ItemTransactionDetail
          WHERE TransactionID = @TransactionID AND TransactionDetailID = @TransactionDetailID
            AND (IsDeleted = 0 OR IsDeleted IS NULL)
            AND (IsDeletedTransaction = 0 OR IsDeletedTransaction IS NULL)
        `);
      const firstDetail = detailRow.recordset && detailRow.recordset[0];
      const itemGroupId = firstDetail ? (firstDetail.ItemGroupID ?? firstDetail.itemgroupid) : null;
      const itemId = firstDetail ? (firstDetail.ItemID ?? firstDetail.itemid) : null;

      let itemDescription = null;
      if (itemId != null) {
        const itemRow = await transaction.request()
          .input('ItemID', sql.Int, itemId)
          .query(`SELECT ItemDescription FROM ItemMaster WHERE ItemID = @ItemID`);
        const itemRec = itemRow.recordset && itemRow.recordset[0];
        itemDescription = itemRec && (itemRec.ItemDescription ?? itemRec.itemdescription);
      }

      const paramList = [];
      if (itemGroupId != null) {
        const paramRows = await transaction.request()
          .input('ItemGroupID', sql.Int, itemGroupId)
          .query(`
            SELECT ID, Parameter, Type, Value
            FROM ItemGroupParameters
            WHERE ItemGroupID = @ItemGroupID AND (IsDeleted = 0 OR IsDeleted IS NULL)
            ORDER BY ID
          `);
        paramList.push(...(paramRows.recordset || []));
      }
      const paramById = {};
      const paramByName = {};
      paramList.forEach((r) => {
        const id = r.ID ?? r.id;
        const name = (r.Parameter ?? r.parameter ?? '').toString().trim();
        paramById[id] = { type: (r.Type ?? r.type ?? '').toString().toLowerCase(), value: r.Value ?? r.value };
        if (name) paramByName[name.toLowerCase()] = { type: (r.Type ?? r.type ?? '').toString().toLowerCase(), value: r.Value ?? r.value };
      });

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const paramId = it.parameterId != null ? parseInt(it.parameterId, 10) : null;
        const paramName = (it.parameterName || '').toString().trim();
        const param = (paramId != null && !Number.isNaN(paramId) ? paramById[paramId] : null) || (paramName ? paramByName[paramName.toLowerCase()] : null) || { type: 'value', value: null };
        const standardFromDesc = paramName ? parseStandardFromItemDescription(itemDescription, paramName) : null;
        const validationStatus = computeValidationStatus(
          param.type,
          param.value,
          it.actualValue,
          standardFromDesc,
          it.standardValue
        );
        const standardToSave = standardFromDesc != null ? String(standardFromDesc) : (it.standardValue != null ? String(it.standardValue) : null);

        await transaction.request()
          .input('RawMaterialQCMainId', sql.Int, mainId)
          .input('ItemGroupParameterID', sql.Int, it.parameterId != null ? it.parameterId : null)
          .input('ParameterName', sql.NVarChar(255), String(it.parameterName || ''))
          .input('StandardValue', sql.NVarChar(500), standardToSave)
          .input('ActualValue', sql.NVarChar(500), String(it.actualValue ?? ''))
          .input('Unit', sql.NVarChar(50), it.unit != null ? String(it.unit) : null)
          .input('ParameterOrder', sql.Int, it.parameterOrder != null ? it.parameterOrder : i + 1)
          .input('ValidationStatus', sql.NVarChar(50), validationStatus)
          .query(`
            INSERT INTO RawMaterialQCDetail (RawMaterialQCMainId, ItemGroupParameterID, ParameterName, StandardValue, ActualValue, Unit, ParameterOrder, ValidationStatus)
            VALUES (@RawMaterialQCMainId, @ItemGroupParameterID, @ParameterName, @StandardValue, @ActualValue, @Unit, @ParameterOrder, @ValidationStatus)
          `);
      }
      await transaction.commit();
      return res.json({
        status: true,
        message: 'Inspection saved successfully',
        rawMaterialQCMainId: mainId,
        voucherNumber: String(voucherNo),
      });
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }
  } catch (err) {
    console.error('[raw-qc] save-inspection error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to save inspection' });
  }
});

/**
 * POST /api/raw-qc/reports/inspector-performance
 * Body: { database, startDate, endDate }
 * Returns count of QC per user per day from RawMaterialQCMain.
 */
router.post('/raw-qc/reports/inspector-performance', async (req, res) => {
  const { database, startDate, endDate } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ status: false, error: 'startDate and endDate are required' });
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ status: false, error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (start > end) {
    return res.status(400).json({ status: false, error: 'Start date cannot be after end date' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request()
      .input('StartDate', sql.Date, start)
      .input('EndDate', sql.Date, end)
      .query(`
        SELECT CAST(q.CreatedAt AS DATE) AS QCDate, q.UserId AS UserID, um.UserName, COUNT(1) AS EntryCount
        FROM RawMaterialQCMain q
        LEFT JOIN UserMaster um ON q.UserId = um.UserID
        WHERE CAST(q.CreatedAt AS DATE) >= @StartDate AND CAST(q.CreatedAt AS DATE) <= @EndDate
        GROUP BY CAST(q.CreatedAt AS DATE), q.UserId, um.UserName
        ORDER BY QCDate DESC, UserName, q.UserId
      `);
    const rows = result.recordset || [];
    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('[raw-qc] inspector-performance error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch report' });
  }
});

/**
 * POST /api/raw-qc/reports/grn-entries
 * Body: { database, voucherNo } or { database, transactionId }
 * Returns QC entries for the given GRN: one row per RawMaterialQCDetail, joined with RawMaterialQCMain.
 * Columns: VoucherNo, TransactionDetailID, AuditDateTime, VoucherDate, ParameterName, StandardValue, ActualValue, ValidationStatus.
 */
router.post('/raw-qc/reports/grn-entries', async (req, res) => {
  const { database, voucherNo, transactionId } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  const byTid = transactionId != null && String(transactionId).trim() !== '';
  const byVoucher = voucherNo != null && String(voucherNo).trim() !== '';
  if (!byTid && !byVoucher) {
    return res.status(400).json({ status: false, error: 'voucherNo or transactionId is required' });
  }
  try {
    const pool = await getPool(db);
    let result;
    if (byTid) {
      const tid = parseInt(transactionId, 10);
      if (Number.isNaN(tid)) {
        return res.status(400).json({ status: false, error: 'Valid transactionId is required' });
      }
      result = await pool.request()
        .input('TransactionID', sql.Int, tid)
        .query(`
          SELECT
            q.VoucherNo,
            q.TransactionDetailID,
            q.CreatedAt AS AuditDateTime,
            q.VoucherDate,
            d.ParameterName,
            d.StandardValue,
            d.ActualValue,
            d.ValidationStatus
          FROM RawMaterialQCMain q
          INNER JOIN RawMaterialQCDetail d ON d.RawMaterialQCMainId = q.Id
          WHERE q.TransactionID = @TransactionID
          ORDER BY q.CreatedAt DESC, d.ParameterOrder, d.ParameterName
        `);
    } else {
      const v = String(voucherNo).trim();
      result = await pool.request()
        .input('VoucherNo', sql.NVarChar(100), v)
        .query(`
          SELECT
            q.VoucherNo,
            q.TransactionDetailID,
            q.CreatedAt AS AuditDateTime,
            q.VoucherDate,
            d.ParameterName,
            d.StandardValue,
            d.ActualValue,
            d.ValidationStatus
          FROM RawMaterialQCMain q
          INNER JOIN RawMaterialQCDetail d ON d.RawMaterialQCMainId = q.Id
          WHERE q.VoucherNo = @VoucherNo
          ORDER BY q.CreatedAt DESC, d.ParameterOrder, d.ParameterName
        `);
    }
    const rows = result.recordset || [];
    return res.json({
      status: true,
      data: rows,
    });
  } catch (err) {
    console.error('[raw-qc] grn-entries error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch GRN entries' });
  }
});

/**
 * POST /api/raw-qc/reports/audit-detail
 * Body: { database, startDate, endDate, userId }
 * Drill-down: list of QC audits for the given user in date range.
 */
router.post('/raw-qc/reports/audit-detail', async (req, res) => {
  const { database, startDate, endDate, userId } = req.body || {};
  const db = getDb({ database });
  if (!db) {
    return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
  }
  if (!startDate || !endDate || userId == null) {
    return res.status(400).json({ status: false, error: 'startDate, endDate and userId are required' });
  }
  const uid = parseInt(userId, 10);
  if (Number.isNaN(uid)) {
    return res.status(400).json({ status: false, error: 'Valid userId is required' });
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ status: false, error: 'Invalid date format.' });
  }
  try {
    const pool = await getPool(db);
    const result = await pool.request()
      .input('StartDate', sql.Date, start)
      .input('EndDate', sql.Date, end)
      .input('UserId', sql.Int, uid)
      .query(`
        SELECT Id, TransactionID, VoucherNo, VoucherDate, UserId, CreatedAt, Remarks
        FROM RawMaterialQCMain
        WHERE UserId = @UserId
          AND CAST(CreatedAt AS DATE) >= @StartDate
          AND CAST(CreatedAt AS DATE) <= @EndDate
        ORDER BY CreatedAt DESC
      `);
    const rows = result.recordset || [];
    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('[raw-qc] audit-detail error:', err);
    return res.status(500).json({ status: false, error: err.message || 'Failed to fetch audit detail' });
  }
});

export default router;
