/**
 * Editing and deleting a posted GRN. Writes to the ERP, so:
 *
 *  1. **Gated** behind SP_ENABLE_ERP_WRITES, like posting. Until then only the
 *     dry run works - it returns exactly what would change.
 *  2. **Only named people**: ERP user names listed in SP_GRN_EDITORS. Unset,
 *     nobody may edit or delete.
 *  3. **The rules are checked twice**: once for the page, and again inside the
 *     write's own transaction, on rows locked against change, so nothing that
 *     happened in between - an issue, a purchase invoice, someone else's edit -
 *     slips past.
 *
 * The rules (agreed with CDC, 22 Oct 2026):
 *  - Header fields may always change.
 *  - A GRN with a live purchase invoice keeps its quantities and lines, and
 *    cannot be deleted, until that invoice is deleted in the ERP.
 *  - A line stock has been issued from cannot be removed, its stock quantity
 *    cannot drop below what was issued, and its warehouse cannot change.
 *  - A GRN any of whose lines has been issued from cannot be deleted.
 *
 * How this differs from the ERP's own screen, deliberately: the ERP's GRN edit
 * deletes every line and inserts them again with new TransactionDetailIDs
 * (REC04612_26_27: 9 lines hard-deleted on an edit, per DeletionLog). Issues
 * point at a GRN line by that id (BatchID), so that would cut them loose.
 * Here lines are updated in place and keep their ids. A removed line, and a
 * deleted GRN, are flagged IsDeletedTransaction = 1 with DeletedBy/Date, as
 * the ERP does on its own GRN delete (REC04715_26_27: header and all 3 lines).
 * The ERP's history triggers record the before and after of each change.
 */

import { withTransaction, txQuery, query, sql, assertSite } from '../db/mssql.js';
import { COMPANY_ID, TOLERANCES } from '../config/constants.js';
import { erpWritesEnabled, refreshStock, repairItemStock } from './erp-receiving.js';
import { loadGrn } from './grn-register.js';
import { purchaseQtyFromStock, stockQtyFromPurchase } from './receipt-units.js';

const HEADER_FIELDS = ['deliveryNoteNo', 'deliveryNoteDate', 'gateEntryNo', 'gateEntryDate', 'eWayBillNo', 'eWayBillDate', 'vehicleNo', 'receivedBy'];
const DATE_FIELDS = new Set(['deliveryNoteDate', 'gateEntryDate', 'eWayBillDate']);

/** May this signed-in person edit and delete posted GRNs? */
export function canEditGrns(user) {
  const names = String(process.env.SP_GRN_EDITORS || '')
    .split(',').map((n) => n.trim().toUpperCase()).filter(Boolean);
  const me = String(user?.erpUserName || '').trim().toUpperCase();
  return Boolean(me) && names.includes(me);
}

const finite = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const dayOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};
const blank = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Pure: check an edit against the GRN as it stands, and say what would change.
 *
 * @param {Object} grn  from loadGrn()
 * @param {Object} edit {header: {...}, lines: [{transactionDetailId, stockQty?, qty?, warehouseId?, remove?}]}
 * @returns {{header: Array, lines: Array, removals: Array, errors: Array}}
 */
