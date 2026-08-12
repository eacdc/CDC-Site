/**
 * CDC Job Wise Profitability
 * GET /job-wise-profitability?database=KOL|AHM&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 * — dbo.rpt_job_gp_per_impression_v11 (@start, @end) + computed GP %
 */
import { Router } from 'express';
import { getLongQueryPool, sql } from './db.js';

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
	if (raw instanceof Date) {
		return raw.toISOString().slice(0, 10);
	}

	const num = toNumber(raw);
	if (num == null) {
		return typeof raw === 'string' ? raw : String(raw);
	}

	if (QTY_COLUMNS.has(colName)) {
		return Math.round(num);
	}
	if (RATE_COST_COLUMNS.has(colName)) {
		return Number(num.toFixed(2));
	}

	if (typeof raw === 'number') {
		return Number.isInteger(raw) ? raw : Number(num.toFixed(4));
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
	return out;
}

router.get('/job-wise-profitability', async (req, res) => {
	try {
		const { database, fromDate, toDate } = req.query || {};
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

		const pool = await getLongQueryPool(selectedDatabase);
		// Positional EXEC so we do not depend on the SP's declared parameter names.
		const result = await pool
			.request()
			.input('StartDate', sql.VarChar(10), safeFromDate)
			.input('EndDate', sql.VarChar(10), safeToDate)
			.query('EXEC dbo.rpt_job_gp_per_impression_v11 @StartDate, @EndDate');

		const rawRows = result.recordset || [];
		const baseColumns = orderColumnsFromRows(rawRows);
		const billKey = findColumnKey(baseColumns, 'Total Bill Value');
		const costKey = findColumnKey(baseColumns, 'Total Cost');

		const columns = baseColumns.includes('GP %')
			? baseColumns
			: baseColumns.concat(['GP %']);

		const records = rawRows.map((row) => serializeRow(row, baseColumns, billKey, costKey));

		return res.json({
			status: true,
			fromDate: safeFromDate,
			toDate: safeToDate,
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
