/**
 * Create PO: checking a PO again on the server, and writing it to the ERP.
 *
 * The screen applies every rule as the buyer types (Create-PO po-math.js);
 * nothing it sends is trusted. `preparePo` works the whole PO out again from
 * the ERP and the supplier portal - the supplier's ledger, each item, the
 * approved price it may be bought at, the quantities and tax, the
 * requisition lines it closes and the free floor stock that makes it need
 * approval - with the same arithmetic (lib/po-math.cjs is that file).
 *
 * `writePoToErp` writes what the ERP's own PO screen writes, studied on
 * PO04017_26_27 (saved once, from PREQ00620) and the FY 2026-27 lines:
 *
 *   ItemTransactionMain            1 row, VoucherID -11
 *   ItemTransactionDetail          1 per line
 *   ItemPurchaseOrderTaxes         1 per tax ledger with an amount
 *   ItemPurchaseRequisitionDetail  1 per line made from a requisition
 *
 * in one transaction with the number allocated under a lock (erp-voucher.js).
 * The ERP's own screen reads the next number without one, so after commit the
 * number is checked again and a clash is recorded, not hidden.
 *
 * Writing is behind the same switch as receiving: SP_ENABLE_ERP_WRITES and a
 * write login.
 */

import PoMath from '../lib/po-math.cjs';
import { query, assertSite, sql, idParam, idSet, withTransaction, txQuery } from '../db/mssql.js';
import { ensureSupplierPortalReady, PoOrder } from '../db/mongo.js';
import { COMPANY_ID, VOUCHER, VOUCHER_PREFIX } from '../config/constants.js';
import { allocateVoucherNo, financialYearFor } from './erp-voucher.js';
import { erpNow, erpToday } from '../lib/erp-time.js';
import { erpWritesEnabled } from './erp-receiving.js';
import { compareItem } from './proposals.js';
import { getItems, hsnForItems } from './erp-items.js';
import { supplierLedgers } from './erp-ledgers.js';
import { normaliseGstin } from './supplier-groups.js';
import {
  DELIVERY_ADDRESSES, PAYMENT_TERMS, TRANSPORT_MODES, PURCHASE_DIVISION, CURRENCY_CODE,
  supplierResolver, bufferStock, toPoItem, firstJobNo,
} from './po.js';

const M = PoMath;

/** GST ledgers on ItemPurchaseOrderTaxes: the same IDs in both plants (FY 2026-27). */
export const PO_TAX_LEDGERS = { CGST: 6, SGST: 7, IGST: 8 };

/** The ERP stamps every PO line approved by Admin (UserID 2) at save. */
const ERP_APPROVER_USER_ID = 2;

/** nvarchar(512) holds 256 characters. */
const REF_MAX = 256;

/** A PO the server will not accept, with every reason, so the buyer can fix them all at once. */
export class PoRejected extends Error {
  constructor(problems) {
    super(problems.length === 1 ? problems[0] : `${problems.length} things stop this PO: ${problems.join(' ')}`);
    this.status = 422;
    this.problems = problems;
  }
}

// ── working a PO out ────────────────────────────────────────────────────────

/**
 * The PO as it would be written: every figure worked out here, every rule
 * checked. Throws PoRejected listing all the problems.
 *
 * @param {'KOL'|'AHM'} site
 * @param {Object} body  as the screen sends it (savePo() in Create-PO app.js)
 * @param {Object} [opts]
 * @param {string} [opts.orderId]  a tool PO being saved after approval: its
 *   own requisition lines are not "held by another PO"
 * @param {Object} [opts.edit]  editing an ERP PO: the PO as it stands
 *   (po-edit.js loadPoForEdit). The supplier stays; a line left at its rate
 *   keeps it, approved or not; a line keeps its requisition link and client;
 *   and only a new line, or one ordering more kg, can need approval.
 */
