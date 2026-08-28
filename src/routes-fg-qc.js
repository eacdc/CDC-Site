/**
 * Finished Goods QC — Node API
 *
 * Every verdict is computed by SaveFinishGoodsQCInspection. This file only
 * binds parameters and forwards stored-procedure results.
 *
 * Spec section 6: every route calls a stored procedure — no business logic in
 * JavaScript. The three read routes that were written before their procedures
 * existed (inspections list, inspection by id, dashboard) call the procedure
 * first and fall back to an equivalent inline query only when the procedure is
 * not deployed yet, logging a warning each time. Deploy sql/fgqc/*.sql and the
 * fallbacks stop being reached; sql/fgqc/002_verify.sql reports which are still
 * missing. The fallbacks exist so that deploying the API and deploying the
 * database do not have to happen in the same minute — they are not a second
 * implementation, they are the same SQL.
 *
 *   GET  /api/qc/pending
 *   GET  /api/qc/template
 *   POST /api/qc/inspections
 *   GET  /api/qc/inspections
 *   GET  /api/qc/inspections/:id
 *   GET  /api/qc/dashboard
 *   GET  /api/qc/login
 *   GET  /api/qc/inspectors
 *   GET  /api/qc/units
 */
import { Router } from 'express';
import { getPool, sql } from './db.js';

const router = Router();

const ALLOWED_DATABASES = ['KOL', 'AHM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/*
 * The GPNs this module reads are stored against CompanyID 2 in Indus. This is
 * the value that decides whether the pending queue has any rows at all: the
 * spec marks FinishGoodsTransactionMain.CompanyID as [VERIFY] (section 4.3)
 * precisely because getting it wrong empties the queue with no error raised.
 * Override with FGQC_COMPANY_ID if another site stores them elsewhere.
 */
const DEFAULT_COMPANY_ID = Number(process.env.FGQC_COMPANY_ID || 2);
const DEFAULT_FROM_GPN_DATE = process.env.FGQC_FROM_GPN_DATE || '2026-08-01';
const DOUBLE_SUBMIT_WINDOW_MS = 8000;

/** In-memory guard against double-clicks. Rework resubmits are allowed after the window. */
const recentSubmits = new Map();

/** SQL Server: "Could not find stored procedure". */
const SP_MISSING_ERROR_NUMBERS = new Set([2812]);

/**
 * SQL Server: 8144 "has too many arguments specified", 8145 "is not a parameter
 * for procedure". Both mean the deployed procedure predates the route that
 * calls it — a live database still running last month's sql/fgqc/*.sql.
 */
const SP_STALE_ERROR_NUMBERS = new Set([8144, 8145]);

/** Warn once per procedure, not once per request. */
const warnedMissingSps = new Set();

function isMissingProcedure(err, spName) {
	if (!err) return false;
	if (SP_MISSING_ERROR_NUMBERS.has(err.number)) return true;
	const text = String(err.message || '');
	return /could not find stored procedure/i.test(text) && text.includes(spName);
}

function isStaleProcedure(err, spName) {
	if (!err) return false;
	if (SP_STALE_ERROR_NUMBERS.has(err.number)) return true;
	const text = String(err.message || '');
	return /(too many arguments specified|is not a parameter for procedure)/i.test(text)
		&& text.includes(spName);
}

/**
 * Run a stored procedure, falling back to an equivalent inline query while the
 * procedure has not been deployed yet. See the file header — the fallback is
 * the same SQL, not a second implementation, and it warns so the gap is
 * visible in the logs rather than silent.
 */
async function execProcedure(pool, spName, bind, fallbackSql) {
	try {
		return await bind(pool.request()).execute(spName);
	} catch (err) {
		const missing = isMissingProcedure(err, spName);
		const stale = !missing && isStaleProcedure(err, spName);
		if (!fallbackSql || !(missing || stale)) throw err;
		if (!warnedMissingSps.has(spName)) {
			warnedMissingSps.add(spName);
			console.warn(
				stale
					? `[fg-qc] ${spName} is deployed but does not accept every parameter this `
						+ 'route sends — using the inline fallback. Re-run the matching '
						+ 'sql/fgqc/*.sql to bring the procedure up to date.'
					: `[fg-qc] ${spName} is not deployed — using the inline fallback. `
						+ 'Deploy sql/fgqc/*.sql and re-run sql/fgqc/002_verify.sql.'
			);
		}
		return bind(pool.request()).query(fallbackSql);
	}
}

function getDb(value) {
	const db = String(value || '').trim().toUpperCase();
	return ALLOWED_DATABASES.includes(db) ? db : null;
}

function pick(row, ...keys) {
	if (!row || typeof row !== 'object') return undefined;
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) {
			return row[key];
		}
	}
	const lower = Object.create(null);
	for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
	for (const key of keys) {
		const v = lower[String(key).toLowerCase()];
		if (v !== undefined) return v;
	}
	return undefined;
}

function asStr(value) {
	if (value == null) return '';
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
	return String(value).trim();
}

