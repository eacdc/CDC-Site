/**
 * One issue voucher with its lines, for the Item Issue Slip PDF.
 */

import { query, sql } from '../db.js';
import { qty, str } from './shared.js';
import { toIsoDate } from '../dates.js';
import { ApiError } from '../errors.js';

export async function issueSlipData({ site, companyId, transactionId }) {
	const params = { companyId: [sql.Int, companyId], transactionId: [sql.BigInt, transactionId] };
	const [headers, lines] = await Promise.all([
		query(site, `
			SELECT M.TransactionID, M.VoucherID, M.VoucherNo, M.VoucherDate, M.Narration,
			       ISNULL(M.IsDeletedTransaction, 0) AS IsDeleted,
			       DM.DepartmentName, UM.UserName AS IssuedBy,
			       COALESCE(JC.JobCardContentNo, LJ.JobCardContentNo) AS JobCardContentNo,
			       COALESCE(JB.JobName, LJ.JobName) AS JobName,
			       COALESCE(NULLIF(JB.ClientName, ''), LM.LedgerName, LJ.ClientName) AS ClientName
			FROM dbo.ItemTransactionMain M
			LEFT JOIN dbo.UserMaster UM ON UM.UserID = M.CreatedBy
			LEFT JOIN dbo.DepartmentMaster DM ON DM.DepartmentID = M.DepartmentID AND DM.CompanyID = M.CompanyID
			LEFT JOIN dbo.JobBookingJobCardContents JC
			       ON JC.JobBookingJobCardContentsID = M.JobBookingJobCardContentsID AND JC.CompanyID = M.CompanyID
			      AND ISNULL(M.JobBookingJobCardContentsID, 0) <> 0
			LEFT JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = JC.JobBookingID AND JB.CompanyID = JC.CompanyID
			LEFT JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = JB.OrderBookingID
			LEFT JOIN dbo.LedgerMaster LM ON LM.LedgerID = JOB.LedgerID
			OUTER APPLY (
				-- A header without a content (direct issue: the job is on the lines).
				SELECT TOP (1) LJC.JobCardContentNo, LJB.JobName,
				       ISNULL(NULLIF(LJB.ClientName, ''), LLM.LedgerName) AS ClientName
				FROM dbo.ItemTransactionDetail D
				JOIN dbo.JobBookingJobCardContents LJC
				  ON LJC.JobBookingJobCardContentsID = D.JobBookingJobCardContentsID AND LJC.CompanyID = D.CompanyID
				LEFT JOIN dbo.JobBookingJobCard LJB ON LJB.JobBookingID = LJC.JobBookingID AND LJB.CompanyID = LJC.CompanyID
				LEFT JOIN dbo.JobOrderBooking LJOB ON LJOB.OrderBookingID = LJB.OrderBookingID
				LEFT JOIN dbo.LedgerMaster LLM ON LLM.LedgerID = LJOB.LedgerID
				WHERE D.TransactionID = M.TransactionID AND ISNULL(D.JobBookingJobCardContentsID, 0) <> 0
				ORDER BY D.TransID
			) LJ
			WHERE M.TransactionID = @transactionId AND M.CompanyID = @companyId
		`, params),
		query(site, `
			SELECT D.TransID, IM.ItemCode, IM.ItemName, D.StockUnit, D.IssueQuantity, D.BatchNo,
			       W.WarehouseName, W.BinName, G.VoucherNo AS GrnNo
			FROM dbo.ItemTransactionDetail D
			JOIN dbo.ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
			LEFT JOIN dbo.WarehouseMaster W ON W.WarehouseID = D.WarehouseID AND W.CompanyID = D.CompanyID
			LEFT JOIN dbo.ItemTransactionMain G ON G.TransactionID = D.ParentTransactionID AND ISNULL(D.ParentTransactionID, 0) <> 0
			WHERE D.TransactionID = @transactionId AND D.CompanyID = @companyId
			  AND ISNULL(D.IsCancelled, 0) = 0
			ORDER BY D.TransID
		`, params),
	]);

	const h = headers[0];
	if (!h || Number(h.VoucherID) !== -19) throw new ApiError(404, 'UNKNOWN_ISSUE', 'The issue voucher does not exist.');

	return {
		voucherNo: str(h.VoucherNo),
		voucherDate: toIsoDate(h.VoucherDate),
		deleted: h.IsDeleted === 1 || h.IsDeleted === true,
		departmentName: str(h.DepartmentName),
		jobCardNo: str(h.JobCardContentNo),
		jobName: str(h.JobName),
		clientName: str(h.ClientName),
		narration: str(h.Narration),
		issuedBy: str(h.IssuedBy),
		lines: lines.map((l) => ({
			itemCode: str(l.ItemCode),
			itemName: str(l.ItemName),
			unit: str(l.StockUnit),
			quantity: qty(l.IssueQuantity),
			batchNo: str(l.BatchNo),
			warehouse: str(l.WarehouseName),
			grnNo: str(l.GrnNo),
			bin: str(l.BinName),
		})),
	};
}
