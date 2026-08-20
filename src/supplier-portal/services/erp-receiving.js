/**
 * M5 — writing the GRN, the purchase invoice and the PO line closure.
 *
 * This is the only module in the portal that writes to the ERP, and the
 * highest-risk code in the application. Three deliberate safeguards:
 *
 *  1. **Posting is gated** behind `SP_ENABLE_ERP_WRITES`. Until this has been
 *     exercised against a real database with real credentials, the default is
 *     to refuse rather than to try. `dryRun` returns the exact rows that would
 *     be written, which is what makes the first test reviewable.
 *  2. **Everything is in one transaction**, including the voucher-number
 *     allocation. A GRN with a number somebody else also used is worse than a
 *     GRN that failed to post.
 *  3. **The stock refresh is outside it**, best-effort. It is cursor-driven
 *     and slow, nothing downstream depends on it, and CDC's own reporting
 *     computes stock from transactions anyway.
 *
 * The shape of what gets written comes from the reference trace:
 *   PO 58682 (PO02359_26_27) → GRN 58823 (REC03283_26_27) → PI 7409 (PI03219_26_27)
 */

import { withTransaction, txQuery, sql, assertSite, hasWriteLogin, db } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER, VOUCHER_PREFIX, TOLERANCES, STOCK_REFRESH_PROC } from '../config/constants.js';
import { allocateVoucherNo, fYearFor } from './erp-voucher.js';
import { apportionFreight, invoiceTotals, round } from '../lib/invoice-math.js';

/** Posting is off unless explicitly enabled. */
export function erpWritesEnabled() {
  return process.env.SP_ENABLE_ERP_WRITES === 'true' && hasWriteLogin();
}

/**
 * Post a document set: GRN, then purchase invoice, then PO line closure.
 *
 * @param {Object} input
 * @param {'KOL'|'AHM'} input.site
 * @param {Object} input.header      invoice header (already validated)
 * @param {Array}  input.lines       matched lines with PO linkage
 * @param {Object} input.context     {userId, employeeLedgerId, warehouseId,
 *                                    supplierLedgerId, purchaseLedgerId,
 *                                    freightLedgerId, chargeLedgers}
 * @param {boolean} [input.dryRun]
 * @returns {Promise<{grn, pi, closedLines, dryRun}>}
 */
export async function postDocumentSet({ site, header, lines, context, dryRun = false }) {
  assertSite(site);
  validatePostInput({ header, lines, context });

  if (!dryRun && !erpWritesEnabled()) {
    throw new Error(
      'ERP writes are disabled. Set SP_ENABLE_ERP_WRITES=true and configure ' +
      'SP_DB_WRITE_USER / SP_DB_WRITE_PASSWORD once the write path has been ' +
      'verified against the target database. Use dryRun to see what would be written.',
    );
  }

  const voucherDate = new Date();
  const fYear = fYearFor(voucherDate);
  const priced = priceLines({ header, lines });

  if (dryRun) {
    return {
      dryRun: true,
      fYear,
      grn: previewGrn({ header, lines: priced, context, voucherDate, fYear }),
      pi: previewPi({ header, lines: priced, context, voucherDate, fYear }),
      closedLines: priced.filter(closesPoLine).map((l) => ({
        transactionDetailId: l.poTransactionDetailId,
        pendingAfter: round((l.poPendingQty || 0) - (l.qty || 0), 3),
      })),
      totals: invoiceTotals(priced, { freight: num(header.freight), roundOff: num(header.roundOff) }),
    };
  }

  return withTransaction(site, async (tx) => {
    const grn = await writeGrn({ tx, header, lines: priced, context, voucherDate, fYear });
    const pi = await writePurchaseInvoice({
      tx, header, lines: priced, context, voucherDate, fYear, grnTransactionId: grn.transactionId,
    });
    const closedLines = await closePoLines({ tx, lines: priced, context });
    return { grn, pi, closedLines, dryRun: false };
  }).then(async (result) => {
    // Outside the transaction, deliberately. If it fails the GRN and PI are
    // still correct — CDC's reporting computes stock from transactions.
    result.stockRefresh = await refreshStock(site, result.grn.transactionId);
    return result;
  });
}

