/**
 * Create PO: deleting and editing a PO in the ERP, from the Purchase orders tab.
 *
 * Any PO may be changed - made with the tool or in the ERP - but only while
 * nothing has happened to it: no goods received (GRN), no paper allocated to
 * a job from it, and no edit of it waiting for approval (Manu, 23 Nov 2026).
 * Of Kolkata's 546 POs in the 30 days to 23 Nov 2026, 445 had a GRN and 53
 * an allocation; changing those would leave stock and job costing wrong.
 *
 * Both follow what the ERP's own screen does:
 *
 *   Delete  marks the header, lines, taxes and requisition links deleted
 *           (IsDeletedTransaction = 1, DeletedBy, DeletedDate) and keeps the
 *           rows. The number is not reused. Its requisition lines are open
 *           again, since "ordered" means a live PO line.
 *   Edit    keeps the header (number, date, supplier) and updates it; the
 *           lines, taxes and requisition links are deleted and written again,
 *           as the ERP does - a live PO never carries a deleted line. The
 *           ERP's triggers keep the old rows: trg_ItemTransactionDetail_Delete
 *           writes each to DeletionLog, the history triggers log the header.
 *           TR_BlockMassDelete_ITD refuses more than 50 lines at once, so a
 *           PO is held to 50 lines.
 *
 * Who did it and why goes to the portal's audit log.
 */

import { query, assertSite, sql, idParam, idSet, withTransaction, txQuery } from '../db/mssql.js';
import { ensureSupplierPortalReady, PoOrder, AuditLog } from '../db/mongo.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';
import { erpNow } from '../lib/erp-time.js';
import { erpWritesEnabled } from './erp-receiving.js';
import { erpRows } from './po-save.js';
import { DELIVERY_ADDRESSES, normalisePaymentTerms } from './po.js';

// ── what stops a change ─────────────────────────────────────────────────────

const LOCK_SQL = `
  SELECT X.PurchaseTransactionID AS Tid, XM.VoucherID, MIN(XM.VoucherNo) AS Ref
  FROM ItemTransactionDetail X
  JOIN ItemTransactionMain XM ON XM.TransactionID = X.TransactionID
   AND XM.VoucherID IN (@grn, @allocation) AND ISNULL(XM.IsDeletedTransaction,0) = 0
  WHERE X.PurchaseTransactionID IN ${idSet('tids')}
    AND ISNULL(X.IsDeletedTransaction,0) = 0
    AND ISNULL(X.IsCancelled,0) = 0
  GROUP BY X.PurchaseTransactionID, XM.VoucherID`;

function lockParams(tids) {
  return { tids: idParam(tids), grn: VOUCHER.GRN, allocation: VOUCHER.ITEM_ALLOCATION };
}

/** Readable reasons, GRN first: it is the one that matters most. */
function lockReasons(rows) {
  const out = new Map();
  for (const r of [...rows].sort((a, b) => Number(a.VoucherID === VOUCHER.GRN ? 0 : 1) - Number(b.VoucherID === VOUCHER.GRN ? 0 : 1))) {
    const tid = Number(r.Tid);
    if (out.has(tid)) continue;
    out.set(tid, Number(r.VoucherID) === VOUCHER.GRN
      ? `Goods already received on ${r.Ref}.`
      : `Paper from it is allocated to a job (${r.Ref}).`);
  }
  return out;
}

/**
 * Why each PO can no longer be edited or deleted; POs not in the map are free.
 * @returns {Promise<Map<number, string>>}
 */
export async function poLocks(site, transactionIds = []) {
  assertSite(site);
  const tids = [...new Set(transactionIds.map(Number).filter(Number.isFinite))];
  if (!tids.length) return new Map();
  const [rows, pending] = await Promise.all([
    query(site, LOCK_SQL, lockParams(tids)),
    pendingEdits(site, tids),
  ]);
  const out = lockReasons(rows);
  for (const tid of pending) if (!out.has(tid)) out.set(tid, 'An edit of it is waiting for approval.');
  return out;
}

async function pendingEdits(site, tids) {
  await ensureSupplierPortalReady();
  const docs = await PoOrder.find({
    site, kind: 'EDIT', status: { $in: ['AWAITING_APPROVAL', 'SAVE_FAILED'] }, 'erp.transactionId': { $in: tids },
  }).select('erp.transactionId').lean();
  return new Set(docs.map((d) => Number(d.erp.transactionId)));
}

