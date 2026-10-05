/**
 * Recent issues for the History view (brief 6.4): live -19 vouchers in a date
 * range, with their lines, creator, and whether delete is allowed.
 *
 * Every live -19 voucher is listed, whether this tool or the ERP created it;
 * createdByIssueTool tells them apart.
 */

import { query, sql, inList } from '../db.js';
import { mapItem, qty, str } from './shared.js';
import { toIsoDate, toLocalDateTime } from '../dates.js';

export async function recentIssues({ site, companyId, from, to }) {
	const headers = await query(site, `
		SELECT TOP (500)
		       M.TransactionID, M.VoucherNo, M.VoucherDate, M.DeliveryNoteNo, M.TotalQuantity,
		       M.Narration,                       -- ASSUMPTION (brief 7): remark is stored in Narration
		       M.DepartmentID, DM.DepartmentName,
		       M.JobBookingJobCardContentsID, JC.JobCardContentNo, JC.PlanContName,
		       JB.JobBookingNo, JB.JobName,
		       M.CreatedBy, UM.UserName AS CreatedByName, M.CreatedDate,
		       CASE WHEN EXISTS (SELECT 1 FROM dbo.ItemConsumptionDetail C WHERE C.IssueTransactionID = M.TransactionID)
		            THEN 1 ELSE 0 END AS IsConsumed,
		       CASE WHEN EXISTS (SELECT 1 FROM dbo.IssueTool_PostLog L WHERE L.TransactionID = M.TransactionID AND L.IsDryRun = 0)
		            THEN 1 ELSE 0 END AS CreatedByIssueTool
		FROM dbo.ItemTransactionMain M
		LEFT JOIN dbo.JobBookingJobCardContents JC
		       ON JC.JobBookingJobCardContentsID = M.JobBookingJobCardContentsID AND JC.CompanyID = M.CompanyID
		LEFT JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = JC.JobBookingID AND JB.CompanyID = JC.CompanyID
		LEFT JOIN dbo.DepartmentMaster DM ON DM.DepartmentID = M.DepartmentID AND DM.CompanyID = M.CompanyID
		LEFT JOIN dbo.UserMaster UM ON UM.UserID = M.CreatedBy
		WHERE M.VoucherID = -19
		  AND M.CompanyID = @companyId
		  AND ISNULL(M.IsDeletedTransaction, 0) = 0
		  AND M.VoucherDate >= @from
		  AND M.VoucherDate < DATEADD(DAY, 1, @to)
		ORDER BY M.VoucherDate DESC, M.MaxVoucherNo DESC
	`, {
		companyId: [sql.Int, companyId],
		from: [sql.Date, from],
		to: [sql.Date, to],
	});

	if (!headers.length) return { from, to, rows: [] };

	const list = inList('t', headers.map((h) => h.TransactionID));
	const lines = await query(site, `
		SELECT D.TransactionID, D.TransactionDetailID, D.TransID, D.IssueQuantity, D.BatchNo,
		       D.PicklistTransactionID, PL.VoucherNo AS PicklistNo,
		       D.WarehouseID, W.WarehouseName, W.BinName,
		       D.FloorWarehouseID, FW.WarehouseName AS FloorWarehouseName, FW.BinName AS FloorBinName,
		       IM.ItemID, IM.ItemCode, IM.ItemName, IM.ItemGroupID, IGM.ItemGroupName,
		       IM.Quality, IM.GSM, IM.SizeW, IM.SizeL, IM.Manufecturer AS Manufacturer,
		       D.StockUnit, IM.PhysicalStock
		FROM dbo.ItemTransactionDetail D
		JOIN dbo.ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
		LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
		LEFT JOIN dbo.ItemTransactionMain PL ON PL.TransactionID = D.PicklistTransactionID AND ISNULL(D.PicklistTransactionID, 0) <> 0
		LEFT JOIN dbo.WarehouseMaster W ON W.WarehouseID = D.WarehouseID AND W.CompanyID = D.CompanyID
		LEFT JOIN dbo.WarehouseMaster FW ON FW.WarehouseID = D.FloorWarehouseID AND FW.CompanyID = D.CompanyID
		WHERE D.TransactionID IN (${list.sql})
		  AND ISNULL(D.IsDeletedTransaction, 0) = 0
		  AND ISNULL(D.IsCancelled, 0) = 0
		ORDER BY D.TransactionID, D.TransID
	`, list.params);

	return { from, to, rows: assembleIssues(headers, lines) };
}

/** Pure: headers plus their lines, in the shape docs/issue-tool-api.md gives. */
export function assembleIssues(headers, lines) {
	const byTransaction = new Map();
	for (const line of lines) {
		if (!byTransaction.has(line.TransactionID)) byTransaction.set(line.TransactionID, []);
		byTransaction.get(line.TransactionID).push({
			transactionDetailId: line.TransactionDetailID,
			transId: line.TransID,
			item: mapItem(line),
			stockUnit: str(line.StockUnit),
			issueQuantity: qty(line.IssueQuantity),
			batchNo: str(line.BatchNo),
			warehouseName: str(line.WarehouseName),
			binName: str(line.BinName),
			floorWarehouseId: line.FloorWarehouseID ?? null,
			floorWarehouseName: str(line.FloorWarehouseName),
			floorBinName: str(line.FloorBinName),
			picklistTransactionId: line.PicklistTransactionID || null,
			picklistNo: str(line.PicklistNo),
		});
	}

	return headers.map((h) => {
		const issueLines = byTransaction.get(h.TransactionID) ?? [];
		const consumed = h.IsConsumed === 1 || h.IsConsumed === true;
		return {
			transactionId: h.TransactionID,
			voucherNo: str(h.VoucherNo),
			voucherDate: toIsoDate(h.VoucherDate),
			mode: issueLines.some((l) => l.picklistTransactionId) ? 'ALLOCATED' : 'DIRECT',
			jobCardNo: str(h.JobBookingNo),
			jobContentNo: str(h.JobCardContentNo),
			jobName: str(h.JobName),
			contentName: str(h.PlanContName),
			departmentId: h.DepartmentID ?? null,
			departmentName: str(h.DepartmentName),
			slipNo: str(h.DeliveryNoteNo),
			remark: str(h.Narration),
			totalQuantity: qty(h.TotalQuantity),
			createdBy: { userId: h.CreatedBy ?? null, userName: str(h.CreatedByName) },
			createdDate: toLocalDateTime(h.CreatedDate),
			createdByIssueTool: h.CreatedByIssueTool === 1 || h.CreatedByIssueTool === true,
			canDelete: !consumed,
			deleteBlockedReason: consumed ? 'Material from this issue has been consumed.' : null,
			lines: issueLines,
		};
	});
}