// ── GRN ─────────────────────────────────────────────────────────────────────

/**
 * The GRN carries no value.
 *
 * Every amount and tax column on the header is 0, and on the detail line
 * `PurchaseRate` is 0 as well — the rate lives in `GrsRate`. All value lives
 * on the purchase invoice. That makes this write mostly quantities, batch,
 * warehouse and approval flags.
 */
async function writeGrn({ tx, header, lines, context, voucherDate, fYear }) {
  const { maxVoucherNo, voucherNo } = await allocateVoucherNo(tx, {
    voucherId: VOUCHER.GRN, fYear, table: 'ItemTransactionMain',
  });

  const inserted = await txQuery(tx, `
    INSERT INTO ItemTransactionMain (
      VoucherPrefix, MaxVoucherNo, VoucherID, VoucherNo, VoucherDate,
      LedgerID, DestinationWarehouseID,
      TotalQuantity, TotalBasicAmount, TotalDiscountAmount,
      TotalCGSTTaxAmount, TotalSGSTTaxAmount, TotalIGSTTaxAmount,
      TotalTaxAmount, NetAmount, TotalOverheadAmount,
      Particular, DeliveryNoteNo, DeliveryNoteDate,
      GateEntryNo, GateEntryDate, ReceivedBy,
      EWayBillNumber, EWayBillDate, VehicleNo,
      IsPurchaseInvoiceCreated,
      CompanyID, BranchID, UserID, FYear,
      CreatedBy, CreatedDate, ModifiedBy, ModifiedDate,
      IsDeletedTransaction, ProductionUnitID
    )
    OUTPUT INSERTED.TransactionID
    VALUES (
      @prefix, @maxVoucherNo, @voucherId, @voucherNo, @voucherDate,
      @ledgerId, @warehouseId,
      @totalQuantity, 0, 0,
      0, 0, 0,
      0, 0, 0,
      'Receipt Note', @deliveryNoteNo, @deliveryNoteDate,
      @gateEntryNo, @gateEntryDate, @receivedBy,
      @ewayBillNo, @ewayBillDate, @vehicleNo,
      1,
      @companyId, @branchId, @userId, @fYear,
      @userId, @now, @userId, @now,
      0, 0
    )
  `, {
    prefix: VOUCHER_PREFIX[VOUCHER.GRN],
    maxVoucherNo: { type: sql.Int, value: maxVoucherNo },
    voucherId: { type: sql.Int, value: VOUCHER.GRN },
    voucherNo,
    voucherDate: { type: sql.DateTime, value: voucherDate },
    ledgerId: { type: sql.Int, value: context.supplierLedgerId },
    warehouseId: { type: sql.Int, value: context.warehouseId },
    totalQuantity: { type: sql.Float, value: sumBy(lines, 'qty') },
    deliveryNoteNo: header.invoiceNo ?? null,
    deliveryNoteDate: { type: sql.DateTime, value: toDate(header.invoiceDate) },
    gateEntryNo: header.gateEntryNo ?? null,
    gateEntryDate: { type: sql.DateTime, value: toDate(header.gateEntryDate) },
    // ReceivedBy is an employee LedgerID, NOT a UserID. Different ID space.
    receivedBy: { type: sql.Int, value: context.employeeLedgerId },
    ewayBillNo: header.eWayBillNo ?? null,
    ewayBillDate: { type: sql.DateTime, value: toDate(header.eWayBillDate) },
    vehicleNo: header.vehicleNo ?? null,
    companyId: { type: sql.Int, value: COMPANY_ID },
    branchId: { type: sql.Int, value: context.branchId ?? 1 },
    userId: { type: sql.Int, value: context.userId },
    fYear,
    now: { type: sql.DateTime, value: new Date() },
  });

  const transactionId = inserted[0]?.TransactionID;
  if (!transactionId) throw new Error('GRN header insert returned no TransactionID.');

  const detailIds = [];
  for (const [index, line] of lines.entries()) {
    const detailId = await writeGrnLine({
      tx, transactionId, line, index, context, fYear, poVoucherNo: line.poVoucherNo,
    });
    detailIds.push(detailId);
  }

  return { transactionId, voucherNo, maxVoucherNo, fYear, detailIds };
}

