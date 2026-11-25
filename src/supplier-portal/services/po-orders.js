/**
 * Create PO: the life of a PO made with the tool.
 *
 *   createOrder   checked again (po-save.js preparePo); written to the ERP at
 *                 once, or - when free floor stock already covers a line -
 *                 kept as AWAITING_APPROVAL with the buyer's reason
 *   approveOrder  a photo of the signed approval page approves it (Manu, 23
 *                 Nov 2026: the upload is the approval, no second checker);
 *                 it is then checked again and written to the ERP
 *   retrySave     for a PO approved but not written (SAVE_FAILED)
 *   cancelOrder   a PO waiting for approval that is no longer wanted
 *
 *   editOrder     a change to a PO already in the ERP (po-edit.js): written at
 *                 once, or - when it adds kg that free floor stock covers -
 *                 kept as an EDIT awaiting approval, like a new PO
 *
 *   listOrders    the Purchase orders tab: POs in a date range from the ERP
 *                 and from the tool, with where each came from, deleted ones
 *                 included, and why a PO can no longer be changed
 */

import { query, assertSite, sql } from '../db/mssql.js';
import { ensureSupplierPortalReady, PoOrder, AuditLog } from '../db/mongo.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';
import { preparePo, writePoToErp, erpRows } from './po-save.js';
import { loadPoForEdit, editBasis, writePoEdit, editSummary, poLocks } from './po-edit.js';
import { erpWritesEnabled } from './erp-receiving.js';
import { financialYearFor } from './erp-voucher.js';
import { erpNow, erpToday } from '../lib/erp-time.js';

/** Who did it, as the tool records it. */
export function actorOf(req) {
  const user = req.sp?.user || {};
  return {
    email: user.email || req.sp?.actor || null,
    erpUserId: req.sp?.context?.erpUserId != null ? Number(req.sp.context.erpUserId) : null,
    name: user.erpUserName || user.name || user.email || null,
  };
}

/**
 * A new PO from the screen.
 *
 * @returns the order as toOrderJson shapes it
 */
export async function createOrder(site, body, actor) {
  await ensureSupplierPortalReady();
  const prepared = await preparePo(site, body);
  if (body?.dryRun) {
    // Every row the save would write, without writing or recording anything:
    // how the first live PO is checked before it goes into the ERP.
    const voucherDate = erpToday();
    return {
      dryRun: true,
      writesEnabled: erpWritesEnabled(),
      approvalNeeded: prepared.approvalNeeded,
      lines: prepared.lines,
      totals: prepared.totals,
      rows: erpRows(prepared, { userId: actor.erpUserId, voucherDate, fYear: financialYearFor(voucherDate).fYear, now: erpNow() }),
    };
  }
  const reason = String(body?.approvalReason || '').trim();
  if (prepared.approvalNeeded && reason.length < 10) {
    throw Object.assign(new Error('Free floor stock already covers a line. Write why this PO is still needed (at least a few words).'), { status: 422 });
  }

  const doc = new PoOrder({
    site,
    status: prepared.approvalNeeded ? 'AWAITING_APPROVAL' : 'SAVED',
    request: stripRequest(body),
    supplier: prepared.supplier,
    deliveryAddress: prepared.deliveryAddress,
    lines: prepared.lines,
    totals: prepared.totals,
    createdBy: actor,
    approval: { needed: prepared.approvalNeeded, reason: prepared.approvalNeeded ? reason : null },
  });

  if (prepared.approvalNeeded) {
    await doc.save();
    // In full: the screen makes the approval page from it straight away.
    return toOrderJson(doc.toObject(), { full: true });
  }

  // Nothing to approve: write first, record after, so a refused write leaves no record.
  const written = await writePoToErp(site, prepared, { userId: actor.erpUserId });
  doc.erp = { ...written, savedAt: new Date() };
  try {
    await doc.save();
  } catch (err) {
    // The PO is in the ERP whatever happens here; say which one.
    console.error(`[SP][po] ${written.voucherNo} is in the ERP but the tool's record failed to save:`, err.message);
  }
  return toOrderJson(doc.toObject());
}

/**
 * A change to a PO already in the ERP. The PO must still be free to change
 * (po-edit.js poLocks); the same rules as a new PO apply, except that a line
 * left at its rate keeps it and only added kg can need approval.
 */
