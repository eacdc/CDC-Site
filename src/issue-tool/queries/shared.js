/**
 * SQL fragments and row mappers shared by the read queries.
 *
 * Conventions that have bitten us before (brief 3):
 *  - IsDeletedTransaction is filtered on both ITM and ITD; IsCancelled on ITD
 *    only, because ITM has no IsCancelled column.
 *  - Job, item and master tables join on CompanyID as well as their ID.
 *  - StockUnit casing varies (Kg / KG / Sheet): compare with UPPER().
 */

/** Live -19 issue lines: `FROM ${ISSUE_FROM} WHERE ${LIVE_ISSUE}`. Needs @companyId. */
export const ISSUE_FROM = `
	dbo.ItemTransactionDetail D
	JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID`;

export const LIVE_ISSUE = `
	M.VoucherID = -19
	  AND M.CompanyID = @companyId
	  AND ISNULL(M.IsDeletedTransaction, 0) = 0
	  AND ISNULL(D.IsDeletedTransaction, 0) = 0
	  AND ISNULL(D.IsCancelled, 0) = 0`;

/**
 * Item columns, from `IM`, `IGM` and `ISG` (ItemSubGroupMaster, joined on
 * ItemSubGroupID). Free stock is worked out as physical − allocated, as the
 * ERP's issue screen shows it.
 */
export const ITEM_COLUMNS = `
	IM.ItemID, IM.ItemCode, IM.ItemName, IM.ItemGroupID, IGM.ItemGroupName, ISG.ItemSubGroupName,
	IM.Quality, IM.GSM, IM.SizeW, IM.SizeL, IM.Manufecturer AS Manufacturer,
	IM.CertificationType, IM.StockUnit, IM.PhysicalStock, IM.AllocatedStock,
	IM.IncomingStock, IM.UnapprovedStock`;

/** The same columns for a GROUP BY. */
export const ITEM_GROUP_BY = `
	IM.ItemID, IM.ItemCode, IM.ItemName, IM.ItemGroupID, IGM.ItemGroupName, ISG.ItemSubGroupName,
	IM.Quality, IM.GSM, IM.SizeW, IM.SizeL, IM.Manufecturer,
	IM.CertificationType, IM.StockUnit, IM.PhysicalStock, IM.AllocatedStock,
	IM.IncomingStock, IM.UnapprovedStock`;

export function num(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** Quantities to 3 decimals, so 0.1 + 0.2 never shows as 0.30000000000000004. */
export function qty(value) {
	const n = num(value);
	return n === null ? 0 : Math.round(n * 1000) / 1000;
}

export function str(value) {
	if (value === null || value === undefined) return null;
	const s = String(value).trim();
	return s === '' ? null : s;
}

/** "1020 x 720" from SizeW / SizeL, or null. */
export function sizeOf(row) {
	const w = num(row.SizeW);
	const l = num(row.SizeL);
	if (!w && !l) return null;
	return [w, l].filter(Boolean).join(' x ');
}

export function mapItem(row) {
	return {
		itemId: row.ItemID,
		itemCode: str(row.ItemCode),
		itemName: str(row.ItemName),
		itemGroupId: row.ItemGroupID,
		itemGroupName: str(row.ItemGroupName),
		itemSubGroupName: str(row.ItemSubGroupName),
		quality: str(row.Quality),
		gsm: num(row.GSM),
		size: sizeOf(row),
		sizeW: num(row.SizeW),
		sizeL: num(row.SizeL),
		manufacturer: str(row.Manufacturer),
		certification: str(row.CertificationType),
		stockUnit: str(row.StockUnit),
		physicalStock: qty(row.PhysicalStock),
		allocatedStock: qty(row.AllocatedStock),
		freeStock: qty(qty(row.PhysicalStock) - qty(row.AllocatedStock)),
		incomingStock: qty(row.IncomingStock),
		unapprovedStock: qty(row.UnapprovedStock),
	};
}

/** The key the frontend groups requirement by: item group + stock unit. */
export function unitKey(stockUnit) {
	return String(stockUnit ?? '').trim().toUpperCase();
}