export async function preparePo(site, body, { orderId = null, edit = null } = {}) {
  assertSite(site);
  const b = body || {};
  const problems = [];

  const ledgers = await supplierLedgers(site);
  const ledger = ledgers.find((l) => Number(l.LedgerID) === Number(b.supplierLedgerId));
  if (!ledger) throw new PoRejected(['Choose a supplier.']);
  const supplier = {
    ledgerId: Number(ledger.LedgerID),
    name: ledger.LedgerName,
    gstin: normaliseGstin(ledger.GSTNo),
    state: ledger.State || null,
    city: ledger.City || null,
  };
  if (edit && supplier.ledgerId !== Number(edit.supplierLedgerId)) {
    problems.push('The supplier of a PO cannot be changed. Delete it and make a new PO for the other supplier.');
  }

  const address = (DELIVERY_ADDRESSES[site] || []).find((a) => a.id === b.deliveryAddressId);
  if (!address) problems.push('Choose where the goods are delivered.');
  if (!PAYMENT_TERMS.includes(b.paymentTerms)) problems.push('Choose the payment terms.');
  if (!TRANSPORT_MODES.includes(b.transport)) problems.push('Choose the mode of transport.');

  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length) problems.push('Add at least one item.');
  // The ERP refuses to delete more than 50 lines at once (TR_BlockMassDelete_ITD),
  // and an edit rewrites every line.
  if (raw.length > 50) problems.push('A PO can have at most 50 lines.');
  // The ERP never puts an item twice on one PO; receipts match a PO line by
  // PO + item, so a second line for the same item could not be received.
  const seen = new Set();
  for (const l of raw) {
    if (seen.has(Number(l.itemId))) problems.push(`Item ${l.itemId} is on the PO twice. Put it on one line.`);
    seen.add(Number(l.itemId));
  }
  if (problems.length) throw new PoRejected(problems);

  const ids = raw.map((l) => Number(l.itemId));
  // On an edit, requisition links come from the PO as it stands, never from the screen.
  const reqLineIds = edit ? [] : raw.flatMap((l) => (l.requisitionLineIds || []).map(String));
  const [items, hsn, resolve, reqs, held] = await Promise.all([
    getItems(site, ids),
    hsnForItems(site, ids),
    supplierResolver(site),
    requisitionLines(site, reqLineIds),
    reqLinesHeldByTool(site, { exceptOrderId: orderId }),
  ]);
  const intraState = M.isIntraState(supplier.gstin, site);

  const lines = [];
  for (const l of raw) {
    const id = Number(l.itemId);
    const row = items.get(id) || items.get(String(id));
    if (!row) { problems.push(`Item ${id} is not in the ERP.`); continue; }
    const hsnRow = hsn.get(row.ItemID) || hsn.get(String(row.ItemID)) || null;
    const item = toPoItem(row, hsnRow);
    const label = item.itemCode || item.itemName;
    const lineProblems = [];

    if (item.gstPct == null) lineProblems.push(`${label}: the item has no HSN code in the ERP, so its GST is not known.`);
    const qty = Number(l.qty);
    if (!(qty > 0)) lineProblems.push(`${label}: enter a quantity.`);
    const expectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(l.expectedDate || '')) ? l.expectedDate : null;
    if (!expectedDate) lineProblems.push(`${label}: enter the expected delivery date.`);

    // Only a price a person approved in the supplier portal, from this supplier -
    // except a line on an edited PO left at the rate it already has.
    const kept = edit ? edit.linesByItem.get(id) || null : null;
    const offers = await compareItem({ site, itemId: id });
    const mine = offers.find((o) => resolve(o.supplier)?.ledgerId === supplier.ledgerId) || null;
    const approvedRate = mine ? M.offerRate(mine, item.purchaseUnit) : null;
    const rate = Number(l.rate);
    const rateKept = Boolean(kept) && Math.abs(rate - kept.rate) < 0.00005;
    if (!rateKept && mine && approvedRate == null) {
      lineProblems.push(`${label}: the approved price is per ${mine.rate?.uom || '?'} and cannot be turned into a price per ${item.purchaseUnit}.`);
    }
    for (const c of M.rateChecks({ rate, approvedRate: mine ? approvedRate : null, unit: item.purchaseUnit })) {
      if (c.severity !== 'BLOCK') continue;
      if (rateKept && c.code !== 'NO_RATE') continue;
      if (c.code === 'NO_APPROVED_PRICE' && mine) continue; // the unit problem above says it better
      lineProblems.push(`${label}: ${c.message}`);
    }

    // Requisition lines: each must be this item's, still open, and not on
    // another tool PO waiting for approval.
    const refs = kept?.requisition ? [{ ...kept.requisition, clientId: kept.clientId, clientName: null }] : [];
    for (const reqLineId of (edit ? [] : (l.requisitionLineIds || []).map(String))) {
      const r = reqs.get(reqLineId);
      if (!r) { lineProblems.push(`${label}: requisition line ${reqLineId} is not an open requisition.`); continue; }
      if (Number(r.ItemID) !== id) { lineProblems.push(`${label}: ${r.VoucherNo} asks for a different item.`); continue; }
      if (r.OrderedOn) { lineProblems.push(`${label}: ${r.VoucherNo} is already on ${r.OrderedOn}.`); continue; }
      if (held.has(reqLineId)) { lineProblems.push(`${label}: ${r.VoucherNo} is on another PO waiting for approval.`); continue; }
      refs.push({
        reqLineId,
        requisitionTransactionId: Number(r.TransactionID),
        reqNo: r.VoucherNo,
        jobRef: String(r.RefJobCardContentNo || '').trim(),
        jobContentsId: String(r.RefJobBookingJobCardContentsID || '').trim(),
        qty: Number(r.RequiredQuantity) || 0,
        clientId: r.ClientID != null ? Number(r.ClientID) : null,
        clientName: r.ClientName || null,
      });
    }
    problems.push(...lineProblems);
    if (lineProblems.length) continue;

    // The client the stock is tagged to: the jobs' client when they share one.
    const clientIds = [...new Set(refs.map((r) => r.clientId).filter((c) => c != null))];
    const clientId = kept ? kept.clientId ?? null : (clientIds.length === 1 ? clientIds[0] : null);
    const clientName = clientId != null ? (refs.find((r) => r.clientId === clientId)?.clientName || null) : null;

    const q = M.lineQuantities(item, qty, rate);
    const tax = M.lineTax(q.amount, item.gstPct, intraState);
    const kg = M.lineKg(item, qty);
    const stock = M.isPaperItem(item) ? await bufferStock(site, row, { clientId }) : [];
    const buffer = M.bufferCheck(kg, stock);
    // An edit needs approval only for what it adds: a new line, or more kg.
    const keptKg = kept ? M.lineKg(item, kept.qty) : null;
    const needsApproval = buffer.needsApproval && !(kept && keptKg != null && kg <= keptKg + 0.001);

    lines.push({
      itemId: id,
      itemCode: item.itemCode,
      itemName: item.itemName,
      itemGroupId: item.groupId,
      groupName: item.groupName,
      itemDescription: row.ItemDescription || null,
      stockUnit: item.stockUnit,
      purchaseUnit: item.purchaseUnit,
      qty,
      stockQty: q.stockQty,
      poQty: q.poQty,
      qtyPerPack: item.qtyPerPack || 1,
      packs: Math.round(q.stockQty / (item.qtyPerPack || 1)),
      rate,
      approvedRate,
      proposalId: mine ? String(mine._id) : null,
      amount: q.amount,
      gstPct: item.gstPct,
      cgstPct: tax.cgstPct,
      sgstPct: tax.sgstPct,
      igstPct: tax.igstPct,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      net: M.round(q.amount + tax.tax, 2),
      productHsnId: hsnRow ? Number(hsnRow.ProductHSNID) : 0,
      hsnCode: item.hsnCode,
      expectedDate,
      clientId,
      clientName,
      reqRefs: refs.map(({ clientId: _c, clientName: _n, ...r }) => r),
      kg,
      floorFreeKg: buffer.floorFree,
      onOrderFreeKg: buffer.onOrderFree,
      needsApproval,
      topStock: needsApproval ? M.topFloorStock(kg, stock).map(stockSummary) : [],
    });
  }
  if (problems.length) throw new PoRejected(problems);

  const totals = M.totals(lines);
  return {
    supplier,
    deliveryAddress: address.address,
    header: {
      deliveryAddressId: address.id,
      paymentTerms: b.paymentTerms,
      transport: b.transport,
      division: PURCHASE_DIVISION,
      currency: CURRENCY_CODE,
      purchaseReference: String(b.purchaseReference || '').trim().slice(0, 500),
    },
    lines,
    totals: { ...totals, wordsErp: erpAmountInWords(totals.net) },
    approvalNeeded: lines.some((l) => l.needsApproval),
  };
}

