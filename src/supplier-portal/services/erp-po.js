/**
 * Purchase order reads.
 *
 * Pending quantity is computed from receipts against the PO, not read from a
 * status column: line closure is per-line (`IsCompleted`), and PO-level status
 * is an aggregate across lines rather than a field.
 *
 * The linkage chain, verified end to end on Krishna Vanijya `KV/26-27/12945`:
 *
 *   PO 58682 (PO02359_26_27, VoucherID -11)
 *     └─ GRN 58823 (REC03283_26_27, -14)  — ITD.PurchaseTransactionID → PO TransactionID
 *         └─ PI 7409 (PI03219_26_27, -32) — IPID.ParentTransactionID → GRN TransactionID
 *
 * `PurchaseTransactionID` points at the PO *header*, not the PO line, so
 * PO-line matching is `PurchaseTransactionID + ItemID`.
 */

import { query, sql, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER, TOLERANCES } from '../config/constants.js';

const ITD_FILTER = `
  AND ISNULL(ITD.IsDeletedTransaction,0) = 0
  AND ISNULL(ITD.IsCancelled,0) = 0`;
const ITM_FILTER = `
  AND ISNULL(ITM.IsDeletedTransaction,0) = 0`;

/**
 * Open PO lines for a supplier, with pending quantity.
 *
 * @param {'KOL'|'AHM'} site
 * @param {Object} opts
 * @param {number[]} [opts.ledgerIds]  supplier ledgers (a group has several)
 * @param {number[]} [opts.itemIds]    restrict to these items
 * @param {boolean} [opts.includeCompleted]
 */
