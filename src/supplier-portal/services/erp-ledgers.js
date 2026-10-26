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
import { COMPANY_ID, INTERNAL_LEDGER_PATTERNS, SUPPLIER_LEDGER_TYPES } from '../config/constants.js';

/** Supplier ledgers. */
export async function supplierLedgers(site, { activeOnly = true } = {}) {
  assertSite(site);

  // Parameterised rather than interpolated. These values come from our own
  // config today, but a list that reaches a WHERE clause by string
  // concatenation is one config edit away from being an injection point.
  const typeParams = SUPPLIER_LEDGER_TYPES.map((_, i) => `ledgerType${i}`);
  const typeValues = Object.fromEntries(
    SUPPLIER_LEDGER_TYPES.map((value, i) => [typeParams[i], value]),
  );

  const rows = await query(site, `
    SELECT LedgerID, LedgerCode, LedgerName, LedgerType, LedgerGroupID,
           City, State, GSTNo, PANNo, Email, TelephoneNo, MobileNo,
           MaxCreditPeriod, ISLedgerActive
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND LedgerType IN (${typeParams.map((p) => `@${p}`).join(', ')})
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
      ${activeOnly ? 'AND ISLedgerActive = 1' : ''}
    ORDER BY LedgerName
  `, { companyId: COMPANY_ID, ...typeValues });

  return rows.map((r) => ({
    ...r,
    // CDC Printers (Ahmedabad) appears here on lamination film. That is an
    // inter-unit transfer, not a purchase, and it is excluded from every
    // benchmark rather than quietly ranked as the cheapest supplier.
    isInternal: INTERNAL_LEDGER_PATTERNS.some((p) => p.test(r.LedgerName || '')),
  }));
}

/** Employee ledgers — the ID space `ReceivedBy` lives in. */
/**
 * Every `LedgerType` in the database, with a count, and whether we treat it as
 * a supplier type.
 *
 * A diagnostic, and it exists because of a silent failure: `supplierLedgers`
 * matched only 'Sundry Creditors', so every ledger filed under 'Suppliers' was
 * absent from the supplier list with nothing on screen to say so. A missing
 * WHERE-clause value looks exactly like a supplier who was never set up.
 * Being able to see the real vocabulary turns that into a five-second check.
 */
export async function ledgerTypes(site) {
  assertSite(site);
  const rows = await query(site, `
    SELECT LedgerType, COUNT(*) AS Ledgers,
           SUM(CASE WHEN ISLedgerActive = 1 THEN 1 ELSE 0 END) AS Active
    FROM LedgerMaster
    WHERE CompanyID = @companyId
      AND ISNULL(IsDeleted,0) = 0
      AND ISNULL(IsDeletedTransaction,0) = 0
    GROUP BY LedgerType
    ORDER BY COUNT(*) DESC
  `, { companyId: COMPANY_ID });

  return rows.map((r) => ({
    ledgerType: r.LedgerType,
    ledgers: r.Ledgers,
    active: r.Active,
    treatedAsSupplier: SUPPLIER_LEDGER_TYPES.includes(r.LedgerType),
  }));
}

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
/**
 * One ERP user by name, for sign-in.
 *
 * Matches `UserName` or `LoginUserName`, case- and space-insensitively, the
 * same way the Stock Issue Tool does — the two tools must agree on who you
 * are or the same person gets two different `CreatedBy` values.
 *
 * `UserMaster.EmployeeId` is null on every active user (188/188 in Kolkata,
 * October 2026), so it cannot supply the employee ledger for `ReceivedBy`.
 * That stays a choice the user makes. `EmailID` is set on only 66 of them, so
 * it cannot key an account either; `UserName` is distinct across all 188 and
 * is what the portal keys on.
 */
export async function erpUserByName(site, username) {
  assertSite(site);
  const name = String(username || '').trim();
  if (!name) return null;

  const rows = await query(site, `
    SELECT UserID, UserName, LoginUserName, Designation, IsAdmin, ProductionUnitID
    FROM UserMaster
    WHERE CompanyID = @companyId
      AND ISNULL(IsDeletedUser,0) = 0
      AND ISNULL(IsBlocked,0) = 0
      AND (UPPER(LTRIM(RTRIM(UserName))) = UPPER(@username)
        OR UPPER(LTRIM(RTRIM(ISNULL(LoginUserName,'')))) = UPPER(@username))
  `, { companyId: COMPANY_ID, username: name });

  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];

  // An exact UserName match beats a LoginUserName match; a genuine tie is a
  // master-data problem and must not be resolved by picking one at random.
  const exact = rows.filter(
    (r) => String(r.UserName ?? '').trim().toUpperCase() === name.toUpperCase(),
  );
  if (exact.length === 1) return exact[0];

  const err = new Error(`More than one ERP user is called "${name}". Ask an admin to make the names unique.`);
  err.status = 409;
  throw err;
}

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

/**
 * The same question asked once for every ledger at a site.
 *
 * `suppliedItemGroups` answers for one supplier, which is right when a screen
 * is showing one. Refreshing the whole site with it means one query per
 * supplier — ~1,300 of them against the ERP, which outlives the request that
 * asked. This returns `LedgerID -> [ItemGroupID]` from a single scan instead.
 *
 * @returns {Promise<Map<number, number[]>>}
 */
export async function suppliedItemGroupsByLedger(site, ledgerIds = [], { months = 24 } = {}) {
  assertSite(site);
  const ids = [...new Set(ledgerIds.map(Number).filter(Number.isFinite))];
  const byLedger = new Map();
  if (!ids.length) return byLedger;

  // Chunked because the id list is inlined: one enormous IN list is a query
  // plan SQL Server handles badly, and several thousand is a parse error.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await query(site, `
      SELECT DISTINCT ITM.LedgerID, IM.ItemGroupID
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        AND ITM.LedgerID IN (${chunk.join(',')})
        AND ITM.VoucherID IN (-11, -14)
        AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.IsCancelled,0) = 0
        AND ISNULL(ITM.IsDeletedTransaction,0) = 0
    `, { companyId: COMPANY_ID, months });

    for (const row of rows) {
      if (row.ItemGroupID === null || row.ItemGroupID === undefined) continue;
      const list = byLedger.get(row.LedgerID) || [];
      list.push(row.ItemGroupID);
      byLedger.set(row.LedgerID, list);
    }
  }

  return byLedger;
}