async function writeGrnLine({ tx, transactionId, line, index, context, fYear, poVoucherNo }) {
  const inserted = await txQuery(tx, `
    INSERT INTO ItemTransactionDetail (
      TransactionID, ParentTransactionID, TransID, ItemGroupID, ItemID,
      PurchaseOrderQuantity, PurchaseUnit, StockUnit,
      ChallanQuantity, ReceiptQuantity, ApprovedQuantity, RejectedQuantity,
      ChallanWeight, ReceiptWtPerPacking,
      QCApprovalNo, QCApprovedNarration,
      PurchaseRate, GrsRate, LandedRate,
      GrossAmount, BasicAmount, TaxableAmount, NetAmount,
      CGSTAmount, SGSTAmount, IGSTAmount,
      WarehouseID, PurchaseTransactionID, ProductHSNID,
      IsVoucherItemApproved, VoucherItemApprovedBy, VoucherItemApprovedDate,
      BatchNo,
      CompanyID, BranchID, UserID, FYear,
      CreatedBy, CreatedDate, ModifiedBy, ModifiedDate,
      IsDeletedTransaction, IsCancelled, ItemDescription
    )
    OUTPUT INSERTED.TransactionDetailID
    VALUES (
      @transactionId, @transactionId, @transId, @itemGroupId, @itemId,
      @poQty, @purchaseUnit, @stockUnit,
      @stockQty, @stockQty, @stockQty, 0,
      @challanWeight, @wtPerPacking,
      'Auto', 'Auto Approved by System',
      0, @grsRate, @landedRate,
      0, 0, 0, 0,
      0, 0, 0,
      @warehouseId, @poTransactionId, @productHsnId,
      1, @userId, @now,
      @batchNoPlaceholder,
      @companyId, @branchId, @userId, @fYear,
      @userId, @now, @userId, @now,
      0, 0, @itemDescription
    )
  `, {
    transactionId: { type: sql.Int, value: transactionId },
    transId: { type: sql.Int, value: index + 1 },
    itemGroupId: { type: sql.Int, value: line.itemGroupId },
    itemId: { type: sql.Int, value: line.itemId },
    poQty: { type: sql.Float, value: line.poQty ?? line.qty },
    purchaseUnit: line.purchaseUnit ?? null,
    stockUnit: line.stockUnit ?? null,
    // ChallanQuantity / ReceiptQuantity / ApprovedQuantity are in StockUnit;
    // ChallanWeight carries the quantity in PurchaseUnit.
    stockQty: { type: sql.Float, value: line.stockQty ?? line.qty },
    challanWeight: { type: sql.Float, value: line.qty },
    wtPerPacking: { type: sql.Float, value: line.wtPerPacking ?? null },
    grsRate: { type: sql.Float, value: line.rate },
    /**
     * LandedRate is currently left at 0 by the ERP's own screens, so job
     * costing falls back to a fixed ladder — ₹80/kg for Gloss Art instead of
     * the ₹76 or ₹79 actually paid. Populating it is a deliberate improvement.
     */
    landedRate: { type: sql.Float, value: line.landedRate ?? line.rate },
    warehouseId: { type: sql.Int, value: line.warehouseId ?? context.warehouseId },
    poTransactionId: { type: sql.Int, value: line.poTransactionId },
    productHsnId: { type: sql.Int, value: line.productHsnId ?? null },
    userId: { type: sql.Int, value: context.userId },
    now: { type: sql.DateTime, value: new Date() },
    batchNoPlaceholder: '',
    companyId: { type: sql.Int, value: COMPANY_ID },
    branchId: { type: sql.Int, value: context.branchId ?? 1 },
    fYear,
    itemDescription: line.itemDescription ?? null,
  });

  const detailId = inserted[0]?.TransactionDetailID;
  if (!detailId) throw new Error(`GRN detail insert for item ${line.itemId} returned no TransactionDetailID.`);

  /**
   * `BatchID` is the row's own `TransactionDetailID` and `BatchNo` embeds it,
   * so both can only be set after the insert. This is the ERP's convention,
   * not a workaround.
   */
  const batchNo = `${transactionId}_${poVoucherNo}_${line.itemId}_${detailId}.00`;
  await txQuery(tx, `
    UPDATE ItemTransactionDetail
    SET BatchID = @detailId, BatchNo = @batchNo
    WHERE TransactionDetailID = @detailId
  `, {
    detailId: { type: sql.Int, value: detailId },
    batchNo,
  });

  return detailId;
}