export async function editOrder(site, transactionId, body, actor) {
  await ensureSupplierPortalReady();
  const before = await loadPoForEdit(site, transactionId);
  if (before.lockedReason) {
    throw Object.assign(new Error(`${before.voucherNo} cannot be changed. ${before.lockedReason}`), { status: 409 });
  }
  const prepared = await preparePo(site, body, { edit: editBasis(before) });
  const changes = editSummary(before, prepared);
  if (body?.dryRun) {
    return {
      dryRun: true,
      writesEnabled: erpWritesEnabled(),
      voucherNo: before.voucherNo,
      approvalNeeded: prepared.approvalNeeded,
      changes,
      lines: prepared.lines,
      totals: prepared.totals,
      rows: erpRows(prepared, { userId: actor.erpUserId, voucherDate: before.voucherDate, fYear: before.fYear, now: erpNow() }),
    };
  }
  const reason = String(body?.approvalReason || '').trim();
  if (prepared.approvalNeeded && reason.length < 10) {
    throw Object.assign(new Error('Free floor stock already covers what this edit adds. Write why it is still needed (at least a few words).'), { status: 422 });
  }

  const doc = new PoOrder({
    site,
    kind: 'EDIT',
    status: prepared.approvalNeeded ? 'AWAITING_APPROVAL' : 'SAVED',
    request: stripRequest(body),
    supplier: prepared.supplier,
    deliveryAddress: prepared.deliveryAddress,
    lines: prepared.lines,
    totals: prepared.totals,
    createdBy: actor,
    approval: { needed: prepared.approvalNeeded, reason: prepared.approvalNeeded ? reason : null },
    erp: { transactionId: before.transactionId, voucherNo: before.voucherNo },
    editOf: { voucherNo: before.voucherNo, changes },
  });
  if (prepared.approvalNeeded) {
    await doc.save();
    return toOrderJson(doc.toObject(), { full: true });
  }
  const written = await writePoEdit(site, before.transactionId, prepared, { userId: actor.erpUserId });
  doc.erp = { ...written, savedAt: new Date() };
  await doc.save();
  await auditEdit(site, doc, actor);
  return toOrderJson(doc.toObject());
}

async function auditEdit(site, doc, actor) {
  await AuditLog.create({
    action: 'PO_EDITED', entity: 'PO', entityId: `${site}:${doc.erp.transactionId}`, site,
    actor: actor?.email || actor?.name || null, reason: doc.approval?.reason || null,
    before: { voucherNo: doc.editOf?.voucherNo }, after: { changes: doc.editOf?.changes || [] },
    meta: { orderId: String(doc._id), approvedOnSignedPage: Boolean(doc.approval?.needed) },
  }).catch((err) => console.warn('[SP][po] audit of an edit failed:', err.message));
}

/** What the buyer sent, kept to re-check the PO when it is approved. */
function stripRequest(body = {}) {
  const { approvalReason: _r, dryRun: _d, ...rest } = body;
  return rest;
}

/**
 * The signed approval page is uploaded: that approves the PO. It is then
 * checked again and written to the ERP. A PO that no longer passes (a rate
 * now above the last one paid, a requisition ordered elsewhere) stays approved but unsaved,
 * with the reason, as SAVE_FAILED.
 */
export async function approveOrder(site, id, { image, actor }) {
  await ensureSupplierPortalReady();
  const doc = await findOrder(site, id);
  if (doc.status !== 'AWAITING_APPROVAL') {
    throw Object.assign(new Error(`This PO is not waiting for approval (${doc.status}).`), { status: 409 });
  }
  doc.approval.signedImage = image;
  doc.approval.approvedAt = new Date();
  doc.approval.approvedBy = { email: actor.email, name: actor.name };
  await doc.save();
  return saveApproved(site, doc, actor);
}

export async function retrySave(site, id, actor) {
  await ensureSupplierPortalReady();
  const doc = await findOrder(site, id);
  if (doc.status !== 'SAVE_FAILED') {
    throw Object.assign(new Error(`Only a PO whose save failed can be saved again (this one is ${doc.status}).`), { status: 409 });
  }
  return saveApproved(site, doc, actor);
}

