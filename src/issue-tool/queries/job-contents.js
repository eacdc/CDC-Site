/**
 * Job contents for the "Direct issue" tab (brief 6.4).
 *
 * Searched by job card number (JobBookingNo, e.g. J06482_26_27) or content
 * number (JobCardContentNo, e.g. J06482_26_27[1_1]), and by the Job Card
 * Generator's other filters. For each content: the
 * planned items with required / issued / pending, and the same figures per
 * item group + stock unit, which is what a substitute item counts against.
 */

import { query, sql, likePattern, inList } from '../db.js';
import { ITEM_COLUMNS, ITEM_GROUP_BY, ISSUE_FROM, LIVE_ISSUE, mapItem, qty, str, unitKey } from './shared.js';
import { toIsoDate } from '../dates.js';

/** Most contents one search returns; `truncated` says when there were more. */
export const MAX_CONTENTS = 500;

/**
 * Job contents matching the Job Card Generator's filters: job number (job
 * card or content number), client, sales person, job date range and status.
 * Status is worked out as the generator does: Cancelled, Closed (closed by
 * hand, or at least 90% of the order quantity dispatched), else Pending.
 */
export async function searchJobContents({ site, companyId, search = '', clientName = '', salesPersonId, fromDate, toDate, jobStatus }) {
	const contents = await query(site, `
		WITH J AS (
			SELECT JC.JobBookingJobCardContentsID, JC.JobBookingID, JC.JobCardContentNo, JC.PlanContName, JC.ReleasedDate,
			       JB.JobBookingNo, JB.JobName, JB.JobBookingDate,
			       ISNULL(NULLIF(JB.ClientName, ''), LM.LedgerName) AS ClientName,
			       SP.LedgerName AS SalesPersonName,
			       CASE
			           WHEN ISNULL(JB.IsCancel, 0) = 1 THEN 'cancelled'
			           WHEN ISNULL(JB.IsClose, 0) = 1 THEN 'closed'
			           WHEN ISNULL(JB.OrderQuantity, 0) > 0 AND ISNULL(DISP.DispatchQty, 0) >= 0.9 * JB.OrderQuantity THEN 'closed'
			           ELSE 'pending'
			       END AS JobStatus
			FROM dbo.JobBookingJobCardContents JC
			JOIN dbo.JobBookingJobCard JB ON JB.JobBookingID = JC.JobBookingID AND JB.CompanyID = JC.CompanyID
			LEFT JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = JB.OrderBookingID
			LEFT JOIN dbo.LedgerMaster LM ON LM.LedgerID = JOB.LedgerID
			LEFT JOIN dbo.LedgerMaster SP ON SP.LedgerID = JB.SalesEmployeeID
			OUTER APPLY (
				-- Delivered quantity, as the Job Card Generator counts it (DN dispatch notes).
				SELECT SUM(ISNULL(FGD.InnerCarton, 0) * ISNULL(FGD.QuantityPerPack, 0)) AS DispatchQty
				FROM dbo.FinishGoodsTransactionDetail FGD
				JOIN dbo.FinishGoodsTransactionMain FGM ON FGM.FGTransactionID = FGD.FGTransactionID
				WHERE FGD.JobBookingID = JB.JobBookingID
				  AND FGM.VoucherID = -51 AND FGM.VoucherPrefix = 'DN'
				  AND ISNULL(FGM.IsDeletedTransaction, 0) = 0
				  AND ISNULL(FGD.IsDeletedTransaction, 0) = 0
			) DISP
			WHERE JC.CompanyID = @companyId
			  AND ISNULL(JC.IsDeletedTransaction, 0) = 0
			  AND ISNULL(JB.IsDeletedTransaction, 0) = 0
			  AND (@search = '' OR JB.JobBookingNo LIKE @like ESCAPE '\\' OR JC.JobCardContentNo LIKE @like ESCAPE '\\')
			  AND (@client = '' OR ISNULL(NULLIF(JB.ClientName, ''), LM.LedgerName) LIKE @clientLike ESCAPE '\\')
			  AND (@salesPersonId IS NULL OR JB.SalesEmployeeID = @salesPersonId)
			  AND (@fromDate IS NULL OR JB.JobBookingDate >= @fromDate)
			  AND (@toDate IS NULL OR JB.JobBookingDate < DATEADD(DAY, 1, @toDate))
		)
		SELECT TOP (${MAX_CONTENTS + 1}) *
		FROM J
		WHERE @jobStatus IS NULL OR J.JobStatus = @jobStatus
		ORDER BY J.JobBookingDate DESC, J.JobBookingID DESC, J.JobCardContentNo
	`, {
		companyId: [sql.Int, companyId],
		search: [sql.NVarChar(100), search],
		like: [sql.NVarChar(210), likePattern(search)],
		client: [sql.NVarChar(200), clientName],
		clientLike: [sql.NVarChar(410), likePattern(clientName)],
		salesPersonId: [sql.BigInt, salesPersonId ?? null],
		fromDate: [sql.Date, fromDate ?? null],
		toDate: [sql.Date, toDate ?? null],
		jobStatus: [sql.NVarChar(20), jobStatus ?? null],
	});

	if (contents.length === 0) return { rows: [], truncated: false };
	const truncated = contents.length > MAX_CONTENTS;
	if (truncated) contents.length = MAX_CONTENTS;

	const ids = contents.map((c) => c.JobBookingJobCardContentsID);
	const [requirements, departments] = await Promise.all([
		contentRequirements({ site, companyId, contentIds: ids }),
		suggestedDepartments({ site, companyId, contentIds: ids }),
	]);

	return {
		rows: contents.map((c) => {
			const id = c.JobBookingJobCardContentsID;
			const req = requirements.get(id) ?? { plannedItems: [], requirementGroups: [] };
			const dept = departments.get(id) ?? null;
			return {
				jobContentId: id,
				jobBookingId: c.JobBookingID,
				jobCardNo: str(c.JobBookingNo),
				jobContentNo: str(c.JobCardContentNo),
				jobName: str(c.JobName),
				contentName: str(c.PlanContName),
				clientName: str(c.ClientName),
				salesPersonName: str(c.SalesPersonName),
				jobBookingDate: toIsoDate(c.JobBookingDate),
				releasedDate: toIsoDate(c.ReleasedDate),
				jobStatus: c.JobStatus,
				suggestedDepartmentId: dept?.departmentId ?? null,
				suggestedDepartmentName: dept?.departmentName ?? null,
				plannedItems: req.plannedItems,
				requirementGroups: req.requirementGroups,
			};
		}),
		truncated,
	};
}

