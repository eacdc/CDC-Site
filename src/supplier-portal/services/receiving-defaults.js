/**
 * Sensible starting values for the four things an invoice does not say:
 * who received it, which warehouse it went into, and which purchase and
 * freight ledgers the purchase invoice is booked to.
 *
 * Each comes from the ERP's own recent history rather than from a setting
 * somebody has to maintain, and each says where it came from so the person
 * receiving can see whether to trust it. All four stay editable.
 *
 * Facts this relies on, verified live on Kolkata, October 2026:
 *  - the warehouse lives on the GRN LINES (ItemTransactionDetail.WarehouseID).
 *    The GRN header's DestinationWarehouseID was 0 on all 2,043 GRNs of the
 *    previous 90 days, and every one of their 4,267 lines carried a warehouse;
 *  - PO lines carry no warehouse (WarehouseID 0), so a PO cannot supply one;
 *  - ReceivedBy is an employee LedgerID; CreatedBy is a UserMaster UserID.
 *    Two ID spaces - "Manik" the ledger is not "Manik Khanra" the user.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';

const ITM_LIVE = 'AND ISNULL(ITM.IsDeletedTransaction,0) = 0';
const ITD_LIVE = 'AND ISNULL(ITD.IsDeletedTransaction,0) = 0 AND ISNULL(ITD.IsCancelled,0) = 0';

function idList(ids) {
  return (ids || []).map(Number).filter(Number.isFinite).join(',');
}

/**
 * @param {'KOL'|'AHM'} site
 * @param {Object} opts
 * @param {number[]} opts.ledgerIds  every ledger the supplier trades under
 * @param {number}   [opts.erpUserId] the signed-in ERP user
 */
