/**
 * The GRN register: every live GRN on a site, whoever made it, with whether
 * stock has been issued from it and whether its purchase invoice exists.
 * Read-only. Edits and deletes are in erp-grn-edit.js and go through the
 * rules here first.
 *
 * Facts this rests on, checked live on Kolkata, 22 Oct 2026:
 *  - An issue line points at the GRN line it draws on by `BatchID` = the GRN
 *    line's TransactionDetailID (see grn-issues.js). IssueQuantity is in the
 *    stock unit.
 *  - The purchase invoice points at the GRN from ItemPurchaseInvoiceDetail.
 *    ParentTransactionID. The GRN's own IsPurchaseInvoiceCreated flag is not
 *    trusted: REC04691_26_27 was deleted with the flag set and its invoice
 *    PI (TransactionID 8819) still live. The invoice rows are what count.
 *  - On a GRN line ChallanWeight is the qty in the purchase unit and
 *    ReceiptQuantity / ChallanQuantity / ApprovedQuantity the qty in the stock
 *    unit. The GRN line's own PurchaseUnit is a blank; the PO line has it.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';

const LIVE_ITM = 'ISNULL(ITM.IsDeletedTransaction,0) = 0';

const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Issued is 'none', 'part' or 'full' - of the stock the GRN brought in. */
export function issueState(stockQty, issuedQty) {
  const issued = Number(issuedQty) || 0;
  if (issued <= 0) return 'none';
  return issued + 0.001 >= (Number(stockQty) || 0) ? 'full' : 'part';
}

/**
 * The GRNs of a date range, newest first. Filters: supplier ledgers, and a
 * search over GRN no. and D.N. no.
 */