function stockSummary(r) {
  return {
    itemId: r.itemId,
    itemName: r.itemName,
    matchType: r.matchType,
    gsmDiff: r.gsmDiff,
    sizeWDiff: r.sizeWDiff,
    sizeLDiff: r.sizeLDiff,
    freeKg: r.freeKg,
    clientTag: r.clientTag,
    clientTagName: r.clientTagName,
    coversAlone: r.coversAlone,
  };
}

/**
 * Requisition lines by "TransactionID:TransID", with the job's client and
 * the PO, if any, that already ordered them. Only open lines come back.
 */
export async function requisitionLines(site, reqLineIds = []) {
  const keys = [...new Set(reqLineIds)].map((k) => {
    const [tid, transId] = String(k).split(':').map(Number);
    return Number.isFinite(tid) && Number.isFinite(transId) ? { key: `${tid}:${transId}`, tid, transId } : null;
  }).filter(Boolean);
  if (!keys.length) return new Map();

  const rows = await query(site, `
    SELECT ITM.TransactionID, ITM.VoucherNo, ITD.TransID, ITD.ItemID, ITD.RequiredQuantity, ITD.StockUnit,
           ITD.RefJobBookingJobCardContentsID, ITD.RefJobCardContentNo,
           (SELECT TOP 1 P.VoucherNo
            FROM ItemTransactionDetail PD
            JOIN ItemTransactionMain P ON P.TransactionID = PD.TransactionID AND P.VoucherID = @po
             AND ISNULL(P.IsDeletedTransaction,0) = 0
            WHERE PD.RequisitionTransactionID = ITM.TransactionID AND PD.ItemID = ITD.ItemID
              AND ISNULL(PD.IsDeletedTransaction,0) = 0) AS OrderedOn
    FROM ItemTransactionMain ITM
    JOIN ItemTransactionDetail ITD ON ITD.TransactionID = ITM.TransactionID AND ITD.CompanyID = ITM.CompanyID
    WHERE ITM.CompanyID = @companyId
      AND ITM.VoucherID = @preq
      AND ITM.TransactionID IN ${idSet('tids')}
      AND ISNULL(ITM.IsDeletedTransaction,0) = 0
      AND ISNULL(ITD.IsDeletedTransaction,0) = 0
      AND ISNULL(ITD.IsCancelled,0) = 0
      AND ISNULL(ITD.IsCompleted,0) = 0
  `, {
    companyId: COMPANY_ID, preq: VOUCHER.PURCHASE_REQUISITION, po: VOUCHER.PURCHASE_ORDER,
    tids: idParam(keys.map((k) => k.tid)),
  });

  const wanted = new Set(keys.map((k) => k.key));
  const found = rows.filter((r) => wanted.has(`${r.TransactionID}:${r.TransID}`));
  const jobNos = [...new Set(found.map((r) => firstJobNo(r.RefJobCardContentNo)).filter(Boolean))];
  const jobs = jobNos.length ? await query(site, `
    SELECT J.JobBookingNo, J.LedgerID, ISNULL(LM.LedgerName, J.ClientName) AS ClientName
    FROM JobBookingJobCard J
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = J.LedgerID AND LM.CompanyID = J.CompanyID
    WHERE J.CompanyID = @companyId AND J.JobBookingNo IN (SELECT value FROM STRING_SPLIT(@jobNos, ','))
  `, { companyId: COMPANY_ID, jobNos: jobNos.join(',') }) : [];
  const jobByNo = new Map(jobs.map((j) => [String(j.JobBookingNo).trim().toUpperCase(), j]));

  return new Map(found.map((r) => {
    const job = jobByNo.get(firstJobNo(r.RefJobCardContentNo));
    return [`${r.TransactionID}:${r.TransID}`, {
      ...r,
      ClientID: job?.LedgerID != null ? Number(job.LedgerID) : null,
      ClientName: job?.ClientName || null,
    }];
  }));
}

