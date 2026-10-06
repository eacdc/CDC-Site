/**
 * Item search and batch stock (brief 6.4).
 */

import { query, sql, likePattern, inList } from '../db.js';
import { ITEM_COLUMNS, mapItem, qty, str, unitKey } from './shared.js';
import { contentRequirements } from './job-contents.js';
import { toIsoDate } from '../dates.js';
import { ApiError } from '../errors.js';

const MAX_ITEMS = 50;
const MAX_TOKENS = 5;

/**
 * Search ItemMaster by code, name, group, quality, GSM, width, length. Every
 * word typed must match one of those. With a job content, its planned items
 * come first (marked planned: true), each with the job's pending figures, and
 * every result carries pendingForJob: the pending requirement of its item
 * group + stock unit on that content, which is what a substitute draws from.
 */
export async function searchItems({ site, companyId, search, jobContentId }) {
	const tokens = search.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);

	let requirement = null;
	if (jobContentId) {
		const reqs = await contentRequirements({ site, companyId, contentIds: [jobContentId] });
		requirement = reqs.get(jobContentId) ?? { plannedItems: [], requirementGroups: [] };
	}

	let found = [];
	if (tokens.length) {
		const params = { companyId: [sql.Int, companyId] };
		const conditions = tokens.map((token, i) => {
			params[`t${i}`] = [sql.NVarChar(210), likePattern(token)];
			return `(
				IM.ItemCode LIKE @t${i} ESCAPE '\\'
				OR IM.ItemName LIKE @t${i} ESCAPE '\\'
				OR IGM.ItemGroupName LIKE @t${i} ESCAPE '\\'
				OR IM.Quality LIKE @t${i} ESCAPE '\\'
				OR IM.Manufecturer LIKE @t${i} ESCAPE '\\'
				OR CONVERT(NVARCHAR(50), IM.GSM) LIKE @t${i} ESCAPE '\\'
				OR CONVERT(NVARCHAR(50), IM.SizeW) LIKE @t${i} ESCAPE '\\'
				OR CONVERT(NVARCHAR(50), IM.SizeL) LIKE @t${i} ESCAPE '\\'
			)`;
		});
		const rows = await query(site, `
			SELECT TOP (${MAX_ITEMS}) ${ITEM_COLUMNS}
			FROM dbo.ItemMaster IM
			LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
			LEFT JOIN dbo.ItemSubGroupMaster ISG ON ISG.ItemSubGroupID = IM.ItemSubGroupID AND ISG.CompanyID = IM.CompanyID
			WHERE IM.CompanyID = @companyId
			  AND ISNULL(IM.IsDeletedTransaction, 0) = 0
			  AND ${conditions.join(' AND ')}
			ORDER BY CASE WHEN ISNULL(IM.PhysicalStock, 0) > 0 THEN 0 ELSE 1 END, IM.ItemCode
		`, params);
		found = rows.map(mapItem);
	}

	const rows = mergeItems(requirement, found);
	const extras = await itemExtras({ site, companyId, itemIds: rows.map((r) => r.itemId) });
	return { rows: rows.map((r) => ({ ...r, ...(extras.get(r.itemId) ?? defaultExtras(r)) })) };
}

/**
 * ItemMaster columns the ERP's issue screen shows whose names discovery has
 * not confirmed: Supplier Reference and Unit Decimal Place. The first name of
 * each list that exists in this database is used; none found means
 * supplierReference null and decimal places from the unit (Kg 3, else 0, as
 * the ERP screen shows them).
 */
const OPTIONAL_COLUMNS = {
	supplierReference: ['SupplierReference', 'SupplierRef', 'SupplierReferenceNo', 'SupplierItemCode', 'ItemSupplierReference'],
	unitDecimalPlace: ['UnitDecimalPlace', 'UnitDecimalPlaces', 'DecimalPlace', 'DecimalPlaces', 'StockUnitDecimalPlace'],
};
const optionalColumnsBySite = new Map();