// ── Purchase invoice ────────────────────────────────────────────────────────

/**
 * The purchase invoice carries all the value.
 *
 * Three tables: the header, the lines, and `ItemPurchaseInvoiceTaxes` — one
 * row per charge ledger. `TotalOverheadAmount` on the header is 0; freight
 * lives in the taxes table, not there.
 */
async function writePurchaseInvoice({ tx, header, lines, context, voucherDate, fYear, grnTransactionId }) {
  const { maxVoucherNo, voucherNo } = await allocateVoucherNo(tx, {
    voucherId: VOUCHER.PURCHASE_INVOICE, fYear, table: 'ItemPurchaseInvoiceMain',
  });

  const totals = invoiceTotals(lines, {
    freight: num(header.freight), roundOff: num(header.roundOff),
  });

  const inserted = await txQuery(tx, `
    INSERT INTO ItemPurchaseInvoiceMain (
      VoucherPrefix, MaxVoucherNo, VoucherID, VoucherNo, VoucherDate,
      LedgerID, PurchaseLedgerID,
      TotalQuantity, TotalBasicAmount, TotalDiscountAmount,
      TotalCGSTTaxAmount, TotalSGSTTaxAmount, TotalIGSTTaxAmount,
      TotalTaxAmount, NetAmount, TotalOverheadAmount,
      DeliveryNoteNo, InvoiceNo, InvoiceDate, RoundOffValue, AmountInWords,
      CompanyID, BranchID, UserID, FYear,
      CreatedBy, CreatedDate, IsDeletedTransaction
    )
    OUTPUT INSERTED.TransactionID
    VALUES (
      @prefix, @maxVoucherNo, @voucherId, @voucherNo, @voucherDate,
      @ledgerId, @purchaseLedgerId,
      @totalQuantity, @totalBasic, 0,
      @cgst, @sgst, @igst,
      @totalTax, @netAmount, 0,
      @deliveryNoteNo, @invoiceNo, @invoiceDate, @roundOff, @amountInWords,
      @companyId, @branchId, @userId, @fYear,
      @userId, @now, 0
    )
  `, {
    prefix: VOUCHER_PREFIX[VOUCHER.PURCHASE_INVOICE],
    maxVoucherNo: { type: sql.Int, value: maxVoucherNo },
    voucherId: { type: sql.Int, value: VOUCHER.PURCHASE_INVOICE },
    voucherNo,
    voucherDate: { type: sql.DateTime, value: voucherDate },
    ledgerId: { type: sql.Int, value: context.supplierLedgerId },
    purchaseLedgerId: { type: sql.Int, value: context.purchaseLedgerId },
    // TotalQuantity is in the purchase unit (usually KG).
    totalQuantity: { type: sql.Float, value: sumBy(lines, 'qty') },
    totalBasic: { type: sql.Float, value: totals.totalBasicAmount },
    cgst: { type: sql.Float, value: totals.totalCGSTTaxAmount },
    sgst: { type: sql.Float, value: totals.totalSGSTTaxAmount },
    igst: { type: sql.Float, value: totals.totalIGSTTaxAmount },
    totalTax: { type: sql.Float, value: totals.totalTaxAmount },
    netAmount: { type: sql.Float, value: totals.netAmount },
    deliveryNoteNo: header.invoiceNo ?? null,
    invoiceNo: header.invoiceNo ?? null,
    invoiceDate: { type: sql.DateTime, value: toDate(header.invoiceDate) },
    roundOff: { type: sql.Float, value: totals.roundOffValue },
    amountInWords: amountInWords(totals.netAmount),
    companyId: { type: sql.Int, value: COMPANY_ID },
    branchId: { type: sql.Int, value: context.branchId ?? 1 },
    userId: { type: sql.Int, value: context.userId },
    fYear,
    now: { type: sql.DateTime, value: new Date() },
  });

  const transactionId = inserted[0]?.TransactionID;
  if (!transactionId) throw new Error('Purchase invoice header insert returned no TransactionID.');

  for (const [index, line] of lines.entries()) {
    await txQuery(tx, `
      INSERT INTO ItemPurchaseInvoiceDetail (
        TransactionID, ParentTransactionID, PurchaseTransactionID, TransID,
        ItemID, ItemGroupID, ProductHSNID,
        PurchaseOrderQuantity, ReceiptQuantity, PurchaseUnit,
        ChallanQuantity, StockUnit, ReceiptRate,
        GrossAmount, DiscountAmount, BasicAmount, TaxableAmount,
        GSTPercentage, CGSTPercentage, SGSTPercentage, IGSTPercentage,
        CGSTAmount, SGSTAmount, IGSTAmount,
        LandedRate, LandedAmount, NetAmount,
        ReceiptWtPerPacking, ItemNarration,
        CompanyID, BranchID, UserID, FYear,
        CreatedBy, CreatedDate, IsDeleted, IsDeletedTransaction
      )
      VALUES (
        @transactionId, @grnTransactionId, @poTransactionId, @transId,
        @itemId, @itemGroupId, @productHsnId,
        @poQty, @qty, @purchaseUnit,
        @stockQty, @stockUnit, @rate,
        @grossAmount, 0, @grossAmount, @taxableAmount,
        @gstPct, @cgstPct, @sgstPct, @igstPct,
        @cgstAmount, @sgstAmount, @igstAmount,
        @landedRate, @landedAmount, @netAmount,
        @wtPerPacking, @narration,
        @companyId, @branchId, @userId, @fYear,
        @userId, @now, 0, 0
      )
    `, {
      transactionId: { type: sql.Int, value: transactionId },
      // ParentTransactionID → GRN; PurchaseTransactionID → PO.
      grnTransactionId: { type: sql.Int, value: grnTransactionId },
      poTransactionId: { type: sql.Int, value: line.poTransactionId },
      transId: { type: sql.Int, value: index + 1 },
      itemId: { type: sql.Int, value: line.itemId },
      itemGroupId: { type: sql.Int, value: line.itemGroupId },
      productHsnId: { type: sql.Int, value: line.productHsnId ?? null },
      poQty: { type: sql.Float, value: line.poQty ?? line.qty },
      qty: { type: sql.Float, value: line.qty },
      purchaseUnit: line.purchaseUnit ?? null,
      stockQty: { type: sql.Float, value: line.stockQty ?? line.qty },
      stockUnit: line.stockUnit ?? null,
      rate: { type: sql.Float, value: line.rate },
      grossAmount: { type: sql.Float, value: line.grossAmount },
      taxableAmount: { type: sql.Float, value: line.taxableAmount },
      gstPct: { type: sql.Float, value: line.gstPercentage ?? 0 },
      cgstPct: { type: sql.Float, value: line.cgstPercentage ?? 0 },
      sgstPct: { type: sql.Float, value: line.sgstPercentage ?? 0 },
      igstPct: { type: sql.Float, value: line.igstPercentage ?? 0 },
      cgstAmount: { type: sql.Float, value: line.cgstAmount ?? 0 },
      sgstAmount: { type: sql.Float, value: line.sgstAmount ?? 0 },
      igstAmount: { type: sql.Float, value: line.igstAmount ?? 0 },
      landedRate: { type: sql.Float, value: line.landedRate ?? line.rate },
      landedAmount: { type: sql.Float, value: round((line.landedRate ?? line.rate) * line.qty, 2) },
      netAmount: { type: sql.Float, value: line.netAmount },
      wtPerPacking: { type: sql.Float, value: line.wtPerPacking ?? null },
      narration: line.itemDescription ?? null,
      companyId: { type: sql.Int, value: COMPANY_ID },
      branchId: { type: sql.Int, value: context.branchId ?? 1 },
      userId: { type: sql.Int, value: context.userId },
      fYear,
      now: { type: sql.DateTime, value: new Date() },
    });
  }

  await writeTaxRows({ tx, transactionId, totals, context, fYear });

  return { transactionId, voucherNo, maxVoucherNo, fYear, totals };
}

