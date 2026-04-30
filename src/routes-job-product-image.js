/**
 * Job product image upload tool API
 * - GET  /job-product-image/lookup?database=KOL|AHM&jobBookingNo=... | jobBookingId=...
 * - GET  /job-product-image/search-job-numbers?database=KOL|AHM&jobNumberPart=...
 *       — dbo.contractor_search_jobnumbers (@JobNumberPart), min 3 chars
 * - GET  /job-product-image/pending-missing-images?database=KOL|AHM&fromDate=&toDate=&ledgerId=
 *       — dbo.report_orders_missing_product_image
 * - POST /job-product-image/upload — multipart: file, database, jobBookingId (or jobBookingNo)
 *
 * Upload: Cloudinary (CLOUDINARY_*) then UPDATE dbo.JobBookingJobCard.Jobcardproductimg = secure_url.
 * POST /job-product-image/delete — JSON: clear Jobcardproductimg; destroy Cloudinary asset when URL is ours.
 * Lookup imageUrl uses job-product-image-utils (supports bare filename + https URLs).
 */
import { Router } from 'express';
import multer from 'multer';
import sql from 'mssql';
import { v2 as cloudinary } from 'cloudinary';
import { getPool } from './db.js';
import {
	resolveProductImageUrl,
	DEFAULT_PRODUCT_IMAGE_BASE_URL,
	isLikelyCloudinaryDeliveryUrl,
	cloudinaryPublicIdFromDeliveryUrl
} from './job-product-image-utils.js';

const router = Router();

const DEFAULT_DATABASE = 'KOL';
const ALLOWED_DATABASES = ['KOL', 'AHM'];

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 12 * 1024 * 1024 },
	fileFilter: (req, file, cb) => {
		const type = (file.mimetype || '').toLowerCase();
		const looksLikeImage = type.startsWith('image/');
		const isUnknown = type === '' || type === 'application/octet-stream';
		if (looksLikeImage || isUnknown) return cb(null, true);
		cb(new Error('Only image files are allowed'), false);
	}
});

function getDbFromQuery(req) {
	const db = (req.query?.database || DEFAULT_DATABASE).toString().trim().toUpperCase();
	return ALLOWED_DATABASES.includes(db) ? db : null;
}

function parseQueryDate(value) {
	if (value == null || String(value).trim() === '') return null;
	const d = new Date(String(value).trim());
	if (Number.isNaN(d.getTime())) return null;
	return d;
}

function orderColumnsFromRows(rows) {
	if (!rows || !rows.length) return [];
	const order = Object.keys(rows[0]);
	const seen = new Set(order);
	for (const r of rows) {
		for (const k of Object.keys(r)) {
			if (!seen.has(k)) {
				seen.add(k);
				order.push(k);
			}
		}
	}
	return order;
}

function serializeRowForJson(row) {
	const o = {};
	for (const k of Object.keys(row)) {
		const v = row[k];
		if (v instanceof Date) {
			o[k] = v.toISOString();
		} else {
			o[k] = v;
		}
	}
	return o;
}

function getDbFromBody(req) {
	const db = (req.body?.database || DEFAULT_DATABASE).toString().trim().toUpperCase();
	return ALLOWED_DATABASES.includes(db) ? db : null;
}

function getImageBaseUrl() {
	const b = process.env.PRODUCT_IMAGE_BASE_URL;
	return (b && String(b).trim()) || DEFAULT_PRODUCT_IMAGE_BASE_URL;
}

function isCloudinaryConfigured() {
	return Boolean(
		process.env.CLOUDINARY_CLOUD_NAME &&
			process.env.CLOUDINARY_API_KEY &&
			process.env.CLOUDINARY_API_SECRET
	);
}

function ensureCloudinaryConfigured() {
	if (!isCloudinaryConfigured()) return false;
	cloudinary.config({
		cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
		api_key: process.env.CLOUDINARY_API_KEY,
		api_secret: process.env.CLOUDINARY_API_SECRET
	});
	return true;
}

function cloudinaryFolder() {
	const f = process.env.JOB_PRODUCT_IMAGE_CLOUDINARY_FOLDER;
	return (f && String(f).trim()) || 'job-product-images';
}

/**
 * Upload image buffer to Cloudinary; returns { secure_url, public_id }.
 */