async function saveApproved(site, doc, actor) {
  try {
    // Written under the buyer who made it; the approver is on the tool's record.
    const userId = doc.createdBy?.erpUserId ?? actor.erpUserId;
    let prepared;
    let written;
    if (doc.kind === 'EDIT') {
      const before = await loadPoForEdit(site, doc.erp.transactionId);
      if (before.lockedReason) throw new Error(`${before.voucherNo} cannot be changed any more. ${before.lockedReason}`);
      prepared = await preparePo(site, doc.request, { orderId: doc._id, edit: editBasis(before) });
      written = await writePoEdit(site, before.transactionId, prepared, { userId });
      doc.editOf = { voucherNo: before.voucherNo, changes: editSummary(before, prepared) };
    } else {
      prepared = await preparePo(site, doc.request, { orderId: doc._id });
      written = await writePoToErp(site, prepared, { userId });
    }
    doc.lines = prepared.lines;
    doc.totals = prepared.totals;
    doc.erp = { ...written, savedAt: new Date() };
    doc.status = 'SAVED';
    doc.lastError = null;
    if (doc.kind === 'EDIT') await auditEdit(site, doc, actor);
  } catch (err) {
    doc.status = 'SAVE_FAILED';
    doc.lastError = err.message;
  }
  await doc.save();
  return toOrderJson(doc.toObject());
}

export async function cancelOrder(site, id, actor) {
  await ensureSupplierPortalReady();
  const doc = await findOrder(site, id);
  if (!['AWAITING_APPROVAL', 'SAVE_FAILED'].includes(doc.status)) {
    throw Object.assign(new Error(`A ${doc.status} PO cannot be cancelled here.`), { status: 409 });
  }
  doc.status = 'CANCELLED';
  doc.cancelled = { at: new Date(), by: actor.email || actor.name };
  await doc.save();
  return toOrderJson(doc.toObject());
}

async function findOrder(site, id) {
  const doc = /^[a-f0-9]{24}$/i.test(String(id)) ? await PoOrder.findOne({ _id: id, site }) : null;
  if (!doc) throw Object.assign(new Error('PO not found.'), { status: 404 });
  return doc;
}

export async function getOrder(site, id) {
  await ensureSupplierPortalReady();
  return toOrderJson((await findOrder(site, id)).toObject(), { full: true });
}

/** POs waiting for approval, or approved but not saved: the Pending approval page. */
export async function approvalQueue(site) {
  await ensureSupplierPortalReady();
  const docs = await PoOrder.find({ site, status: { $in: ['AWAITING_APPROVAL', 'SAVE_FAILED'] } })
    .sort({ createdAt: -1 }).lean();
  return docs.map((d) => toOrderJson(d, { full: true }));
}

/** The signed page's storage key, for a short-lived view link. */
export async function approvalImageKey(site, id) {
  await ensureSupplierPortalReady();
  const doc = await findOrder(site, id);
  const key = doc.approval?.signedImage?.key;
  if (!key) throw Object.assign(new Error('No signed approval page has been uploaded for this PO.'), { status: 404 });
  return key;
}

/**
 * The Purchase orders tab: every PO dated in the range, from the ERP and
 * from the tool. A tool PO written to the ERP is one row, marked Tool; a
 * tool PO not (yet) in the ERP is listed by the day it was made.
 */
