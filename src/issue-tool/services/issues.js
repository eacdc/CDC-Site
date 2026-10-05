/**
 * Posting, deleting and stock refresh (brief 6.1, 6.2, 5.3).
 *
 * The procedures do the writing. This layer decides dry-run versus real,
 * translates the procedures' result sets into the API contract, and runs
 * UPDATE_ITEM_STOCK_VALUES after a commit, outside any transaction and outside
 * the numbering lock. A failed refresh never undoes a posted issue: the
 * response says stockRefreshFailed and the client can retry it through
 * POST /issues/:id/refresh-stock.
 */

import { execute, query, sql } from '../db.js';
import { POST_PROC, DELETE_PROC, STOCK_REFRESH_PROC, writesEnabled } from '../config.js';
import { ApiError } from '../errors.js';
import { todayInKolkata, toIsoDate } from '../dates.js';
import { qty, str } from '../queries/shared.js';

/** Why a request ran as a dry run, or null when it really wrote. */
export function dryRunReason({ requested, allowWrites }) {
	if (!allowWrites) return 'WRITES_DISABLED';
	if (requested) return 'REQUESTED';
	return null;
}

export async function postIssue({ site, companyId, erpUserId, body }) {
	if (body.voucherDate > todayInKolkata()) {
		throw new ApiError(400, 'VOUCHER_DATE_IN_FUTURE', 'The voucher date cannot be later than today.');
	}

	const reason = dryRunReason({ requested: body.dryRun, allowWrites: writesEnabled() });
	const dryRun = reason !== null;

	const lines = body.lines.map((l) => ({
		itemId: l.itemId,
		parentTransactionId: l.parentTransactionId,
		warehouseId: l.warehouseId,
		batchNo: l.batchNo ?? null,
		quantity: l.quantity,
	}));

	const result = await execute(site, POST_PROC, {
		CompanyID: [sql.Int, companyId],
		UserID: [sql.Int, erpUserId],
		VoucherDate: [sql.Date, body.voucherDate],
		Mode: [sql.VarChar(10), body.mode],
		PicklistDetailID: [sql.BigInt, body.mode === 'ALLOCATED' ? body.picklistDetailId : null],
		JobContentID: [sql.BigInt, body.mode === 'DIRECT' ? body.jobContentId : null],
		DepartmentID: [sql.BigInt, body.mode === 'DIRECT' ? body.departmentId : null],
		SlipNo: [sql.NVarChar(100), body.mode === 'DIRECT' ? (body.slipNo || null) : null],
		FloorWarehouseID: [sql.BigInt, body.floorWarehouseId],
		Remark: [sql.NVarChar(500), body.remark || null],
		LinesJson: [sql.NVarChar(sql.MAX), JSON.stringify(lines)],
		RequestID: [sql.UniqueIdentifier, body.requestId],
		PayloadJson: [sql.NVarChar(sql.MAX), JSON.stringify(body)],
		AcknowledgeWarnings: [sql.Bit, body.acknowledgeWarnings ? 1 : 0],
		DryRun: [sql.Bit, dryRun ? 1 : 0],
	});

	const response = interpretPostResult(result.recordsets, { dryRunReason: reason });

	if (response.status === 'POSTED' && !response.replayed) {
		const refresh = await refreshStockForTransaction({ site, companyId, transactionId: response.transactionId });
		response.stockRefreshFailed = !refresh.ok;
		if (!refresh.ok) response.stockRefreshError = refresh.error;
	}
	return response;
}

/**
 * Pure: the procedure's three result sets to the API response.
 * Throws the 409 that asks the client to acknowledge warnings.
 */
export function interpretPostResult(recordsets, { dryRunReason: reason }) {
	const [statusRows = [], warningRows = [], lineRows = []] = recordsets || [];
	const s = statusRows[0];
	if (!s) throw new Error('usp_IssueTool_PostIssue returned no status row.');

	const warnings = warningRows.map(mapWarning);
	const lines = lineRows.map((l) => ({ transId: l.TransID, transactionDetailId: l.TransactionDetailID }));

	switch (s.Status) {
		case 'WARNINGS':
			throw new ApiError(409, 'WARNINGS_NOT_ACKNOWLEDGED',
				'This issue has warnings. Read them, tick to acknowledge, and save again with the same request ID.',
				{ warnings });
		case 'DRY_RUN':
			return {
				status: 'DRY_RUN',
				dryRun: true,
				dryRunReason: reason ?? 'REQUESTED',
				voucherDate: toIsoDate(s.VoucherDate),
				fYear: str(s.FYear),
				warnings,
				wouldWrite: {
					header: parseJson(s.DryRunHeaderJson, null),
					lines: parseJson(s.DryRunLinesJson, []),
				},
			};
		case 'POSTED':
		case 'REPLAYED':
			return {
				status: 'POSTED',
				dryRun: false,
				replayed: s.Status === 'REPLAYED',
				transactionId: s.TransactionID,
				voucherNo: str(s.VoucherNo),
				voucherDate: toIsoDate(s.VoucherDate),
				fYear: str(s.FYear),
				lines,
				warnings,
				stockRefreshFailed: false,
			};
		default:
			throw new Error(`usp_IssueTool_PostIssue returned an unknown status "${s.Status}".`);
	}
}