function uploadImageBufferToCloudinary(buffer, { jobBookingId }) {
	const publicId = `jb-${jobBookingId}-${Date.now()}`;
	return new Promise((resolve, reject) => {
		const stream = cloudinary.uploader.upload_stream(
			{
				folder: cloudinaryFolder(),
				resource_type: 'image',
				public_id: publicId
			},
			(err, result) => {
				if (err) reject(err);
				else resolve(result);
			}
		);
		stream.end(buffer);
	});
}

function checkJobProductImageApiKey(req, res) {
	const secret = process.env.JOB_PRODUCT_IMAGE_API_KEY;
	if (!secret) return true;
	const got = req.headers['x-job-product-image-key'];
	if (got !== secret) {
		res.status(401).json({ error: 'Invalid or missing X-Job-Product-Image-Key header' });
		return false;
	}
	return true;
}

const LOOKUP_SELECT = `
SELECT TOP (1)
  JEJ.JobBookingID,
  JEJ.JobBookingNo,
  JEJ.JobName,
  JEJ.Jobcardproductimg AS jobCardProductImg,
  JOBD.ProductMasterCode AS productMasterCode,
  PM.ImgStringName AS productImgStringName,
  JOB.PONo AS poNo,
  LM.LedgerName AS clientName
FROM dbo.JobBookingJobCard JEJ
INNER JOIN dbo.JobOrderBookingDetails JOBD ON JOBD.OrderBookingDetailsID = JEJ.OrderBookingDetailsID
INNER JOIN dbo.JobOrderBooking JOB ON JOB.OrderBookingID = JOBD.OrderBookingID
LEFT JOIN dbo.ProductMaster PM ON PM.ProductMasterCode = JOBD.ProductMasterCode
  AND (PM.IsDeletedTransaction IS NULL OR PM.IsDeletedTransaction = 0)
LEFT JOIN dbo.LedgerMaster LM ON LM.LedgerID = JOB.LedgerID
WHERE ISNULL(JEJ.IsDeletedTransaction, 0) = 0
  AND ISNULL(JEJ.IsCancel, 0) = 0
  AND ISNULL(JOB.IsDeletedTransaction, 0) = 0
  AND ISNULL(JOBD.IsDeletedTransaction, 0) = 0
`;

async function fetchLookupRow(pool, { jobBookingId, jobBookingNo }) {
	const req = pool.request();
	let whereClause;
	if (jobBookingId != null && jobBookingId !== '') {
		const id = Number(jobBookingId);
		if (!Number.isInteger(id) || id <= 0) {
			throw Object.assign(new Error('jobBookingId must be a positive integer'), { statusCode: 400 });
		}
		req.input('JobBookingId', sql.Int, id);
		whereClause = 'JEJ.JobBookingID = @JobBookingId';
	} else if (jobBookingNo != null && String(jobBookingNo).trim() !== '') {
		req.input('JobBookingNo', sql.NVarChar(200), String(jobBookingNo).trim());
		whereClause = 'JEJ.JobBookingNo = @JobBookingNo';
	} else {
		return null;
	}
	const result = await req.query(`${LOOKUP_SELECT} AND ${whereClause}`);
	return result.recordset?.[0] ?? null;
}

function mapLookupResponse(row) {
	if (!row) return null;
	const baseUrl = getImageBaseUrl();
	const jobCardProductImg =
		row.jobCardProductImg != null
			? String(row.jobCardProductImg)
			: row.Jobcardproductimg != null
				? String(row.Jobcardproductimg)
				: '';
	const productImgStringName =
		row.productImgStringName != null
			? String(row.productImgStringName)
			: row.ImgStringName != null
				? String(row.ImgStringName)
				: '';
	const imageUrl = resolveProductImageUrl({
		jobCardProductImg,
		productImgStringName,
		baseUrl
	});
	const jobBookingId = row.JobBookingID ?? row.jobBookingId;
	const jobBookingNo = row.JobBookingNo ?? row.jobBookingNo ?? '';
	const jobName = row.JobName ?? row.jobName ?? '';
	const productMasterCode =
		row.productMasterCode != null
			? String(row.productMasterCode)
			: row.ProductMasterCode != null
				? String(row.ProductMasterCode)
				: '';
	const poNo = row.poNo != null ? String(row.poNo) : row.PONo != null ? String(row.PONo) : '';
	const clientName =
		row.clientName != null ? String(row.clientName) : row.ClientName != null ? String(row.ClientName) : '';
	return {
		jobBookingId,
		jobBookingNo: jobBookingNo != null ? String(jobBookingNo) : '',
		jobName: jobName != null ? String(jobName) : '',
		productMasterCode,
		poNo,
		clientName,
		jobCardProductImg,
		productImgStringName,
		imageUrl,
		imageBaseUrlUsed: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
	};
}

