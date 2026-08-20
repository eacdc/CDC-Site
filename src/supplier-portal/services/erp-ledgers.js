/**
 * Ledger, warehouse and user reads.
 *
 * `LedgerMaster` holds suppliers, tax ledgers, purchase ledgers and employees
 * in one table, separated by `LedgerType` and `LedgerCodePrefix`. Three
 * separate ID spaces meet on a single voucher and confusing them is the most
 * likely bug in receiving:
 *
 *   UserID / CreatedBy / CompletedBy / VoucherItemApprovedBy → UserMaster
 *   ReceivedBy                                               → LedgerMaster, Employees
 *   LedgerID on the header                                   → LedgerMaster, supplier
 *
 * `UserMaster` and `LedgerMaster` are not linked — `EmployeeId` is NULL on
 * observed rows. A user logs in and selects which employee ledger they are
 * acting as, which is why the session carries both.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID, INTERNAL_LEDGER_PATTERNS } from '../config/constants.js';

/** Supplier ledgers. */
export async function supplierLedgers(site, { activeOnly = true } = {}) {
  assertSite(site);
  const rows = await query(site, `
    SELECT LedgerID, LedgerCode, LedgerName, LedgerType, LedgerGroupID,
           City, State, GSTNo, PANNo, Email, TelephoneNo, MobileNo,
           MaxCreditPeriod, ISLedgerActive
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND LedgerType = 'Sundry Creditors'
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
      ${activeOnly ? 'AND ISLedgerActive = 1' : ''}
    ORDER BY LedgerName
  `, { companyId: COMPANY_ID });

  return rows.map((r) => ({
    ...r,
    // CDC Printers (Ahmedabad) appears here on lamination film. That is an
    // inter-unit transfer, not a purchase, and it is excluded from every
    // benchmark rather than quietly ranked as the cheapest supplier.
    isInternal: INTERNAL_LEDGER_PATTERNS.some((p) => p.test(r.LedgerName || '')),
  }));
}

/** Employee ledgers — the ID space `ReceivedBy` lives in. */
export async function employeeLedgers(site) {
  assertSite(site);
  return query(site, `
    SELECT LedgerID, LedgerName, Designation, ISLedgerActive
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND LedgerType = 'Employees'
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
      AND ISLedgerActive = 1
    ORDER BY LedgerName
  `, { companyId: COMPANY_ID });
}

/**
 * Tax and charge ledgers, `LedgerCodePrefix = 'T'`.
 *
 * The 18/12/5 in the inward-freight ledger names refers to the GST rate of the
 * material carried, not of the freight itself. All three carry
 * `TaxPercentage = 18`, which is correct and must not be "fixed". Which one to
 * use is a human's choice, matched to the invoice.
 */
export async function chargeLedgers(site) {
  assertSite(site);
  const rows = await query(site, `
    SELECT LedgerID, LedgerName, LedgerCode, TaxPercentage, GSTLedgerType, IsTaxType
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND LedgerCodePrefix = 'T'
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
      AND ISLedgerActive = 1
    ORDER BY LedgerName
  `, { companyId: COMPANY_ID });

  return rows.map((r) => ({
    ...r,
    kind: classifyChargeLedger(r.LedgerName),
  }));
}

function classifyChargeLedger(name) {
  const n = String(name || '').toUpperCase();
  if (/\bCGST\b/.test(n)) return 'CGST';
  if (/\bSGST\b/.test(n)) return 'SGST';
  if (/\bIGST\b/.test(n)) return 'IGST';
  if (/ROUND\s*OFF/.test(n)) return 'ROUND_OFF';
  if (/FREIGHT/.test(n)) return 'FREIGHT';
  if (/PACKING/.test(n)) return 'PACKING';
  if (/COMMISSION/.test(n)) return 'COMMISSION';
  return 'OTHER';
}

/**
 * Purchase ledgers, `LedgerCodePrefix = 'P'`, `LedgerGroupID = 6`.
 *
 * CDC has split these repeatedly — the 10278-10288 block splits Paper & Board
 * by salesperson and segment. Which one applies is selected manually today;
 * the portal proposes one from the PO's client and sales employee and lets the
 * user override, because the split encodes intent the data does not.
 */
export async function purchaseLedgers(site) {
  assertSite(site);
  return query(site, `
    SELECT LedgerID, LedgerName, LedgerCode
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND LedgerCodePrefix = 'P'
      AND LedgerGroupID = 6
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
      AND ISLedgerActive = 1
    ORDER BY LedgerName
  `, { companyId: COMPANY_ID });
}

/** Warehouses. IDs differ per database — always read, never hard-coded. */
export async function warehouses(site) {
  assertSite(site);
  return query(site, `
    SELECT WarehouseID, WarehouseName, WarehouseBinName, BinName, City,
           WarehouseCode, ProductionUnitID, IsFloorWarehouse
    FROM WarehouseMaster
    WHERE CompanyID = @companyId
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
    ORDER BY WarehouseName
  `, { companyId: COMPANY_ID });
}

/** ERP users — the ID space `UserID` and the approval columns live in. */
export async function erpUsers(site) {
  assertSite(site);
  return query(site, `
    SELECT UserID, UserName, LoginUserName, Designation, IsAdmin,
           ProductionUnitID, CanReceiveExcessMaterial, CanEditPOQuantityAndRate
    FROM UserMaster
    WHERE CompanyID = @companyId
      AND ISNULL(IsDeletedUser,0) = 0
      AND ISNULL(IsBlocked,0) = 0
    ORDER BY UserName
  `, { companyId: COMPANY_ID });
}

/** One ledger by id, whatever its type. */
export async function getLedger(site, ledgerId) {
  assertSite(site);
  const rows = await query(site, `
    SELECT LedgerID, LedgerName, LedgerType, LedgerCodePrefix, City, State,
           GSTNo, PANNo, Email, MaxCreditPeriod
    FROM LedgerMaster
    WHERE CompanyID = @companyId AND LedgerID = @ledgerId
  `, { companyId: COMPANY_ID, ledgerId: Number(ledgerId) });
  return rows[0] || null;
}

/**
 * Which item groups a supplier ledger has historically supplied. Tier 0 of the
 * matcher uses this to keep an ink supplier's quote away from shipper cartons.
 */
export async function suppliedItemGroups(site, ledgerIds = [], { months = 24 } = {}) {
  assertSite(site);
  const ids = [...new Set(ledgerIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return [];

  const rows = await query(site, `
    SELECT DISTINCT IM.ItemGroupID
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
    JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId
      AND ITM.LedgerID IN (${ids.join(',')})
      AND ITM.VoucherID IN (-11, -14)
      AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
      AND ISNULL(ITD.IsDeletedTransaction,0) = 0
      AND ISNULL(ITD.IsCancelled,0) = 0
      AND ISNULL(ITM.IsDeletedTransaction,0) = 0
  `, { companyId: COMPANY_ID, months });

  return rows.map((r) => r.ItemGroupID);
}