async function optionalColumns(site) {
	if (!optionalColumnsBySite.has(site)) {
		const all = Object.values(OPTIONAL_COLUMNS).flat();
		const promise = query(site, `
			SELECT name FROM sys.columns
			WHERE object_id = OBJECT_ID('dbo.ItemMaster') AND name IN (${all.map((_, i) => `@c${i}`).join(', ')})
		`, Object.fromEntries(all.map((c, i) => [`c${i}`, [sql.NVarChar(128), c]])))
			.then((rows) => {
				const present = new Set(rows.map((r) => String(r.name).toLowerCase()));
				const pick = (names) => names.find((n) => present.has(n.toLowerCase())) ?? null;
				return { supplierReference: pick(OPTIONAL_COLUMNS.supplierReference), unitDecimalPlace: pick(OPTIONAL_COLUMNS.unitDecimalPlace) };
			})
			.catch((err) => {
				optionalColumnsBySite.delete(site);
				throw err;
			});
		optionalColumnsBySite.set(site, promise);
	}
	return optionalColumnsBySite.get(site);
}

export function defaultExtras(item) {
	const unit = String(item.stockUnit ?? '').trim().toUpperCase();
	return { supplierReference: null, unitDecimalPlace: unit === 'KG' || unit === 'KGS' ? 3 : 0 };
}

async function itemExtras({ site, companyId, itemIds }) {
	const out = new Map();
	if (!itemIds.length) return out;
	let cols;
	try {
		cols = await optionalColumns(site);
	} catch (err) {
		console.warn('[issue-tool] optional item columns unavailable:', err.message);
		return out;
	}
	if (!cols.supplierReference && !cols.unitDecimalPlace) return out;
	const list = inList('i', [...new Set(itemIds)]);
	// Column names come from sys.columns and the fixed lists above, never from the client.
	const rows = await query(site, `
		SELECT IM.ItemID, IM.StockUnit,
		       ${cols.supplierReference ? `IM.[${cols.supplierReference}]` : 'NULL'} AS SupplierReference,
		       ${cols.unitDecimalPlace ? `IM.[${cols.unitDecimalPlace}]` : 'NULL'} AS UnitDecimalPlace
		FROM dbo.ItemMaster IM
		WHERE IM.CompanyID = @companyId AND IM.ItemID IN (${list.sql})
	`, { companyId: [sql.Int, companyId], ...list.params });
	for (const r of rows) {
		const fallback = defaultExtras({ stockUnit: r.StockUnit });
		out.set(r.ItemID, {
			supplierReference: str(r.SupplierReference),
			unitDecimalPlace: r.UnitDecimalPlace === null || r.UnitDecimalPlace === undefined ? fallback.unitDecimalPlace : Number(r.UnitDecimalPlace),
		});
	}
	return out;
}

/** Pure: planned items first, then search hits not already listed. */
export function mergeItems(requirement, found) {
	if (!requirement) return found.map((item) => ({ ...item, planned: false }));

	const pendingFor = (item) => {
		const g = requirement.requirementGroups.find(
			(r) => r.itemGroupId === item.itemGroupId && unitKey(r.stockUnit) === unitKey(item.stockUnit),
		);
		return g ? g.pending : 0;
	};

	const planned = requirement.plannedItems.map((p) => ({ ...p, planned: true, pendingForJob: pendingFor(p) }));
	const seen = new Set(planned.map((p) => p.itemId));
	const others = found
		.filter((item) => !seen.has(item.itemId))
		.map((item) => ({ ...item, planned: false, pendingForJob: pendingFor(item) }));
	return [...planned, ...others];
}

/**
 * Batches for an item with stock above zero.
 *
 * Grouped exactly as UPDATE_ITEM_STOCK_VALUES groups them — live ITD rows of
 * the item, vouchers not in (-8, -9, -11), by ISNULL(ParentTransactionID,0),
 * ISNULL(WarehouseID,0), NULLIF(BatchNo,'') — so the batch total equals
 * ItemMaster.PhysicalStock. Oldest GRN first.
 *
 * The batch key the client sends back with an issue line is
 * { parentTransactionId, warehouseId, batchNo }, exactly as returned here.
 */