function asNum(value) {
	if (value == null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function asInt(value) {
	const n = asNum(value);
	return n == null ? null : Math.trunc(n);
}

function asDate(value) {
	if (value == null || value === '') return null;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	const s = String(value).trim();
	if (DATE_RE.test(s)) return new Date(`${s}T00:00:00`);
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(value) {
	const d = asDate(value);
	if (!d) return null;
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/** Calendar date in India — used as the pending-queue end date when the client omits toGPNDate. */
function todayYmd() {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
	} catch {
		return ymd(new Date());
	}
}

function queryVal(req, ...names) {
	const src = { ...(req.query || {}), ...(req.body || {}) };
	for (const name of names) {
		if (src[name] != null && String(src[name]).trim() !== '') return src[name];
		const hit = Object.keys(src).find((k) => k.toLowerCase() === String(name).toLowerCase());
		if (hit && src[hit] != null && String(src[hit]).trim() !== '') return src[hit];
	}
	return undefined;
}

function requireDb(req, res) {
	const db = getDb(queryVal(req, 'database', 'db'));
	if (!db) {
		res.status(400).json({
			status: false,
			error: 'Invalid or missing database (must be KOL or AHM)'
		});
		return null;
	}
	return db;
}

function companyIdOf(req) {
	return asInt(queryVal(req, 'companyId', 'companyID', 'CompanyID')) || DEFAULT_COMPANY_ID;
}

/** Indian financial year start (April). */
function currentFYear(now = new Date()) {
	const y = now.getFullYear();
	return now.getMonth() >= 3 ? y : y - 1;
}

function pruneSubmitCache(now = Date.now()) {
	for (const [key, ts] of recentSubmits) {
		if (now - ts > DOUBLE_SUBMIT_WINDOW_MS) recentSubmits.delete(key);
	}
}

function jsonColumnPayload(row) {
	if (!row || typeof row !== 'object') return null;
	const keys = Object.keys(row);
	for (const key of keys) {
		const v = row[key];
		if (typeof v === 'string') {
			const t = v.trim();
			if (t.startsWith('{') || t.startsWith('[')) {
				try {
					return JSON.parse(t);
				} catch {
					/* keep looking */
				}
			}
		}
	}
	if (keys.length === 1 && typeof row[keys[0]] === 'object' && row[keys[0]] != null) {
		return row[keys[0]];
	}
	return null;
}

function parseSpJson(result) {
	const sets = Array.isArray(result?.recordsets) && result.recordsets.length
		? result.recordsets
		: [result?.recordset].filter(Boolean);
	for (const rs of sets) {
		if (!Array.isArray(rs) || !rs.length) continue;
		const parsed = jsonColumnPayload(rs[0]);
		if (parsed) return parsed;
	}
	return null;
}

function firstRow(result) {
	const sets = Array.isArray(result?.recordsets) ? result.recordsets : [];
	for (let i = sets.length - 1; i >= 0; i--) {
		if (Array.isArray(sets[i]) && sets[i].length) return sets[i][0];
	}
	return result?.recordset?.[0] || null;
}

function parsePaged(result) {
	const primary = result?.recordset || [];
	let total = null;
	const sets = result?.recordsets || [];
	if (sets.length > 1) {
		for (let i = 1; i < sets.length; i++) {
			const row = sets[i] && sets[i][0];
			if (!row) continue;
			const t = pick(row, 'Total', 'total', 'TotalCount', 'TOTAL', 'Cnt', 'RowCount', 'TotalRows');
			if (t != null) {
				total = asInt(t);
				break;
			}
		}
	}
	if (total == null && primary[0]) {
		total = asInt(pick(primary[0], 'TotalCount', 'Total', 'total', 'TOTAL', 'TotalRows', 'RowCount'));
	}
	if (total == null) total = primary.length;
	return { rows: primary, total };
}

function mapPendingRow(row) {
	return {
		jobBookingId: asInt(pick(row, 'JobBookingID')),
		fgTransactionId: asInt(pick(row, 'FGTransactionID', 'FGtransactionID')),
		categoryId: asInt(pick(row, 'CategoryID')),
		categoryName: asStr(pick(row, 'CategoryName', 'Category')),
		gpnNo: asStr(pick(row, 'VoucherNo', 'GPNNo', 'GpnNo')),
		gpnDate: ymd(pick(row, 'VoucherDate', 'GPNDate', 'GpnDate')) || pick(row, 'VoucherDate', 'GPNDate'),
		jobNo: asStr(pick(row, 'JobBookingNo', 'JobNo')),
		jobName: asStr(pick(row, 'JobName')),
		client: asStr(pick(row, 'ClientName', 'Client')),
		lotSize: asNum(pick(row, 'LotSize', 'TotalBox')) || 0,
		packedQuantity: asNum(pick(row, 'PackedQuantity')),
		requiredSample: asNum(pick(row, 'RequiredSample')),
		inspectedQty: asNum(pick(row, 'InspectedQty', 'SampleSize')),
		pendingReason: asStr(pick(row, 'PendingReason')),
		qcStatus: asStr(pick(row, 'QCStatus')),
		foundCritical: asNum(pick(row, 'FoundCritical')) || 0,
		foundMajor: asNum(pick(row, 'FoundMajor')) || 0,
		foundMinor: asNum(pick(row, 'FoundMinor')) || 0,
		submissionCount: asInt(pick(row, 'SubmissionCount')) || 0,
		productionUnitId: asInt(pick(row, 'ProductionUnitID')),
		productionUnitName: asStr(pick(row, 'ProductionUnitName')),
		shift: asStr(pick(row, 'Shift')),
		fgqcNo: asStr(pick(row, 'FGQCNo')),
		companyId: asInt(pick(row, 'CompanyID')),
		mainId: asInt(pick(row, 'FinishGoodsQCInspectionMainID', 'MainID'))
	};
}

function mapAql(src) {
	if (!src || typeof src !== 'object') {
		return { critical: 0, major: null, minor: null };
	}
	return {
		critical: asNum(pick(src, 'critical', 'Critical', 'ReferenceAQLCritical')) ?? 0,
		major: asNum(pick(src, 'major', 'Major', 'ReferenceAQLMajor')),
		minor: asNum(pick(src, 'minor', 'Minor', 'ReferenceAQLMinor')),
		total: asNum(pick(src, 'total', 'Total', 'ReferenceAQLTotal'))
	};
}

/**
 * Spec section 5 question 1 is still open: which column on
 * FinishGoodsQCParameterSetting is authoritative for severity.
 *
 * Until it is answered, an unrecognised value must not be guessed. Defaulting
 * to Minor — which this used to do — takes a Critical defect, files it under
 * Minor, and turns a lot that should be rejected on one defect into a lot that
 * accepts up to the Minor accept number. That is exactly the silent wrong
 * verdict the spec is written to prevent, so an unresolved value is reported as
 * Unclassified and the form refuses to count it.
 */
const SEVERITY_UNCLASSIFIED = 'Unclassified';

function severityOf(value) {
	const s = String(value == null ? '' : value).trim().toLowerCase();
	if (!s) return null;
	if (s.startsWith('crit')) return 'Critical';
	if (s.startsWith('maj')) return 'Major';
	if (s.startsWith('min')) return 'Minor';
	return null;
}

function mapTemplateItem(item) {
	const rawSeverity = pick(item, 'severity', 'Severity', 'MasterFieldType');
	const severity = severityOf(rawSeverity);
	return {
		fgqcParameterSettingID: asInt(pick(item, 'fgqcParameterSettingID', 'FGQCParameterSettingID', 'FinishGoodsQCParameterSettingID', 'id', 'ID')),
		characterstics: asStr(pick(item, 'characterstics', 'Characterstics', 'characteristics', 'Characteristics', 'parameter', 'Parameter')),
		severity: severity || SEVERITY_UNCLASSIFIED,
		severityResolved: severity != null,
		rawSeverity: asStr(rawSeverity),
		critical: asNum(pick(item, 'critical', 'Critical')) || 0,
		major: asNum(pick(item, 'major', 'Major')) || 0,
		minor: asNum(pick(item, 'minor', 'Minor')) || 0,
		remark: asStr(pick(item, 'remark', 'Remark'))
	};
}

function mapTemplate(payload, lotSizeFallback) {
	if (!payload || typeof payload !== 'object') {
		return {
			lotSize: lotSizeFallback,
			sampleSize: null,
			planFound: false,
			referenceAQL: { critical: 0, major: null, minor: null },
			items: [],
			unclassifiedCount: 0
		};
	}
	const refSrc = pick(payload, 'referenceAQL', 'ReferenceAQL') || payload;
	const rawItems = pick(payload, 'items', 'Items') || [];
	const planFoundRaw = pick(payload, 'planFound', 'PlanFound');
	const items = (Array.isArray(rawItems) ? rawItems : []).map(mapTemplateItem);
	return {
		lotSize: asNum(pick(payload, 'lotSize', 'LotSize', 'TotalBox')) ?? lotSizeFallback,
		sampleSize: asNum(pick(payload, 'sampleSize', 'SampleSize')),
		planFound: planFoundRaw === true || planFoundRaw === 1 || String(planFoundRaw).toLowerCase() === 'true',
		lotRangeFrom: asNum(pick(payload, 'lotRangeFrom', 'LotRangeFrom')),
		lotRangeTo: asNum(pick(payload, 'lotRangeTo', 'LotRangeTo')),
		referenceAQL: mapAql(refSrc),
		items,
		unclassifiedCount: items.filter((item) => !item.severityResolved).length
	};
}

function mapSaveResult(row) {
	if (!row) return null;
	const successRaw = pick(row, 'success', 'Success');
	const success = successRaw === true || successRaw === 1 || String(successRaw) === '1';
	return {
		success,
		message: asStr(pick(row, 'message', 'Message')),
		fgqcNo: asStr(pick(row, 'fgqcNo', 'FGQCNo')),
		mainID: asInt(pick(row, 'mainID', 'MainID', 'FinishGoodsQCInspectionMainID')),
		qcStatus: asStr(pick(row, 'qcStatus', 'QCStatus')),
		isResubmission: pick(row, 'isResubmission', 'IsResubmission') === true
			|| pick(row, 'isResubmission', 'IsResubmission') === 1,
		lotSize: asNum(pick(row, 'lotSize', 'LotSize')),
		requiredSample: asNum(pick(row, 'requiredSample', 'RequiredSample')),
		inspected: asNum(pick(row, 'inspected', 'Inspected', 'SampleSize')),
		criticalFound: asNum(pick(row, 'criticalFound', 'CriticalFound', 'FoundCritical')),
		criticalAccept: asNum(pick(row, 'criticalAccept', 'CriticalAccept')),
		majorFound: asNum(pick(row, 'majorFound', 'MajorFound', 'FoundMajor')),
		majorAccept: asNum(pick(row, 'majorAccept', 'MajorAccept')),
		minorFound: asNum(pick(row, 'minorFound', 'MinorFound', 'FoundMinor')),
		minorAccept: asNum(pick(row, 'minorAccept', 'MinorAccept')),
		defectPercent: asNum(pick(row, 'defectPercent', 'DefectPercent'))
	};
}

function mapInspectionListRow(row) {
	return {
		mainId: asInt(pick(row, 'FinishGoodsQCInspectionMainID', 'MainID')),
		fgqcNo: asStr(pick(row, 'FGQCNo')),
		qcStatus: asStr(pick(row, 'QCStatus')),
		sampleSize: asNum(pick(row, 'SampleSize')),
		lotSize: asNum(pick(row, 'LotSize', 'TotalBox')),
		packedQuantity: asNum(pick(row, 'PackedQuantity')),
		referenceAQL: mapAql(row),
		jobBookingId: asInt(pick(row, 'JobBookingID')),
		fgTransactionId: asInt(pick(row, 'FGTransactionID', 'FGtransactionID')),
		inspectedOn: pick(row, 'InspectedOn', 'CreatedDate', 'ModifiedDate'),
		inspector: asStr(pick(row, 'Inspector', 'UserName')),
		userId: asInt(pick(row, 'UserID', 'CreatedBy')),
		gpnNo: asStr(pick(row, 'GPNNo', 'VoucherNo')),
		gpnDate: ymd(pick(row, 'GPNDate', 'VoucherDate')),
		jobNo: asStr(pick(row, 'JobBookingNo', 'JobNo')),
		jobName: asStr(pick(row, 'JobName')),
		client: asStr(pick(row, 'ClientName')),
		categoryName: asStr(pick(row, 'CategoryName')),
		productionUnitId: asInt(pick(row, 'ProductionUnitID')),
		productionUnitName: asStr(pick(row, 'ProductionUnitName')),
		foundCritical: asNum(pick(row, 'FoundCritical')) || 0,
		foundMajor: asNum(pick(row, 'FoundMajor')) || 0,
		foundMinor: asNum(pick(row, 'FoundMinor')) || 0,
		submissionCount: asInt(pick(row, 'SubmissionCount')) || 0,
		remark: asStr(pick(row, 'Remark'))
	};
}

function mapDetailRow(row) {
	return {
		detailId: asInt(pick(row, 'FinishGoodsQCInspectionDetailID')),
		fgqcParameterSettingID: asInt(pick(row, 'FGQCParameterSettingID')),
		characterstics: asStr(pick(row, 'Characterstics', 'characteristics')),
		critical: asNum(pick(row, 'Critical')) || 0,
		major: asNum(pick(row, 'Major')) || 0,
		minor: asNum(pick(row, 'Minor')) || 0,
		sampleSize: asNum(pick(row, 'SampleSize')),
		remark: asStr(pick(row, 'Remark')),
		createdDate: pick(row, 'CreatedDate'),
		createdBy: asInt(pick(row, 'CreatedBy', 'UserID'))
	};
}

function buildInspectionJson(body) {
	const items = Array.isArray(body.items) ? body.items : [];
	return {
		companyID: asInt(body.companyID ?? body.companyId),
		categoryID: asInt(body.categoryID ?? body.categoryId),
		jobBookingID: asInt(body.jobBookingID ?? body.jobBookingId),
		fgTransactionID: asInt(body.fgTransactionID ?? body.fgTransactionId),
		sampleSize: asNum(body.sampleSize),
		samplingMethodType: asStr(body.samplingMethodType) || 'Carter',
		packingDescription: asStr(body.packingDescription),
		remark: asStr(body.remark),
		productionUnitID: asInt(body.productionUnitID ?? body.productionUnitId),
		items: items.map((item) => ({
			fgqcParameterSettingID: asInt(item.fgqcParameterSettingID ?? item.FGQCParameterSettingID),
			characterstics: asStr(item.characterstics ?? item.characteristics),
			critical: asNum(item.critical) || 0,
			major: asNum(item.major) || 0,
			minor: asNum(item.minor) || 0,
			remark: asStr(item.remark)
		}))
	};
}

/**
 * GET /api/qc/pending
 */
router.get('/qc/pending', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const companyId = companyIdOf(req);
	const search = asStr(queryVal(req, 'search')) || null;
	const fromGPNDate = ymd(queryVal(req, 'fromGPNDate')) || DEFAULT_FROM_GPN_DATE;
	const toGPNDate = ymd(queryVal(req, 'toGPNDate')) || todayYmd();
	const page = Math.max(1, asInt(queryVal(req, 'page')) || 1);
	const pageSize = Math.min(200, Math.max(1, asInt(queryVal(req, 'pageSize')) || 25));
	const unitId = asInt(queryVal(req, 'unitId', 'productionUnitId', 'productionUnitID'));
	const includeClosed = String(queryVal(req, 'includeClosed') || '0') === '1';

	try {
		const pool = await getPool(db);
		const request = pool.request()
			.input('Search', sql.NVarChar(200), search)
			.input('FromGPNDate', sql.Date, fromGPNDate)
			.input('ToGPNDate', sql.Date, toGPNDate)
			.input('CompanyID', sql.BigInt, companyId)
			.input('ProductionUnitID', sql.BigInt, unitId)
			.input('IncludeClosed', sql.Bit, includeClosed)
			.input('Page', sql.Int, page)
			.input('PageSize', sql.Int, pageSize);

		const result = await request.execute('GetPendingFGQCList');
		const paged = parsePaged(result);
		return res.json({
			status: true,
			rows: paged.rows.map(mapPendingRow),
			total: paged.total,
			page,
			pageSize,
			fromGPNDate,
			toGPNDate
		});
	} catch (err) {
		console.error('[fg-qc] pending error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch lots awaiting inspection'
		});
	}
});

/**
 * GET /api/qc/template
 */
router.get('/qc/template', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const companyId = companyIdOf(req);
	const categoryId = asInt(queryVal(req, 'categoryId', 'categoryID'));
	const lotSize = asNum(queryVal(req, 'lotSize', 'LotSize'));
	if (categoryId == null) {
		return res.status(400).json({ status: false, error: 'categoryId is required' });
	}
	if (lotSize == null || lotSize < 0) {
		return res.status(400).json({
			status: false,
			error: 'lotSize is required and must be the inner carton count for this lot'
		});
	}

	try {
		const pool = await getPool(db);
		const result = await pool.request()
			/*
			 * Bound to the types GetFinishGoodsQCTemplate actually declares:
			 * @LotSize is bigint and @SamplingMethodType is varchar(128).
			 * Lot size is a count of inner cartons, so rounding here is exact
			 * rather than leaving a decimal-to-bigint conversion to the driver.
			 */
			.input('CategoryID', sql.BigInt, categoryId)
			.input('LotSize', sql.BigInt, Math.round(lotSize))
			.input('SamplingMethodType', sql.VarChar(128), 'Carter')
			.input('CompanyID', sql.BigInt, companyId)
			.input('IncludeDeleted', sql.Bit, 0)
			.execute('GetFinishGoodsQCTemplate');

		const parsed = parseSpJson(result);
		let template;
		if (parsed) {
			template = mapTemplate(parsed, lotSize);
		} else {
			const header = result?.recordset?.[0] || {};
			const itemSet = result?.recordsets?.[1];
			const merged = {
				...header,
				items: Array.isArray(itemSet) ? itemSet : (pick(header, 'items', 'Items') || [])
			};
			template = mapTemplate(merged, lotSize);
		}

		return res.json({ status: true, ...template });
	} catch (err) {
		console.error('[fg-qc] template error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch inspection template'
		});
	}
});