/**
 * Planned items per content, and requirement per item group + stock unit.
 *
 * Required is RequiredQuantityInStockUnit (RequiredQty exists but reads 0).
 * Issued to an item is every live -19 line to that content for that item,
 * allocated or direct. A group's issued also counts substitutes.
 *
 * @returns {Map<number, {plannedItems: Array, requirementGroups: Array}>}
 */
export async function contentRequirements({ site, companyId, contentIds }) {
	const list = inList('c', contentIds);
	const [planned, issued] = await Promise.all([
		query(site, `
			SELECT G.*, FP.ProcessID AS PlannedProcessID, FP.ProcessName AS PlannedProcessName
			FROM (
			SELECT JM.JobBookingJobCardContentsID,
			       SUM(ISNULL(JM.RequiredQuantityInStockUnit, 0)) AS RequiredQuantity,
			       MIN(JM.SequenceNo) AS FirstSequenceNo,
			       ${ITEM_COLUMNS}
			FROM dbo.JobBookingJobCardProcessMaterialRequirement JM
			JOIN dbo.ItemMaster IM ON IM.ItemID = JM.ItemID AND IM.CompanyID = JM.CompanyID
			LEFT JOIN dbo.ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
			LEFT JOIN dbo.ItemSubGroupMaster ISG ON ISG.ItemSubGroupID = IM.ItemSubGroupID AND ISG.CompanyID = IM.CompanyID
			WHERE JM.CompanyID = @companyId
			  AND ISNULL(JM.IsDeletedTransaction, 0) = 0
			  AND JM.JobBookingJobCardContentsID IN (${list.sql})
			GROUP BY JM.JobBookingJobCardContentsID, ${ITEM_GROUP_BY}
			) G
			OUTER APPLY (
				-- The process the item is planned for (the first one when several).
				SELECT TOP (1) JM2.ProcessID, PM.ProcessName
				FROM dbo.JobBookingJobCardProcessMaterialRequirement JM2
				LEFT JOIN dbo.ProcessMaster PM ON PM.ProcessID = JM2.ProcessID AND PM.CompanyID = JM2.CompanyID
				WHERE JM2.JobBookingJobCardContentsID = G.JobBookingJobCardContentsID
				  AND JM2.ItemID = G.ItemID
				  AND JM2.CompanyID = @companyId
				  AND ISNULL(JM2.IsDeletedTransaction, 0) = 0
				ORDER BY JM2.SequenceNo
			) FP
			ORDER BY G.JobBookingJobCardContentsID, G.FirstSequenceNo, G.ItemCode
		`, { companyId: [sql.Int, companyId], ...list.params }),
		query(site, `
			SELECT D.JobBookingJobCardContentsID, D.ItemID, IM.ItemGroupID, IM.StockUnit,
			       SUM(ISNULL(D.IssueQuantity, 0)) AS IssuedQuantity
			FROM ${ISSUE_FROM}
			JOIN dbo.ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
			WHERE ${LIVE_ISSUE}
			  AND D.JobBookingJobCardContentsID IN (${list.sql})
			GROUP BY D.JobBookingJobCardContentsID, D.ItemID, IM.ItemGroupID, IM.StockUnit
		`, { companyId: [sql.Int, companyId], ...list.params }),
	]);

	return buildRequirements(planned, issued);
}

