/**
 * Pending Dashboard — read-only reporting over two stored procedures.
 *
 *   GET /api/pending-po
 *   GET /api/pending-jobs
 *
 * Never writes to IndusEnterprise. Every proc parameter is bound through
 * request.input() with an explicit sql type. Missing optional filters are
 * sent as null. Parameters whose CREATE PROCEDURE default is not null
 * (CompanyID, IncludeKraft, ReceiptCutoff, TopN, DeliveryCutoff,
 * PrintCompletePct) are omitted when the query string does not name them,
 * so the procedure's own default stands. Passing SQL NULL for those would
 * override the default — for @CompanyID that empties the report.
 */
import { Router } from 'express';
import { getLongQueryPool, sql } from './db.js';

const router = Router();

export const JOB_MODES = ['DELIVERY', 'POSTPRINT', 'PARTIAL', 'ALL'];
export const CACHE_TTL_MS = 60_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATABASE = () =>
	String(process.env.PENDING_DASHBOARD_DATABASE || 'KOL').trim().toUpperCase();

const PO_DATE_COLS = new Set(['PODate', 'ExpectedDeliveryDate']);
const JOB_DATE_COLS = new Set(['JobBookingDate', 'PrintEnd', 'LastDeliveryDate']);
const PO_NUM_COLS = new Set([
	'DaysOverdue',
	'GSM',
	'POQty',
	'ReceivedQty',
	'PendingQty',
	'PendingQty_StockUnit',
	'PctReceived',
	'Rate',
	'PendingValue'
]);
const JOB_NUM_COLS = new Set([
	'OrderQuantity',
	'DeliveredQty',
	'PendingQty',
	'PctDelivered',
	'UnitRate',
	'PendingValue',
	'JobAgeDays'
]);

const cache = new Map();

export function parseMode(raw) {
	if (raw == null || String(raw).trim() === '') return null;
	const mode = String(raw).trim().toUpperCase();
	return JOB_MODES.includes(mode) ? mode : undefined;
}

export function emptyToNull(raw) {
	if (raw == null) return null;
	const s = String(raw).trim();
	return s === '' ? null : s;
}

export function dateOrNull(raw) {
	const s = emptyToNull(raw);
	if (s == null) return null;
	return DATE_RE.test(s) ? s : undefined;
}

export function intOrNull(raw) {
	const s = emptyToNull(raw);
	if (s == null) return null;
	const n = Number(s);
	if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
	return n;
}