export async function receivingDefaults(site, { ledgerIds = [], erpUserId = null }) {
  assertSite(site);
  const supplier = idList(ledgerIds);
  const user = Number.isFinite(Number(erpUserId)) ? Number(erpUserId) : null;
  const params = { companyId: COMPANY_ID, grn: VOUCHER.GRN };

  // Received by: whoever this user usually receives as, else whoever usually
  // receives from this supplier.
  const receivedBy = (where) => query(site, `
    SELECT TOP 1 ITM.ReceivedBy AS LedgerID, LM.LedgerName
    FROM ItemTransactionMain ITM
    JOIN LedgerMaster LM ON LM.LedgerID = ITM.ReceivedBy AND LM.CompanyID = ITM.CompanyID
    WHERE ITM.CompanyID = @companyId AND ITM.VoucherID = @grn
      AND ISNULL(ITM.ReceivedBy,0) > 0 ${where} ${ITM_LIVE}
    ORDER BY ITM.VoucherDate DESC, ITM.TransactionID DESC
  `, params);

  // Warehouse: where this supplier's goods last went, else this user's last.
  const warehouse = (where) => query(site, `
    SELECT TOP 1 ITD.WarehouseID, WM.WarehouseName, WM.BinName, WM.WarehouseBinName
    FROM ItemTransactionMain ITM
    JOIN ItemTransactionDetail ITD ON ITD.TransactionID = ITM.TransactionID AND ITD.CompanyID = ITM.CompanyID
    JOIN WarehouseMaster WM ON WM.WarehouseID = ITD.WarehouseID AND WM.CompanyID = ITD.CompanyID
    WHERE ITM.CompanyID = @companyId AND ITM.VoucherID = @grn
      AND ISNULL(ITD.WarehouseID,0) > 0 ${where} ${ITM_LIVE} ${ITD_LIVE}
    ORDER BY ITM.VoucherDate DESC, ITM.TransactionID DESC
  `, params);

  const [byUser, bySupplier, whSupplier, whUser, purchase, freight, recent] = await Promise.all([
    user !== null ? receivedBy(`AND ITM.CreatedBy = ${user}`) : Promise.resolve([]),
    supplier ? receivedBy(`AND ITM.LedgerID IN (${supplier})`) : Promise.resolve([]),
    supplier ? warehouse(`AND ITM.LedgerID IN (${supplier})`) : Promise.resolve([]),
    user !== null ? warehouse(`AND ITM.CreatedBy = ${user}`) : Promise.resolve([]),
    supplier ? query(site, `
      SELECT TOP 1 PIM.PurchaseLedgerID AS LedgerID, LM.LedgerName
      FROM ItemPurchaseInvoiceMain PIM
      JOIN LedgerMaster LM ON LM.LedgerID = PIM.PurchaseLedgerID AND LM.CompanyID = PIM.CompanyID
      WHERE PIM.CompanyID = @companyId AND PIM.LedgerID IN (${supplier})
        AND ISNULL(PIM.PurchaseLedgerID,0) > 0 AND ISNULL(PIM.IsDeletedTransaction,0) = 0
      ORDER BY PIM.VoucherDate DESC, PIM.TransactionID DESC
    `, { companyId: COMPANY_ID }) : Promise.resolve([]),
    supplier ? query(site, `
      SELECT TOP 1 T.LedgerID, LM.LedgerName
      FROM ItemPurchaseInvoiceMain PIM
      JOIN ItemPurchaseInvoiceTaxes T ON T.TransactionID = PIM.TransactionID AND T.CompanyID = PIM.CompanyID
      JOIN LedgerMaster LM ON LM.LedgerID = T.LedgerID AND LM.CompanyID = T.CompanyID
      WHERE PIM.CompanyID = @companyId AND PIM.LedgerID IN (${supplier})
        AND LM.LedgerName LIKE '%freight%'
        AND ISNULL(PIM.IsDeletedTransaction,0) = 0 AND ISNULL(T.IsDeletedTransaction,0) = 0
      ORDER BY PIM.VoucherDate DESC, PIM.TransactionID DESC
    `, { companyId: COMPANY_ID }) : Promise.resolve([]),
    // How many of the supplier's last 10 purchase invoices charged freight.
    supplier ? query(site, `
      SELECT COUNT(*) AS Bills, SUM(F.Has) AS WithFreight
      FROM (
        SELECT TOP 10 PIM.TransactionID, PIM.CompanyID FROM ItemPurchaseInvoiceMain PIM
        WHERE PIM.CompanyID = @companyId AND PIM.LedgerID IN (${supplier}) AND ISNULL(PIM.IsDeletedTransaction,0) = 0
        ORDER BY PIM.VoucherDate DESC, PIM.TransactionID DESC
      ) P
      CROSS APPLY (SELECT CASE WHEN EXISTS (
        SELECT 1 FROM ItemPurchaseInvoiceTaxes T
        JOIN LedgerMaster LM ON LM.LedgerID = T.LedgerID AND LM.CompanyID = T.CompanyID
        WHERE T.TransactionID = P.TransactionID AND T.CompanyID = P.CompanyID
          AND LM.LedgerName LIKE '%freight%' AND T.Amount > 0 AND ISNULL(T.IsDeletedTransaction,0) = 0
      ) THEN 1 ELSE 0 END AS Has) F
    `, { companyId: COMPANY_ID }) : Promise.resolve([]),
  ]);

  const ledger = (row, source) => (row ? { ledgerId: Number(row.LedgerID), name: row.LedgerName, source } : null);
  const wh = (row, source) => (row ? {
    warehouseId: Number(row.WarehouseID),
    name: (row.WarehouseBinName || [row.WarehouseName, row.BinName].filter(Boolean).join(' - ')).trim(),
    source,
  } : null);

  return {
    receivedBy: ledger(byUser[0], 'your last GRN') || ledger(bySupplier[0], "this supplier's last GRN"),
    warehouse: wh(whSupplier[0], "this supplier's last GRN") || wh(whUser[0], 'your last GRN'),
    purchaseLedger: ledger(purchase[0], "this supplier's last purchase invoice"),
    freightLedger: ledger(freight[0], "this supplier's last purchase invoice with freight"),
    // Freight on at least half of the last 10 bills: the screen starts with a
    // freight row waiting for its amount. Krishna Vanijya charged it on 273 of
    // 354 bills from July to October 2026.
    freightUsual: Number(recent[0]?.Bills) > 0 && Number(recent[0]?.WithFreight) * 2 >= Number(recent[0]?.Bills),
    recentFreight: recent[0] ? { bills: Number(recent[0].Bills), withFreight: Number(recent[0].WithFreight) || 0 } : null,
  };
}
