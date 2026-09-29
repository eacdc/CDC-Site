/**
 * CDC Job Wise Profitability
 * GET /job-wise-profitability?database=KOL|AHM&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&clientIds=1,2,3
 * — dbo.rpt_job_gp_per_impression_v11 (@FromDate, @ToDate, @ClientIDs TVP) + computed GP %
 * GET /job-wise-profitability/clients?database=KOL|AHM
 * — client dropdown (LedgerID + LedgerName from JobBookingJobCard)
 */
import { Router } from 'express';
import { getPool, getLongQueryPool, sql } from './db.js';
import { ClientNamesFilterQuery } from './job-card-queries.js';

const router = Router();

const ALLOWED_DATABASES = ['KOL', 'AHM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const QTY_COLUMNS = new Set([
	'OrderQty',
	'GPN Qty',
	'Del Qty',
	'Planned Print Imp',
	'Actual Print Imp',
	'Final Print Imp',
	'Foil Issued',
	'TotalBookedPaperWt',
	'IssuedWt'
]);

const RATE_COST_COLUMNS = new Set([
	'Unit Price',
	'Total Bill Value',
	'IssuedCost',
	'Booked Kraft Cost',
	'Booked Lam Film Cost',
	'Booked Adhesive Cost',
	'Booked Coating Cost',
	'Plate Amount',
	'Notional Pack&Del',
	'Delivery Cost',
	'Notional-ContCost',
	'Addl Manual Total Cost',
	'Total Cost',
	'GP',
	'GP/Imp',
	'GP %'
]);

/** Keep 2 decimal places; all other numeric columns round to 0. */
const TWO_DECIMAL_COLUMNS = new Set(['Unit Price', 'GP/Imp']);

function isTwoDecimalColumn(colName) {
	if (!colName) return false;
	if (TWO_DECIMAL_COLUMNS.has(colName)) return true;
	const lower = String(colName).toLowerCase();
	return lower === 'unit price' || lower === 'gp/imp';
}

const DATE_COLUMNS = new Set(['Date of Final Del']);

function isDateColumn(colName) {
	if (!colName) return false;
	if (DATE_COLUMNS.has(colName)) return true;
	return String(colName).toLowerCase() === 'date of final del';
}

function toDateYmd(raw) {
	if (raw == null || raw === '') return '';
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
		const y = raw.getFullYear();
		const m = String(raw.getMonth() + 1).padStart(2, '0');
		const d = String(raw.getDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}
	const s = String(raw).trim();
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
	if (dmy) {
		return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
	}
	const t = Date.parse(s);
	if (!Number.isNaN(t)) {
		const dt = new Date(t);
		const y = dt.getFullYear();
		const m = String(dt.getMonth() + 1).padStart(2, '0');
		const d = String(dt.getDate()).padStart(2, '0');
		return `${y}-${m}-${d}`;
	}
	return s;
}

function findColumnKey(keys, wanted) {
	const want = String(wanted).toLowerCase();
	for (const k of keys) {
		if (String(k).toLowerCase() === want) return k;
	}
	return null;
}

function toNumber(value) {
	if (value == null || value === '') return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	const n = parseFloat(String(value).replace(/,/g, '').trim());
	return Number.isFinite(n) ? n : null;
}

function formatCell(colName, raw) {
	if (raw == null) return '';
	if (isDateColumn(colName) || raw instanceof Date) {
		return toDateYmd(raw);
	}

	const num = toNumber(raw);
	if (num == null) {
		return typeof raw === 'string' ? raw : String(raw);
	}

	if (isTwoDecimalColumn(colName)) {
		return Number(num.toFixed(2));
	}

	if (
		QTY_COLUMNS.has(colName) ||
		RATE_COST_COLUMNS.has(colName) ||
		typeof raw === 'number'
	) {
		return Math.round(num);
	}

	return String(raw);
}

function orderColumnsFromRows(rows) {
	if (!rows.length) return [];
	const order = Object.keys(rows[0]);
	const seen = new Set(order);
	for (const row of rows) {
		for (const k of Object.keys(row)) {
			if (!seen.has(k)) {
				seen.add(k);
				order.push(k);
			}
		}
	}
	return order;
}

function serializeRow(row, columns, billKey, costKey) {
	const out = {};
	for (const col of columns) {
		out[col] = formatCell(col, row[col]);
	}

	const billValue = billKey ? toNumber(row[billKey]) : null;
	const totalCost = costKey ? toNumber(row[costKey]) : null;
	let gpPercent = '';
	if (billValue != null && billValue !== 0 && totalCost != null) {
		gpPercent = Number(((billValue - totalCost) / billValue).toFixed(2));
	}
	out['GP %'] = gpPercent;
	out['Exception Cause'] = computeExceptionCause(out);
	return out;
}

function pickValue(row, ...names) {
	const keys = Object.keys(row || {});
	for (const name of names) {
		const want = String(name).toLowerCase();
		for (const k of keys) {
			if (String(k).toLowerCase() === want) return toNumber(row[k]);
		}
	}
	return null;
}