/** Inside the write transaction: the PO header, locked, and still free to change. */
async function lockForChange(tx, tid) {
  const [head] = await txQuery(tx, `
    SELECT TransactionID, VoucherNo, VoucherDate, FYear, LedgerID, ISNULL(IsDeletedTransaction,0) AS IsDeleted
    FROM ItemTransactionMain WITH (UPDLOCK, HOLDLOCK)
    WHERE TransactionID = @tid AND CompanyID = @companyId AND VoucherID = @po
  `, { tid: { type: sql.BigInt, value: tid }, companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER });
  if (!head) throw Object.assign(new Error('That PO is not in the ERP.'), { status: 404 });
  if (head.IsDeleted) throw Object.assign(new Error(`${head.VoucherNo} has already been deleted.`), { status: 409 });
  const reason = lockReasons(await txQuery(tx, LOCK_SQL, lockParams([tid]))).get(tid);
  if (reason) throw Object.assign(new Error(`${head.VoucherNo} cannot be changed. ${reason}`), { status: 409 });
  return head;
}

function requireWrites(userId) {
  if (!erpWritesEnabled()) {
    throw Object.assign(new Error('Changing the ERP is switched off on this server (SP_ENABLE_ERP_WRITES).'), { status: 403 });
  }
  if (!(Number(userId) > 0)) {
    throw Object.assign(new Error('No ERP user on this session. Sign out and sign in again with your ERP user name.'), { status: 400 });
  }
}

// ── delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a PO the way the ERP does: every row marked deleted, none removed.
 * @returns {{ transactionId, voucherNo }}
 */
export async function deletePo(site, transactionId, { userId, actor, reason }) {
  assertSite(site);
  const why = String(reason || '').trim();
  if (why.length < 5) throw Object.assign(new Error('Write why the PO is being deleted.'), { status: 422 });
  requireWrites(userId);
  const tid = Number(transactionId);
  await ensureSupplierPortalReady();
  if ((await pendingEdits(site, [tid])).has(tid)) {
    throw Object.assign(new Error('An edit of this PO is waiting for approval. Cancel it first.'), { status: 409 });
  }

  const head = await withTransaction(site, async (tx) => {
    const h = await lockForChange(tx, tid);
    const params = {
      tid: { type: sql.BigInt, value: tid },
      userId: { type: sql.Int, value: Number(userId) },
      now: { type: sql.DateTime, value: erpNow() },
    };
    for (const table of ['ItemTransactionMain', 'ItemTransactionDetail', 'ItemPurchaseOrderTaxes', 'ItemPurchaseRequisitionDetail']) {
      await txQuery(tx, `
        UPDATE ${table} SET IsDeletedTransaction = 1, DeletedBy = @userId, DeletedDate = @now
        WHERE TransactionID = @tid AND ISNULL(IsDeletedTransaction,0) = 0
      `, params);
    }
    return h;
  });

  await PoOrder.updateMany(
    { site, 'erp.transactionId': tid, kind: { $ne: 'EDIT' } },
    { $set: { status: 'DELETED', deleted: { at: new Date(), by: actor?.email || actor?.name || null, reason: why } } },
  );
  await AuditLog.create({
    action: 'PO_DELETED', entity: 'PO', entityId: `${site}:${tid}`, site,
    actor: actor?.email || actor?.name || null, reason: why,
    before: { voucherNo: head.VoucherNo }, meta: { erpUserId: Number(userId) },
  });
  return { transactionId: tid, voucherNo: head.VoucherNo };
}

// ── edit ────────────────────────────────────────────────────────────────────

/**
 * A PO as it stands in the ERP, shaped for the PO screen, with why it cannot
 * be changed (`lockedReason`), if it cannot.
 */
