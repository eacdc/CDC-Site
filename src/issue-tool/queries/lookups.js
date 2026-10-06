/**
 * Lookups: floor warehouses with their bins, and departments (brief 6.4).
 */

import { query, sql } from '../db.js';
import { str } from './shared.js';

/**
 * Each WarehouseMaster row is one warehouse + bin pair (WarehouseID 16 is
 * "Floor-Panchla / Paper"), so the list is grouped by warehouse name and the
 * client picks a bin, which resolves to a WarehouseID.
 *
 * Floor warehouses are IsFloorWarehouse = 1 (confirmed by discovery).
 */
export async function floorWarehouses({ site, companyId }) {
	const rows = await query(site, `
		SELECT WarehouseID, WarehouseName, BinName
		FROM dbo.WarehouseMaster
		WHERE CompanyID = @companyId
		  AND ISNULL(IsFloorWarehouse, 0) = 1
		  AND ISNULL(IsDeleted, 0) = 0
		  AND ISNULL(IsDeletedTransaction, 0) = 0
		ORDER BY WarehouseName, BinName
	`, { companyId: [sql.Int, companyId] });
	return { warehouses: groupWarehouses(rows) };
}

export function groupWarehouses(rows) {
	const byName = new Map();
	for (const row of rows) {
		const name = str(row.WarehouseName) ?? '(unnamed)';
		if (!byName.has(name)) byName.set(name, { warehouseName: name, bins: [] });
		byName.get(name).bins.push({ warehouseId: row.WarehouseID, binName: str(row.BinName) ?? '(no bin)' });
	}
	return [...byName.values()];
}

/**
 * DepartmentMaster.DepartmentID is the ID the ERP stores on vouchers (100 =
 * PRINTING); the table's own key column `ID` is not used.
 */
export async function departments({ site, companyId }) {
	const rows = await query(site, `
		SELECT DepartmentID, DepartmentName
		FROM dbo.DepartmentMaster
		WHERE CompanyID = @companyId
		  AND ISNULL(IsDeletedTransaction, 0) = 0
		  AND ISNULL(IsBlocked, 0) = 0
		ORDER BY DepartmentName
	`, { companyId: [sql.Int, companyId] });
	return {
		departments: rows.map((r) => ({ departmentId: r.DepartmentID, departmentName: str(r.DepartmentName) })),
	};
}

/**
 * Clients for the direct tab's job search, as the Job Card Generator lists
 * them: the ledgers that have job cards.
 */
export async function clients({ site, companyId }) {
	const rows = await query(site, `
		SELECT DISTINCT LM.LedgerName
		FROM dbo.JobBookingJobCard JB
		JOIN dbo.LedgerMaster LM ON LM.LedgerID = JB.LedgerID
		WHERE JB.CompanyID = @companyId
		  AND ISNULL(JB.IsDeletedTransaction, 0) = 0
		  AND NULLIF(LTRIM(RTRIM(LM.LedgerName)), '') IS NOT NULL
		ORDER BY LM.LedgerName
	`, { companyId: [sql.Int, companyId] });
	return { clients: rows.map((r) => str(r.LedgerName)).filter(Boolean) };
}

/** Sales persons, as the Job Card Generator lists them: ledgers with Designation 'Sales Executive'. */
export async function salesPersons({ site }) {
	const rows = await query(site, `
		SELECT LedgerID, LedgerName
		FROM dbo.LedgerMaster
		WHERE Designation = 'Sales Executive'
		ORDER BY LedgerName
	`);
	return { salesPersons: rows.map((r) => ({ ledgerId: r.LedgerID, ledgerName: str(r.LedgerName) })) };
}