/**
 * POST /api/qc/inspections
 * Body is the inspection JSON plus userId / database / fYear (optional).
 */
router.post('/qc/inspections', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const body = req.body || {};
	const userId = asInt(body.userId ?? body.userID ?? body.UserID);
	const companyId = asInt(body.companyID ?? body.companyId) || DEFAULT_COMPANY_ID;
	const fYear = asInt(body.fYear ?? body.FYear) || currentFYear();
	const inspection = buildInspectionJson({ ...body, companyID: companyId });

	if (userId == null) {
		return res.status(400).json({ status: false, error: 'userId is required' });
	}
	if (inspection.categoryID == null) {
		return res.status(400).json({ status: false, error: 'categoryID is required' });
	}
	if (inspection.jobBookingID == null || inspection.fgTransactionID == null) {
		return res.status(400).json({
			status: false,
			error: 'jobBookingID and fgTransactionID are required to identify the lot'
		});
	}
	if (!inspection.sampleSize || inspection.sampleSize <= 0) {
		return res.status(400).json({
			status: false,
			error: 'Cartons inspected (sampleSize) must be greater than zero'
		});
	}
	if (!inspection.items.length) {
		return res.status(400).json({ status: false, error: 'items[] cannot be empty' });
	}

	const submitKey = `${db}:${inspection.jobBookingID}:${inspection.fgTransactionID}`;
	pruneSubmitCache();
	const last = recentSubmits.get(submitKey);
	if (last && Date.now() - last < DOUBLE_SUBMIT_WINDOW_MS) {
		return res.status(429).json({
			status: false,
			success: false,
			error: 'This lot was just submitted. Wait a moment before submitting again.'
		});
	}
	recentSubmits.set(submitKey, Date.now());

	try {
		const pool = await getPool(db);
		const result = await pool.request()
			.input('UserID', sql.BigInt, userId)
			.input('InspectionJson', sql.NVarChar(sql.MAX), JSON.stringify(inspection))
			.input('CompanyID', sql.BigInt, companyId)
			.input('FYear', sql.Int, fYear)
			.input('Prefix', sql.NVarChar(20), asStr(body.prefix) || 'FGQC')
			.input('AllowNoPlan', sql.Bit, 1)
			.execute('SaveFinishGoodsQCInspection');

		const row = firstRow(result);
		const mapped = mapSaveResult(row) || {
			success: false,
			message: 'Save procedure returned no result'
		};

		if (!mapped.success) {
			recentSubmits.delete(submitKey);
			return res.status(400).json({
				status: false,
				success: false,
				error: mapped.message || 'Inspection was not saved',
				...mapped
			});
		}

		return res.json({ status: true, ...mapped });
	} catch (err) {
		recentSubmits.delete(submitKey);
		console.error('[fg-qc] save error:', err);
		return res.status(500).json({
			status: false,
			success: false,
			error: err?.message || 'Failed to save inspection'
		});
	}
});