/**
 * Priority (only when GP/Imp < 0.9; otherwise blank):
 * 1) Paper issued > 20% more than required → excess paper issued
 * 2) Del qty < 90% of order qty → Short Delivery
 * 3) Else → Low pricing
 */
function computeExceptionCause(row) {
	const gpImp = pickValue(row, 'GP/Imp', 'GP / Imp');
	if (gpImp == null || gpImp >= 0.9) return '';

	const issued = pickValue(row, 'IssuedWt', 'Issued Wt', 'Paper Issued');
	const required = pickValue(row, 'TotalBookedPaperWt', 'Total Booked Paper Wt', 'Booked Paper Wt');
	if (required != null && required > 0 && issued != null && issued > required * 1.2) {
		return 'excess paper issued';
	}

	const orderQty = pickValue(row, 'OrderQty', 'Order Qty');
	const delQty = pickValue(row, 'Del Qty', 'DelQty', 'Delivery Qty');
	if (orderQty != null && orderQty > 0 && delQty != null && delQty < orderQty * 0.9) {
		return 'Short Delivery';
	}

	return 'Low pricing';
}

function parseClientIds(raw) {
	const values = Array.isArray(raw) ? raw : [raw];
	const ids = [];
	const seen = new Set();
	for (const value of values) {
		String(value == null ? '' : value)
			.split(/[,\s]+/)
			.forEach((part) => {
				const n = Number(part);
				if (!Number.isFinite(n) || n <= 0 || seen.has(n)) return;
				seen.add(n);
				ids.push(n);
			});
	}
	return ids;
}

function buildClientIdTvp(clientIds) {
	const tvp = new sql.Table('dbo.IdList');
	tvp.columns.add('Id', sql.Int, { nullable: false });
	clientIds.forEach((id) => tvp.rows.add(id));
	return tvp;
}

router.get('/job-wise-profitability/clients', async (req, res) => {
	try {
		const selectedDatabase = String(req.query?.database || '')
			.trim()
			.toUpperCase();
		if (!ALLOWED_DATABASES.includes(selectedDatabase)) {
			return res.status(400).json({
				status: false,
				error: 'Invalid or missing database (must be KOL or AHM)'
			});
		}

		const pool = await getPool(selectedDatabase);
		const result = await pool.request().query(ClientNamesFilterQuery);
		const clients = (result.recordset || [])
			.map((row) => ({
				clientId: row.LedgerID ?? row.ledgerid ?? null,
				clientName: String(row.LedgerName ?? row.ledgername ?? '').trim()
			}))
			.filter((c) => c.clientId != null && c.clientName);

		return res.json({ status: true, clients });
	} catch (err) {
		console.error('Job wise profitability clients error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch clients'
		});
	}
});

router.get('/job-wise-profitability', async (req, res) => {
	try {
		const { database, fromDate, toDate, clientIds, clientId } = req.query || {};
		const selectedDatabase = String(database || '').trim().toUpperCase();
		if (!ALLOWED_DATABASES.includes(selectedDatabase)) {
			return res.status(400).json({
				status: false,
				error: 'Invalid or missing database (must be KOL or AHM)'
			});
		}

		const safeFromDate = String(fromDate || '').trim();
		const safeToDate = String(toDate || '').trim();
		if (!DATE_RE.test(safeFromDate) || !DATE_RE.test(safeToDate)) {
			return res.status(400).json({
				status: false,
				error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.'
			});
		}
		if (safeFromDate > safeToDate) {
			return res.status(400).json({
				status: false,
				error: 'fromDate cannot be after toDate'
			});
		}

		const parsedClientIds = parseClientIds(
			clientIds != null && String(clientIds).trim() !== '' ? clientIds : clientId
		);
		if (!parsedClientIds.length) {
			return res.status(400).json({
				status: false,
				error: 'Invalid or missing clientIds (select at least one client)'
			});
		}

		const pool = await getLongQueryPool(selectedDatabase);
		const tvp = buildClientIdTvp(parsedClientIds);
		const result = await pool
			.request()
			.input('FromDate', sql.Date, safeFromDate)
			.input('ToDate', sql.Date, safeToDate)
			.input('ClientIDs', tvp)
			.execute('dbo.rpt_job_gp_per_impression_v11');

		const rawRows = result.recordset || [];
		const baseColumns = orderColumnsFromRows(rawRows);
		const billKey = findColumnKey(baseColumns, 'Total Bill Value');
		const costKey = findColumnKey(baseColumns, 'Total Cost');

		const columns = baseColumns.includes('GP %')
			? baseColumns.slice()
			: baseColumns.concat(['GP %']);
		if (!columns.includes('Exception Cause')) {
			columns.push('Exception Cause');
		}

		const records = rawRows.map((row) => serializeRow(row, baseColumns, billKey, costKey));

		return res.json({
			status: true,
			fromDate: safeFromDate,
			toDate: safeToDate,
			clientIds: parsedClientIds,
			database: selectedDatabase,
			columns,
			qtyColumns: [...QTY_COLUMNS],
			rateCostColumns: [...RATE_COST_COLUMNS],
			records
		});
	} catch (err) {
		console.error('Job wise profitability error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch job wise profitability'
		});
	}
});

export default router;
