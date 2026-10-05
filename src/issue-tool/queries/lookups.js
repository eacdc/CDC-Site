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
 * ASSUMPTION (discovery item 2): floor warehouses are IsFloorWarehouse = 1.
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

/** ASSUMPTION (discovery item 3): DepartmentMaster(DepartmentID, DepartmentName, CompanyID). */
export async function departments({ site, companyId }) {
	const rows = await query(site, `
		SELECT DepartmentID, DepartmentName
		FROM dbo.DepartmentMaster
		WHERE CompanyID = @companyId
		ORDER BY DepartmentName
	`, { companyId: [sql.Int, companyId] });
	return {
		departments: rows.map((r) => ({ departmentId: r.DepartmentID, departmentName: str(r.DepartmentName) })),
	};
}