const INSPECTION_LIST_SQL = `
;WITH LatestDetail AS (
  SELECT
    d.FinishGoodsQCInspectionMainID,
    SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
    SUM(ISNULL(d.Major, 0)) AS FoundMajor,
    SUM(ISNULL(d.Minor, 0)) AS FoundMinor
  FROM dbo.FinishGoodsQCInspectionDetail d
  INNER JOIN (
    SELECT FinishGoodsQCInspectionMainID, MAX(CreatedDate) AS MaxCreated
    FROM dbo.FinishGoodsQCInspectionDetail
    WHERE ISNULL(IsDeletedTransaction, 0) = 0
    GROUP BY FinishGoodsQCInspectionMainID
  ) latest
    ON latest.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
   AND d.CreatedDate = latest.MaxCreated
  WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
  GROUP BY d.FinishGoodsQCInspectionMainID
),
SubmissionCount AS (
  SELECT
    FinishGoodsQCInspectionMainID,
    COUNT(DISTINCT CreatedDate) AS Submissions
  FROM dbo.FinishGoodsQCInspectionDetail
  WHERE ISNULL(IsDeletedTransaction, 0) = 0
  GROUP BY FinishGoodsQCInspectionMainID
),
LotJob AS (
  SELECT
    fgd.FGTransactionID,
    fgd.JobBookingID,
    ROW_NUMBER() OVER (
      PARTITION BY fgd.FGTransactionID, fgd.JobBookingID
      ORDER BY fgd.JobBookingID
    ) AS rn
  FROM dbo.FinishGoodsTransactionDetail fgd
  WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
)
SELECT
  m.FinishGoodsQCInspectionMainID,
  m.FGQCNo,
  m.QCStatus,
  m.SampleSize,
  m.TotalBox AS LotSize,
  m.PackedQuantity,
  m.ReferenceAQLCritical,
  m.ReferenceAQLMajor,
  m.ReferenceAQLMinor,
  m.FGTransactionID,
  ISNULL(m.JobBookingID, lj.JobBookingID) AS JobBookingID,
  ISNULL(m.ModifiedDate, m.CreatedDate) AS InspectedOn,
  m.Remark,
  m.ProductionUnitID,
  ISNULL(um.UserName, '') AS Inspector,
  m.CreatedBy AS UserID,
  fgm.VoucherNo AS GPNNo,
  fgm.VoucherDate AS GPNDate,
  jb.JobBookingNo,
  jb.JobName,
  ISNULL(jb.ClientName, lm.LedgerName) AS ClientName,
  cm.CategoryName,
  ISNULL(ld.FoundCritical, 0) AS FoundCritical,
  ISNULL(ld.FoundMajor, 0) AS FoundMajor,
  ISNULL(ld.FoundMinor, 0) AS FoundMinor,
  ISNULL(sc.Submissions, 0) AS SubmissionCount
FROM dbo.FinishGoodsQCInspectionMain m
LEFT JOIN LatestDetail ld ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
LEFT JOIN SubmissionCount sc ON sc.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
LEFT JOIN dbo.FinishGoodsTransactionMain fgm
  ON fgm.FGTransactionID = m.FGTransactionID
 AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
LEFT JOIN LotJob lj
  ON lj.FGTransactionID = m.FGTransactionID
 AND (m.JobBookingID IS NULL OR lj.JobBookingID = m.JobBookingID)
 AND lj.rn = 1
LEFT JOIN dbo.JobBookingJobCard jb
  ON jb.JobBookingID = ISNULL(m.JobBookingID, lj.JobBookingID)
LEFT JOIN dbo.JobOrderBooking job
  ON job.OrderBookingID = jb.OrderBookingID
LEFT JOIN dbo.LedgerMaster lm
  ON lm.LedgerID = job.LedgerID
LEFT JOIN dbo.CategoryMaster cm
  ON cm.CategoryID = ISNULL(m.CategoryID, jb.CategoryID)
LEFT JOIN dbo.UserMaster um
  ON um.UserID = m.CreatedBy
WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
  AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
  AND (@FromDate IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) >= @FromDate)
  AND (@ToDate IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) <= @ToDate)
  AND (@Status IS NULL OR m.QCStatus = @Status)
  AND (
    @JobNo IS NULL
    OR jb.JobBookingNo LIKE '%' + @JobNo + '%'
    OR m.FGQCNo LIKE '%' + @JobNo + '%'
    OR fgm.VoucherNo LIKE '%' + @JobNo + '%'
  )
  AND (@UnitID IS NULL OR m.ProductionUnitID = @UnitID)
  AND (@FGQCNo IS NULL OR m.FGQCNo LIKE '%' + @FGQCNo + '%')
  AND (@JobBookingNo IS NULL OR jb.JobBookingNo LIKE '%' + @JobBookingNo + '%')
  AND (@GPNNo IS NULL OR fgm.VoucherNo LIKE '%' + @GPNNo + '%')
  AND (@Inspector IS NULL OR um.UserName LIKE '%' + @Inspector + '%')
  AND (@MinLotSize IS NULL OR ISNULL(m.TotalBox, 0) >= @MinLotSize)
  AND (@MinSample IS NULL OR ISNULL(m.SampleSize, 0) >= @MinSample)
  AND (@MinCritical IS NULL OR ISNULL(ld.FoundCritical, 0) >= @MinCritical)
  AND (@MinMajor IS NULL OR ISNULL(ld.FoundMajor, 0) >= @MinMajor)
  AND (@MinMinor IS NULL OR ISNULL(ld.FoundMinor, 0) >= @MinMinor)
ORDER BY ISNULL(m.ModifiedDate, m.CreatedDate) DESC
OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;

;WITH LatestDetail AS (
  SELECT
    d.FinishGoodsQCInspectionMainID,
    SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
    SUM(ISNULL(d.Major, 0)) AS FoundMajor,
    SUM(ISNULL(d.Minor, 0)) AS FoundMinor
  FROM dbo.FinishGoodsQCInspectionDetail d
  INNER JOIN (
    SELECT FinishGoodsQCInspectionMainID, MAX(CreatedDate) AS MaxCreated
    FROM dbo.FinishGoodsQCInspectionDetail
    WHERE ISNULL(IsDeletedTransaction, 0) = 0
    GROUP BY FinishGoodsQCInspectionMainID
  ) latest
    ON latest.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
   AND d.CreatedDate = latest.MaxCreated
  WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
  GROUP BY d.FinishGoodsQCInspectionMainID
)
/*
  Total for the pager and the summary row under the table, from one pass.

  The inner query groups by the lot so the joins cannot inflate anything: a GPN
  spanning several jobs fans out to several rows here, and a straight SUM over
  that would count the same lot's cartons twice. MIN picks one job number per
  lot, which is the same tie-break the row listing makes with LotJob rn = 1.
*/
SELECT
  COUNT(1) AS Total,
  COUNT(DISTINCT s.Inspector) AS DistinctInspectors,
  COUNT(DISTINCT s.JobBookingNo) AS DistinctJobs,
  COUNT(DISTINCT s.GPNNo) AS DistinctGPNs,
  SUM(s.LotSize) AS TotalLotSize,
  SUM(s.SampleSize) AS TotalSampleSize
FROM (
SELECT
  m.FinishGoodsQCInspectionMainID AS MainID,
  MIN(ISNULL(m.TotalBox, 0)) AS LotSize,
  MIN(ISNULL(m.SampleSize, 0)) AS SampleSize,
  MIN(NULLIF(um.UserName, '')) AS Inspector,
  MIN(jb.JobBookingNo) AS JobBookingNo,
  MIN(fgm.VoucherNo) AS GPNNo
FROM dbo.FinishGoodsQCInspectionMain m
LEFT JOIN LatestDetail ld ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
LEFT JOIN dbo.FinishGoodsTransactionMain fgm
  ON fgm.FGTransactionID = m.FGTransactionID
 AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
LEFT JOIN dbo.FinishGoodsTransactionDetail fgd
  ON fgd.FGTransactionID = m.FGTransactionID
 AND ISNULL(fgd.IsDeletedTransaction, 0) = 0
 AND (m.JobBookingID IS NULL OR fgd.JobBookingID = m.JobBookingID)
LEFT JOIN dbo.JobBookingJobCard jb
  ON jb.JobBookingID = ISNULL(m.JobBookingID, fgd.JobBookingID)
LEFT JOIN dbo.UserMaster um
  ON um.UserID = m.CreatedBy
WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
  AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
  AND (@FromDate IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) >= @FromDate)
  AND (@ToDate IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) <= @ToDate)
  AND (@Status IS NULL OR m.QCStatus = @Status)
  AND (
    @JobNo IS NULL
    OR jb.JobBookingNo LIKE '%' + @JobNo + '%'
    OR m.FGQCNo LIKE '%' + @JobNo + '%'
    OR fgm.VoucherNo LIKE '%' + @JobNo + '%'
  )
  AND (@UnitID IS NULL OR m.ProductionUnitID = @UnitID)
  AND (@FGQCNo IS NULL OR m.FGQCNo LIKE '%' + @FGQCNo + '%')
  AND (@JobBookingNo IS NULL OR jb.JobBookingNo LIKE '%' + @JobBookingNo + '%')
  AND (@GPNNo IS NULL OR fgm.VoucherNo LIKE '%' + @GPNNo + '%')
  AND (@Inspector IS NULL OR um.UserName LIKE '%' + @Inspector + '%')
  AND (@MinLotSize IS NULL OR ISNULL(m.TotalBox, 0) >= @MinLotSize)
  AND (@MinSample IS NULL OR ISNULL(m.SampleSize, 0) >= @MinSample)
  AND (@MinCritical IS NULL OR ISNULL(ld.FoundCritical, 0) >= @MinCritical)
  AND (@MinMajor IS NULL OR ISNULL(ld.FoundMajor, 0) >= @MinMajor)
  AND (@MinMinor IS NULL OR ISNULL(ld.FoundMinor, 0) >= @MinMinor)
GROUP BY m.FinishGoodsQCInspectionMainID
) s;
`;