export async function openPoLines(site, {
  ledgerIds = null,
  itemIds = null,
  transactionIds = null,
  includeCompleted = false,
  months = 12,
} = {}) {
  assertSite(site);
  const ledgerFilter = ledgerIds?.length
    ? `AND ITM.LedgerID IN (${ledgerIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';
  const itemFilter = itemIds?.length
    ? `AND ITD.ItemID IN (${itemIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';
  // A specific PO is fetched by id rather than by date window — an old PO is
  // still a real PO, and the caller already knows which one it wants.
  const txFilter = transactionIds?.length
    ? `AND ITD.TransactionID IN (${transactionIds.map(Number).filter(Number.isFinite).join(',')})`
    : `AND ITM.VoucherDate >= DATEADD(month, -${Number(months) || 12}, GETDATE())`;
  const completedFilter = includeCompleted ? '' : 'AND ISNULL(ITD.IsCompleted,0) = 0';

  return query(site, `
    WITH Po AS (
      SELECT ITD.TransactionDetailID, ITD.TransactionID, ITD.ItemID, ITD.ItemGroupID,
             ITD.PurchaseOrderQuantity, ITD.PurchaseUnit, ITD.StockUnit,
             ITD.ChallanWeight, ITD.PurchaseRate, ITD.PurchaseTolerance,
             ITD.ExpectedDeliveryDate, ITD.WarehouseID, ITD.ProductHSNID,
             ITD.ItemDescription, ITD.ClientID, ITD.IsCompleted,
             ITM.VoucherNo AS PoVoucherNo, ITM.VoucherDate AS PoDate,
             ITM.LedgerID, ITM.SalesEmployeeID, ITM.FYear
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        AND ITM.VoucherID = @po
        ${txFilter}
        ${ledgerFilter}
        ${itemFilter}
        ${completedFilter}
        ${ITD_FILTER}
        ${ITM_FILTER}
    ),
    -- Receipts are matched to the PO header + item, which is how the ERP
    -- itself links them: PurchaseTransactionID points at the PO header.
    Received AS (
      SELECT ITD.PurchaseTransactionID AS PoTransactionID,
             ITD.ItemID,
             SUM(ISNULL(ITD.ReceiptQuantity,0))  AS ReceivedStockQty,
             SUM(ISNULL(ITD.ChallanWeight,0))    AS ReceivedPurchaseQty,
             SUM(ISNULL(ITD.RejectedQuantity,0)) AS RejectedQty,
             MAX(ITM.VoucherDate)                AS LastReceiptDate
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        AND ITM.VoucherID = @grn
        ${ITD_FILTER}
        ${ITM_FILTER}
      GROUP BY ITD.PurchaseTransactionID, ITD.ItemID
    )
    SELECT Po.*,
           LM.LedgerName AS SupplierName,
           IM.ItemName, IM.ItemCode, IM.WtPerPacking, IM.UnitPerPacking,
           IM.ItemGroupID AS MasterItemGroupID,
           ISNULL(R.ReceivedPurchaseQty,0) AS ReceivedQty,
           ISNULL(R.RejectedQty,0)         AS RejectedQty,
           R.LastReceiptDate,
           Po.PurchaseOrderQuantity - ISNULL(R.ReceivedPurchaseQty,0) AS PendingQty
    FROM Po
    LEFT JOIN Received R
      ON R.PoTransactionID = Po.TransactionID AND R.ItemID = Po.ItemID
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = Po.LedgerID AND LM.CompanyID = @companyId
    LEFT JOIN ItemMaster IM ON IM.ItemID = Po.ItemID AND IM.CompanyID = @companyId
    ORDER BY Po.PoDate DESC, Po.PoVoucherNo, Po.TransactionDetailID
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, grn: VOUCHER.GRN }, { long: true });
}

/** One PO by TransactionID, header plus lines. */
export async function getPo(site, transactionId) {
  assertSite(site);
  const [header] = await query(site, `
    SELECT ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITM.VoucherPrefix,
           ITM.MaxVoucherNo, ITM.FYear, ITM.LedgerID, ITM.SalesEmployeeID,
           ITM.DestinationWarehouseID, ITM.TermsOfPayment, ITM.TermsOfDelivery,
           ITM.Narration, LM.LedgerName AS SupplierName, LM.State AS SupplierState,
           LM.GSTNo AS SupplierGstin
    FROM ItemTransactionMain ITM
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = ITM.LedgerID AND LM.CompanyID = ITM.CompanyID
    WHERE ITM.CompanyID = @companyId
      AND ITM.TransactionID = @transactionId
      AND ITM.VoucherID = @po
      ${ITM_FILTER}
  `, { companyId: COMPANY_ID, transactionId: Number(transactionId), po: VOUCHER.PURCHASE_ORDER });

  if (!header) return null;
  const lines = await openPoLines(site, {
    transactionIds: [header.TransactionID],
    includeCompleted: true,
  });
  return { header, lines };
}

/**
 * POs raised in a date window. Feeds the nightly PO-check sweep and the
 * leakage report.
 */
export async function posInWindow(site, { from, to } = {}) {
  assertSite(site);
  return query(site, `
    SELECT ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITM.LedgerID,
           LM.LedgerName AS SupplierName, ITM.DestinationWarehouseID
    FROM ItemTransactionMain ITM
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = ITM.LedgerID AND LM.CompanyID = ITM.CompanyID
    WHERE ITM.CompanyID = @companyId
      AND ITM.VoucherID = @po
      AND ITM.VoucherDate >= @from
      AND ITM.VoucherDate < @to
      ${ITM_FILTER}
    ORDER BY ITM.VoucherDate DESC
  `, {
    companyId: COMPANY_ID,
    po: VOUCHER.PURCHASE_ORDER,
    from: { type: sql.DateTime, value: from },
    to: { type: sql.DateTime, value: to },
  });
}

/**
 * Open PO lines for the delivery-date snapshot job.
 *
 * Deliberately lean — this runs across every open line daily and only needs
 * what the commitment-stability metric consumes.
 */
export async function openLinesForSnapshot(site) {
  assertSite(site);
  return query(site, `
    WITH Received AS (
      SELECT ITD.PurchaseTransactionID AS PoTransactionID, ITD.ItemID,
             SUM(ISNULL(ITD.ChallanWeight,0)) AS ReceivedQty
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId AND ITM.VoucherID = @grn
        ${ITD_FILTER} ${ITM_FILTER}
      GROUP BY ITD.PurchaseTransactionID, ITD.ItemID
    )
    SELECT ITD.TransactionDetailID, ITD.TransactionID, ITD.ItemID,
           ITD.ExpectedDeliveryDate, ITM.LedgerID, ITM.VoucherNo,
           ITD.PurchaseOrderQuantity - ISNULL(R.ReceivedQty,0) AS PendingQty
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
    LEFT JOIN Received R
      ON R.PoTransactionID = ITD.TransactionID AND R.ItemID = ITD.ItemID
    WHERE ITD.CompanyID = @companyId
      AND ITM.VoucherID = @po
      AND ISNULL(ITD.IsCompleted,0) = 0
      ${ITD_FILTER}
      ${ITM_FILTER}
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, grn: VOUCHER.GRN }, { long: true });
}

/**
 * Delivery performance per supplier (§16.1).
 *
 * Three rules the query encodes:
 *  1. Measured against the GRN that *completes* the line — cumulative receipt
 *     within tolerance — not the first GRN. A supplier who ships 10% on day 5
 *     and the rest on day 60 is not on time.
 *  2. Lines closed with nothing received count as the worst outcome, not as
 *     "no outcome". Excluding them makes non-delivery score better than late
 *     delivery.
 *  3. `ExpectedDeliveryDate` is edited in place, so this measures against the
 *     current date. Commitment stability is a separate metric fed by the
 *     snapshot collection.
 */
export async function deliveryPerformance(site, { ledgerIds = null, months = 12 } = {}) {
  assertSite(site);
  const ledgerFilter = ledgerIds?.length
    ? `AND ITM.LedgerID IN (${ledgerIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  return query(site, `
    WITH PoLine AS (
      SELECT ITD.TransactionDetailID, ITD.TransactionID, ITD.ItemID,
             ITD.PurchaseOrderQuantity, ITD.ExpectedDeliveryDate,
             ITD.IsCompleted, ITD.CompletedDate, ITM.LedgerID,
             ITM.VoucherDate AS PoDate, ITM.VoucherNo AS PoVoucherNo
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        AND ITM.VoucherID = @po
        AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
        ${ledgerFilter}
        ${ITD_FILTER}
        ${ITM_FILTER}
    ),
    Receipts AS (
      SELECT ITD.PurchaseTransactionID AS PoTransactionID, ITD.ItemID,
             ITM.VoucherDate,
             SUM(ISNULL(ITD.ChallanWeight,0))    AS Qty,
             SUM(ISNULL(ITD.RejectedQuantity,0)) AS Rejected,
             SUM(ISNULL(ITD.ApprovedQuantity,0)) AS Approved
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId AND ITM.VoucherID = @grn
        ${ITD_FILTER} ${ITM_FILTER}
      GROUP BY ITD.PurchaseTransactionID, ITD.ItemID, ITM.VoucherDate
    ),
    Cumulative AS (
      SELECT R.PoTransactionID, R.ItemID, R.VoucherDate, R.Qty, R.Rejected, R.Approved,
             SUM(R.Qty) OVER (
               PARTITION BY R.PoTransactionID, R.ItemID
               ORDER BY R.VoucherDate
               ROWS UNBOUNDED PRECEDING
             ) AS CumQty
      FROM Receipts R
    ),
    Completing AS (
      -- The first receipt whose cumulative quantity brings the line within
      -- the closure tolerance. That receipt's date is the delivery date.
      SELECT C.PoTransactionID, C.ItemID, MIN(C.VoucherDate) AS CompletingDate
      FROM Cumulative C
      JOIN PoLine P ON P.TransactionID = C.PoTransactionID AND P.ItemID = C.ItemID
      WHERE C.CumQty >= P.PurchaseOrderQuantity * (1 - @closureTolerance)
      GROUP BY C.PoTransactionID, C.ItemID
    )
    SELECT P.LedgerID, LM.LedgerName,
           P.TransactionID, P.PoVoucherNo, P.ItemID, P.PoDate,
           P.ExpectedDeliveryDate, P.PurchaseOrderQuantity,
           P.IsCompleted, P.CompletedDate,
           CMP.CompletingDate,
           ISNULL(TOT.TotalReceived,0)  AS TotalReceived,
           ISNULL(TOT.TotalRejected,0)  AS TotalRejected,
           ISNULL(TOT.TotalApproved,0)  AS TotalApproved,
           DATEDIFF(day, P.PoDate, P.ExpectedDeliveryDate) AS LeadDays,
           DATEDIFF(day, P.ExpectedDeliveryDate, CMP.CompletingDate) AS DaysLate
    FROM PoLine P
    LEFT JOIN Completing CMP
      ON CMP.PoTransactionID = P.TransactionID AND CMP.ItemID = P.ItemID
    LEFT JOIN (
      SELECT PoTransactionID, ItemID,
             SUM(Qty) AS TotalReceived, SUM(Rejected) AS TotalRejected,
             SUM(Approved) AS TotalApproved
      FROM Receipts GROUP BY PoTransactionID, ItemID
    ) TOT ON TOT.PoTransactionID = P.TransactionID AND TOT.ItemID = P.ItemID
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = P.LedgerID AND LM.CompanyID = @companyId
    ORDER BY P.LedgerID, P.PoDate DESC
  `, {
    companyId: COMPANY_ID,
    po: VOUCHER.PURCHASE_ORDER,
    grn: VOUCHER.GRN,
    months,
    closureTolerance: { type: sql.Float, value: TOLERANCES.closurePendingPct },
  }, { long: true });
}

/**
 * Has this invoice already been posted? Checked against the delivery-note
 * fields on the GRN header, which is where the supplier's invoice number is
 * recorded (INV001).
 */
export async function findPostedInvoice(site, { invoiceNo, ledgerIds = [] }) {
  assertSite(site);
  if (!invoiceNo) return null;
  const ledgerFilter = ledgerIds?.length
    ? `AND ITM.LedgerID IN (${ledgerIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  const rows = await query(site, `
    SELECT TOP 5 ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate,
           ITM.DeliveryNoteNo, ITM.LedgerID
    FROM ItemTransactionMain ITM
    WHERE ITM.CompanyID = @companyId
      AND ITM.VoucherID = @grn
      AND ITM.DeliveryNoteNo = @invoiceNo
      ${ledgerFilter}
      ${ITM_FILTER}
  `, { companyId: COMPANY_ID, grn: VOUCHER.GRN, invoiceNo: String(invoiceNo) });

  return rows[0] || null;
}