export async function loadPoForEdit(site, transactionId) {
  assertSite(site);
  const tid = Number(transactionId);
  const params = { tid: { type: sql.BigInt, value: tid }, companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER };
  const [heads, lines] = await Promise.all([
    query(site, `
      SELECT M.TransactionID, M.VoucherNo, M.VoucherDate, M.FYear, M.LedgerID, M.TermsOfPayment, M.ModeOfTransport,
             M.DeliveryAddress, M.PurchaseReferenceRemark, ISNULL(M.IsDeletedTransaction,0) AS IsDeleted,
             L.LedgerName, L.GSTNo, L.State, L.City
      FROM ItemTransactionMain M
      LEFT JOIN LedgerMaster L ON L.LedgerID = M.LedgerID AND L.CompanyID = M.CompanyID
      WHERE M.TransactionID = @tid AND M.CompanyID = @companyId AND M.VoucherID = @po
    `, params),
    query(site, `
      SELECT D.TransID, D.ItemID, D.PurchaseOrderQuantity, D.ChallanWeight, D.PurchaseRate, D.ExpectedDeliveryDate,
             D.ClientID, D.RequisitionTransactionID, D.RequiredQuantity, D.RefJobCardContentNo,
             D.RefJobBookingJobCardContentsID, R.VoucherNo AS ReqNo, LM.LedgerName AS ClientName
      FROM ItemTransactionDetail D
      LEFT JOIN ItemTransactionMain R ON R.TransactionID = D.RequisitionTransactionID AND R.VoucherID = @preq
      LEFT JOIN LedgerMaster LM ON LM.LedgerID = D.ClientID AND LM.CompanyID = D.CompanyID
      WHERE D.TransactionID = @tid AND ISNULL(D.IsDeletedTransaction,0) = 0
      ORDER BY D.TransID
    `, { ...params, preq: VOUCHER.PURCHASE_REQUISITION }),
  ]);
  const h = heads[0];
  if (!h) throw Object.assign(new Error('That PO is not in the ERP.'), { status: 404 });

  const locks = h.IsDeleted ? new Map([[tid, 'It has been deleted.']]) : await poLocks(site, [tid]);
  const address = String(h.DeliveryAddress || '').trim();
  const delivery = (DELIVERY_ADDRESSES[site] || []).find((a) => a.address.trim() === address)
    || (DELIVERY_ADDRESSES[site] || []).find((a) => address && (a.address.includes(address.slice(0, 30)) || address.includes(a.address.slice(0, 30))))
    || null;

  return {
    transactionId: tid,
    voucherNo: h.VoucherNo,
    voucherDate: h.VoucherDate,
    fYear: h.FYear,
    supplierLedgerId: Number(h.LedgerID),
    supplier: { ledgerId: Number(h.LedgerID), name: h.LedgerName || '', gstin: String(h.GSTNo || '').trim().toUpperCase() || null, state: h.State || null, city: h.City || null },
    paymentTerms: normalisePaymentTerms(h.TermsOfPayment),
    paymentTermsAsSaved: String(h.TermsOfPayment || '').trim(),
    transport: String(h.ModeOfTransport || '').trim() || null,
    deliveryAddressId: delivery ? delivery.id : null,
    purchaseReference: String(h.PurchaseReferenceRemark || '').trim(),
    lockedReason: locks.get(tid) || null,
    lines: lines.map((d) => ({
      itemId: Number(d.ItemID),
      // In the stock unit: sheets for sheet paper bought by kg, else the PO quantity.
      qty: Number(d.ChallanWeight) || Number(d.PurchaseOrderQuantity) || 0,
      // PurchaseRate is a `real`: 16.32 comes back as 16.31999969482422.
      rate: Math.round(Number(d.PurchaseRate) * 10000) / 10000,
      expectedDate: isoDate(d.ExpectedDeliveryDate),
      clientId: d.ClientID != null && Number(d.ClientID) > 0 ? Number(d.ClientID) : null,
      clientName: d.ClientName || null,
      requisition: Number(d.RequisitionTransactionID) > 0 ? {
        requisitionTransactionId: Number(d.RequisitionTransactionID),
        reqNo: d.ReqNo || null,
        jobRef: String(d.RefJobCardContentNo || '').trim(),
        jobContentsId: String(d.RefJobBookingJobCardContentsID || '').trim(),
        qty: Number(d.RequiredQuantity) || 0,
      } : null,
    })),
  };
}

/** An ERP datetime as India's yyyy-mm-dd: midnight comes back as 00:00Z or 18:30Z the day before. */
function isoDate(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t + 330 * 60000).toISOString().slice(0, 10);
}

/** The PO as it stands, in the form preparePo's `edit` option takes. */
export function editBasis(po) {
  return {
    supplierLedgerId: po.supplierLedgerId,
    linesByItem: new Map(po.lines.map((l) => [l.itemId, l])),
  };
}

/**
 * Write an edited PO over the one in the ERP: header updated, lines, taxes
 * and requisition links written again, in one transaction.
 */