export async function itemBatches({ site, companyId, itemId }) {
	const [itemRows, batchRows] = await Promise.all([
		query(site, `
			SELECT ${ITEM_COLUMNS}
			FROM dbo.ItemMaster IM
			LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
			LEFT JOIN dbo.ItemSubGroupMaster ISG ON ISG.ItemSubGroupID = IM.ItemSubGroupID AND ISG.CompanyID = IM.CompanyID
			WHERE IM.ItemID = @itemId AND IM.CompanyID = @companyId
		`, { itemId: [sql.BigInt, itemId], companyId: [sql.Int, companyId] }),
		query(site, `
			WITH G AS (
				SELECT ISNULL(D.ParentTransactionID, 0) AS ParentTransactionID,
				       ISNULL(D.WarehouseID, 0) AS WarehouseID,
				       NULLIF(D.BatchNo, '') AS BatchNo,
				       SUM(ISNULL(D.ReceiptQuantity, 0) - ISNULL(D.IssueQuantity, 0) - ISNULL(D.RejectedQuantity, 0)) AS BatchStock,
				       MAX(D.BatchID) AS AnyBatchID
				FROM dbo.ItemTransactionDetail D
				JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
				WHERE D.ItemID = @itemId
				  AND D.CompanyID = @companyId
				  AND ISNULL(D.IsDeletedTransaction, 0) = 0
				  AND ISNULL(D.IsCancelled, 0) = 0
				  AND ISNULL(M.IsDeletedTransaction, 0) = 0
				  AND M.VoucherID NOT IN (-8, -9, -11)
				GROUP BY ISNULL(D.ParentTransactionID, 0), ISNULL(D.WarehouseID, 0), NULLIF(D.BatchNo, '')
				HAVING SUM(ISNULL(D.ReceiptQuantity, 0) - ISNULL(D.IssueQuantity, 0) - ISNULL(D.RejectedQuantity, 0)) > 0
			)
			SELECT G.ParentTransactionID, G.WarehouseID, G.BatchNo, G.BatchStock,
			       COALESCE(R.BatchID, G.AnyBatchID) AS BatchID, R.SupplierBatchNo,
			       PM.VoucherNo AS GrnNo, PM.VoucherDate AS GrnDate, PM.VoucherID AS ParentVoucherID,
			       WM.WarehouseName, WM.BinName
			FROM G
			LEFT JOIN dbo.ItemTransactionMain PM ON PM.TransactionID = G.ParentTransactionID
			OUTER APPLY (
				SELECT TOP (1) RD.BatchID, RD.SupplierBatchNo
				FROM dbo.ItemTransactionDetail RD
				WHERE RD.TransactionID = G.ParentTransactionID
				  AND RD.ItemID = @itemId
				  AND RD.CompanyID = @companyId
				  AND ISNULL(RD.WarehouseID, 0) = G.WarehouseID
				  AND ISNULL(NULLIF(RD.BatchNo, ''), '') = ISNULL(G.BatchNo, '')
				  AND ISNULL(RD.IsDeletedTransaction, 0) = 0
				ORDER BY RD.TransactionDetailID
			) R
			LEFT JOIN dbo.WarehouseMaster WM ON WM.WarehouseID = G.WarehouseID AND WM.CompanyID = @companyId
			ORDER BY CASE WHEN PM.VoucherDate IS NULL THEN 1 ELSE 0 END, PM.VoucherDate, G.ParentTransactionID, G.BatchNo
		`, { itemId: [sql.BigInt, itemId], companyId: [sql.Int, companyId] }),
	]);

	if (!itemRows.length) throw new ApiError(404, 'UNKNOWN_ITEM', 'The item does not exist.');
	const item = mapItem(itemRows[0]);
	const batches = batchRows.map(mapBatch);
	return {
		item,
		batches,
		batchTotal: qty(batches.reduce((sum, b) => sum + b.batchStock, 0)),
		physicalStock: item.physicalStock,
	};
}

function mapBatch(row) {
	return {
		batchKey: {
			parentTransactionId: row.ParentTransactionID,
			warehouseId: row.WarehouseID,
			batchNo: str(row.BatchNo),
		},
		batchId: row.BatchID ?? null,
		supplierBatchNo: str(row.SupplierBatchNo),
		batchStock: qty(row.BatchStock),
		grnNo: str(row.GrnNo),
		grnDate: toIsoDate(row.GrnDate),
		grnVoucherId: row.ParentVoucherID ?? null,
		warehouseName: str(row.WarehouseName),
		binName: str(row.BinName),
	};
}