export function planGrnEdit(grn, edit = {}) {
  const errors = [];
  const header = [];
  for (const field of HEADER_FIELDS) {
    if (!edit.header || !(field in edit.header)) continue;
    const wanted = edit.header[field];
    let before; let after;
    if (DATE_FIELDS.has(field)) {
      before = dayOf(grn.header[field]);
      after = dayOf(wanted);
      if (after === undefined) { errors.push(`${field} is not a date.`); continue; }
    } else if (field === 'receivedBy') {
      before = finite(grn.header.receivedBy);
      after = finite(wanted);
      if (!(after > 0)) { errors.push('Choose who received it.'); continue; }
    } else {
      before = blank(grn.header[field]);
      after = blank(wanted);
    }
    if (before !== after) header.push({ field, before, after });
  }
  if (header.some((h) => h.field === 'deliveryNoteNo' && !h.after)) errors.push('The D.N. / invoice no. cannot be blank.');

  const byId = new Map(grn.lines.map((l) => [l.transactionDetailId, l]));
  const lines = [];
  const removals = [];
  for (const change of edit.lines || []) {
    const line = byId.get(Number(change.transactionDetailId));
    if (!line) { errors.push(`GRN line ${change.transactionDetailId} is not on ${grn.voucherNo}.`); continue; }

    if (change.remove) {
      if (line.removeLocked) errors.push(`Line ${line.lineNo}: ${line.removeLocked}`);
      else removals.push({ transactionDetailId: line.transactionDetailId, lineNo: line.lineNo, itemId: line.itemId });
      continue;
    }

    const row = { transactionDetailId: line.transactionDetailId, lineNo: line.lineNo, itemId: line.itemId, changes: [] };
    const units = line;
    let stockQty = null; let qty = null;
    if (change.stockQty !== undefined) {
      stockQty = finite(change.stockQty);
      qty = purchaseQtyFromStock(stockQty, units);
    } else if (change.qty !== undefined) {
      qty = finite(change.qty);
      stockQty = stockQtyFromPurchase(qty, units);
    }
    if (stockQty !== null || qty !== null) {
      const changed = Math.abs((stockQty ?? 0) - (line.stockQty ?? 0)) > 1e-6 || Math.abs((qty ?? 0) - (line.qty ?? 0)) > 1e-6;
      if (changed) {
        if (line.qtyLocked) errors.push(`Line ${line.lineNo}: ${line.qtyLocked}`);
        else if (!(stockQty > 0) || !(qty > 0)) errors.push(`Line ${line.lineNo}: the quantity must be more than 0.`);
        else if (stockQty + 1e-6 < line.minStockQty) {
          errors.push(`Line ${line.lineNo}: ${line.minStockQty} ${line.stockUnit || ''} has already been issued from it `
            + `(${line.issues.map((i) => i.issueNo).join(', ')}); it cannot go below that.`.replace('  ', ' '));
        } else {
          row.changes.push({ field: 'stockQty', before: line.stockQty, after: stockQty });
          row.changes.push({ field: 'qty', before: line.qty, after: qty });
        }
      }
    }
    if (change.warehouseId !== undefined) {
      const wh = finite(change.warehouseId);
      if (wh !== line.warehouseId) {
        if (line.warehouseLocked) errors.push(`Line ${line.lineNo}: ${line.warehouseLocked}`);
        else if (!(wh > 0)) errors.push(`Line ${line.lineNo}: choose a warehouse.`);
        else row.changes.push({ field: 'warehouseId', before: line.warehouseId, after: wh });
      }
    }
    if (row.changes.length) lines.push(row);
  }
  if (removals.length && removals.length >= grn.lines.length) {
    errors.push('That removes every line. Delete the GRN instead.');
  }
  if (!errors.length && !header.length && !lines.length && !removals.length) errors.push('Nothing has changed.');
  return { header, lines, removals, errors };
}

/** PO lines this change leaves closed with more than the tolerance still pending. */
async function closedPoWarnings(q, grn, plan) {
  const touched = new Set([
    ...plan.lines.filter((l) => l.changes.some((c) => c.field === 'qty')).map((l) => l.transactionDetailId),
    ...plan.removals.map((r) => r.transactionDetailId),
  ]);
  const poLines = grn.lines.filter((l) => touched.has(l.transactionDetailId) && l.poCompleted && l.poTransactionDetailId);
  const notes = [];
  for (const l of poLines) {
    const [po] = await q(`
      SELECT P.PurchaseOrderQuantity AS Ordered,
             P.PurchaseOrderQuantity - ISNULL((
               SELECT SUM(ISNULL(G.ChallanWeight,0)) FROM ItemTransactionDetail G
               JOIN ItemTransactionMain GM ON GM.TransactionID = G.TransactionID AND GM.CompanyID = G.CompanyID
               WHERE G.PurchaseTransactionID = P.TransactionID AND G.ItemID = P.ItemID AND G.CompanyID = P.CompanyID
                 AND GM.VoucherID = -14 AND ISNULL(GM.IsDeletedTransaction,0) = 0
                 AND ISNULL(G.IsDeletedTransaction,0) = 0 AND ISNULL(G.IsCancelled,0) = 0), 0) AS Pending
      FROM ItemTransactionDetail P WHERE P.TransactionDetailID = @id AND P.CompanyID = @companyId
    `, { id: l.poTransactionDetailId, companyId: COMPANY_ID });
    if (!po) continue;
    const change = plan.lines.find((x) => x.transactionDetailId === l.transactionDetailId)?.changes.find((c) => c.field === 'qty');
    const removed = plan.removals.some((r) => r.transactionDetailId === l.transactionDetailId);
    const pendingAfter = Number(po.Pending) + (removed ? (l.qty || 0) : change ? (change.before - change.after) : 0);
    if (pendingAfter > Number(po.Ordered) * TOLERANCES.closurePendingPct) {
      notes.push(`${l.poVoucherNo} (${l.itemCode}) is closed but would have ${Math.round(pendingAfter * 1000) / 1000} pending. Reopen it in the ERP if more is coming.`);
    }
  }
  return notes;
}