export async function writePoEdit(site, transactionId, prepared, { userId }) {
  assertSite(site);
  requireWrites(userId);
  const tid = Number(transactionId);

  return withTransaction(site, async (tx) => {
    const head = await lockForChange(tx, tid);
    if (Number(head.LedgerID) !== prepared.supplier.ledgerId) {
      throw Object.assign(new Error('The supplier of a PO cannot be changed.'), { status: 422 });
    }
    const rows = erpRows(prepared, { userId: Number(userId), voucherDate: head.VoucherDate, fYear: head.FYear, now: erpNow() });
    const h = rows.header;
    await txQuery(tx, `
      UPDATE ItemTransactionMain SET
        TotalQuantity = @qty, TotalBasicAmount = @basic,
        TotalCGSTTaxAmount = @cgst, TotalSGSTTaxAmount = @sgst, TotalIGSTTaxAmount = @igst,
        TotalTaxAmount = @tax, NetAmount = @net, AmountInWords = @words,
        ModeOfTransport = @transport, PurchaseReferenceRemark = @ref, DeliveryAddress = @address,
        TermsOfPayment = @terms, ModifiedBy = @userId, ModifiedDate = @now
      WHERE TransactionID = @tid
    `, {
      tid: { type: sql.BigInt, value: tid },
      qty: { type: sql.Float, value: h.TotalQuantity },
      basic: { type: sql.Float, value: h.TotalBasicAmount },
      cgst: { type: sql.Float, value: h.TotalCGSTTaxAmount },
      sgst: { type: sql.Float, value: h.TotalSGSTTaxAmount },
      igst: { type: sql.Float, value: h.TotalIGSTTaxAmount },
      tax: { type: sql.Float, value: h.TotalTaxAmount },
      net: { type: sql.Float, value: h.NetAmount },
      words: h.AmountInWords,
      transport: h.ModeOfTransport,
      ref: h.PurchaseReferenceRemark,
      address: h.DeliveryAddress,
      terms: h.TermsOfPayment,
      userId: { type: sql.Int, value: Number(userId) },
      now: { type: sql.DateTime, value: h.ModifiedDate },
    });

    const tidParam = { tid: { type: sql.BigInt, value: tid } };
    for (const table of ['ItemTransactionDetail', 'ItemPurchaseOrderTaxes', 'ItemPurchaseRequisitionDetail']) {
      await txQuery(tx, `DELETE FROM ${table} WHERE TransactionID = @tid`, tidParam);
    }
    for (const d of rows.details) await insertRow(tx, 'ItemTransactionDetail', { ...d, TransactionID: tid });
    for (const t of rows.taxes) await insertRow(tx, 'ItemPurchaseOrderTaxes', { ...t, TransactionID: tid });
    for (const r of rows.requisitions) await insertRow(tx, 'ItemPurchaseRequisitionDetail', { ...r, TransactionID: tid });
    return { transactionId: tid, voucherNo: head.VoucherNo, voucherDate: head.VoucherDate, fYear: head.FYear };
  });
}

function sqlParam(value) {
  if (value === null || value === undefined) return { type: sql.NVarChar, value: null };
  if (value instanceof Date) return { type: sql.DateTime, value };
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 2 ** 31
    ? { type: sql.Int, value } : { type: sql.Float, value };
  return { type: sql.NVarChar, value: String(value) };
}

async function insertRow(tx, table, row) {
  const cols = Object.keys(row);
  await txQuery(tx, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `@p${i}`).join(', ')})`,
    Object.fromEntries(cols.map((c, i) => [`p${i}`, sqlParam(row[c])])));
}

/** For the audit: what an edit changed, line by line. */
export function editSummary(before, prepared) {
  const was = new Map(before.lines.map((l) => [l.itemId, l]));
  const now = new Map(prepared.lines.map((l) => [l.itemId, l]));
  const changes = [];
  for (const [id, l] of now) {
    const o = was.get(id);
    if (!o) { changes.push(`added ${l.itemCode}: ${l.qty} at ${l.rate}`); continue; }
    if (Math.abs(o.qty - l.qty) > 0.0001) changes.push(`${l.itemCode} qty ${o.qty} -> ${l.qty}`);
    if (Math.abs(o.rate - l.rate) > 0.00005) changes.push(`${l.itemCode} rate ${o.rate} -> ${l.rate}`);
    if (o.expectedDate !== l.expectedDate) changes.push(`${l.itemCode} expected ${o.expectedDate} -> ${l.expectedDate}`);
  }
  for (const [id] of was) if (!now.has(id)) changes.push(`removed item ${id}`);
  return changes;
}