/**
 * One row per charge ledger.
 *
 * `TaxInAmount = 1` means the figure is an absolute amount rather than a
 * percentage — that is how freight and round-off are recorded. The GST rows
 * carry `TaxPercentage = 0` and `TaxInAmount = 0`, matching the reference
 * invoice. The trailing GST columns on this table were NULL on every observed
 * row and are deliberately left unset.
 */
async function writeTaxRows({ tx, transactionId, totals, context, fYear }) {
  const rows = [];
  const ledgers = context.chargeLedgers || {};
  let transId = 1;

  if (totals.totalCGSTTaxAmount > 0 && ledgers.CGST) {
    rows.push({ transId: transId++, ledgerId: ledgers.CGST, taxPercentage: 0, amount: totals.totalCGSTTaxAmount, taxInAmount: 0 });
  }
  if (totals.totalSGSTTaxAmount > 0 && ledgers.SGST) {
    rows.push({ transId: transId++, ledgerId: ledgers.SGST, taxPercentage: 0, amount: totals.totalSGSTTaxAmount, taxInAmount: 0 });
  }
  if (totals.totalIGSTTaxAmount > 0 && ledgers.IGST) {
    rows.push({ transId: transId++, ledgerId: ledgers.IGST, taxPercentage: 0, amount: totals.totalIGSTTaxAmount, taxInAmount: 0 });
  }
  if (totals.freight > 0) {
    if (!context.freightLedgerId) {
      throw new Error('Freight is present but no freight ledger was selected (INV018).');
    }
    // TaxPercentage 18 on every inward-freight ledger is correct: the 18/12/5
    // in the ledger name is the GST rate of the material carried.
    rows.push({ transId: transId++, ledgerId: context.freightLedgerId, taxPercentage: 18, amount: totals.freight, taxInAmount: 1 });
  }
  if (totals.roundOffValue !== 0 && ledgers.ROUND_OFF) {
    rows.push({ transId: transId++, ledgerId: ledgers.ROUND_OFF, taxPercentage: 0, amount: totals.roundOffValue, taxInAmount: 1 });
  }

  for (const row of rows) {
    await txQuery(tx, `
      INSERT INTO ItemPurchaseInvoiceTaxes (
        TransactionID, TransID, LedgerID, TaxPercentage, Amount, TaxInAmount,
        TaxTiming, CalculatedON,
        CompanyID, BranchID, UserID, FYear,
        CreatedBy, CreatedDate, IsDeletedTransaction
      )
      VALUES (
        @transactionId, @transId, @ledgerId, @taxPercentage, @amount, @taxInAmount,
        1, 'Value',
        @companyId, @branchId, @userId, @fYear,
        @userId, @now, 0
      )
    `, {
      transactionId: { type: sql.Int, value: transactionId },
      transId: { type: sql.Int, value: row.transId },
      ledgerId: { type: sql.Int, value: row.ledgerId },
      taxPercentage: { type: sql.Float, value: row.taxPercentage },
      amount: { type: sql.Float, value: row.amount },
      taxInAmount: { type: sql.Int, value: row.taxInAmount },
      companyId: { type: sql.Int, value: COMPANY_ID },
      branchId: { type: sql.Int, value: context.branchId ?? 1 },
      userId: { type: sql.Int, value: context.userId },
      fYear,
      now: { type: sql.DateTime, value: new Date() },
    });
  }

  return rows;
}