/** Requisition lines on tool POs still waiting for approval: not to be ordered twice. */
export async function reqLinesHeldByTool(site, { exceptOrderId = null } = {}) {
  await ensureSupplierPortalReady();
  const filter = { site, status: { $in: ['AWAITING_APPROVAL', 'SAVE_FAILED'] } };
  if (exceptOrderId) filter._id = { $ne: exceptOrderId };
  const orders = await PoOrder.find(filter).select('lines.reqRefs.reqLineId').lean();
  return new Set(orders.flatMap((o) => (o.lines || []).flatMap((l) => (l.reqRefs || []).map((r) => r.reqLineId))));
}

// ── writing ─────────────────────────────────────────────────────────────────

/**
 * Write a prepared PO to the ERP. Returns the voucher it became.
 *
 * @param {'KOL'|'AHM'} site
 * @param {Object} prepared  from preparePo
 * @param {Object} context   { userId } - the signed-in ERP user (UserMaster)
 */
export async function writePoToErp(site, prepared, { userId }) {
  assertSite(site);
  if (!erpWritesEnabled()) {
    throw Object.assign(new Error('Saving to the ERP is switched off on this server (SP_ENABLE_ERP_WRITES).'), { status: 403 });
  }
  if (!Number.isFinite(Number(userId)) || !(Number(userId) > 0)) {
    throw Object.assign(new Error('No ERP user on this session. Sign out and sign in again with your ERP user name.'), { status: 400 });
  }
  const voucherDate = erpToday();
  const { fYear, suffix } = financialYearFor(voucherDate);
  const rows = erpRows(prepared, { userId: Number(userId), voucherDate, fYear, now: erpNow() });

  const written = await withTransaction(site, async (tx) => {
    const { maxVoucherNo, voucherNo } = await allocateVoucherNo(tx, {
      voucherId: VOUCHER.PURCHASE_ORDER, fYear, suffix, table: 'ItemTransactionMain',
    });
    const transactionId = await insertRow(tx, 'ItemTransactionMain',
      { ...rows.header, MaxVoucherNo: maxVoucherNo, VoucherNo: voucherNo }, 'TransactionID');
    for (const d of rows.details) {
      await insertRow(tx, 'ItemTransactionDetail', { ...d, TransactionID: transactionId });
    }
    for (const t of rows.taxes) {
      await insertRow(tx, 'ItemPurchaseOrderTaxes', { ...t, TransactionID: transactionId });
    }
    for (const r of rows.requisitions) {
      await insertRow(tx, 'ItemPurchaseRequisitionDetail', { ...r, TransactionID: transactionId });
    }
    return { transactionId, voucherNo, voucherDate, fYear };
  });

  written.duplicateOf = await numberClashes(site, written);
  if (written.duplicateOf.length) {
    console.error(`[SP][po] ${written.voucherNo} was also used by TransactionID ${written.duplicateOf.join(', ')}.`);
  }
  return written;
}