const sameStamp = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** Lock the GRN header, then reload it inside the transaction. */
async function lockAndLoad(tx, transactionId, expectedModifiedDate) {
  await txQuery(tx, `
    SELECT TransactionID FROM ItemTransactionMain WITH (UPDLOCK, HOLDLOCK)
    WHERE TransactionID = @tid AND CompanyID = @companyId
  `, { tid: { type: sql.Int, value: Number(transactionId) }, companyId: { type: sql.Int, value: COMPANY_ID } });
  const grn = await loadGrn((t, p) => txQuery(tx, t, p), transactionId);
  if (!grn) throw fail('That GRN no longer exists - it may have been deleted.', 404);
  if (expectedModifiedDate !== undefined && !sameStamp(grn.modifiedDate, expectedModifiedDate)) {
    throw fail(`${grn.voucherNo} was changed by someone else since you opened it. Open it again.`, 409);
  }
  return grn;
}

const COLUMN = {
  deliveryNoteNo: ['DeliveryNoteNo', sql.NVarChar(100)],
  deliveryNoteDate: ['DeliveryNoteDate', sql.DateTime],
  gateEntryNo: ['GateEntryNo', sql.NVarChar(100)],
  gateEntryDate: ['GateEntryDate', sql.DateTime],
  eWayBillNo: ['EWayBillNumber', sql.NVarChar(100)],
  eWayBillDate: ['EWayBillDate', sql.DateTime],
  vehicleNo: ['VehicleNo', sql.NVarChar(100)],
  receivedBy: ['ReceivedBy', sql.Int],
};

/**
 * Edit a posted GRN. `dryRun` (or writes off) returns the plan and writes
 * nothing.
 */
export async function editGrn(site, { transactionId, edit, userId, expectedModifiedDate, dryRun = false }) {
  assertSite(site);
  if (!dryRun && !erpWritesEnabled()) throw fail('ERP writes are disabled. Set SP_ENABLE_ERP_WRITES=true once this has been verified. Use the dry run to see what would change.', 403);
  if (!dryRun && !(Number(userId) > 0)) throw fail('No ERP user on this session to record the change against.', 400);

  if (dryRun) {
    const grn = await loadGrn((t, p) => query(site, t, p), transactionId);
    if (!grn) throw fail('That GRN no longer exists - it may have been deleted.', 404);
    const plan = planGrnEdit(grn, edit);
    if (plan.errors.length) throw Object.assign(fail(plan.errors.join(' '), 409), { plan });
    const notes = await closedPoWarnings((t, p) => query(site, t, p), grn, plan);
    return { dryRun: true, voucherNo: grn.voucherNo, plan, notes };
  }

  const result = await withTransaction(site, async (tx) => {
    const grn = await lockAndLoad(tx, transactionId, expectedModifiedDate);
    const plan = planGrnEdit(grn, edit);
    if (plan.errors.length) throw Object.assign(fail(plan.errors.join(' '), 409), { plan });
    const notes = await closedPoWarnings((t, p) => txQuery(tx, t, p), grn, plan);
    const now = new Date();
    const who = { type: sql.Int, value: Number(userId) };
    const tid = { type: sql.Int, value: Number(transactionId) };
    const companyId = { type: sql.Int, value: COMPANY_ID };

    for (const line of plan.lines) {
      const set = []; const params = { id: { type: sql.Int, value: line.transactionDetailId }, tid, companyId, who, now: { type: sql.DateTime, value: now } };
      for (const c of line.changes) {
        if (c.field === 'stockQty') {
          set.push('ChallanQuantity = @stockQty', 'ReceiptQuantity = @stockQty', 'ApprovedQuantity = @stockQty');
          params.stockQty = { type: sql.Float, value: c.after };
        } else if (c.field === 'qty') {
          set.push('ChallanWeight = @qty');
          params.qty = { type: sql.Float, value: c.after };
        } else if (c.field === 'warehouseId') {
          set.push('WarehouseID = @wh');
          params.wh = { type: sql.Int, value: c.after };
        }
      }
      await txQuery(tx, `
        UPDATE ItemTransactionDetail SET ${set.join(', ')}, ModifiedBy = @who, ModifiedDate = @now
        WHERE TransactionDetailID = @id AND TransactionID = @tid AND CompanyID = @companyId
          AND ISNULL(IsDeletedTransaction,0) = 0
      `, params);
    }

    for (const r of plan.removals) {
      await txQuery(tx, `
        UPDATE ItemTransactionDetail SET IsDeletedTransaction = 1, DeletedBy = @who, DeletedDate = @now
        WHERE TransactionDetailID = @id AND TransactionID = @tid AND CompanyID = @companyId
      `, { id: { type: sql.Int, value: r.transactionDetailId }, tid, companyId, who, now: { type: sql.DateTime, value: now } });
    }

    const set = ['ModifiedBy = @who', 'ModifiedDate = @now',
      `TotalQuantity = (SELECT ISNULL(SUM(ChallanWeight),0) FROM ItemTransactionDetail
                        WHERE TransactionID = @tid AND CompanyID = @companyId AND ISNULL(IsDeletedTransaction,0) = 0)`];
    const params = { tid, companyId, who, now: { type: sql.DateTime, value: now } };
    for (const h of plan.header) {
      const [column, type] = COLUMN[h.field];
      set.push(`${column} = @h_${h.field}`);
      params[`h_${h.field}`] = { type, value: DATE_FIELDS.has(h.field) ? (h.after ? new Date(`${h.after}T00:00:00`) : null) : h.after };
    }
    await txQuery(tx, `
      UPDATE ItemTransactionMain SET ${set.join(', ')}
      WHERE TransactionID = @tid AND CompanyID = @companyId AND ISNULL(IsDeletedTransaction,0) = 0
    `, params);

    return { voucherNo: grn.voucherNo, plan, notes };
  });

  // Outside the transaction and best-effort, as after posting.
  result.stockRefresh = await refreshStock(site, Number(transactionId));
  for (const r of result.plan.removals) await repairItemStock(site, r.itemId).catch(() => null);
  return { dryRun: false, ...result };
}