function mapWarning(w) {
	return {
		code: w.Code,
		lineNo: w.LineNum ?? null,
		itemId: w.ItemID ?? null,
		quantity: w.Quantity === null || w.Quantity === undefined ? null : qty(w.Quantity),
		limit: w.Limit === null || w.Limit === undefined ? null : qty(w.Limit),
		stockUnit: str(w.StockUnit),
		message: w.Message,
	};
}

function parseJson(text, fallback) {
	if (!text) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

export async function deleteIssue({ site, companyId, erpUserId, transactionId }) {
	const reason = dryRunReason({ requested: false, allowWrites: writesEnabled() });
	const dryRun = reason !== null;

	const result = await execute(site, DELETE_PROC, {
		CompanyID: [sql.Int, companyId],
		UserID: [sql.Int, erpUserId],
		TransactionID: [sql.BigInt, transactionId],
		DryRun: [sql.Bit, dryRun ? 1 : 0],
	});

	const [statusRows = [], itemRows = []] = result.recordsets || [];
	const s = statusRows[0];
	if (!s) throw new Error('usp_IssueTool_DeleteIssue returned no status row.');
	const itemIds = itemRows.map((r) => r.ItemID);

	if (dryRun) {
		return {
			status: 'DRY_RUN',
			dryRun: true,
			dryRunReason: reason,
			transactionId,
			voucherNo: str(s.VoucherNo),
			itemIds,
			wouldWrite: {
				header: parseJson(s.DryRunHeaderJson, null),
				lines: parseJson(s.DryRunLinesJson, []),
			},
		};
	}

	const refresh = await refreshStockForItems({ site, companyId, itemIds });
	return {
		status: 'DELETED',
		dryRun: false,
		transactionId,
		voucherNo: str(s.VoucherNo),
		itemIds,
		stockRefreshFailed: !refresh.ok,
		...(refresh.ok ? {} : { stockRefreshError: refresh.error }),
	};
}

/**
 * Retry a stock refresh. A live voucher is refreshed by TransactionID, as after
 * a post; a deleted one item by item, as after a delete.
 */
export async function retryStockRefresh({ site, companyId, transactionId }) {
	const params = { transactionId: [sql.BigInt, transactionId], companyId: [sql.Int, companyId] };
	const rows = await query(site, `
		SELECT VoucherID, ISNULL(IsDeletedTransaction, 0) AS IsDeleted
		FROM dbo.ItemTransactionMain
		WHERE TransactionID = @transactionId AND CompanyID = @companyId
	`, params);

	const v = rows[0];
	if (!v || v.VoucherID !== -19) throw new ApiError(404, 'UNKNOWN_ISSUE', 'The issue voucher does not exist.');

	const itemRows = await query(site, `
		SELECT DISTINCT ItemID
		FROM dbo.ItemTransactionDetail
		WHERE TransactionID = @transactionId AND CompanyID = @companyId AND ItemID IS NOT NULL
	`, params);
	const itemIds = itemRows.map((r) => r.ItemID);
	const deleted = v.IsDeleted === 1 || v.IsDeleted === true;
	const refresh = deleted
		? await refreshStockForItems({ site, companyId, itemIds })
		: await refreshStockForTransaction({ site, companyId, transactionId });

	if (!refresh.ok) {
		throw new ApiError(502, 'STOCK_REFRESH_FAILED',
			`The stock refresh failed again: ${refresh.error}. The issue itself is saved.`);
	}
	return { ok: true, transactionId, mode: deleted ? 'ITEMS' : 'TRANSACTION', itemIds };
}

async function refreshStockForTransaction({ site, companyId, transactionId }) {
	try {
		await execute(site, STOCK_REFRESH_PROC, {
			CompanyID: [sql.Int, companyId],
			TransactionID: [sql.BigInt, transactionId],
			DeletedItemID: [sql.BigInt, 0],
		}, { long: true });
		return { ok: true };
	} catch (err) {
		console.warn(`[issue-tool] stock refresh failed for transaction ${transactionId}:`, err.message);
		return { ok: false, error: err.message };
	}
}

/** ASSUMPTION (brief 7): after a delete, @TransactionID = 0, @DeletedItemID = each item. */
async function refreshStockForItems({ site, companyId, itemIds }) {
	const failures = [];
	for (const itemId of itemIds) {
		try {
			await execute(site, STOCK_REFRESH_PROC, {
				CompanyID: [sql.Int, companyId],
				TransactionID: [sql.BigInt, 0],
				DeletedItemID: [sql.BigInt, itemId],
			}, { long: true });
		} catch (err) {
			console.warn(`[issue-tool] stock refresh failed for item ${itemId}:`, err.message);
			failures.push(`item ${itemId}: ${err.message}`);
		}
	}
	return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
}