/**
 * The rows a prepared PO becomes, column by column, without the numbers
 * the transaction assigns. Pure, so the shape can be tested and previewed.
 */
export function erpRows(prepared, { userId, voucherDate, fYear, now }) {
  const { supplier, header, lines, totals } = prepared;
  const common = {
    CompanyID: COMPANY_ID, BranchID: 0, UserID: userId, FYear: fYear,
    CreatedBy: userId, CreatedDate: now, ModifiedBy: userId, ModifiedDate: now,
    IsDeleted: 0, IsBlocked: 0, IsLocked: 0, DeletedBy: 0, IsDeletedTransaction: 0,
  };

  const headerRow = {
    VoucherPrefix: VOUCHER_PREFIX[VOUCHER.PURCHASE_ORDER],
    VoucherID: VOUCHER.PURCHASE_ORDER,
    VoucherDate: voucherDate,
    LedgerID: supplier.ledgerId,
    DealerID: 0, DepartmentID: 0, JobBookingID: 0, JobBookingJobCardContentsID: 0,
    MachineID: 0, OperationID: 0, ContactPersonID: 0, SourceWarehouseID: 0, DestinationWarehouseID: 0,
    TotalQuantity: M.round(lines.reduce((s, l) => s + l.poQty, 0), 3),
    TotalBasicAmount: totals.basic,
    TotalDiscountAmount: 0,
    TotalCGSTTaxAmount: totals.cgst,
    TotalSGSTTaxAmount: totals.sgst,
    TotalIGSTTaxAmount: totals.igst,
    TotalTaxAmount: totals.tax,
    // The sum of the lines, unrounded, as on 1,260 of 1,311 ERP POs.
    NetAmount: totals.net,
    TotalOverheadAmount: 0,
    Particular: ' ', DeliveryNoteNo: ' ', Transporter: ' ', GateEntryNo: ' ', LRNoVehicleNo: ' ',
    AmountInWords: totals.wordsErp,
    CurrencyCode: header.currency,
    ConversionRate: 0,
    PurchaseDivision: header.division,
    ModeOfTransport: header.transport,
    PurchaseReferenceRemark: header.purchaseReference || '',
    DeliveryAddress: prepared.deliveryAddress,
    TermsOfPayment: header.paymentTerms,
    TermsOfDelivery: ' ',
    ReceivedBy: 0,
    Narration: ' ',
    IsPurchaseInvoiceCreated: 0,
    VoucherApprovalByEmployeeID: 0,
    IsPostedInTally: 0,
    IsMailSent: 0,
    IsIntegrated: 0,
    ProductionUnitID: 0,
    GateEntryTransactionID: 0,
    ...common,
  };

  const details = lines.map((l, i) => {
    const refs = l.reqRefs || [];
    const fromReq = refs.length > 0;
    return {
      ParentTransactionID: 0,
      TransID: i + 1,
      ItemGroupID: l.itemGroupId,
      ItemID: l.itemId,
      JobBookingID: 0, JobBookingJobCardContentsID: 0, MachineID: 0, DepartmentID: 0, ProcessID: 0,
      RequiredNoOfPacks: l.packs,
      QuantityPerPack: l.qtyPerPack,
      // The requisition's quantity in the stock unit; 0 on a line typed fresh (all 7,211 this year).
      RequiredQuantity: fromReq ? M.round(refs.reduce((s, r) => s + (r.qty || 0), 0), 3) : 0,
      PurchaseOrderQuantity: l.poQty,
      PurchaseUnit: l.purchaseUnit,
      // In the stock unit: sheets for sheet paper bought by kg, else the PO quantity.
      ChallanWeight: l.stockQty,
      StockUnit: l.stockUnit,
      ChallanQuantity: 0, ReceiptQuantity: 0, IssueQuantity: 0, ApprovedQuantity: 0, RejectedQuantity: 0,
      OldStockQuantity: 0, NewStockQuantity: 0,
      QCApprovalNo: ' ', BatchNo: ' ', BatchID: 0, SupplierBatchNo: '', PalletNo: ' ', RefBatchNo: '',
      PurchaseRate: l.rate,
      PurchaseTolerance: 0,
      GrossAmount: l.amount,
      DiscountPercentage: 0,
      DiscountAmount: 0,
      BasicAmount: l.amount,
      TaxableAmount: l.amount,
      // All three stored whichever tax applies, as the ERP does: 9 / 9 / 18.
      GSTPercentage: l.gstPct,
      CGSTPercentage: l.gstPct / 2,
      SGSTPercentage: l.gstPct / 2,
      IGSTPercentage: l.gstPct,
      CGSTAmount: l.cgst,
      SGSTAmount: l.sgst,
      IGSTAmount: l.igst,
      NetAmount: l.net,
      LandedRate: 0,
      ItemNarration: '',
      Remark: '',
      WarehouseID: 0, FloorWarehouseID: 0, DestinationWarehouseID: 0,
      RequisitionItemID: 0,
      RequisitionTransactionID: fromReq ? refs[0].requisitionTransactionId : 0,
      PurchaseTransactionID: 0, PicklistTransactionID: 0, IssueTransactionID: 0, PicklistReleaseTransactionID: 0,
      IsVoucherItemApproved: 1,
      VoucherItemApprovedBy: ERP_APPROVER_USER_ID,
      VoucherItemApprovedDate: common.CreatedDate,
      ReceiptWtPerPacking: 0,
      // Several jobs on one line: the ERP glues the IDs with no separator and
      // keeps the commas only in the job numbers. Copied as it is.
      RefJobBookingJobCardContentsID: fromReq ? refs.map((r) => r.jobContentsId).join('').slice(0, REF_MAX) : null,
      RefJobCardContentNo: fromReq ? refs.map((r) => r.jobRef).join(',').slice(0, REF_MAX) : null,
      CurrentStockInStockUnit: 0, CurrentStockInPurchaseUnit: 0,
      IsReleased: 0, ReleasedBy: 0, IsCompleted: 0, CompletedBy: 0, IsCancelled: 0, CancelledBy: 0,
      IsAuditApproved: 0, AuditApprovedBy: 0, IsAuditCancelled: 0, AuditCancelledBy: 0,
      QtyInKg: 0, WoTransactionID: 0, WoIdentityID: 0, JumboRollSlittingTransactionID: 0, InvoiceTransactionID: 0,
      ExpectedDeliveryDate: new Date(`${l.expectedDate}T00:00:00Z`),
      // The item's own HSN, always: 1,395 ERP paper lines left it 0.
      ProductHSNID: l.productHsnId || 0,
      ItemDescription: l.itemDescription,
      ClientID: l.clientId ?? null,
      ProductionUnitID: 0,
      ...common,
    };
  });

  const taxes = [];
  for (const [name, amount] of [['CGST', totals.cgst], ['SGST', totals.sgst], ['IGST', totals.igst]]) {
    if (!(amount > 0)) continue;
    taxes.push({
      TransID: taxes.length + 1,
      LedgerID: PO_TAX_LEDGERS[name],
      TaxPercentage: 0,
      Amount: amount,
      TaxInAmount: 0,
      IsComulative: 0,
      TaxTiming: 0,
      GSTApplicable: 1,
      CalculatedON: 'Value',
      ...common,
    });
  }

  const requisitions = lines.map((l, i) => (l.reqRefs?.length ? {
    RequisitionTransactionID: l.reqRefs[0].requisitionTransactionId,
    ItemID: l.itemId,
    PurchaseItemID: 0,
    TransID: i + 1,
    RequisitionProcessQuantity: details[i].RequiredQuantity,
    StockUnit: l.stockUnit,
    ...common,
  } : null)).filter(Boolean);

  return { header: headerRow, details, taxes, requisitions };
}