export async function listGrns(site, { from, to, ledgerIds = null, search = null, limit = 200 } = {}) {
  assertSite(site);
  const ledgerFilter = ledgerIds?.length
    ? `AND ITM.LedgerID IN (${ledgerIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';
  const searchFilter = search ? 'AND (ITM.VoucherNo LIKE @q OR ITM.DeliveryNoteNo LIKE @q)' : '';

  const rows = await query(site, `
    WITH G AS (
      SELECT TOP (@limit) ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITM.LedgerID,
             ITM.DeliveryNoteNo, ITM.DeliveryNoteDate, ITM.GateEntryNo, ITM.GateEntryDate,
             ITM.ReceivedBy, ITM.CreatedBy, ITM.CreatedDate, ITM.ModifiedBy, ITM.ModifiedDate
      FROM ItemTransactionMain ITM
      WHERE ITM.CompanyID = @companyId AND ITM.VoucherID = @grn AND ${LIVE_ITM}
        AND ITM.VoucherDate >= @from AND ITM.VoucherDate < DATEADD(day, 1, @to)
        ${ledgerFilter}
        ${searchFilter}
      ORDER BY ITM.VoucherDate DESC, ITM.TransactionID DESC
    ),
    L AS (
      SELECT ITD.TransactionID, COUNT(*) AS Lines,
             SUM(ISNULL(ITD.ReceiptQuantity,0)) AS StockQty,
             MIN(ITD.StockUnit) AS MinUnit, MAX(ITD.StockUnit) AS MaxUnit
      FROM ItemTransactionDetail ITD
      JOIN G ON G.TransactionID = ITD.TransactionID
      WHERE ITD.CompanyID = @companyId
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0 AND ISNULL(ITD.IsCancelled,0) = 0
      GROUP BY ITD.TransactionID
    ),
    I AS (
      SELECT GD.TransactionID,
             SUM(ISNULL(ID.IssueQuantity,0)) AS IssuedQty,
             COUNT(DISTINCT ID.TransactionID) AS Issues,
             COUNT(DISTINCT ID.BatchID) AS LinesIssued
      FROM ItemTransactionDetail GD
      JOIN G ON G.TransactionID = GD.TransactionID
      JOIN ItemTransactionDetail ID ON ID.BatchID = GD.TransactionDetailID AND ID.CompanyID = GD.CompanyID
      JOIN ItemTransactionMain IM ON IM.TransactionID = ID.TransactionID AND IM.CompanyID = ID.CompanyID
      WHERE GD.CompanyID = @companyId AND IM.VoucherID = @issue
        AND ISNULL(GD.IsDeletedTransaction,0) = 0
        AND ISNULL(IM.IsDeletedTransaction,0) = 0
        AND ISNULL(ID.IsDeletedTransaction,0) = 0 AND ISNULL(ID.IsCancelled,0) = 0
      GROUP BY GD.TransactionID
    ),
    P AS (
      SELECT PD.ParentTransactionID AS TransactionID,
             MIN(PM.VoucherNo) AS PiVoucherNo, COUNT(DISTINCT PM.TransactionID) AS PIs
      FROM ItemPurchaseInvoiceDetail PD
      JOIN G ON G.TransactionID = PD.ParentTransactionID
      JOIN ItemPurchaseInvoiceMain PM ON PM.TransactionID = PD.TransactionID AND PM.CompanyID = PD.CompanyID
      WHERE PD.CompanyID = @companyId
        AND ISNULL(PD.IsDeletedTransaction,0) = 0 AND ISNULL(PM.IsDeletedTransaction,0) = 0
      GROUP BY PD.ParentTransactionID
    )
    SELECT G.TransactionID, G.VoucherNo, G.VoucherDate, G.LedgerID, S.LedgerName AS SupplierName,
           G.DeliveryNoteNo, G.DeliveryNoteDate, G.GateEntryNo, G.GateEntryDate,
           G.ReceivedBy, E.LedgerName AS ReceivedByName,
           G.CreatedBy, U.UserName AS CreatedByName, G.CreatedDate, G.ModifiedDate,
           ISNULL(L.Lines,0) AS Lines, ISNULL(L.StockQty,0) AS StockQty,
           CASE WHEN L.MinUnit = L.MaxUnit THEN L.MinUnit END AS StockUnit,
           ISNULL(I.IssuedQty,0) AS IssuedQty, ISNULL(I.Issues,0) AS Issues, ISNULL(I.LinesIssued,0) AS LinesIssued,
           P.PiVoucherNo, ISNULL(P.PIs,0) AS PIs
    FROM G
    LEFT JOIN L ON L.TransactionID = G.TransactionID
    LEFT JOIN I ON I.TransactionID = G.TransactionID
    LEFT JOIN P ON P.TransactionID = G.TransactionID
    LEFT JOIN LedgerMaster S ON S.LedgerID = G.LedgerID AND S.CompanyID = @companyId
    LEFT JOIN LedgerMaster E ON E.LedgerID = G.ReceivedBy AND E.CompanyID = @companyId
    LEFT JOIN UserMaster U ON U.UserID = G.CreatedBy
    ORDER BY G.VoucherDate DESC, G.TransactionID DESC
  `, {
    companyId: COMPANY_ID, grn: VOUCHER.GRN, issue: VOUCHER.ITEM_ISSUE,
    from: new Date(from), to: new Date(to),
    limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
    q: search ? `%${String(search).trim()}%` : '',
  }, { long: true });

  return rows.map((r) => ({
    transactionId: Number(r.TransactionID),
    voucherNo: r.VoucherNo,
    voucherDate: r.VoucherDate,
    supplierLedgerId: Number(r.LedgerID),
    supplierName: r.SupplierName ?? null,
    deliveryNoteNo: (r.DeliveryNoteNo || '').trim() || null,
    deliveryNoteDate: r.DeliveryNoteDate,
    gateEntryNo: (r.GateEntryNo || '').trim() || null,
    receivedByName: r.ReceivedByName ?? null,
    createdByName: r.CreatedByName ?? null,
    createdDate: r.CreatedDate,
    modifiedDate: r.ModifiedDate,
    lines: Number(r.Lines),
    stockQty: toNum(r.StockQty),
    stockUnit: r.StockUnit ?? null,
    issuedQty: toNum(r.IssuedQty),
    issues: Number(r.Issues),
    linesIssued: Number(r.LinesIssued),
    issued: issueState(r.StockQty, r.IssuedQty),
    piVoucherNo: r.PiVoucherNo ?? null,
    purchaseInvoices: Number(r.PIs),
  }));
}

/**
 * One GRN in full: header, lines with their issues, and its live purchase
 * invoices. `q` runs a query - against the pool for a read, or inside the
 * edit's transaction, so the rules are checked on what is about to change.
 */
export async function loadGrn(q, transactionId) {
  const tid = Number(transactionId);
  const [header] = await q(`
    SELECT ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITM.LedgerID, S.LedgerName AS SupplierName,
           ITM.DeliveryNoteNo, ITM.DeliveryNoteDate, ITM.GateEntryNo, ITM.GateEntryDate,
           ITM.EWayBillNumber, ITM.EWayBillDate,
           ISNULL(NULLIF(LTRIM(ITM.VehicleNo),''), NULLIF(LTRIM(ITM.LRNoVehicleNo),'')) AS VehicleNo,
           ITM.ReceivedBy, E.LedgerName AS ReceivedByName,
           ITM.CreatedBy, ITM.CreatedDate, ITM.ModifiedBy, ITM.ModifiedDate
    FROM ItemTransactionMain ITM
    LEFT JOIN LedgerMaster S ON S.LedgerID = ITM.LedgerID AND S.CompanyID = ITM.CompanyID
    LEFT JOIN LedgerMaster E ON E.LedgerID = ITM.ReceivedBy AND E.CompanyID = ITM.CompanyID
    WHERE ITM.CompanyID = @companyId AND ITM.VoucherID = @grn AND ITM.TransactionID = @tid AND ${LIVE_ITM}
  `, { companyId: COMPANY_ID, grn: VOUCHER.GRN, tid });
  if (!header) return null;

  // One after another, not in parallel: inside a transaction there is one
  // connection, and it runs one statement at a time.
  const lines = await q(`
      SELECT ITD.TransactionDetailID, ITD.TransID, ITD.ItemID, IM.ItemCode, IM.ItemName,
             ITD.ChallanWeight AS Qty, ITD.ReceiptQuantity AS StockQty, ITD.StockUnit,
             PO.PurchaseUnit, ITD.WarehouseID, ITD.BatchNo, ITD.PurchaseTransactionID,
             POM.VoucherNo AS PoVoucherNo, PO.TransactionDetailID AS PoTransactionDetailID,
             PO.IsCompleted AS PoCompleted, IM.WtPerPacking, IM.UnitPerPacking
      FROM ItemTransactionDetail ITD
      LEFT JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
      LEFT JOIN ItemTransactionMain POM ON POM.TransactionID = ITD.PurchaseTransactionID AND POM.CompanyID = ITD.CompanyID
      OUTER APPLY (
        SELECT TOP 1 P.TransactionDetailID, P.PurchaseUnit, P.IsCompleted
        FROM ItemTransactionDetail P
        WHERE P.TransactionID = ITD.PurchaseTransactionID AND P.ItemID = ITD.ItemID AND P.CompanyID = ITD.CompanyID
          AND ISNULL(P.IsDeletedTransaction,0) = 0
        ORDER BY P.TransactionDetailID
      ) PO
      WHERE ITD.CompanyID = @companyId AND ITD.TransactionID = @tid
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0 AND ISNULL(ITD.IsCancelled,0) = 0
      ORDER BY ITD.TransID
    `, { companyId: COMPANY_ID, tid });
  const issues = await q(`
      SELECT ID.BatchID, IM.VoucherNo AS IssueNo, IM.VoucherDate AS IssueDate, ID.IssueQuantity
      FROM ItemTransactionDetail ID
      JOIN ItemTransactionMain IM ON IM.TransactionID = ID.TransactionID AND IM.CompanyID = ID.CompanyID
      WHERE ID.CompanyID = @companyId AND IM.VoucherID = @issue
        AND ID.BatchID IN (SELECT TransactionDetailID FROM ItemTransactionDetail
                           WHERE CompanyID = @companyId AND TransactionID = @tid)
        AND ISNULL(IM.IsDeletedTransaction,0) = 0
        AND ISNULL(ID.IsDeletedTransaction,0) = 0 AND ISNULL(ID.IsCancelled,0) = 0
      ORDER BY IM.VoucherDate
    `, { companyId: COMPANY_ID, issue: VOUCHER.ITEM_ISSUE, tid });
  const invoices = await q(`
      SELECT DISTINCT PM.TransactionID, PM.VoucherNo, PM.VoucherDate
      FROM ItemPurchaseInvoiceDetail PD
      JOIN ItemPurchaseInvoiceMain PM ON PM.TransactionID = PD.TransactionID AND PM.CompanyID = PD.CompanyID
      WHERE PD.CompanyID = @companyId AND PD.ParentTransactionID = @tid
        AND ISNULL(PD.IsDeletedTransaction,0) = 0 AND ISNULL(PM.IsDeletedTransaction,0) = 0
    `, { companyId: COMPANY_ID, tid });

  return shapeGrn(header, lines, issues, invoices);
}

/** Pure: the rows above, as one GRN with its rules worked out. */
export function shapeGrn(header, lines = [], issues = [], invoices = []) {
  const byLine = new Map();
  for (const i of issues) {
    const id = Number(i.BatchID);
    if (!byLine.has(id)) byLine.set(id, []);
    byLine.get(id).push({ issueNo: i.IssueNo, issueDate: i.IssueDate, qty: toNum(i.IssueQuantity) || 0 });
  }
  const purchaseInvoices = invoices.map((p) => ({
    transactionId: Number(p.TransactionID), voucherNo: p.VoucherNo, voucherDate: p.VoucherDate,
  }));
  const hasPi = purchaseInvoices.length > 0;
  const piNames = purchaseInvoices.map((p) => p.voucherNo).join(', ');

  const shaped = lines.map((l) => {
    const lineIssues = byLine.get(Number(l.TransactionDetailID)) || [];
    const issuedQty = lineIssues.reduce((s, i) => s + i.qty, 0);
    const issued = issuedQty > 0;
    const issueNames = lineIssues.map((i) => i.issueNo).join(', ');
    return {
      transactionDetailId: Number(l.TransactionDetailID),
      lineNo: Number(l.TransID),
      itemId: Number(l.ItemID),
      itemCode: l.ItemCode ?? null,
      itemName: l.ItemName ?? null,
      qty: toNum(l.Qty),
      stockQty: toNum(l.StockQty),
      stockUnit: l.StockUnit ?? null,
      purchaseUnit: (l.PurchaseUnit || '').trim() || null,
      wtPerPacking: toNum(l.WtPerPacking),
      unitPerPacking: toNum(l.UnitPerPacking),
      warehouseId: toNum(l.WarehouseID),
      batchNo: l.BatchNo ?? null,
      poVoucherNo: l.PoVoucherNo ?? null,
      poTransactionDetailId: toNum(l.PoTransactionDetailID),
      poCompleted: Boolean(l.PoCompleted),
      issues: lineIssues,
      issuedQty,
      // What may change, and why not.
      minStockQty: issuedQty,
      qtyLocked: hasPi ? `Purchase invoice ${piNames} is made from this GRN. Delete it in the ERP first.` : null,
      warehouseLocked: issued ? `Issued on ${issueNames}: the stock left from this warehouse.` : null,
      removeLocked: hasPi
        ? `Purchase invoice ${piNames} is made from this GRN. Delete it in the ERP first.`
        : issued ? `Issued on ${issueNames} (${issuedQty}). Delete ${lineIssues.length > 1 ? 'those issue lines' : 'that issue line'} first.` : null,
    };
  });

  const issuedLines = shaped.filter((l) => l.issuedQty > 0);
  const deleteLocked = hasPi
    ? `Purchase invoice ${piNames} is made from this GRN. Delete it in the ERP first.`
    : issuedLines.length
      ? `Stock has been issued from line ${issuedLines.map((l) => l.lineNo).join(', ')} `
        + `(${[...new Set(issuedLines.flatMap((l) => l.issues.map((i) => i.issueNo)))].join(', ')}). Delete those issue lines first.`
      : null;

  return {
    transactionId: Number(header.TransactionID),
    voucherNo: header.VoucherNo,
    voucherDate: header.VoucherDate,
    supplierLedgerId: Number(header.LedgerID),
    supplierName: header.SupplierName ?? null,
    header: {
      deliveryNoteNo: (header.DeliveryNoteNo || '').trim() || null,
      deliveryNoteDate: header.DeliveryNoteDate ?? null,
      gateEntryNo: (header.GateEntryNo || '').trim() || null,
      gateEntryDate: header.GateEntryDate ?? null,
      eWayBillNo: (header.EWayBillNumber || '').trim() || null,
      eWayBillDate: header.EWayBillDate ?? null,
      vehicleNo: (header.VehicleNo || '').trim() || null,
      receivedBy: toNum(header.ReceivedBy),
      receivedByName: header.ReceivedByName ?? null,
    },
    createdBy: toNum(header.CreatedBy),
    createdDate: header.CreatedDate,
    modifiedDate: header.ModifiedDate,
    purchaseInvoices,
    lines: shaped,
    deleteLocked,
  };
}