/**
 * GET /api/qc/inspections
 */
router.get('/qc/inspections', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const companyId = companyIdOf(req);
	const from = ymd(queryVal(req, 'from', 'fromDate'));
	const to = ymd(queryVal(req, 'to', 'toDate'));
	const jobNo = asStr(queryVal(req, 'jobNo', 'search')) || null;
	const status = asStr(queryVal(req, 'status')) || null;
	const unitId = asInt(queryVal(req, 'unitId', 'productionUnitId'));
	const page = Math.max(1, asInt(queryVal(req, 'page')) || 1);
	const pageSize = Math.min(200, Math.max(1, asInt(queryVal(req, 'pageSize')) || 25));

	/*
	 * Per-column filters, one per header cell in the dashboard table. They are
	 * applied in SQL rather than over the fetched page: the table is paged
	 * server-side, so filtering the twenty-five rows in the browser would
	 * silently hide matches sitting on page two and leave the row count above
	 * the table disagreeing with what is on screen.
	 *
	 * jobNo above stays as it is — it is the toolbar's one-box search across
	 * FGQC, job and GPN. These narrow it to a single column each.
	 */
	const fgqcNo = asStr(queryVal(req, 'fgqcNo')) || null;
	const jobBookingNo = asStr(queryVal(req, 'jobBookingNo')) || null;
	const gpnNo = asStr(queryVal(req, 'gpnNo')) || null;
	const inspector = asStr(queryVal(req, 'inspector')) || null;
	const minLotSize = asInt(queryVal(req, 'minLotSize'));
	const minSample = asInt(queryVal(req, 'minSample'));
	const minCritical = asInt(queryVal(req, 'minCritical'));
	const minMajor = asInt(queryVal(req, 'minMajor'));
	const minMinor = asInt(queryVal(req, 'minMinor'));

	try {
		const pool = await getPool(db);
		const result = await execProcedure(
			pool,
			'GetFGQCInspectionList',
			(request) => request
				.input('CompanyID', sql.BigInt, companyId)
				.input('FromDate', sql.Date, from)
				.input('ToDate', sql.Date, to)
				.input('JobNo', sql.NVarChar(100), jobNo)
				.input('Status', sql.NVarChar(50), status)
				.input('UnitID', sql.BigInt, unitId)
				.input('Offset', sql.Int, (page - 1) * pageSize)
				.input('PageSize', sql.Int, pageSize)
				.input('FGQCNo', sql.NVarChar(100), fgqcNo)
				.input('JobBookingNo', sql.NVarChar(100), jobBookingNo)
				.input('GPNNo', sql.NVarChar(100), gpnNo)
				.input('Inspector', sql.NVarChar(100), inspector)
				.input('MinLotSize', sql.BigInt, minLotSize)
				.input('MinSample', sql.BigInt, minSample)
				.input('MinCritical', sql.BigInt, minCritical)
				.input('MinMajor', sql.BigInt, minMajor)
				.input('MinMinor', sql.BigInt, minMinor),
			INSPECTION_LIST_SQL
		);

		const paged = parsePaged(result);

		/*
		 * The summary row under the table. These describe every lot matching the
		 * filters, not the twenty-five on this page — so they come back from the
		 * same result set as Total rather than being added up in the browser.
		 */
		const summaryRow = (result?.recordsets || [])[1]?.[0] || {};
		const summary = {
			lots: paged.total,
			inspectors: asInt(pick(summaryRow, 'DistinctInspectors')),
			jobs: asInt(pick(summaryRow, 'DistinctJobs')),
			gpns: asInt(pick(summaryRow, 'DistinctGPNs')),
			totalLotSize: asInt(pick(summaryRow, 'TotalLotSize')),
			totalSampleSize: asInt(pick(summaryRow, 'TotalSampleSize'))
		};

		return res.json({
			status: true,
			rows: paged.rows.map(mapInspectionListRow),
			total: paged.total,
			summary,
			page,
			pageSize
		});
	} catch (err) {
		console.error('[fg-qc] inspections list error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch inspections'
		});
	}
});

/**
 * Inline fallback for GetFGQCInspectionByID — same four result sets, same
 * ordering. See the file header for why a fallback exists at all.
 */