/** Pure: turn the two recordsets into per-content planned items and groups. */
export function buildRequirements(planned, issued) {
	const result = new Map();
	const entry = (id) => {
		if (!result.has(id)) result.set(id, { plannedItems: [], groups: new Map() });
		return result.get(id);
	};
	const groupOf = (e, itemGroupId, stockUnit) => {
		const key = `${itemGroupId}|${unitKey(stockUnit)}`;
		if (!e.groups.has(key)) {
			e.groups.set(key, { itemGroupId, stockUnit: str(stockUnit), required: 0, issued: 0, pending: 0 });
		}
		return e.groups.get(key);
	};

	const issuedByItem = new Map();
	for (const row of issued) {
		const e = entry(row.JobBookingJobCardContentsID);
		issuedByItem.set(`${row.JobBookingJobCardContentsID}|${row.ItemID}`, qty(row.IssuedQuantity));
		groupOf(e, row.ItemGroupID, row.StockUnit).issued += qty(row.IssuedQuantity);
	}

	for (const row of planned) {
		const e = entry(row.JobBookingJobCardContentsID);
		const required = qty(row.RequiredQuantity);
		const itemIssued = issuedByItem.get(`${row.JobBookingJobCardContentsID}|${row.ItemID}`) ?? 0;
		e.plannedItems.push({
			...mapItem(row),
			processId: row.PlannedProcessID || null,
			processName: str(row.PlannedProcessName),
			required,
			issued: itemIssued,
			pending: qty(required - itemIssued),
		});
		const group = groupOf(e, row.ItemGroupID, row.StockUnit);
		group.required += required;
		group.stockUnit = str(row.StockUnit);   // label the group with the plan's spelling
	}

	const out = new Map();
	for (const [id, e] of result) {
		const requirementGroups = [...e.groups.values()]
			.filter((g) => g.required > 0)
			.map((g) => ({ ...g, required: qty(g.required), issued: qty(g.issued), pending: qty(g.required - g.issued) }));
		out.set(id, { plannedItems: e.plannedItems, requirementGroups });
	}
	return out;
}

/**
 * The department the API suggests for a direct issue: the department of the
 * process on the content's material requirement rows, the most common one if
 * there are several.
 *
 * Both columns are confirmed by discovery (process 10337 "Printing Front
 * Side" → department 100 PRINTING). That the ERP itself suggests this way is
 * still an inference (brief 5.1). A suggestion is a convenience, so if the
 * query fails the search still works and suggests nothing.
 */
async function suggestedDepartments({ site, companyId, contentIds }) {
	const list = inList('c', contentIds);
	try {
		const rows = await query(site, `
			SELECT JM.JobBookingJobCardContentsID, PM.DepartmentID, DM.DepartmentName, COUNT(*) AS Uses
			FROM dbo.JobBookingJobCardProcessMaterialRequirement JM
			JOIN dbo.ProcessMaster PM ON PM.ProcessID = JM.ProcessID AND PM.CompanyID = JM.CompanyID
			LEFT JOIN dbo.DepartmentMaster DM ON DM.DepartmentID = PM.DepartmentID AND DM.CompanyID = PM.CompanyID
			WHERE JM.CompanyID = @companyId
			  AND ISNULL(JM.IsDeletedTransaction, 0) = 0
			  AND ISNULL(PM.DepartmentID, 0) <> 0
			  AND JM.JobBookingJobCardContentsID IN (${list.sql})
			GROUP BY JM.JobBookingJobCardContentsID, PM.DepartmentID, DM.DepartmentName
			ORDER BY JM.JobBookingJobCardContentsID, COUNT(*) DESC, PM.DepartmentID
		`, { companyId: [sql.Int, companyId], ...list.params });
		const best = new Map();
		for (const r of rows) {
			if (!best.has(r.JobBookingJobCardContentsID)) {
				best.set(r.JobBookingJobCardContentsID, {
					departmentId: r.DepartmentID,
					departmentName: str(r.DepartmentName),
				});
			}
		}
		return best;
	} catch (err) {
		console.warn('[issue-tool] department suggestion unavailable:', err.message);
		return new Map();
	}
}