export function decimalOrUndefined(raw) {
	const s = emptyToNull(raw);
	if (s == null) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

export function intOrUndefined(raw) {
	const n = intOrNull(raw);
	return n == null ? undefined : n;
}

export function bitOrUndefined(raw) {
	if (raw == null || String(raw).trim() === '') return undefined;
	const s = String(raw).trim().toLowerCase();
	if (s === '1' || s === 'true' || s === 'yes') return true;
	if (s === '0' || s === 'false' || s === 'no') return false;
	return undefined;
}

export function cacheKey(kind, params) {
	return `${kind}:${JSON.stringify(params)}`;
}

export function cacheGet(key, now = Date.now()) {
	const hit = cache.get(key);
	if (!hit) return null;
	if (now > hit.expiresAt) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

export function cacheSet(key, value, now = Date.now()) {
	cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
	return value;
}

export function cacheClear() {
	cache.clear();
}

export function sumPendingValue(rows) {
	let total = 0;
	for (const row of rows || []) {
		const n = Number(row?.PendingValue);
		if (Number.isFinite(n)) total += n;
	}
	return total;
}

function ymd(value) {
	if (value == null || value === '') return null;
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		const y = value.getUTCFullYear();
		const m = String(value.getUTCMonth() + 1).padStart(2, '0');
		const d = String(value.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}
	const s = String(value);
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : s;
}

function isoOrDate(value) {
	if (value == null || value === '') return null;
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		if (
			value.getUTCHours() === 0 &&
			value.getUTCMinutes() === 0 &&
			value.getUTCSeconds() === 0 &&
			value.getUTCMilliseconds() === 0
		) {
			return ymd(value);
		}
		return value.toISOString();
	}
	return value;
}

export function serializeRow(row, { dateCols, numCols }) {
	if (!row || typeof row !== 'object') return row;
	const out = { ...row };
	for (const col of dateCols) {
		if (Object.prototype.hasOwnProperty.call(out, col)) {
			out[col] = isoOrDate(out[col]);
		}
	}
	for (const col of numCols) {
		if (out[col] == null || out[col] === '') continue;
		const n = Number(out[col]);
		if (Number.isFinite(n)) out[col] = n;
	}
	return out;
}

function publicError(err) {
	const msg = String(err?.message || 'Query failed');
	if (/timeout/i.test(msg)) {
		return 'The pending report timed out. Try a narrower date range.';
	}
	if (/could not find stored procedure/i.test(msg)) {
		return 'Pending report procedure is not deployed on this database.';
	}
	return msg;
}

function bindOptional(request, name, type, value) {
	if (value === undefined) return;
	request.input(name, type, value);
}

function invalidDate(res, field) {
	return res.status(400).json({ error: `${field} must be YYYY-MM-DD.` });
}

function invalidInt(res, field) {
	return res.status(400).json({ error: `${field} must be an integer.` });
}

async function respondFromProc({
	req,
	res,
	kind,
	procName,
	params,
	bind,
	dateCols,
	numCols
}) {
	const key = cacheKey(kind, params);
	const cached = cacheGet(key);
	if (cached) {
		return res.json(cached);
	}

	try {
		const pool = await getLongQueryPool(DATABASE());
		const request = pool.request();
		bind(request);
		const result = await request.execute(procName);
		const raw = result.recordset || [];
		const rows = raw.map((row) => serializeRow(row, { dateCols, numCols }));
		const payload = {
			rows,
			rowCount: rows.length,
			totals: { pendingValue: sumPendingValue(rows) },
			generatedAt: new Date().toISOString()
		};
		cacheSet(key, payload);
		return res.json(payload);
	} catch (err) {
		console.error(`[pending-dashboard] ${procName} failed:`, err);
		return res.status(500).json({ error: publicError(err) });
	}
}

/**
 * GET /api/pending-po
 * Query: from, to, supplierId, itemGroupId, jobBookingNo, includeKraft, receiptCutoff, top
 */
router.get('/pending-po', async (req, res) => {
	const q = req.query || {};
	const fromDate = dateOrNull(q.from);
	const toDate = dateOrNull(q.to);
	if (fromDate === undefined) return invalidDate(res, 'from');
	if (toDate === undefined) return invalidDate(res, 'to');
	if (fromDate && toDate && fromDate > toDate) {
		return res.status(400).json({ error: 'from cannot be after to.' });
	}

	const supplierId = intOrNull(q.supplierId);
	const itemGroupId = intOrNull(q.itemGroupId);
	if (supplierId === undefined) return invalidInt(res, 'supplierId');
	if (itemGroupId === undefined) return invalidInt(res, 'itemGroupId');

	const jobBookingNo = emptyToNull(q.jobBookingNo);
	const includeKraft = bitOrUndefined(q.includeKraft);
	if (q.includeKraft != null && String(q.includeKraft).trim() !== '' && includeKraft === undefined) {
		return res.status(400).json({ error: 'includeKraft must be 0 or 1.' });
	}
	const receiptCutoff = decimalOrUndefined(q.receiptCutoff);
	if (q.receiptCutoff != null && String(q.receiptCutoff).trim() !== '' && receiptCutoff === undefined) {
		return res.status(400).json({ error: 'receiptCutoff must be a number.' });
	}
	const topN = intOrUndefined(q.top);
	if (q.top != null && String(q.top).trim() !== '' && topN === undefined) {
		return invalidInt(res, 'top');
	}

	const params = {
		fromDate,
		toDate,
		supplierId,
		itemGroupId,
		jobBookingNo,
		includeKraft: includeKraft ?? null,
		receiptCutoff: receiptCutoff ?? null,
		topN: topN ?? null
	};

	return respondFromProc({
		req,
		res,
		kind: 'po',
		procName: 'GetPendingPOWithValue',
		params,
		dateCols: PO_DATE_COLS,
		numCols: PO_NUM_COLS,
		bind(request) {
			request.input('FromDate', sql.Date, fromDate);
			request.input('ToDate', sql.Date, toDate);
			request.input('SupplierID', sql.Int, supplierId);
			request.input('ItemGroupID', sql.Int, itemGroupId);
			request.input('JobBookingNo', sql.NVarChar(50), jobBookingNo);
			bindOptional(request, 'IncludeKraft', sql.Bit, includeKraft);
			bindOptional(request, 'ReceiptCutoff', sql.Decimal(5, 2), receiptCutoff);
			bindOptional(request, 'TopN', sql.Int, topN);
		}
	});
});

/**
 * GET /api/pending-jobs
 * Query: mode, from, to, clientName, salesPersonId, jobBookingNo, categoryId,
 *        deliveryCutoff, printCompletePct, top
 */
router.get('/pending-jobs', async (req, res) => {
	const q = req.query || {};
	const mode = parseMode(q.mode);
	if (q.mode != null && String(q.mode).trim() !== '' && mode === undefined) {
		return res.status(400).json({
			error: `mode must be one of ${JOB_MODES.join(', ')}.`
		});
	}

	const fromDate = dateOrNull(q.from);
	const toDate = dateOrNull(q.to);
	if (fromDate === undefined) return invalidDate(res, 'from');
	if (toDate === undefined) return invalidDate(res, 'to');
	if (fromDate && toDate && fromDate > toDate) {
		return res.status(400).json({ error: 'from cannot be after to.' });
	}

	const salesPersonId = intOrNull(q.salesPersonId);
	const categoryId = intOrNull(q.categoryId);
	if (salesPersonId === undefined) return invalidInt(res, 'salesPersonId');
	if (categoryId === undefined) return invalidInt(res, 'categoryId');

	const clientName = emptyToNull(q.clientName);
	const jobBookingNo = emptyToNull(q.jobBookingNo);
	const deliveryCutoff = decimalOrUndefined(q.deliveryCutoff);
	if (q.deliveryCutoff != null && String(q.deliveryCutoff).trim() !== '' && deliveryCutoff === undefined) {
		return res.status(400).json({ error: 'deliveryCutoff must be a number.' });
	}
	const printCompletePct = decimalOrUndefined(q.printCompletePct);
	if (q.printCompletePct != null && String(q.printCompletePct).trim() !== '' && printCompletePct === undefined) {
		return res.status(400).json({ error: 'printCompletePct must be a number.' });
	}
	const topN = intOrUndefined(q.top);
	if (q.top != null && String(q.top).trim() !== '' && topN === undefined) {
		return invalidInt(res, 'top');
	}

	const params = {
		mode: mode ?? null,
		fromDate,
		toDate,
		clientName,
		salesPersonId,
		jobBookingNo,
		categoryId,
		deliveryCutoff: deliveryCutoff ?? null,
		printCompletePct: printCompletePct ?? null,
		topN: topN ?? null
	};

	return respondFromProc({
		req,
		res,
		kind: 'jobs',
		procName: 'GetPendingJobsWithValue',
		params,
		dateCols: JOB_DATE_COLS,
		numCols: JOB_NUM_COLS,
		bind(request) {
			bindOptional(request, 'Mode', sql.VarChar(20), mode);
			request.input('FromJobDate', sql.Date, fromDate);
			request.input('ToJobDate', sql.Date, toDate);
			request.input('ClientName', sql.NVarChar(200), clientName);
			request.input('SalesPersonID', sql.Int, salesPersonId);
			request.input('JobBookingNo', sql.NVarChar(50), jobBookingNo);
			request.input('CategoryID', sql.Int, categoryId);
			bindOptional(request, 'DeliveryCutoff', sql.Decimal(5, 2), deliveryCutoff);
			bindOptional(request, 'PrintCompletePct', sql.Decimal(5, 2), printCompletePct);
			bindOptional(request, 'TopN', sql.Int, topN);
		}
	});
});

export default router;