const INSPECTION_BY_ID_SQL = `
;WITH LotJob AS (
  SELECT
    fgd.FGTransactionID,
    fgd.JobBookingID,
    ROW_NUMBER() OVER (
      PARTITION BY fgd.FGTransactionID, fgd.JobBookingID
      ORDER BY fgd.JobBookingID
    ) AS rn
  FROM dbo.FinishGoodsTransactionDetail fgd
  WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
),
LatestDetail AS (
  SELECT
    d.FinishGoodsQCInspectionMainID,
    SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
    SUM(ISNULL(d.Major, 0)) AS FoundMajor,
    SUM(ISNULL(d.Minor, 0)) AS FoundMinor
  FROM dbo.FinishGoodsQCInspectionDetail d
  INNER JOIN (
    SELECT FinishGoodsQCInspectionMainID, MAX(CreatedDate) AS MaxCreated
    FROM dbo.FinishGoodsQCInspectionDetail
    WHERE ISNULL(IsDeletedTransaction, 0) = 0
      AND FinishGoodsQCInspectionMainID = @MainID
    GROUP BY FinishGoodsQCInspectionMainID
  ) latest
    ON latest.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
   AND d.CreatedDate = latest.MaxCreated
  WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
  GROUP BY d.FinishGoodsQCInspectionMainID
)
SELECT TOP 1
  m.*,
  ISNULL(m.ModifiedDate, m.CreatedDate) AS InspectedOn,
  ISNULL(um.UserName, '') AS Inspector,
  fgm.VoucherNo AS GPNNo,
  fgm.VoucherDate AS GPNDate,
  jb.JobBookingNo,
  jb.JobName,
  ISNULL(jb.ClientName, lm.LedgerName) AS ClientName,
  cm.CategoryName,
  ISNULL(ld.FoundCritical, 0) AS FoundCritical,
  ISNULL(ld.FoundMajor, 0) AS FoundMajor,
  ISNULL(ld.FoundMinor, 0) AS FoundMinor,
  (
    SELECT COUNT(DISTINCT CreatedDate)
    FROM dbo.FinishGoodsQCInspectionDetail
    WHERE FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
      AND ISNULL(IsDeletedTransaction, 0) = 0
  ) AS SubmissionCount
FROM dbo.FinishGoodsQCInspectionMain m
LEFT JOIN LatestDetail ld ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
LEFT JOIN dbo.FinishGoodsTransactionMain fgm ON fgm.FGTransactionID = m.FGTransactionID
LEFT JOIN LotJob lj
  ON lj.FGTransactionID = m.FGTransactionID
 AND (m.JobBookingID IS NULL OR lj.JobBookingID = m.JobBookingID)
 AND lj.rn = 1
LEFT JOIN dbo.JobBookingJobCard jb ON jb.JobBookingID = ISNULL(m.JobBookingID, lj.JobBookingID)
LEFT JOIN dbo.JobOrderBooking job ON job.OrderBookingID = jb.OrderBookingID
LEFT JOIN dbo.LedgerMaster lm ON lm.LedgerID = job.LedgerID
LEFT JOIN dbo.CategoryMaster cm ON cm.CategoryID = ISNULL(m.CategoryID, jb.CategoryID)
LEFT JOIN dbo.UserMaster um ON um.UserID = m.CreatedBy
WHERE m.FinishGoodsQCInspectionMainID = @MainID
  AND ISNULL(m.IsDeletedTransaction, 0) = 0;

DECLARE @LatestCreated DATETIME = (
  SELECT MAX(CreatedDate)
  FROM dbo.FinishGoodsQCInspectionDetail
  WHERE FinishGoodsQCInspectionMainID = @MainID
    AND ISNULL(IsDeletedTransaction, 0) = 0
);

SELECT *
FROM dbo.FinishGoodsQCInspectionDetail
WHERE FinishGoodsQCInspectionMainID = @MainID
  AND ISNULL(IsDeletedTransaction, 0) = 0
  AND (@LatestCreated IS NULL OR CreatedDate = @LatestCreated)
ORDER BY FinishGoodsQCInspectionDetailID;

;WITH Submissions AS (
  SELECT CreatedDate, DENSE_RANK() OVER (ORDER BY CreatedDate) AS SubmissionNo
  FROM dbo.FinishGoodsQCInspectionDetail
  WHERE FinishGoodsQCInspectionMainID = @MainID
    AND ISNULL(IsDeletedTransaction, 0) = 0
  GROUP BY CreatedDate
)
SELECT d.*, s.SubmissionNo
FROM dbo.FinishGoodsQCInspectionDetail d
INNER JOIN Submissions s ON s.CreatedDate = d.CreatedDate
WHERE d.FinishGoodsQCInspectionMainID = @MainID
  AND ISNULL(d.IsDeletedTransaction, 0) = 0
ORDER BY s.SubmissionNo, d.FinishGoodsQCInspectionDetailID;

DECLARE @AqlCritical DECIMAL(18,4), @AqlMajor DECIMAL(18,4), @AqlMinor DECIMAL(18,4);
SELECT
  @AqlCritical = TRY_CAST(ReferenceAQLCritical AS DECIMAL(18,4)),
  @AqlMajor    = TRY_CAST(ReferenceAQLMajor AS DECIMAL(18,4)),
  @AqlMinor    = TRY_CAST(ReferenceAQLMinor AS DECIMAL(18,4))
FROM dbo.FinishGoodsQCInspectionMain
WHERE FinishGoodsQCInspectionMainID = @MainID;

;WITH PerSubmission AS (
  SELECT
    d.CreatedDate,
    DENSE_RANK() OVER (ORDER BY d.CreatedDate) AS SubmissionNo,
    SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
    SUM(ISNULL(d.Major, 0)) AS FoundMajor,
    SUM(ISNULL(d.Minor, 0)) AS FoundMinor,
    MAX(ISNULL(TRY_CAST(d.SampleSize AS DECIMAL(18,4)), 0)) AS SampleSize,
    MIN(d.CreatedBy) AS CreatedBy
  FROM dbo.FinishGoodsQCInspectionDetail d
  WHERE d.FinishGoodsQCInspectionMainID = @MainID
    AND ISNULL(d.IsDeletedTransaction, 0) = 0
  GROUP BY d.CreatedDate
)
SELECT
  ps.SubmissionNo,
  ps.CreatedDate,
  ps.SampleSize,
  ps.FoundCritical,
  ps.FoundMajor,
  ps.FoundMinor,
  ISNULL(um.UserName, '') AS Inspector,
  CASE
    WHEN @AqlCritical IS NULL AND @AqlMajor IS NULL AND @AqlMinor IS NULL THEN NULL
    WHEN ps.FoundCritical > ISNULL(@AqlCritical, 0) THEN CAST(0 AS BIT)
    WHEN ps.FoundMajor > ISNULL(@AqlMajor, ps.FoundMajor) THEN CAST(0 AS BIT)
    WHEN ps.FoundMinor > ISNULL(@AqlMinor, ps.FoundMinor) THEN CAST(0 AS BIT)
    ELSE CAST(1 AS BIT)
  END AS WouldPass
FROM PerSubmission ps
LEFT JOIN dbo.UserMaster um ON um.UserID = ps.CreatedBy
ORDER BY ps.SubmissionNo;
`;

/**
 * GET /api/qc/inspections/:id
 */
router.get('/qc/inspections/:id', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const id = asInt(req.params.id);
	if (id == null) {
		return res.status(400).json({ status: false, error: 'Valid inspection id is required' });
	}

	try {
		const pool = await getPool(db);
		const result = await execProcedure(
			pool,
			'GetFGQCInspectionByID',
			(request) => request.input('MainID', sql.BigInt, id),
			INSPECTION_BY_ID_SQL
		);

		const sets = result.recordsets || [];
		const mainRow = sets[0]?.[0];
		if (!mainRow) {
			return res.status(404).json({ status: false, error: 'Inspection not found' });
		}

		/*
		 * Rows from one submission share a CreatedDate (spec section 4.1), so
		 * the latest submission is selected in SQL by exact equality against
		 * MAX(CreatedDate). This used to be a two-second window in JavaScript,
		 * which could merge two submissions made in quick succession — the
		 * opposite of what the detail history is for.
		 */
		const detail = (sets[1] || []).map(mapDetailRow);
		const history = (sets[2] || []).map((row) => ({
			...mapDetailRow(row),
			submissionNo: asInt(pick(row, 'SubmissionNo')) || 1
		}));
		const submissions = (sets[3] || []).map((row) => ({
			submissionNo: asInt(pick(row, 'SubmissionNo')) || 1,
			createdDate: pick(row, 'CreatedDate'),
			inspector: asStr(pick(row, 'Inspector')),
			sampleSize: asNum(pick(row, 'SampleSize')),
			foundCritical: asNum(pick(row, 'FoundCritical')) || 0,
			foundMajor: asNum(pick(row, 'FoundMajor')) || 0,
			foundMinor: asNum(pick(row, 'FoundMinor')) || 0,
			wouldPass: pick(row, 'WouldPass') == null ? null : Boolean(pick(row, 'WouldPass'))
		}));

		/*
		 * Spec section 5 question 2: a rejected lot is re-inspected against the
		 * same key and the main row is replaced, so the main row no longer shows
		 * that the lot ever failed. Rather than add a column the save procedure
		 * would not fill, the flag is derived from the detail history, which
		 * survives replacement by design.
		 */
		const everRejected = submissions.some((sub) => sub.wouldPass === false);

		return res.json({
			status: true,
			main: {
				...mapInspectionListRow(mainRow),
				packingDescription: asStr(pick(mainRow, 'PackingDescription')),
				samplingMethodType: asStr(pick(mainRow, 'SamplingMethodType')) || 'Carter',
				sampleSize: asNum(pick(mainRow, 'SampleSize')),
				lotSize: asNum(pick(mainRow, 'TotalBox', 'LotSize')),
				submissionCount: asInt(pick(mainRow, 'SubmissionCount')) || submissions.length,
				everRejected
			},
			detail,
			history,
			submissions
		});
	} catch (err) {
		console.error('[fg-qc] inspection by id error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch inspection'
		});
	}
});

/**
 * Inline fallback for GetFGQCDashboardKPIs — the body of the procedure, same
 * five result sets in the same order. See the file header.
 */
