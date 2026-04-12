/**
 * Previous Items By Client Tool API
 * - POST /previousitemsbyclient/search
 *   Body: { database: 'KOL'|'AHM', ledgerIds: number[], basis: 'O'|'D', topFilter: 'top50'|'top100'|'all6months' }
 *   Executes GetPackagingClientConsumption_withpaper_check; returns last 2 result sets side-by-side ready data.
 *
 * Client list: reuse GET /api/inventory-summary/client-names (same database query param).
 */
import { Router } from 'express';
import { getPool } from './db.js';
import sql from 'mssql';
import OpenAI from 'openai';

const router = Router();
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

const TOP_FILTERS = new Set(['top50', 'top100', 'all6months']);
const BASIS_VALUES = new Set(['O', 'D']);

function normalizeDb(body = {}) {
	const db = String(body.database || '').trim().toUpperCase();
	return db === 'KOL' || db === 'AHM' ? db : null;
}

function parseLedgerIds(raw) {
	if (!Array.isArray(raw)) return null;
	const ids = [];
	for (const x of raw) {
		const n = typeof x === 'number' ? x : parseInt(String(x).trim(), 10);
		if (!Number.isInteger(n) || n <= 0) return null;
		ids.push(n);
	}
	return ids.length ? ids : null;
}

function rowLimitForTopFilter(topFilter) {
	if (topFilter === 'top50') return 50;
	if (topFilter === 'top100') return 100;
	return null; // all6months — no cap
}

function recordsetToTable(rows, limit) {
	const arr = Array.isArray(rows) ? rows : [];
	const sliced = limit != null ? arr.slice(0, limit) : arr;
	const columns =
		sliced.length > 0
			? Object.keys(sliced[0])
			: arr.length > 0
				? Object.keys(arr[0])
				: [];
	return { columns, rows: sliced };
}

function normalizeTableInput(table = {}) {
	const columns = Array.isArray(table.columns) ? table.columns.map((c) => String(c)) : [];
	const rows = Array.isArray(table.rows) ? table.rows : [];
	return { columns, rows };
}

/**
 * POST /api/previousitemsbyclient/search
 */
router.post('/previousitemsbyclient/search', async (req, res) => {
	const db = normalizeDb(req.body || {});
	if (!db) {
		return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
	}

	const ledgerIds = parseLedgerIds(req.body?.ledgerIds);
	if (!ledgerIds) {
		return res.status(400).json({ status: false, error: 'ledgerIds must be a non-empty array of positive integers' });
	}

	let basis = String(req.body?.basis || '').trim().toUpperCase();
	if (!BASIS_VALUES.has(basis)) {
		return res.status(400).json({ status: false, error: 'basis must be O (order wise) or D (delivery wise)' });
	}

	const topFilter = String(req.body?.topFilter || '').trim().toLowerCase();
	if (!TOP_FILTERS.has(topFilter)) {
		return res.status(400).json({
			status: false,
			error: 'topFilter must be top50, top100, or all6months',
		});
	}

	const ledgerCsv = ledgerIds.join(',');
	const limit = rowLimitForTopFilter(topFilter);

	try {
		const pool = await getPool(db);
		const result = await pool
			.request()
			.input('LedgerIDs', sql.VarChar(8000), ledgerCsv)
			.input('Basis', sql.VarChar(1), basis)
			.execute('dbo.GetPackagingClientConsumption_withpaper_check');

		const recordsets = result.recordsets;
		if (!recordsets || !Array.isArray(recordsets) || recordsets.length < 3) {
			return res.status(500).json({
				status: false,
				error:
					'Stored procedure did not return at least 3 result sets. Got ' +
					(recordsets ? String(recordsets.length) : '0') +
					'.',
			});
		}

		const rs = recordsets;
		const table2 = rs[rs.length - 2];
		const table3 = rs[rs.length - 1];

		const leftTable = recordsetToTable(table2, limit);
		const rightTable = recordsetToTable(table3, limit);

		return res.json({
			status: true,
			data: {
				leftTable,
				rightTable,
			},
		});
	} catch (err) {
		console.error('[previousitemsbyclient] search error:', err);
		return res.status(500).json({
			status: false,
			error: err.message || 'Failed to run packaging client consumption report',
		});
	}
});

/**
 * POST /api/previousitemsbyclient/analyze
 * Body: {
 *  database, basis, topFilter, ledgerIds, clientNames,
 *  leftTable: { columns, rows }, rightTable: { columns, rows }
 * }
 */
router.post('/previousitemsbyclient/analyze', async (req, res) => {
	try {
		if (!process.env.OPENAI_API_KEY) {
			return res.status(500).json({ status: false, error: 'OPENAI_API_KEY is not configured on server' });
		}

		const db = normalizeDb(req.body || {});
		if (!db) {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const basis = String(req.body?.basis || '').trim().toUpperCase();
		if (!BASIS_VALUES.has(basis)) {
			return res.status(400).json({ status: false, error: 'basis must be O (order wise) or D (delivery wise)' });
		}

		const topFilter = String(req.body?.topFilter || '').trim().toLowerCase();
		if (!TOP_FILTERS.has(topFilter)) {
			return res.status(400).json({ status: false, error: 'topFilter must be top50, top100, or all6months' });
		}

		const ledgerIds = parseLedgerIds(req.body?.ledgerIds);
		if (!ledgerIds) {
			return res.status(400).json({ status: false, error: 'ledgerIds must be a non-empty array of positive integers' });
		}

		const leftTable = normalizeTableInput(req.body?.leftTable);
		const rightTable = normalizeTableInput(req.body?.rightTable);
		if (!leftTable.rows.length || !rightTable.rows.length) {
			return res.status(400).json({ status: false, error: 'Both leftTable and rightTable must contain rows for analysis' });
		}

		const clientNames = Array.isArray(req.body?.clientNames)
			? req.body.clientNames.map((x) => String(x)).filter(Boolean)
			: [];

		const basisLabel = basis === 'O' ? 'Order wise' : 'Delivery wise';
		const userPayload = {
			context: {
				database: db,
				basis,
				basisLabel,
				topFilter,
				ledgerIds,
				clientNames,
			},
			skuWiseConsumptionTable: leftTable,
			productCategoryWiseConsumptionTable: rightTable,
		};

		const completion = await openai.chat.completions.create({
			model: 'gpt-4o-mini',
			temperature: 0.2,
			messages: [
				{
					role: 'system',
					content:
						'You are a packaging demand planning analyst for a printing/manufacturing business. ' +
						'Analyze SKU-wise and product-category-wise client consumption data to project future stock consumption and surface key business highlights. ' +
						'Respond in concise markdown with these sections exactly: ' +
						'1) Projection Summary, 2) Demand Drivers, 3) Risk Alerts, 4) Recommended Stock Actions, 5) Key Highlights. ' +
						'Use specific numbers and trends from provided data where possible. Include a short 30-day and 60-day outlook. ' +
						'If confidence is limited due to data shape, explicitly mention assumptions.',
				},
				{
					role: 'user',
					content: JSON.stringify(userPayload),
				},
			],
		});

		const analysis = completion.choices?.[0]?.message?.content || 'No analysis returned.';
		return res.json({ status: true, analysis });
	} catch (err) {
		console.error('[previousitemsbyclient] analyze error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Failed to analyze data with AI' });
	}
});

export default router;