/**
 * GET /api/job-product-image/lookup?database=KOL&jobBookingNo=...
 */
router.get('/job-product-image/lookup', async (req, res) => {
	const database = getDbFromQuery(req);
	if (!database) {
		return res.status(400).json({ error: 'database must be KOL or AHM' });
	}
	const jobBookingId = req.query.jobBookingId ?? req.query.jobBookingID;
	const jobBookingNo = req.query.jobBookingNo ?? req.query.jobNumber;
	if ((!jobBookingId || String(jobBookingId).trim() === '') && (!jobBookingNo || String(jobBookingNo).trim() === '')) {
		return res.status(400).json({ error: 'Provide jobBookingId or jobBookingNo' });
	}
	try {
		const pool = await getPool(database);
		const row = await fetchLookupRow(pool, { jobBookingId, jobBookingNo });
		if (!row) {
			return res.status(404).json({ error: 'Job card not found for this database and key' });
		}
		return res.json(mapLookupResponse(row));
	} catch (err) {
		const code = err.statusCode || 500;
		console.error('[job-product-image] lookup failed:', err);
		return res.status(code).json({ error: err.message || 'Lookup failed' });
	}
});

function jobNumberFromContractorSearchRow(row) {
	if (!row || typeof row !== 'object') return null;
	const jobNum =
		row.JobNumber ??
		row.Job_Number ??
		row.jobNumber ??
		row.job_number ??
		row.JobNo ??
		row.Job_NO ??
		row.JobBookingNo ??
		row.jobBookingNo;
	if (jobNum != null && String(jobNum).trim() !== '') return String(jobNum).trim();
	const first = Object.values(row)[0];
	if (first != null && typeof first !== 'object' && String(first).trim() !== '') {
		return String(first).trim();
	}
	return null;
}

/**
 * GET /api/job-product-image/search-job-numbers?database=KOL&jobNumberPart=...
 * dbo.contractor_search_jobnumbers @JobNumberPart
 */
router.get('/job-product-image/search-job-numbers', async (req, res) => {
	const database = getDbFromQuery(req);
	if (!database) {
		return res.status(400).json({ error: 'database must be KOL or AHM' });
	}
	const part = (req.query.jobNumberPart ?? req.query.q ?? '').toString().trim();
	if (part.length < 3) {
		return res.status(400).json({ error: 'jobNumberPart must be at least 3 characters' });
	}
	if (part.length > 255) {
		return res.status(400).json({ error: 'jobNumberPart is too long' });
	}
	try {
		const pool = await getPool(database);
		const request = pool.request();
		request.input('JobNumberPart', sql.NVarChar(255), part);
		const result = await request.execute('dbo.contractor_search_jobnumbers');
		const rows = result.recordset || [];
		const jobNumbers = rows.map((row) => jobNumberFromContractorSearchRow(row)).filter(Boolean);
		const unique = [...new Set(jobNumbers)];
		return res.json({ database, jobNumbers: unique });
	} catch (err) {
		const msg = err?.message || String(err);
		const num = err?.number ?? err?.originalError?.info?.number;
		console.error('[job-product-image] search-job-numbers failed:', err);
		if (num === 2812 || msg.toLowerCase().includes('could not find stored procedure')) {
			return res.status(502).json({
				error: 'Stored procedure dbo.contractor_search_jobnumbers was not found on this database.'
			});
		}
		return res.status(500).json({ error: msg });
	}
});

/**
 * GET /api/job-product-image/pending-missing-images?database=KOL&fromDate=&toDate=&ledgerId=
 * Executes dbo.report_orders_missing_product_image (@FromDate, @ToDate, @LedgerId).
 */