/** SQL type per value: the ERP columns are int, bigint, real/float, bit, datetime or nvarchar. */
function sqlParam(value) {
  if (value === null || value === undefined) return { type: sql.NVarChar, value: null };
  if (value instanceof Date) return { type: sql.DateTime, value };
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 2 ** 31
    ? { type: sql.Int, value } : { type: sql.Float, value };
  return { type: sql.NVarChar, value: String(value) };
}

async function insertRow(tx, table, row, outputColumn = null) {
  const cols = Object.keys(row);
  const params = Object.fromEntries(cols.map((c, i) => [`p${i}`, sqlParam(row[c])]));
  const out = await txQuery(tx, `
    INSERT INTO ${table} (${cols.join(', ')})
    ${outputColumn ? `OUTPUT INSERTED.${outputColumn}` : ''}
    VALUES (${cols.map((_, i) => `@p${i}`).join(', ')})
  `, params);
  if (!outputColumn) return null;
  // A bigint: the driver returns it as text.
  const id = Number(out[0]?.[outputColumn]);
  if (!id) throw new Error(`${table} insert returned no ${outputColumn}.`);
  return id;
}

/** Other live POs with our number, after commit. */
async function numberClashes(site, { transactionId, voucherNo, fYear }) {
  try {
    const rows = await query(site, `
      SELECT TransactionID FROM ItemTransactionMain
      WHERE CompanyID = @companyId AND VoucherID = @po AND FYear = @fYear AND VoucherNo = @voucherNo
        AND TransactionID <> @tid AND ISNULL(IsDeletedTransaction,0) = 0
    `, {
      companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, fYear, voucherNo,
      tid: { type: sql.BigInt, value: transactionId },
    });
    return rows.map((r) => String(r.TransactionID));
  } catch (err) {
    console.warn('[SP][po] could not re-check the PO number:', err.message);
    return [];
  }
}

// ── amount in words, as the ERP writes it ───────────────────────────────────

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const twoDigits = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);

/**
 * The ERP's PO wording: "Twenty Two Thousand Five Hundred Thirty Five Rupee
 * and Ninety Two Paisa", "Two Lakhs ...", "One Crore ...". The ERP leaves
 * stray double spaces in it; this does not.
 */
export function erpAmountInWords(amount) {
  const total = Math.round((Number(amount) || 0) * 100);
  let n = Math.floor(total / 100);
  const paisa = total % 100;
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = Math.floor(n / 100); n %= 100;
  if (crore) parts.push(`${crore >= 100 ? `${ONES[Math.floor(crore / 100)]} Hundred ` : ''}${twoDigits(crore % 100)}`.trim() + ' Crore');
  if (lakh) parts.push(`${twoDigits(lakh)} ${lakh === 1 ? 'Lakh' : 'Lakhs'}`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (n) parts.push(twoDigits(n));
  const rupees = `${parts.length ? parts.join(' ') : 'Zero'} Rupee`;
  return paisa ? `${rupees} and ${twoDigits(paisa)} Paisa` : rupees;
}