const DASHBOARD_SQL = `
SET NOCOUNT ON;
DECLARE @DaySpan INT = DATEDIFF(day, @FromDate, @ToDate);

IF OBJECT_ID('tempdb..#FgqcLots') IS NOT NULL DROP TABLE #FgqcLots;
SELECT
  m.FinishGoodsQCInspectionMainID,
  m.QCStatus,
  ISNULL(TRY_CAST(m.SampleSize AS DECIMAL(18,4)), 0) AS SampleSize,
  m.ProductionUnitID,
  TRY_CAST(m.ReferenceAQLCritical AS DECIMAL(18,4)) AS AqlCritical,
  TRY_CAST(m.ReferenceAQLMajor AS DECIMAL(18,4)) AS AqlMajor,
  TRY_CAST(m.ReferenceAQLMinor AS DECIMAL(18,4)) AS AqlMinor,
  CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) AS InspectedDate
INTO #FgqcLots
FROM dbo.FinishGoodsQCInspectionMain m
WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
  AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
  AND (@UnitID IS NULL OR m.ProductionUnitID = @UnitID)
  AND CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) BETWEEN @FromDate AND @ToDate;

IF OBJECT_ID('tempdb..#FgqcSubmissions') IS NOT NULL DROP TABLE #FgqcSubmissions;
SELECT
  d.FinishGoodsQCInspectionMainID,
  d.CreatedDate,
  DENSE_RANK() OVER (PARTITION BY d.FinishGoodsQCInspectionMainID ORDER BY d.CreatedDate) AS SubmissionNo,
  DENSE_RANK() OVER (PARTITION BY d.FinishGoodsQCInspectionMainID ORDER BY d.CreatedDate DESC) AS SubmissionNoDesc,
  SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
  SUM(ISNULL(d.Major, 0)) AS FoundMajor,
  SUM(ISNULL(d.Minor, 0)) AS FoundMinor
INTO #FgqcSubmissions
FROM dbo.FinishGoodsQCInspectionDetail d
INNER JOIN #FgqcLots l ON l.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
GROUP BY d.FinishGoodsQCInspectionMainID, d.CreatedDate;

IF OBJECT_ID('tempdb..#FgqcLatest') IS NOT NULL DROP TABLE #FgqcLatest;
SELECT
  l.FinishGoodsQCInspectionMainID, l.QCStatus, l.SampleSize, l.ProductionUnitID,
  l.AqlCritical, l.AqlMajor, l.AqlMinor, l.InspectedDate,
  ISNULL(s.FoundCritical, 0) AS FoundCritical,
  ISNULL(s.FoundMajor, 0) AS FoundMajor,
  ISNULL(s.FoundMinor, 0) AS FoundMinor,
  ISNULL(s.FoundCritical, 0) + ISNULL(s.FoundMajor, 0) + ISNULL(s.FoundMinor, 0) AS FoundTotal
INTO #FgqcLatest
FROM #FgqcLots l
LEFT JOIN #FgqcSubmissions s
  ON s.FinishGoodsQCInspectionMainID = l.FinishGoodsQCInspectionMainID
 AND s.SubmissionNoDesc = 1;

IF OBJECT_ID('tempdb..#FgqcFirstPass') IS NOT NULL DROP TABLE #FgqcFirstPass;
SELECT
  l.FinishGoodsQCInspectionMainID,
  CASE
    WHEN s.FoundCritical > ISNULL(l.AqlCritical, 0) THEN 0
    WHEN s.FoundMajor > ISNULL(l.AqlMajor, s.FoundMajor) THEN 0
    WHEN s.FoundMinor > ISNULL(l.AqlMinor, s.FoundMinor) THEN 0
    ELSE 1
  END AS FirstPassAccepted
INTO #FgqcFirstPass
FROM #FgqcLatest l
INNER JOIN #FgqcSubmissions s
  ON s.FinishGoodsQCInspectionMainID = l.FinishGoodsQCInspectionMainID
 AND s.SubmissionNo = 1
WHERE l.AqlCritical IS NOT NULL OR l.AqlMajor IS NOT NULL OR l.AqlMinor IS NOT NULL;

SELECT
  COUNT(1) AS LotsInspected,
  SUM(CASE WHEN QCStatus = 'Accepted' THEN 1 ELSE 0 END) AS LotsAccepted,
  SUM(CASE WHEN QCStatus = 'Rejected' THEN 1 ELSE 0 END) AS LotsRejected,
  SUM(CASE WHEN QCStatus = 'Pending' THEN 1 ELSE 0 END) AS PendingVerdicts,
  SUM(CASE WHEN QCStatus = 'In Progress' THEN 1 ELSE 0 END) AS InProgress,
  SUM(SampleSize) AS TotalSample,
  SUM(FoundTotal) AS TotalDefects,
  (SELECT COUNT(1) FROM #FgqcFirstPass) AS FirstPassLots,
  (SELECT ISNULL(SUM(FirstPassAccepted), 0) FROM #FgqcFirstPass) AS FirstPassAccepted,
  (SELECT COUNT(DISTINCT FinishGoodsQCInspectionMainID) FROM #FgqcSubmissions WHERE SubmissionNo > 1) AS LotsReinspected
FROM #FgqcLatest;

SELECT
  CASE WHEN @DaySpan <= 21 THEN InspectedDate
       ELSE DATEADD(day, -DATEPART(weekday, InspectedDate) + 1, InspectedDate) END AS PeriodStart,
  COUNT(1) AS LotsInspected,
  SUM(CASE WHEN QCStatus = 'Accepted' THEN 1 ELSE 0 END) AS LotsAccepted,
  SUM(CASE WHEN QCStatus = 'Rejected' THEN 1 ELSE 0 END) AS LotsRejected
FROM #FgqcLatest
GROUP BY
  CASE WHEN @DaySpan <= 21 THEN InspectedDate
       ELSE DATEADD(day, -DATEPART(weekday, InspectedDate) + 1, InspectedDate) END
ORDER BY PeriodStart;

SELECT TOP 20
  d.Characterstics,
  SUM(ISNULL(d.Critical, 0)) AS CriticalCount,
  SUM(ISNULL(d.Major, 0)) AS MajorCount,
  SUM(ISNULL(d.Minor, 0)) AS MinorCount,
  SUM(ISNULL(d.Critical, 0) + ISNULL(d.Major, 0) + ISNULL(d.Minor, 0)) AS TotalCount
FROM dbo.FinishGoodsQCInspectionDetail d
INNER JOIN #FgqcSubmissions s
  ON s.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
 AND s.CreatedDate = d.CreatedDate
 AND s.SubmissionNoDesc = 1
WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
GROUP BY d.Characterstics
HAVING SUM(ISNULL(d.Critical, 0) + ISNULL(d.Major, 0) + ISNULL(d.Minor, 0)) > 0
ORDER BY TotalCount DESC;

SELECT ProductionUnitID, COUNT(1) AS RejectionCount
FROM #FgqcLatest
WHERE QCStatus = 'Rejected'
GROUP BY ProductionUnitID
ORDER BY RejectionCount DESC;

SELECT
  SUM(CASE WHEN FoundCritical > ISNULL(AqlCritical, 0) THEN 1 ELSE 0 END) AS CriticalRejects,
  SUM(CASE WHEN FoundMajor > ISNULL(AqlMajor, FoundMajor) THEN 1 ELSE 0 END) AS MajorRejects,
  SUM(CASE WHEN FoundMinor > ISNULL(AqlMinor, FoundMinor) THEN 1 ELSE 0 END) AS MinorRejects
FROM #FgqcLatest
WHERE QCStatus = 'Rejected';

DROP TABLE #FgqcFirstPass;
DROP TABLE #FgqcLatest;
DROP TABLE #FgqcSubmissions;
DROP TABLE #FgqcLots;
`;

/**
 * Production units, with a fallback for databases where ProductionUnitMaster is
 * not present. Shared by the unit filter and by the dashboard, which needs the
 * names to label the rejections-by-unit chart — the spec asks for units, not
 * bare identifiers.
 */
async function fetchUnits(pool) {
	let rows = [];
	try {
		const result = await pool.request().query(`
			SELECT DISTINCT ProductionUnitID, ProductionUnitName
			FROM dbo.ProductionUnitMaster
			ORDER BY ProductionUnitName
		`);
		rows = result.recordset || [];
	} catch {
		const result = await pool.request().query(`
			SELECT DISTINCT ProductionUnitID
			FROM dbo.FinishGoodsTransactionMain
			WHERE ProductionUnitID IS NOT NULL
			  AND ISNULL(IsDeletedTransaction, 0) = 0
			ORDER BY ProductionUnitID
		`);
		rows = result.recordset || [];
	}
	return rows.map((row) => ({
		productionUnitId: asInt(pick(row, 'ProductionUnitID')),
		productionUnitName: asStr(pick(row, 'ProductionUnitName'))
			|| String(pick(row, 'ProductionUnitID') ?? '')
	})).filter((r) => r.productionUnitId != null);
}

/**
 * GET /api/qc/dashboard
 */
