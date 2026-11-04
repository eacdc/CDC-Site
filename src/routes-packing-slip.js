/**
 * Packing Slip Barcode — Node API
 *
 * Browser replacement for IndusPackingSlipBarcodeGenerator (VB6). Each carton
 * label gets its own number in PackingSlipBarcodeEntry; the GPN and delivery
 * note screens later look the carton up by that number alone.
 *
 * Numbering. The vendor proc InsertPackingSlipBarcodeAuto takes MAX(BarcodeNo)
 * within one FYear, but BarcodeNo is unique across ALL years
 * (UQ_PackingSlipBarcodeEntry_BarcodeNo). A new FYear therefore restarts at
 * 100001 and runs into numbers already used, which is why the old exe hard-codes
 * '2025-2026'. InsertPackingSlipBarcodeBatch_Manu (sql/packing-slip/) numbers
 * across all years, stores the real Apr-Mar year and inserts a whole batch in
 * one lock. Until it is deployed, this falls back to the vendor proc with the
 * same '2025-2026' the exe passes, one call per label.
 *
 * Writes are a dry run until PACKING_SLIP_ALLOW_WRITES=true: the numbers shown
 * are a preview and nothing is inserted.
 *
 *   GET  /api/packing-slip/config
 *   GET  /api/packing-slip/jobs?database=KOL&q=0882
 *   GET  /api/packing-slip/jobs/:jobBookingId?database=KOL
 *   POST /api/packing-slip/generate
 *   POST /api/packing-slip/generate-mixed
 *   GET  /api/packing-slip/barcodes?database=KOL&from=1297970&to=1297981
 *   GET  /api/packing-slip/ranges?database=KOL&from=2026-11-01&to=2026-11-02
 */
import { Router } from 'express';
import { getPool, sql } from './db.js';

const router = Router();

