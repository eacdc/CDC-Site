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

/** Most issue vouchers one History request returns; `truncated` says when there were more. */
export const MAX_HISTORY_ISSUES = 3000;

export async function recentIssues({ site, companyId, from, to }) {
	const headers = await query(site, `
		SELECT TOP (${MAX_HISTORY_ISSUES + 1})
		       M.TransactionID, M.VoucherNo, M.VoucherDate, M.DeliveryNoteNo, M.TotalQuantity,
		       M.Narration,                       -- ASSUMPTION (brief 7): remark is stored in Narration
		       M.DepartmentID, DM.DepartmentName,
		       M.JobBookingJobCardContentsID, JC.JobCardContentNo, JC.PlanContName,
		       JB.JobBookingNo, JB.JobName,
		       ISNULL(NULLIF(JB.ClientName, ''), LM.LedgerName) AS ClientName,
		       M.CreatedBy, UM.UserName AS CreatedByName, M.CreatedDate,
		       -- Same rule as usp_IssueTool_DeleteIssue: the issue's own floor
		       -- receipt (RFS, VoucherID -53) does not count; anything that
		       -- consumed, returned or wasted material, or any other voucher
		       -- pointing at the issue, does.
		       CASE WHEN EXISTS (
		              SELECT 1 FROM dbo.ItemConsumptionDetail C
		              LEFT JOIN dbo.ItemConsumptionMain CM
		                     ON CM.ConsumptionTransactionID = C.ConsumptionTransactionID
		                    AND CM.VoucherID = -53
		                    AND CM.ReturnTransactionID = M.TransactionID
		                    AND ISNULL(CM.IsDeletedTransaction, 0) = 0
		              WHERE C.IssueTransactionID = M.TransactionID
		                AND C.CompanyID = M.CompanyID
		                AND ISNULL(C.IsDeletedTransaction, 0) = 0
		                AND (   ISNULL(C.ConsumeQuantity, 0) <> 0
		                     OR ISNULL(C.ReturnQuantity, 0) <> 0
		                     OR ISNULL(C.WasteQuantity, 0) <> 0
		                     OR CM.ConsumptionTransactionID IS NULL))
		            THEN 1 ELSE 0 END AS IsConsumed,
		       CASE WHEN EXISTS (SELECT 1 FROM dbo.IssueTool_PostLog L WHERE L.TransactionID = M.TransactionID AND L.IsDryRun = 0)
		            THEN 1 ELSE 0 END AS CreatedByIssueTool
		FROM dbo.ItemTransactionMain M
		LEFT JOIN dbo.JobBookingJobCardContents JC
		       ON JC.JobBookingJobCardContentsID = M.JobBookingJobCardContentsID AND JC.CompanyID = M.CompanyID
		LEFT JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = JC.JobBookingID AND JB.CompanyID = JC.CompanyID
		LEFT JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = JB.OrderBookingID
		LEFT JOIN dbo.LedgerMaster LM ON LM.LedgerID = JOB.LedgerID
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

	if (!headers.length) return { from, to, rows: [], truncated: false };
	const truncated = headers.length > MAX_HISTORY_ISSUES;
	if (truncated) headers.length = MAX_HISTORY_ISSUES;

	// The IN list goes in batches: SQL Server takes at most 2,100 parameters.
	const lines = [];
	for (let i = 0; i < headers.length; i += 1000) {
		lines.push(...await issueLines(site, headers.slice(i, i + 1000).map((h) => h.TransactionID)));
	}

	return { from, to, rows: assembleIssues(headers, lines), truncated };
}

/**
 * Lines of the given vouchers, with the issue register's columns: item group
 * and sub group, machine, and the line's own job content and client (a line
 * can belong to a different content than its header).
 */
async function issueLines(site, transactionIds) {
	const list = inList('t', transactionIds);
	return query(site, `
		SELECT D.TransactionID, D.TransactionDetailID, D.TransID, D.IssueQuantity, D.BatchNo,
		       D.PicklistTransactionID, PL.VoucherNo AS PicklistNo,
		       D.WarehouseID, W.WarehouseName, W.BinName,
		       D.FloorWarehouseID, FW.WarehouseName AS FloorWarehouseName, FW.BinName AS FloorBinName,
		       IM.ItemID, IM.ItemCode, IM.ItemName, IM.ItemGroupID, IGM.ItemGroupName,
		       IM.Quality, IM.GSM, IM.SizeW, IM.SizeL, IM.Manufecturer AS Manufacturer, IM.CertificationType,
		       D.StockUnit, IM.PhysicalStock, IM.AllocatedStock,
		       SG.ItemSubGroupName,
		       D.MachineID, MM.MachineName,
		       D.JobBookingJobCardContentsID AS LineContentID, LJC.JobCardContentNo AS LineContentNo,
		       LJC.PlanContName AS LineContentName, LJB.JobName AS LineJobName,
		       ISNULL(NULLIF(LJB.ClientName, ''), LLM.LedgerName) AS LineClientName
		FROM dbo.ItemTransactionDetail D
		JOIN dbo.ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
		LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
		LEFT JOIN dbo.ItemSubGroupMaster SG ON SG.ItemSubGroupID = IM.ItemSubGroupID AND SG.CompanyID = IM.CompanyID
		LEFT JOIN dbo.MachineMaster MM ON MM.MachineId = D.MachineID AND MM.CompanyID = D.CompanyID AND ISNULL(D.MachineID, 0) <> 0
		LEFT JOIN dbo.JobBookingJobCardContents LJC
		       ON LJC.JobBookingJobCardContentsID = D.JobBookingJobCardContentsID AND LJC.CompanyID = D.CompanyID
		      AND ISNULL(D.JobBookingJobCardContentsID, 0) <> 0
		LEFT JOIN dbo.JobBookingJobCard LJB ON LJB.JobBookingID = LJC.JobBookingID AND LJB.CompanyID = LJC.CompanyID
		LEFT JOIN dbo.JobOrderBooking LJOB ON LJOB.OrderBookingID = LJB.OrderBookingID
		LEFT JOIN dbo.LedgerMaster LLM ON LLM.LedgerID = LJOB.LedgerID
		LEFT JOIN dbo.ItemTransactionMain PL ON PL.TransactionID = D.PicklistTransactionID AND ISNULL(D.PicklistTransactionID, 0) <> 0
		LEFT JOIN dbo.WarehouseMaster W ON W.WarehouseID = D.WarehouseID AND W.CompanyID = D.CompanyID
		LEFT JOIN dbo.WarehouseMaster FW ON FW.WarehouseID = D.FloorWarehouseID AND FW.CompanyID = D.CompanyID
		WHERE D.TransactionID IN (${list.sql})
		  AND ISNULL(D.IsDeletedTransaction, 0) = 0
		  AND ISNULL(D.IsCancelled, 0) = 0
		ORDER BY D.TransactionID, D.TransID
	`, list.params);
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
			itemSubGroupName: str(line.ItemSubGroupName),
			machineId: line.MachineID || null,
			machineName: str(line.MachineName),
			jobContentId: line.LineContentID || null,
			jobContentNo: str(line.LineContentNo),
			jobName: str(line.LineJobName),
			contentName: str(line.LineContentName),
			clientName: str(line.LineClientName),
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
			clientName: str(h.ClientName),
			departmentId: h.DepartmentID ?? null,
			departmentName: str(h.DepartmentName),
			slipNo: str(h.DeliveryNoteNo),
			remark: str(h.Narration),
			totalQuantity: qty(h.TotalQuantity),
			createdBy: { userId: h.CreatedBy ?? null, userName: str(h.CreatedByName) },
			createdDate: toLocalDateTime(h.CreatedDate),
			createdByIssueTool: h.CreatedByIssueTool === 1 || h.CreatedByIssueTool === true,
			canDelete: !consumed,
			deleteBlockedReason: consumed ? 'Material from this issue has been consumed or returned.' : null,
			lines: issueLines,
		};
	});
}