router.get('/job-product-image/pending-missing-images', async (req, res) => {
	if (!checkJobProductImageApiKey(req, res)) return;

	const database = getDbFromQuery(req);
	if (!database) {
		return res.status(400).json({ error: 'database must be KOL or AHM' });
	}

	const fromDate = parseQueryDate(req.query.fromDate);
	const toDate = parseQueryDate(req.query.toDate);
	let ledgerId = null;
	const ledgerRaw = req.query.ledgerId;
	if (ledgerRaw != null && String(ledgerRaw).trim() !== '') {
		const n = parseInt(String(ledgerRaw), 10);
		if (!Number.isNaN(n)) ledgerId = n;
	}

	try {
		const pool = await getPool(database);
		const request = pool.request();
		request.input('FromDate', sql.Date, fromDate);
		request.input('ToDate', sql.Date, toDate);
		request.input('LedgerId', sql.Int, ledgerId);

		const result = await request.execute('dbo.report_orders_missing_product_image');
		const rawRows = result.recordset || [];
		const rows = rawRows.map((r) => serializeRowForJson(r));
		const columns = orderColumnsFromRows(rows);

		return res.json({
			database,
			count: rows.length,
			columns,
			rows
		});
	} catch (err) {
		const msg = err?.message || String(err);
		const num = err?.number ?? err?.originalError?.info?.number;
		console.error('[job-product-image] pending-missing-images failed:', err);
		if (num === 2812 || msg.toLowerCase().includes('could not find stored procedure')) {
			return res.status(502).json({
				error: 'Stored procedure dbo.report_orders_missing_product_image was not found on this database.'
			});
		}
		return res.status(500).json({ error: msg });
	}
});

/**
 * POST /api/job-product-image/upload
 */
router.post(
	'/job-product-image/upload',
	(req, res, next) => {
		upload.single('file')(req, res, (err) => {
			if (err) {
				return res.status(400).json({ error: err.message || 'Invalid file upload' });
			}
			next();
		});
	},
	async (req, res) => {
		if (!checkJobProductImageApiKey(req, res)) return;

		const database = getDbFromBody(req);
		if (!database) {
			return res.status(400).json({ error: 'database must be KOL or AHM' });
		}

		if (!ensureCloudinaryConfigured()) {
			return res.status(503).json({
				error:
					'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
			});
		}

		const file = req.file;
		if (!file || !file.buffer) {
			return res.status(400).json({ error: 'Image file is required (field name: file)' });
		}

		let jobBookingId = req.body.jobBookingId ?? req.body.jobBookingID;
		const jobBookingNo = req.body.jobBookingNo;

		try {
			const pool = await getPool(database);

			if (jobBookingId == null || String(jobBookingId).trim() === '') {
				if (!jobBookingNo || String(jobBookingNo).trim() === '') {
					return res.status(400).json({ error: 'Provide jobBookingId or jobBookingNo' });
				}
				const row = await fetchLookupRow(pool, { jobBookingNo });
				if (!row) {
					return res.status(404).json({ error: 'Job card not found for jobBookingNo' });
				}
				jobBookingId = row.JobBookingID;
			}

			const idNum = Number(jobBookingId);
			if (!Number.isInteger(idNum) || idNum <= 0) {
				return res.status(400).json({ error: 'jobBookingId must be a positive integer' });
			}

			const uploadResult = await uploadImageBufferToCloudinary(file.buffer, {
				jobBookingId: idNum
			});
			const secureUrl = uploadResult?.secure_url;
			if (!secureUrl || typeof secureUrl !== 'string') {
				return res.status(502).json({ error: 'Cloudinary upload did not return a URL' });
			}

			const upd = pool.request();
			upd.input('JobBookingId', sql.Int, idNum);
			upd.input('ImageUrl', sql.NVarChar(sql.MAX), secureUrl);
			const updateResult = await upd.query(`
				UPDATE dbo.JobBookingJobCard
				SET Jobcardproductimg = @ImageUrl
				WHERE JobBookingID = @JobBookingId
				  AND ISNULL(IsDeletedTransaction, 0) = 0
				  AND ISNULL(IsCancel, 0) = 0
			`);

			const ra = updateResult?.rowsAffected;
			const affected = Array.isArray(ra) ? Number(ra[0]) || 0 : Number(ra) || 0;
			if (affected === 0) {
				return res.status(409).json({
					error:
						'No row updated (job missing, deleted, or cancelled). Cloudinary object was created; remove it manually if needed.',
					cloudinaryPublicId: uploadResult.public_id,
					cloudinaryUrl: secureUrl
				});
			}

			const refreshed = await fetchLookupRow(pool, { jobBookingId: idNum });
			if (!refreshed) {
				return res.status(500).json({ error: 'Update ran but job row could not be re-read' });
			}
			const payload = mapLookupResponse(refreshed);
			return res.json({
				success: true,
				storage: 'cloudinary',
				cloudinaryUrl: secureUrl,
				cloudinaryPublicId: uploadResult.public_id || '',
				...payload
			});
		} catch (err) {
			const msg =
				err?.originalError?.info?.message ||
				err?.precedingErrors?.[0]?.message ||
				err?.message ||
				'Upload failed';
			console.error('[job-product-image] upload failed:', err);
			return res.status(500).json({ error: msg });
		}
	}
);