const ALLOWED_DATABASES = ['KOL', 'AHM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_ID = Number(process.env.PACKING_SLIP_COMPANY_ID || 2);
/** What the old exe passes. Only used while the batch proc is not deployed. */
const LEGACY_FYEAR = process.env.PACKING_SLIP_LEGACY_FYEAR || '2025-2026';
const MAX_COPIES = Number(process.env.PACKING_SLIP_MAX_COPIES || 500);
/** A reprint of more labels than this is almost certainly a typo in the range. */
const MAX_REPRINT = 1000;
const BATCH_PROC = 'dbo.InsertPackingSlipBarcodeBatch_Manu';

function writesAllowed() {
	return String(process.env.PACKING_SLIP_ALLOW_WRITES || '').toLowerCase() === 'true';
}

function dbFrom(req) {
	const db = String(req.query.database || req.body?.database || '').toUpperCase();
	if (!ALLOWED_DATABASES.includes(db)) {
		const err = new Error('Select a database (KOL or AHM).');
		err.status = 400;
		throw err;
	}
	return db;
}

function positiveInt(value) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegative(value) {
	if (value === '' || value == null) return 0;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function sendError(res, err, where) {
	const status = err.status || 500;
	if (status >= 500) console.error(`[packing-slip] ${where}:`, err);
	res.status(status).json({ ok: false, error: err.message || String(err) });
}

const ACTIVE_JOB_SQL = `
	ISNULL(J.IsReleasedForSchedule, 0) = 1
	AND ISNULL(J.IsClose, 0) = 0
	AND ISNULL(J.IsCancel, 0) = 0
	AND ISNULL(J.IsDeletedTransaction, 0) = 0
	AND J.CompanyID = @CompanyID`;

const JOB_COLUMNS_SQL = `
	J.JobBookingID, J.JobBookingNo, J.JobBookingDate, J.JobName, J.ProductCode,
	J.PONo, J.PODate, J.OrderQuantity, J.LedgerID, LM.LedgerName`;

/* Slips already printed for the job, so the packer sees how far along it is. */
const SLIP_TOTALS_SQL = `
	OUTER APPLY (
		SELECT COUNT(*) AS Slips, SUM(CAST(P.QuantityPerBox AS BIGINT)) AS SlipQty
		FROM dbo.PackingSlipBarcodeEntry P
		WHERE P.JobBookingID = J.JobBookingID
	) S`;

function shapeJob(row) {
	return {
		jobBookingId: Number(row.JobBookingID),
		jobBookingNo: row.JobBookingNo,
		jobBookingDate: row.JobBookingDate,
		jobName: row.JobName,
		productCode: row.ProductCode,
		poNo: row.PONo,
		poDate: row.PODate,
		orderQuantity: Number(row.OrderQuantity || 0),
		ledgerId: Number(row.LedgerID),
		clientName: row.LedgerName,
		slips: Number(row.Slips || 0),
		slipQty: Number(row.SlipQty || 0)
	};
}

async function loadActiveJob(pool, jobBookingId) {
	const result = await pool.request()
		.input('JobBookingID', sql.BigInt, jobBookingId)
		.input('CompanyID', sql.Int, COMPANY_ID)
		.query(`
			SELECT ${JOB_COLUMNS_SQL}, S.Slips, S.SlipQty
			FROM dbo.JobBookingJobCard J
			INNER JOIN dbo.LedgerMaster LM ON LM.LedgerID = J.LedgerID
			${SLIP_TOTALS_SQL}
			WHERE J.JobBookingID = @JobBookingID AND ${ACTIVE_JOB_SQL};
		`);
	const row = result.recordset[0];
	return row ? shapeJob(row) : null;
}

async function batchProcDeployed(pool) {
	const result = await pool.request()
		.input('name', sql.NVarChar(256), BATCH_PROC)
		.query('SELECT OBJECT_ID(@name, \'P\') AS id;');
	return result.recordset[0]?.id != null;
}

router.get('/config', (req, res) => {
	res.json({ ok: true, writesAllowed: writesAllowed(), maxCopies: MAX_COPIES });
});

router.get('/jobs', async (req, res) => {
	try {
		const db = dbFrom(req);
		const q = String(req.query.q || '').trim();
		if (q.length < 2) return res.json({ ok: true, jobs: [] });

		// No slip totals here: PackingSlipBarcodeEntry has no index led by
		// JobBookingID, so counting for 50 jobs took ~5 s. The selected job shows them.
		const pool = await getPool(db);
		const result = await pool.request()
			.input('q', sql.NVarChar(100), `%${q}%`)
			.input('CompanyID', sql.Int, COMPANY_ID)
			.query(`
				SELECT TOP (50) ${JOB_COLUMNS_SQL}
				FROM dbo.JobBookingJobCard J
				INNER JOIN dbo.LedgerMaster LM ON LM.LedgerID = J.LedgerID
				WHERE ${ACTIVE_JOB_SQL}
				  AND (J.JobBookingNo LIKE @q OR J.JobName LIKE @q OR LM.LedgerName LIKE @q)
				ORDER BY J.JobBookingID DESC;
			`);
		res.json({ ok: true, jobs: result.recordset.map(shapeJob) });
	} catch (err) {
		sendError(res, err, 'job search');
	}
});

router.get('/jobs/:jobBookingId', async (req, res) => {
	try {
		const db = dbFrom(req);
		const jobBookingId = positiveInt(req.params.jobBookingId);
		if (!jobBookingId) return res.status(400).json({ ok: false, error: 'Invalid job.' });

		const pool = await getPool(db);
		const job = await loadActiveJob(pool, jobBookingId);
		if (!job) return res.status(404).json({ ok: false, error: 'Job not found, not released, closed or cancelled.' });

		// Printed numbers as unbroken runs (gaps-and-islands), newest first.
		const ranges = await pool.request()
			.input('JobBookingID', sql.BigInt, jobBookingId)
			.query(`
				WITH B AS (
					SELECT P.BarcodeNo, P.QuantityPerBox, P.[DateTime],
					       P.BarcodeNo - ROW_NUMBER() OVER (ORDER BY P.BarcodeNo) AS Grp
					FROM dbo.PackingSlipBarcodeEntry P
					WHERE P.JobBookingID = @JobBookingID
				)
				SELECT MIN(BarcodeNo) AS StartBarcode, MAX(BarcodeNo) AS EndBarcode,
				       COUNT(*) AS Labels, SUM(CAST(QuantityPerBox AS BIGINT)) AS Qty,
				       MIN([DateTime]) AS FirstAt
				FROM B
				GROUP BY Grp
				ORDER BY MIN(BarcodeNo) DESC;
			`);

		// Batches entered for the job in the ERP. Only suggestions for the label's
		// Batch No: like the old exe, the batch is printed, not saved.
		const batches = await pool.request()
			.input('JobBookingID', sql.BigInt, jobBookingId)
			.input('CompanyID', sql.Int, COMPANY_ID)
			.query(`
				SELECT BatchNo
				FROM dbo.JobBookingJobCardBatch
				WHERE JobBookingID = @JobBookingID AND CompanyID = @CompanyID
				  AND LTRIM(RTRIM(ISNULL(BatchNo, N''))) <> N''
				ORDER BY JobBookingJobCardBatchID;
			`);

		res.json({
			ok: true,
			job,
			batches: [...new Set(batches.recordset.map((b) => b.BatchNo.trim()))],
			ranges: ranges.recordset.map((r) => ({
				start: Number(r.StartBarcode),
				end: Number(r.EndBarcode),
				labels: Number(r.Labels),
				qty: Number(r.Qty || 0),
				firstAt: r.FirstAt
			}))
		});
	} catch (err) {
		sendError(res, err, 'job detail');
	}
});

router.post('/generate', async (req, res) => {
	try {
		const db = dbFrom(req);
		const jobBookingId = positiveInt(req.body?.jobBookingId);
		const qtyPerBox = positiveInt(req.body?.qtyPerBox);
		const copies = positiveInt(req.body?.copies);
		const netWt = nonNegative(req.body?.netWt);
		const grossWt = nonNegative(req.body?.grossWt);

		if (!jobBookingId) return res.status(400).json({ ok: false, error: 'Select a PWO first.' });
		if (!qtyPerBox) return res.status(400).json({ ok: false, error: 'Enter the quantity per box.' });
		if (!copies || copies > MAX_COPIES) {
			return res.status(400).json({ ok: false, error: `Number of labels must be between 1 and ${MAX_COPIES}.` });
		}
		if (netWt == null || grossWt == null) {
			return res.status(400).json({ ok: false, error: 'Weights must be numbers, zero or more.' });
		}

		const pool = await getPool(db);
		const job = await loadActiveJob(pool, jobBookingId);
		if (!job) return res.status(404).json({ ok: false, error: 'Job not found, not released, closed or cancelled.' });

		const useBatch = await batchProcDeployed(pool);

		if (!writesAllowed()) {
			// Preview only: the numbers the next insert would take. Nothing is saved.
			const preview = await pool.request()
				.input('FYear', sql.NVarChar(100), LEGACY_FYEAR)
				.query(useBatch
					? 'SELECT ISNULL(MAX(BarcodeNo), 100000) + 1 AS NextNo FROM dbo.PackingSlipBarcodeEntry;'
					: 'SELECT ISNULL(MAX(BarcodeNo), 100000) + 1 AS NextNo FROM dbo.PackingSlipBarcodeEntry WHERE FYear = @FYear;');
			const next = Number(preview.recordset[0].NextNo);
			return res.json({
				ok: true,
				dryRun: true,
				method: useBatch ? 'batch' : 'legacy',
				job,
				packedAt: new Date().toISOString(),
				barcodes: Array.from({ length: copies }, (_, i) => next + i)
			});
		}

		let barcodes;
		if (useBatch) {
			const result = await pool.request()
				.input('JobBookingID', sql.Int, jobBookingId)
				.input('LedgerID', sql.Int, job.ledgerId)
				.input('Qty', sql.Decimal(18, 2), qtyPerBox)
				.input('NetWt', sql.Decimal(18, 2), netWt)
				.input('GrossWt', sql.Decimal(18, 2), grossWt)
				.input('Copies', sql.Int, copies)
				.execute(BATCH_PROC);
			barcodes = result.recordset.map((r) => Number(r.BarcodeNo)).sort((a, b) => a - b);
		} else {
			// One label per call, as the exe does. A failure part-way keeps the
			// numbers already made: they are in the table and can be reprinted.
			barcodes = [];
			try {
				for (let i = 0; i < copies; i += 1) {
					const result = await pool.request()
						.input('JobBookingJobcardContentsID', sql.Int, 0)
						.input('JobBookingID', sql.Int, jobBookingId)
						.input('FYear', sql.VarChar(10), LEGACY_FYEAR)
						.input('LedgerID', sql.Int, job.ledgerId)
						.input('Qty', sql.Decimal(18, 2), qtyPerBox)
						.input('NetWt', sql.Decimal(18, 2), netWt)
						.input('GrossWt', sql.Decimal(18, 2), grossWt)
						.output('NewBarcode', sql.Int)
						.execute('dbo.InsertPackingSlipBarcodeAuto');
					barcodes.push(Number(result.output.NewBarcode));
				}
			} catch (err) {
				if (!barcodes.length) throw err;
				console.error('[packing-slip] generate stopped part-way:', err);
				return res.json({
					ok: true,
					partial: true,
					error: `Only ${barcodes.length} of ${copies} labels were created: ${err.message}`,
					method: 'legacy',
					job,
					packedAt: new Date().toISOString(),
					barcodes
				});
			}
		}

		res.json({
			ok: true,
			dryRun: false,
			method: useBatch ? 'batch' : 'legacy',
			job,
			packedAt: new Date().toISOString(),
			barcodes
		});
	} catch (err) {
		sendError(res, err, 'generate');
	}
});

/*
 * Mixed box: one barcode for several PWOs of the same client, one row per PWO
 * (InsertPackingSlipBarcodeMixed_Manu, sql/packing-slip/003_mixed_box.sql).
 * weightMode 'box' stores the box weight on the first PWO's row and 0 on the
 * rest, so weight totals count the box once; 'job' stores each PWO's own.
 */
router.post('/generate-mixed', async (req, res) => {
	try {
		const db = dbFrom(req);
		const copies = positiveInt(req.body?.copies);
		const perJobWeight = req.body?.weightMode === 'job';
		const boxNetWt = nonNegative(req.body?.boxNetWt);
		const boxGrossWt = nonNegative(req.body?.boxGrossWt);
		const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

		if (!copies || copies > MAX_COPIES) {
			return res.status(400).json({ ok: false, error: `Number of labels must be between 1 and ${MAX_COPIES}.` });
		}
		if (rawItems.length < 2) return res.status(400).json({ ok: false, error: 'Add at least two PWOs to a mixed box.' });

		const items = rawItems.map((it) => ({
			jobBookingId: positiveInt(it?.jobBookingId),
			qty: positiveInt(it?.qty),
			netWt: nonNegative(it?.netWt),
			grossWt: nonNegative(it?.grossWt)
		}));
		if (items.some((it) => !it.jobBookingId)) return res.status(400).json({ ok: false, error: 'A PWO in the box is not valid.' });
		if (items.some((it) => !it.qty)) return res.status(400).json({ ok: false, error: 'Enter the quantity for every PWO.' });
		if (new Set(items.map((it) => it.jobBookingId)).size !== items.length) {
			return res.status(400).json({ ok: false, error: 'The same PWO is in the box twice.' });
		}
		if (perJobWeight ? items.some((it) => it.netWt == null || it.grossWt == null) : (boxNetWt == null || boxGrossWt == null)) {
			return res.status(400).json({ ok: false, error: 'Weights must be numbers, zero or more.' });
		}

		const pool = await getPool(db);
		const jobs = [];
		for (const it of items) {
			const job = await loadActiveJob(pool, it.jobBookingId);
			if (!job) return res.status(404).json({ ok: false, error: 'A PWO in the box is not found, released, or is closed or cancelled.' });
			jobs.push(job);
		}
		if (new Set(jobs.map((j) => j.ledgerId)).size > 1) {
			return res.status(400).json({ ok: false, error: 'All PWOs in one box must be for the same client.' });
		}

		// Saved and printed in PWO order, so a reprint shows the same label.
		const lines = items
			.map((it, i) => ({ ...it, job: jobs[i] }))
			.sort((a, b) => a.jobBookingId - b.jobBookingId)
			.map((it, i) => ({
				jobBookingId: it.jobBookingId,
				qty: it.qty,
				netWt: perJobWeight ? it.netWt : (i === 0 ? boxNetWt : 0),
				grossWt: perJobWeight ? it.grossWt : (i === 0 ? boxGrossWt : 0),
				job: it.job
			}));
		const shapedLines = lines.map((l) => ({ ...l.job, qtyPerBox: l.qty }));

		if (!writesAllowed()) {
			const preview = await pool.request()
				.query('SELECT ISNULL(MAX(BarcodeNo), 100000) + 1 AS NextNo FROM dbo.PackingSlipBarcodeEntry;');
			const next = Number(preview.recordset[0].NextNo);
			return res.json({
				ok: true,
				dryRun: true,
				lines: shapedLines,
				packedAt: new Date().toISOString(),
				barcodes: Array.from({ length: copies }, (_, i) => next + i)
			});
		}

		const deployed = await pool.request()
			.query("SELECT OBJECT_ID('dbo.InsertPackingSlipBarcodeMixed_Manu', 'P') AS id;");
		if (deployed.recordset[0]?.id == null) {
			return res.status(409).json({
				ok: false,
				error: 'Mixed boxes are not set up in this plant yet: run sql/packing-slip/003_mixed_box.sql first.'
			});
		}

		const result = await pool.request()
			.input('Items', sql.NVarChar(sql.MAX), JSON.stringify(lines.map(({ job, ...rest }) => rest)))
			.input('Copies', sql.Int, copies)
			.execute('dbo.InsertPackingSlipBarcodeMixed_Manu');
		const barcodes = result.recordset.map((r) => Number(r.BarcodeNo)).sort((a, b) => a - b);

		res.json({
			ok: true,
			dryRun: false,
			lines: shapedLines,
			packedAt: new Date().toISOString(),
			barcodes
		});
	} catch (err) {
		sendError(res, err, 'generate mixed');
	}
});

/* Reprint: labels already in the table, by number or number range. */
router.get('/barcodes', async (req, res) => {
	try {
		const db = dbFrom(req);
		const from = positiveInt(req.query.from);
		const to = positiveInt(req.query.to || req.query.from);
		if (!from || !to || to < from) return res.status(400).json({ ok: false, error: 'Enter a valid barcode or range.' });
		if (to - from + 1 > MAX_REPRINT) {
			return res.status(400).json({ ok: false, error: `A reprint is limited to ${MAX_REPRINT} labels.` });
		}

		const pool = await getPool(db);
		const result = await pool.request()
			.input('From', sql.BigInt, from)
			.input('To', sql.BigInt, to)
			.query(`
				SELECT P.BarcodeNo, P.QuantityPerBox, P.NetWt, P.GrossWt, P.BatchNo, P.[DateTime],
				       J.JobBookingID, J.JobBookingNo, J.JobName, J.ProductCode, LM.LedgerName
				FROM dbo.PackingSlipBarcodeEntry P
				INNER JOIN dbo.JobBookingJobCard J ON J.JobBookingID = P.JobBookingID
				INNER JOIN dbo.LedgerMaster LM ON LM.LedgerID = J.LedgerID
				WHERE P.BarcodeNo BETWEEN @From AND @To
				ORDER BY P.BarcodeNo, P.JobBookingID;
			`);
		res.json({
			ok: true,
			labels: result.recordset.map((r) => ({
				barcodeNo: Number(r.BarcodeNo),
				qtyPerBox: Number(r.QuantityPerBox || 0),
				netWt: r.NetWt,
				grossWt: r.GrossWt,
				batchNo: r.BatchNo || '',
				packedAt: r.DateTime,
				jobBookingId: Number(r.JobBookingID),
				jobBookingNo: r.JobBookingNo,
				jobName: r.JobName,
				productCode: r.ProductCode,
				clientName: r.LedgerName
			}))
		});
	} catch (err) {
		sendError(res, err, 'reprint lookup');
	}
});

/* The exe's range report: printed numbers per job as unbroken runs, for Excel. */
router.get('/ranges', async (req, res) => {
	try {
		const db = dbFrom(req);
		const from = String(req.query.from || '');
		const to = String(req.query.to || '');
		if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
			return res.status(400).json({ ok: false, error: 'Choose a from and to date.' });
		}

		const pool = await getPool(db);
		const result = await pool.request()
			.input('FromDate', sql.Date, from)
			.input('ToDate', sql.Date, to)
			.query(`
				WITH B AS (
					SELECT P.JobBookingID, P.BarcodeNo, P.QuantityPerBox, P.[DateTime],
					       P.BarcodeNo - ROW_NUMBER() OVER (PARTITION BY P.JobBookingID ORDER BY P.BarcodeNo) AS Grp
					FROM dbo.PackingSlipBarcodeEntry P
					WHERE P.[DateTime] >= @FromDate AND P.[DateTime] < DATEADD(DAY, 1, @ToDate)
				),
				R AS (
					SELECT JobBookingID, MIN(BarcodeNo) AS StartBarcode, MAX(BarcodeNo) AS EndBarcode,
					       COUNT(*) AS Labels, SUM(CAST(QuantityPerBox AS BIGINT)) AS Qty, MIN([DateTime]) AS FirstAt
					FROM B
					GROUP BY JobBookingID, Grp
				)
				SELECT LM.LedgerName, JOB.SalesOrderNo, J.JobBookingNo, J.JobName, J.JobBookingDate,
				       J.ProductCode, J.OrderQuantity, R.StartBarcode, R.EndBarcode, R.Labels, R.Qty, R.FirstAt
				FROM R
				INNER JOIN dbo.JobBookingJobCard J ON J.JobBookingID = R.JobBookingID
				INNER JOIN dbo.LedgerMaster LM ON LM.LedgerID = J.LedgerID
				LEFT JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = J.OrderBookingID
				ORDER BY R.FirstAt, R.StartBarcode;
			`);
		res.json({
			ok: true,
			rows: result.recordset.map((r) => ({
				clientName: r.LedgerName,
				salesOrderNo: r.SalesOrderNo,
				jobBookingNo: r.JobBookingNo,
				jobName: r.JobName,
				jobBookingDate: r.JobBookingDate,
				productCode: r.ProductCode,
				orderQuantity: Number(r.OrderQuantity || 0),
				start: Number(r.StartBarcode),
				end: Number(r.EndBarcode),
				labels: Number(r.Labels),
				qty: Number(r.Qty || 0),
				firstAt: r.FirstAt
			}))
		});
	} catch (err) {
		sendError(res, err, 'ranges');
	}
});

export default router;