router.get('/qc/dashboard', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const companyId = companyIdOf(req);
	const from = ymd(queryVal(req, 'from', 'fromDate')) || ymd(new Date(Date.now() - 29 * 86400000));
	const to = ymd(queryVal(req, 'to', 'toDate')) || ymd(new Date());
	const unitId = asInt(queryVal(req, 'unitId', 'productionUnitId'));

	try {
		const pool = await getPool(db);
		const result = await execProcedure(
			pool,
			'GetFGQCDashboardKPIs',
			(request) => request
				.input('CompanyID', sql.BigInt, companyId)
				.input('FromDate', sql.Date, from)
				.input('ToDate', sql.Date, to)
				.input('UnitID', sql.BigInt, unitId),
			DASHBOARD_SQL
		);

		const sets = result.recordsets || [];
		const kpiRow = sets[0]?.[0] || {};
		const inspected = asInt(pick(kpiRow, 'LotsInspected')) || 0;
		const accepted = asInt(pick(kpiRow, 'LotsAccepted')) || 0;
		const rejected = asInt(pick(kpiRow, 'LotsRejected')) || 0;
		const pendingVerdicts = asInt(pick(kpiRow, 'PendingVerdicts')) || 0;
		const totalSample = asNum(pick(kpiRow, 'TotalSample')) || 0;
		const totalDefects = asNum(pick(kpiRow, 'TotalDefects')) || 0;
		const firstPassLots = asInt(pick(kpiRow, 'FirstPassLots')) || 0;
		const firstPassAccepted = asInt(pick(kpiRow, 'FirstPassAccepted')) || 0;
		const lotsReinspected = asInt(pick(kpiRow, 'LotsReinspected')) || 0;

		const acceptanceRate = inspected > 0 ? (accepted / inspected) * 100 : null;

		/*
		 * Spec section 7.4: do not average defect percentages across different
		 * sample sizes without weighting. SUM(defects) / SUM(sample) weights each
		 * lot by the cartons actually inspected, which a mean of per-lot
		 * percentages would not.
		 */
		const avgDefectPercent = totalSample > 0 ? (totalDefects / totalSample) * 100 : null;

		/*
		 * Spec section 7.4: first-pass acceptance has to come from the detail
		 * history, not the main row — the main row carries only the latest
		 * verdict, so a lot that failed and was reworked into an Accepted state
		 * would otherwise be indistinguishable from one that passed first time.
		 */
		const firstPassAcceptanceRate = firstPassLots > 0
			? (firstPassAccepted / firstPassLots) * 100
			: null;

		let awaiting = null;
		try {
			const pendingRes = await pool.request()
				.input('Search', sql.NVarChar(200), null)
				.input('FromGPNDate', sql.Date, DEFAULT_FROM_GPN_DATE)
				.input('ToGPNDate', sql.Date, todayYmd())
				.input('CompanyID', sql.BigInt, companyId)
				.input('ProductionUnitID', sql.BigInt, unitId)
				.input('IncludeClosed', sql.Bit, 0)
				.input('Page', sql.Int, 1)
				.input('PageSize', sql.Int, 1)
				.execute('GetPendingFGQCList');
			awaiting = parsePaged(pendingRes).total;
		} catch (pendingErr) {
			console.warn('[fg-qc] dashboard awaiting count failed:', pendingErr?.message);
		}

		let unitNames = new Map();
		try {
			unitNames = new Map((await fetchUnits(pool)).map((u) => [u.productionUnitId, u.productionUnitName]));
		} catch (unitErr) {
			console.warn('[fg-qc] dashboard unit names failed:', unitErr?.message);
		}

		const classRow = sets[4]?.[0] || {};

		return res.json({
			status: true,
			from,
			to,
			kpis: {
				lotsInspected: inspected,
				lotsAccepted: accepted,
				lotsRejected: rejected,
				pendingVerdicts,
				acceptanceRate,
				avgDefectPercent,
				awaitingInspection: awaiting,
				totalSample,
				totalDefects,
				firstPassLots,
				firstPassAccepted,
				firstPassAcceptanceRate,
				lotsReinspected,
				note: 'Acceptance rate uses the latest verdict per lot. First-pass acceptance comes from the earliest submission in the detail history.'
			},
			trend: (sets[1] || []).map((row) => ({
				periodStart: ymd(pick(row, 'PeriodStart')),
				lotsInspected: asInt(pick(row, 'LotsInspected')) || 0,
				lotsAccepted: asInt(pick(row, 'LotsAccepted')) || 0,
				lotsRejected: asInt(pick(row, 'LotsRejected')) || 0,
				acceptanceRate: (asInt(pick(row, 'LotsInspected')) || 0) > 0
					? ((asInt(pick(row, 'LotsAccepted')) || 0) / (asInt(pick(row, 'LotsInspected')) || 0)) * 100
					: null
			})),
			topDefects: (sets[2] || []).map((row) => ({
				characterstics: asStr(pick(row, 'Characterstics')),
				critical: asNum(pick(row, 'CriticalCount')) || 0,
				major: asNum(pick(row, 'MajorCount')) || 0,
				minor: asNum(pick(row, 'MinorCount')) || 0,
				total: asNum(pick(row, 'TotalCount')) || 0
			})),
			rejectionsByUnit: (sets[3] || []).map((row) => {
				const id = asInt(pick(row, 'ProductionUnitID'));
				return {
					productionUnitId: id,
					productionUnit: unitNames.get(id)
						|| (id == null ? 'Not recorded' : String(id)),
					rejectionCount: asInt(pick(row, 'RejectionCount')) || 0
				};
			}),
			rejectionsByClass: {
				critical: asInt(pick(classRow, 'CriticalRejects')) || 0,
				major: asInt(pick(classRow, 'MajorRejects')) || 0,
				minor: asInt(pick(classRow, 'MinorRejects')) || 0
			}
		});
	} catch (err) {
		console.error('[fg-qc] dashboard error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch dashboard'
		});
	}
});

/**
 * GET /api/qc/login?username=&database=
 * Same sign-in shape as Raw Material QC (username + KOL/AHM), resolved against UserMaster.
 */
router.get('/qc/login', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	const username = asStr(queryVal(req, 'username', 'userName', 'UserName'));
	if (!username) {
		return res.status(400).json({ status: false, error: 'Enter username' });
	}
	try {
		const pool = await getPool(db);
		const result = await pool.request()
			.input('UserName', sql.NVarChar(255), username)
			.query(`
				SELECT TOP 1 UserID, UserName
				FROM dbo.UserMaster
				WHERE LOWER(LTRIM(RTRIM(UserName))) = LOWER(LTRIM(RTRIM(@UserName)))
				ORDER BY UserID
			`);
		const row = result.recordset && result.recordset[0];
		if (!row) {
			return res.status(401).json({
				status: false,
				error: 'No user found with that name in ' + db
			});
		}
		return res.json({
			status: true,
			userId: asInt(pick(row, 'UserID')),
			userName: asStr(pick(row, 'UserName')) || username,
			database: db
		});
	} catch (err) {
		console.error('[fg-qc] login error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Login failed'
		});
	}
});

/**
 * GET /api/qc/inspectors
 */
router.get('/qc/inspectors', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	try {
		const pool = await getPool(db);
		const result = await pool.request().query(`
			SELECT TOP 2000 UserID, UserName
			FROM dbo.UserMaster
			ORDER BY UserName
		`);
		const rows = (result.recordset || []).map((row) => ({
			userId: asInt(pick(row, 'UserID')),
			userName: asStr(pick(row, 'UserName'))
		})).filter((r) => r.userId != null && r.userName);
		return res.json({ status: true, rows });
	} catch (err) {
		console.error('[fg-qc] inspectors error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch inspectors'
		});
	}
});

/**
 * GET /api/qc/units
 */
router.get('/qc/units', async (req, res) => {
	const db = requireDb(req, res);
	if (!db) return;
	try {
		const pool = await getPool(db);
		return res.json({ status: true, rows: await fetchUnits(pool) });
	} catch (err) {
		console.error('[fg-qc] units error:', err);
		return res.status(500).json({
			status: false,
			error: err?.message || 'Failed to fetch production units'
		});
	}
});

export default router;

/*
 * Exported for src/routes-fg-qc.test.js. These are the pure mapping helpers
 * that stand between the stored procedures and the inspector's screen — a
 * mistake in severityOf() files a Critical defect under the wrong accept
 * number, which is the failure mode spec section 3 exists to prevent, so it
 * is worth a test rather than a read-through.
 */
export { severityOf, mapTemplateItem, mapTemplate, mapAql, isMissingProcedure, isStaleProcedure, SEVERITY_UNCLASSIFIED };