export async function listOrders(site, { from, to }) {
  assertSite(site);
  await ensureSupplierPortalReady();
  const [erpRows, toolDocs] = await Promise.all([
    query(site, `
      SELECT ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITM.LedgerID,
             LM.LedgerName, ITM.NetAmount, U.UserName, ISNULL(ITM.IsDeletedTransaction,0) AS IsDeleted,
             DU.UserName AS DeletedByName, ITM.DeletedDate,
             (SELECT COUNT(*) FROM ItemTransactionDetail D
              WHERE D.TransactionID = ITM.TransactionID
                AND ISNULL(D.IsDeletedTransaction,0) = ISNULL(ITM.IsDeletedTransaction,0)) AS LineCount
      FROM ItemTransactionMain ITM
      LEFT JOIN LedgerMaster LM ON LM.LedgerID = ITM.LedgerID AND LM.CompanyID = ITM.CompanyID
      LEFT JOIN UserMaster U ON U.UserID = ITM.CreatedBy
      LEFT JOIN UserMaster DU ON DU.UserID = ITM.DeletedBy
      WHERE ITM.CompanyID = @companyId
        AND ITM.VoucherID = @po
        AND ITM.VoucherDate >= @from AND ITM.VoucherDate < DATEADD(DAY, 1, @to)
    `, {
      companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER,
      from: { type: sql.Date, value: from }, to: { type: sql.Date, value: to },
    }),
    PoOrder.find({
      site,
      kind: { $ne: 'EDIT' },
      $or: [
        { 'erp.transactionId': { $ne: null } },
        { createdAt: { $gte: from, $lt: new Date(to.getTime() + 86400000) } },
      ],
    }).lean(),
  ]);

  const toolByTid = new Map(toolDocs.filter((d) => d.erp?.transactionId).map((d) => [Number(d.erp.transactionId), d]));
  const locks = await poLocks(site, erpRows.filter((r) => !r.IsDeleted).map((r) => r.TransactionID));
  const rows = erpRows.map((r) => {
    const tool = toolByTid.get(Number(r.TransactionID));
    const tid = Number(r.TransactionID);
    return {
      id: tool ? String(tool._id) : null,
      transactionId: Number(r.TransactionID),
      voucherNo: r.VoucherNo,
      poDate: r.VoucherDate,
      supplierName: r.LedgerName || '',
      lineCount: Number(r.LineCount) || 0,
      netAmount: Number(r.NetAmount) || 0,
      source: tool ? 'Tool' : 'ERP',
      status: r.IsDeleted ? 'DELETED' : 'SAVED',
      preparedBy: tool?.createdBy?.name || r.UserName || '',
      approvalNeeded: Boolean(tool?.approval?.needed),
      // Why Edit and Delete are off for this PO; null when it is free to change.
      lockedReason: r.IsDeleted ? 'Deleted.' : (locks.get(tid) || null),
      deletedBy: r.IsDeleted ? (r.DeletedByName || null) : undefined,
      deletedReason: r.IsDeleted ? (tool?.deleted?.reason || null) : undefined,
    };
  });
  const inErp = new Set(rows.map((r) => r.transactionId));
  for (const d of toolDocs) {
    if (d.erp?.transactionId && inErp.has(Number(d.erp.transactionId))) continue;
    if (d.erp?.transactionId) continue; // in the ERP but dated outside the range
    const made = new Date(d.createdAt);
    if (made < from || made >= new Date(to.getTime() + 86400000)) continue;
    rows.push({ ...toOrderJson(d), source: 'Tool' });
  }
  return rows.sort((a, b) => new Date(b.poDate) - new Date(a.poDate) || String(b.voucherNo || '').localeCompare(String(a.voucherNo || '')));
}

/** A tool PO as the screen shows it. `full` adds the lines and the approval page's facts. */
export function toOrderJson(d, { full = false } = {}) {
  const base = {
    id: String(d._id),
    transactionId: d.erp?.transactionId ?? null,
    voucherNo: d.erp?.voucherNo || null,
    poDate: d.erp?.voucherDate || d.createdAt,
    supplierName: d.supplier?.name || '',
    lineCount: (d.lines || []).length,
    netAmount: d.totals?.net ?? null,
    source: 'Tool',
    status: d.status,
    preparedBy: d.createdBy?.name || d.createdBy?.email || '',
    approvalNeeded: Boolean(d.approval?.needed),
    kind: d.kind || 'CREATE',
    editOf: d.kind === 'EDIT' ? { voucherNo: d.editOf?.voucherNo || d.erp?.voucherNo || null, changes: d.editOf?.changes || [] } : undefined,
    lastError: d.lastError || null,
    duplicateOf: d.erp?.duplicateOf?.length ? d.erp.duplicateOf : undefined,
  };
  if (!full) return base;
  return {
    ...base,
    createdAt: d.createdAt,
    supplier: d.supplier,
    deliveryAddress: d.deliveryAddress,
    request: d.request,
    lines: d.lines,
    totals: d.totals,
    approval: {
      needed: Boolean(d.approval?.needed),
      reason: d.approval?.reason || null,
      approvedAt: d.approval?.approvedAt || null,
      approvedBy: d.approval?.approvedBy?.name || d.approval?.approvedBy?.email || null,
      hasSignedImage: Boolean(d.approval?.signedImage?.key),
    },
  };
}