// ── PO line closure ─────────────────────────────────────────────────────────

/**
 * Close the PO lines this receipt completes.
 *
 * Closure is per line; PO-level status is an aggregate. A line may be closed
 * when 10% or less remains pending — looser than the ≤2%/≤25 kg rule used in
 * the earlier one-off bulk cleanup of stale POs, which was not the house rule
 * for live receiving.
 */
async function closePoLines({ tx, lines, context }) {
  const closed = [];

  for (const line of lines) {
    if (!closesPoLine(line)) continue;
    await txQuery(tx, `
      UPDATE ItemTransactionDetail
      SET IsCompleted = 1,
          CompletedBy = @userId,
          CompletedDate = @now,
          ModifiedBy = @userId,
          ModifiedDate = @now
      WHERE TransactionDetailID = @detailId
        AND CompanyID = @companyId
    `, {
      detailId: { type: sql.Int, value: line.poTransactionDetailId },
      // CompletedBy is a UserID, not an employee ledger.
      userId: { type: sql.Int, value: context.userId },
      now: { type: sql.DateTime, value: new Date() },
      companyId: { type: sql.Int, value: COMPANY_ID },
    });
    closed.push(line.poTransactionDetailId);
  }

  return closed;
}

/** Whether this receipt brings the PO line inside the closure tolerance. */
function closesPoLine(line) {
  if (!line.poTransactionDetailId) return false;
  const ordered = num(line.poQty);
  const pendingAfter = num(line.poPendingQty) - num(line.qty);
  if (!Number.isFinite(ordered) || ordered <= 0 || !Number.isFinite(pendingAfter)) return false;
  return pendingAfter <= ordered * TOLERANCES.closurePendingPct;
}

