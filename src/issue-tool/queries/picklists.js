/**
 * Open picklist lines for the "Against picklist" tab (brief 6.4).
 *
 * A line is a -17 ITD row that is live, not cancelled and IsCompleted = 0.
 * Issued = live -19 IssueQuantity matched on PicklistTransactionID + ItemID +
 * JobBookingJobCardContentsID; Pending = RequiredQuantity - Issued.
 *
 * Structured so a "close line" action can be added later: each row carries
 * picklistDetailId, which is what closing would act on.
 */

import { query, sql, likePattern } from '../db.js';
import { ITEM_COLUMNS, ISSUE_FROM, LIVE_ISSUE, mapItem, qty, str } from './shared.js';
import { toIsoDate } from '../dates.js';

export async function listPicklistLines({ site, companyId, search, page, pageSize, showFullyIssued }) {
	const rows = await query(site, `
		WITH Lines AS (
			SELECT P.TransactionDetailID, PM.TransactionID AS PicklistTransactionID,
			       PM.VoucherNo AS PicklistNo, PM.VoucherDate AS PicklistDate,
			       P.ItemID, P.JobBookingID, P.JobBookingJobCardContentsID,
			       ISNULL(P.RequiredQuantity, 0) AS RequiredQuantity,
			       ISNULL(ISS.Issued, 0) AS IssuedQuantity
			FROM dbo.ItemTransactionDetail P
			JOIN dbo.ItemTransactionMain PM ON PM.TransactionID = P.TransactionID
			OUTER APPLY (
				SELECT SUM(ISNULL(D.IssueQuantity, 0)) AS Issued
				FROM ${ISSUE_FROM}
				WHERE ${LIVE_ISSUE}
				  AND D.PicklistTransactionID = PM.TransactionID
				  AND D.ItemID = P.ItemID
				  AND D.JobBookingJobCardContentsID = P.JobBookingJobCardContentsID
			) ISS
			WHERE PM.VoucherID = -17
			  AND PM.CompanyID = @companyId
			  AND ISNULL(PM.IsDeletedTransaction, 0) = 0
			  AND ISNULL(P.IsDeletedTransaction, 0) = 0
			  AND ISNULL(P.IsCancelled, 0) = 0
			  AND ISNULL(P.IsCompleted, 0) = 0
		)
		SELECT L.TransactionDetailID, L.PicklistTransactionID, L.PicklistNo, L.PicklistDate,
		       L.JobBookingID, L.JobBookingJobCardContentsID,
		       L.RequiredQuantity, L.IssuedQuantity,
		       L.RequiredQuantity - L.IssuedQuantity AS PendingQuantity,
		       JB.JobBookingNo, JB.JobName, JC.JobCardContentNo, JC.PlanContName,
		       ISNULL(NULLIF(JB.ClientName, ''), LM.LedgerName) AS ClientName,
		       ${ITEM_COLUMNS},
		       COUNT(*) OVER () AS TotalRows
		FROM Lines L
		JOIN dbo.ItemMaster IM ON IM.ItemID = L.ItemID AND IM.CompanyID = @companyId
		LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
		LEFT JOIN dbo.JobBookingJobCardContents JC
		       ON JC.JobBookingJobCardContentsID = L.JobBookingJobCardContentsID AND JC.CompanyID = @companyId
		LEFT JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = L.JobBookingID AND JB.CompanyID = @companyId
		LEFT JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = JB.OrderBookingID
		LEFT JOIN dbo.LedgerMaster LM ON LM.LedgerID = JOB.LedgerID
		WHERE (@showFullyIssued = 1 OR L.RequiredQuantity - L.IssuedQuantity > 0)
		  AND (
		        @search = ''
		     OR L.PicklistNo LIKE @like ESCAPE '\\'
		     OR JB.JobBookingNo LIKE @like ESCAPE '\\'
		     OR JC.JobCardContentNo LIKE @like ESCAPE '\\'
		     OR JB.JobName LIKE @like ESCAPE '\\'
		     OR JC.PlanContName LIKE @like ESCAPE '\\'
		     OR ISNULL(NULLIF(JB.ClientName, ''), LM.LedgerName) LIKE @like ESCAPE '\\'
		     OR IM.ItemCode LIKE @like ESCAPE '\\'
		     OR IM.ItemName LIKE @like ESCAPE '\\'
		  )
		ORDER BY L.PicklistDate DESC, L.PicklistTransactionID DESC, L.TransactionDetailID
		OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
	`, {
		companyId: [sql.Int, companyId],
		showFullyIssued: [sql.Bit, showFullyIssued ? 1 : 0],
		search: [sql.NVarChar(100), search],
		like: [sql.NVarChar(210), likePattern(search)],
		offset: [sql.Int, (page - 1) * pageSize],
		pageSize: [sql.Int, pageSize],
	});

	return {
		rows: rows.map(mapPicklistLine),
		page,
		pageSize,
		total: rows[0]?.TotalRows ?? (page === 1 ? 0 : null),
	};
}

export function mapPicklistLine(row) {
	return {
		picklistDetailId: row.TransactionDetailID,
		picklistTransactionId: row.PicklistTransactionID,
		picklistNo: str(row.PicklistNo),
		picklistDate: toIsoDate(row.PicklistDate),
		clientName: str(row.ClientName),
		jobBookingId: row.JobBookingID,
		jobContentId: row.JobBookingJobCardContentsID,
		jobCardNo: str(row.JobBookingNo),
		jobContentNo: str(row.JobCardContentNo),
		jobName: str(row.JobName),
		contentName: str(row.PlanContName),
		item: mapItem(row),
		required: qty(row.RequiredQuantity),
		issued: qty(row.IssuedQuantity),
		pending: qty(row.PendingQuantity),
	};
}