/** Delete a posted GRN - only one with no live purchase invoice and nothing issued. */
export async function deleteGrn(site, { transactionId, userId, expectedModifiedDate, dryRun = false }) {
  assertSite(site);
  if (!dryRun && !erpWritesEnabled()) throw fail('ERP writes are disabled. Set SP_ENABLE_ERP_WRITES=true once this has been verified. Use the dry run to see what would change.', 403);
  if (!dryRun && !(Number(userId) > 0)) throw fail('No ERP user on this session to record the delete against.', 400);

  const check = async (q, grn) => {
    if (grn.deleteLocked) throw fail(`${grn.voucherNo} cannot be deleted. ${grn.deleteLocked}`, 409);
    const plan = { header: [], lines: [], removals: grn.lines.map((l) => ({ transactionDetailId: l.transactionDetailId, lineNo: l.lineNo, itemId: l.itemId })) };
    return { plan, notes: await closedPoWarnings(q, grn, plan) };
  };

  if (dryRun) {
    const q = (t, p) => query(site, t, p);
    const grn = await loadGrn(q, transactionId);
    if (!grn) throw fail('That GRN no longer exists - it may have been deleted.', 404);
    const { plan, notes } = await check(q, grn);
    return { dryRun: true, voucherNo: grn.voucherNo, lines: plan.removals.length, notes };
  }

  const result = await withTransaction(site, async (tx) => {
    const grn = await lockAndLoad(tx, transactionId, expectedModifiedDate);
    const { plan, notes } = await check((t, p) => txQuery(tx, t, p), grn);
    const params = {
      tid: { type: sql.Int, value: Number(transactionId) }, companyId: { type: sql.Int, value: COMPANY_ID },
      who: { type: sql.Int, value: Number(userId) }, now: { type: sql.DateTime, value: new Date() },
    };
    await txQuery(tx, `
      UPDATE ItemTransactionDetail SET IsDeletedTransaction = 1, DeletedBy = @who, DeletedDate = @now
      WHERE TransactionID = @tid AND CompanyID = @companyId AND ISNULL(IsDeletedTransaction,0) = 0
    `, params);
    await txQuery(tx, `
      UPDATE ItemTransactionMain SET IsDeletedTransaction = 1, DeletedBy = @who, DeletedDate = @now
      WHERE TransactionID = @tid AND CompanyID = @companyId AND ISNULL(IsDeletedTransaction,0) = 0
    `, params);
    return { voucherNo: grn.voucherNo, lines: plan.removals.length, itemIds: [...new Set(plan.removals.map((r) => r.itemId))], notes };
  });

  for (const itemId of result.itemIds) await repairItemStock(site, itemId).catch(() => null);
  return { dryRun: false, ...result };
}