/**
 * POST /api/job-product-image/delete
 * Body JSON: { database, jobBookingId } or { database, jobBookingNo }
 * Clears JobBookingJobCard.Jobcardproductimg; if value was a Cloudinary delivery URL, destroys that asset.
 */
router.post('/job-product-image/delete', async (req, res) => {
	if (!checkJobProductImageApiKey(req, res)) return;

	const database = getDbFromBody(req);
	if (!database) {
		return res.status(400).json({ error: 'database must be KOL or AHM' });
	}

	let jobBookingId = req.body?.jobBookingId ?? req.body?.jobBookingID;
	const jobBookingNo = req.body?.jobBookingNo;

	try {
		const pool = await getPool(database);

		if (jobBookingId == null || String(jobBookingId).trim() === '') {
			if (!jobBookingNo || String(jobBookingNo).trim() === '') {
				return res.status(400).json({ error: 'Provide jobBookingId or jobBookingNo' });
			}
			const row = await fetchLookupRow(pool, { jobBookingNo });
			if (!row) {
				return res.status(404).json({ error: 'Job card not found for jobBookingNo' });
			}
			jobBookingId = row.JobBookingID;
		}

		const idNum = Number(jobBookingId);
		if (!Number.isInteger(idNum) || idNum <= 0) {
			return res.status(400).json({ error: 'jobBookingId must be a positive integer' });
		}

		const before = await fetchLookupRow(pool, { jobBookingId: idNum });
		if (!before) {
			return res.status(404).json({ error: 'Job card not found' });
		}

		const rawJobImg =
			before.jobCardProductImg != null
				? String(before.jobCardProductImg).trim()
				: before.Jobcardproductimg != null
					? String(before.Jobcardproductimg).trim()
					: '';

		if (!rawJobImg) {
			return res.status(400).json({ error: 'No job-card image stored (Jobcardproductimg is already empty)' });
		}

		let cloudinaryDestroyed = false;
		let cloudinaryPublicId = null;
		let cloudinaryDestroyResult = null;

		if (isLikelyCloudinaryDeliveryUrl(rawJobImg)) {
			if (!ensureCloudinaryConfigured()) {
				return res.status(503).json({
					error:
						'Cloudinary is not configured; cannot delete a Cloudinary-hosted image. Set CLOUDINARY_* env vars.'
				});
			}
			cloudinaryPublicId = cloudinaryPublicIdFromDeliveryUrl(rawJobImg);
			if (!cloudinaryPublicId) {
				return res.status(400).json({ error: 'Could not parse Cloudinary public_id from stored URL' });
			}
			try {
				cloudinaryDestroyResult = await cloudinary.uploader.destroy(cloudinaryPublicId, {
					resource_type: 'image',
					invalidate: true
				});
				cloudinaryDestroyed =
					cloudinaryDestroyResult?.result === 'ok' || cloudinaryDestroyResult?.result === 'not found';
			} catch (destroyErr) {
				console.error('[job-product-image] Cloudinary destroy failed:', destroyErr);
				return res.status(502).json({
					error: destroyErr?.message || 'Cloudinary delete failed; database not changed',
					cloudinaryPublicId
				});
			}
		}

		const upd = pool.request();
		upd.input('JobBookingId', sql.Int, idNum);
		const updateResult = await upd.query(`
			UPDATE dbo.JobBookingJobCard
			SET Jobcardproductimg = NULL
			WHERE JobBookingID = @JobBookingId
			  AND ISNULL(IsDeletedTransaction, 0) = 0
			  AND ISNULL(IsCancel, 0) = 0
		`);

		const ra = updateResult?.rowsAffected;
		const affected = Array.isArray(ra) ? Number(ra[0]) || 0 : Number(ra) || 0;
		if (affected === 0) {
			return res.status(409).json({ error: 'No row updated (job missing, deleted, or cancelled)' });
		}

		const refreshed = await fetchLookupRow(pool, { jobBookingId: idNum });
		const payload = refreshed ? mapLookupResponse(refreshed) : null;

		return res.json({
			success: true,
			removedJobCardImage: true,
			previousJobCardProductImg: rawJobImg,
			cloudinaryDestroyed,
			cloudinaryPublicId: cloudinaryPublicId || undefined,
			cloudinaryDestroyResult: cloudinaryDestroyResult?.result || undefined,
			...(payload || {})
		});
	} catch (err) {
		console.error('[job-product-image] delete failed:', err);
		return res.status(500).json({ error: err?.message || 'Delete failed' });
	}
});

export default router;