// ── Stock refresh ───────────────────────────────────────────────────────────

/**
 * Recompute stock for the items this GRN touched.
 *
 * `UPDATE_ITEM_STOCK_VALUES` (no suffix) is the live procedure; `...VALUES1`
 * is dead code. It writes only to `ItemMaster`, so it is idempotent and safe
 * to re-run. Called after commit and best-effort: a failure is logged and the
 * GRN and PI stand.
 */
export async function refreshStock(site, grnTransactionId) {
  try {
    const pool = await db(site, 'write');
    await pool.request()
      .input('CompanyID', sql.Int, COMPANY_ID)
      .input('TransactionID', sql.Int, grnTransactionId)
      .input('DeletedItemID', sql.Int, 0)
      .execute(STOCK_REFRESH_PROC);
    return { ok: true };
  } catch (err) {
    console.warn(`[SP][receiving] stock refresh failed for GRN ${grnTransactionId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Repair mode: recompute all eight stock columns for one item. */
export async function repairItemStock(site, itemId) {
  const pool = await db(site, 'write');
  await pool.request()
    .input('CompanyID', sql.Int, COMPANY_ID)
    .input('TransactionID', sql.Int, 0)
    .input('DeletedItemID', sql.Int, Number(itemId))
    .execute(STOCK_REFRESH_PROC);
  return { ok: true, itemId: Number(itemId) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Apply freight apportionment and tax to the matched lines. */
function priceLines({ header, lines }) {
  const withGross = lines.map((line) => ({
    ...line,
    grossAmount: num(line.amount) ?? round(num(line.qty) * num(line.rate), 2),
  }));
  return apportionFreight(withGross, num(header.freight) || 0);
}

function validatePostInput({ header, lines, context }) {
  if (!header?.invoiceNo) throw new Error('Cannot post without the supplier invoice number.');
  if (!lines?.length) throw new Error('Cannot post a document set with no lines.');
  // The three ID spaces, each checked by name so a mix-up fails loudly here
  // rather than producing a voucher attributed to the wrong person.
  if (!Number.isFinite(context?.userId)) throw new Error('context.userId (UserMaster) is required.');
  if (!Number.isFinite(context?.employeeLedgerId)) {
    throw new Error('context.employeeLedgerId (LedgerMaster, Employees) is required for ReceivedBy.');
  }
  if (!Number.isFinite(context?.supplierLedgerId)) {
    throw new Error('context.supplierLedgerId (LedgerMaster, Sundry Creditors) is required.');
  }
  if (!Number.isFinite(context?.warehouseId)) throw new Error('context.warehouseId is required.');
  if (!Number.isFinite(context?.purchaseLedgerId)) {
    throw new Error('context.purchaseLedgerId is required for the purchase invoice.');
  }
  for (const line of lines) {
    if (!Number.isFinite(line.itemId)) throw new Error('Every line needs an itemId.');
    if (!Number.isFinite(line.poTransactionId)) {
      throw new Error(`Line for item ${line.itemId} has no matched PO TransactionID.`);
    }
  }
}

function previewGrn({ header, lines, context, voucherDate, fYear }) {
  return {
    table: 'ItemTransactionMain',
    voucherId: VOUCHER.GRN,
    voucherPrefix: VOUCHER_PREFIX[VOUCHER.GRN],
    voucherNo: `${VOUCHER_PREFIX[VOUCHER.GRN]}<next>_${fYear}`,
    voucherDate,
    ledgerId: context.supplierLedgerId,
    receivedBy: context.employeeLedgerId,
    destinationWarehouseId: context.warehouseId,
    deliveryNoteNo: header.invoiceNo,
    allAmountColumns: 0,
    lines: lines.map((l, i) => ({
      transId: i + 1,
      itemId: l.itemId,
      challanQuantity: l.stockQty ?? l.qty,
      challanWeight: l.qty,
      grsRate: l.rate,
      purchaseRate: 0,
      landedRate: l.landedRate ?? l.rate,
      purchaseTransactionId: l.poTransactionId,
      batchNo: `<grnId>_${l.poVoucherNo}_${l.itemId}_<detailId>.00`,
    })),
  };
}

function previewPi({ header, lines, context, voucherDate, fYear }) {
  const totals = invoiceTotals(lines, { freight: num(header.freight), roundOff: num(header.roundOff) });
  return {
    table: 'ItemPurchaseInvoiceMain',
    voucherId: VOUCHER.PURCHASE_INVOICE,
    voucherNo: `${VOUCHER_PREFIX[VOUCHER.PURCHASE_INVOICE]}<next>_${fYear}`,
    voucherDate,
    ledgerId: context.supplierLedgerId,
    purchaseLedgerId: context.purchaseLedgerId,
    invoiceNo: header.invoiceNo,
    totals,
    taxRows: [
      totals.totalCGSTTaxAmount > 0 && { ledger: 'CGST', amount: totals.totalCGSTTaxAmount, taxInAmount: 0 },
      totals.totalSGSTTaxAmount > 0 && { ledger: 'SGST', amount: totals.totalSGSTTaxAmount, taxInAmount: 0 },
      totals.totalIGSTTaxAmount > 0 && { ledger: 'IGST', amount: totals.totalIGSTTaxAmount, taxInAmount: 0 },
      totals.freight > 0 && { ledger: `Freight (${context.freightLedgerId})`, amount: totals.freight, taxPercentage: 18, taxInAmount: 1 },
      totals.roundOffValue !== 0 && { ledger: 'Round Off', amount: totals.roundOffValue, taxInAmount: 1 },
    ].filter(Boolean),
    lines: lines.map((l, i) => ({
      transId: i + 1,
      itemId: l.itemId,
      receiptQuantity: l.qty,
      receiptRate: l.rate,
      grossAmount: l.grossAmount,
      freightShare: l.freightShare,
      taxableAmount: l.taxableAmount,
      cgstAmount: l.cgstAmount,
      sgstAmount: l.sgstAmount,
      igstAmount: l.igstAmount,
      netAmount: l.netAmount,
    })),
  };
}

function sumBy(rows, key) {
  return round(rows.reduce((sum, r) => sum + (num(r[key]) || 0), 0), 3);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Indian numbering for the ERP's `AmountInWords` column. */
export function amountInWords(amount) {
  const n = Math.round(Number(amount) || 0);
  if (n === 0) return 'Rupees Zero Only';

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigits = (v) => (v < 20 ? ones[v] : `${tens[Math.floor(v / 10)]}${v % 10 ? ` ${ones[v % 10]}` : ''}`);
  const threeDigits = (v) => (
    v >= 100
      ? `${ones[Math.floor(v / 100)]} Hundred${v % 100 ? ` ${twoDigits(v % 100)}` : ''}`
      : twoDigits(v)
  );

  // Crore, lakh, thousand, hundred — the Indian grouping the ERP prints.
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  return `Rupees ${parts.join(' ')} Only`;
}
