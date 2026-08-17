import { Router } from 'express';
import axios from "axios";
import nodemailer from "nodemailer";
import { getPool, getLongQueryPool, sql } from './db.js';
import multer from 'multer';
import QrCode from 'qrcode-reader';
import * as jimp from 'jimp';
const { Jimp } = jimp;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';
import {
    generateDispatchNotePdf,
    normalizeDispatchHeader,
    normalizeDispatchLine
} from './lib/dispatch-note-pdf.js';
import { v2 as cloudinary } from 'cloudinary';
import { isR2Enabled } from './lib/media-url.js';
import User from './models/User.js';
import getVoiceNoteModel from './models/VoiceNote.js';
import getAudioModel from './models/Audio.js';
import getVoiceNoteUserModel from './models/VoiceNoteUser.js';
import getPrepressFMSModel from './models/PrepressFMS.js';
// Contractor PO System imports
import Contractor from './models/Contractor.js';
import Operation from './models/Operation.js';
import Job from './models/Job.js';
import JobOperation from './models/JobOperation.js';
import JobOpsMaster from './models/JobOpsMaster.js';
import ContractorWD from './models/ContractorWD.js';
import Bill from './models/Bill.js';
import Series from './models/Series.js';
import AdhocWorkOrder from './models/AdhocWorkOrder.js';
import * as XLSX from 'xlsx';


const router = Router();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Cloudinary
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  console.log('✅ Cloudinary configured successfully');
} else {
  console.warn('⚠️ Cloudinary credentials not found. Audio URLs will not be stored.');
}

// Test route to verify routes are loading
router.get('/test-route', (req, res) => {
  res.json({ message: 'Routes are working!', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Voice note audio delivery
// ---------------------------------------------------------------------------
//
// Audio never needed to leave this app. `audioBlob` is a REQUIRED field on
// every recording, so MongoDB already holds the authoritative bytes and the
// Cloudinary copy was pure redundancy. Serving from Mongo therefore removes
// the Cloudinary dependency for voice notes with no data migration and no
// change to the shared r2-storage module (whose allowed content types are
// images and PDFs only — audio was never uploadable there).

/** Playable URL for a recording, gated by the same flag as everything else. */
function resolveAudioUrl(recording) {
  if (!recording) return '';
  if (!isR2Enabled()) return recording.cloudinaryUrl || '';
  const base = (process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!recording.audioId) return recording.cloudinaryUrl || '';
  const stream = `/api/audio/${encodeURIComponent(recording.audioId)}/stream`;
  return base ? `${base}${stream}` : stream;
}

// GET /audio/:audioId/stream — stream a recording straight from MongoDB.
router.get('/audio/:audioId/stream', async (req, res) => {
  try {
    const Audio = await getAudioModel();
    const audioId = String(req.params.audioId || '');
    const doc = await Audio.findOne(
      { 'recordings.audioId': audioId },
      { 'recordings.$': 1 },
    ).lean();
    const rec = doc?.recordings?.[0];
    if (!rec?.audioBlob) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    const buf = Buffer.isBuffer(rec.audioBlob) ? rec.audioBlob : Buffer.from(rec.audioBlob.buffer || rec.audioBlob);
    res.setHeader('Content-Type', rec.audioMimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    // Immutable content, but keep it private — voice notes are internal.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'none');
    return res.send(buf);
  } catch (err) {
    console.error('[audio] stream failed:', err?.message);
    return res.status(500).json({ error: 'Could not stream recording' });
  }
});

// Test Cloudinary configuration
router.get('/test-cloudinary', (req, res) => {
  const hasCloudName = !!process.env.CLOUDINARY_CLOUD_NAME;
  const hasApiKey = !!process.env.CLOUDINARY_API_KEY;
  const hasApiSecret = !!process.env.CLOUDINARY_API_SECRET;
  
  res.json({
    cloudinaryConfigured: hasCloudName && hasApiKey && hasApiSecret,
    cloudName: hasCloudName ? 'Set ✓' : 'Missing ✗',
    apiKey: hasApiKey ? 'Set ✓' : 'Missing ✗',
    apiSecret: hasApiSecret ? 'Set ✓' : 'Missing ✗',
    cloudinaryInstance: typeof cloudinary !== 'undefined' ? 'Available ✓' : 'Not available ✗'
  });
});

// Debug route to list all registered routes
router.get('/debug-routes', (req, res) => {
  const routes = [];
  router.stack.forEach((middleware) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
      routes.push({
        method: methods,
        path: middleware.route.path
      });
    }
  });
  res.json({ routes: routes.filter(r => r.path.includes('jobs')) });
});

// ============================================
// In-Memory Job Processing System
// ============================================

// In-memory job storage
const jobs = new Map();
let jobIdCounter = Date.now();

// Helper to generate unique job ID
function generateJobId() {
  return `job_${jobIdCounter++}_${Math.random().toString(36).substr(2, 9)}`;
}

function normalizeINPhone(mobile) {
    const raw = String(mobile || "").replace(/[^\d]/g, "");
    if (!raw) return null;
    if (raw.startsWith("91") && raw.length === 12) return `+${raw}`;
    if (raw.length === 10) return `+91${raw}`;
    if (raw.length >= 11) return `+${raw}`;
    return null;
  }
  
  function splitCsv(str) {
    return String(str || "").split(",").map(s => s.trim()).filter(Boolean);
  }
  
  function fmtDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("en-GB");
  }
  
  function buildOrderLines(rows) {
    return rows.map(r => {
      return [
        `• Item: ${r["Job Name"]}`,
        `  Qty: ${r["Order Qty"]}`,
        `  Job No: ${r["Job Card No"] || ""}`,
        `  Committed Delivery: ${fmtDate(r["Final Delivery Date"])}`
      ].join("\n");
    }).join("\n\n");
  }

async function sendWhatsAppMaytapi({ productId, phoneId, apiKey, toNumber, text }) {
  const url = `https://api.maytapi.com/api/${productId}/${phoneId}/sendMessage`;
  const payload = { to_number: toNumber, type: "text", message: text };

  console.log("message", payload.message);

  console.log('[WHATSAPP] Sending message:', {
    url,
    toNumber,
    productId,
    phoneId,
    apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : 'MISSING',
    textPreview: text ? text.substring(0, 50) + '...' : 'EMPTY'
  });

  try {
    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-maytapi-key": apiKey
      },
      timeout: 20000
    });

    console.log('[WHATSAPP] Response:', {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    });

    return response;
  } catch (err) {
    console.error('[WHATSAPP] Request failed:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message
    });
    throw err;
  }
}

async function sendEmailSMTP({ creds, to, subject, text }) {
  const port = Number(creds.SMTPServerPort);
  const transporter = nodemailer.createTransport({
    host: creds.SMTPServer,
    port: port,
    secure: port === 465,  // Only use secure for port 465
    auth: creds.SMTPAuthenticate
      ? { user: creds.SMTPUserName, pass: creds.SMTPUserPassword }
      : undefined,
    tls: {
      rejectUnauthorized: false  // Allow self-signed certs
    }
  });

  const fromEmail = creds.EmailID || creds.SMTPUserName;

  return transporter.sendMail({
    from: fromEmail,
    to,
    subject,
    text
  });
}

// ============================================
// Customer Portal helpers (used by WhatsApp / email templates)
// ----------------------------------------------------------------
// 1) getCompanyCodeByEmail(pool, email)
//    Looks up ConcernPersonMaster.Email -> LedgerID -> LedgerMaster.LedgerCodeString
// 2) isEmailRegisteredInPortal(email)
//    Looks up tenants collection in MongoDB (DB: customer_portal) for { email }
// 3) buildPortalAppend({ pool, customerEmail })
//    Returns the "🔗 Track your orders online" block (Scenario 1 / 2 / 3)
//    that gets appended to the WhatsApp and email bodies of the three
//    intimation templates.
// ============================================

let portalMongoConnPromise = null;

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getPortalMongoConnection() {
  if (portalMongoConnPromise) return portalMongoConnPromise;

  const rawUri = process.env.mongodb_uri_concern || process.env.MONGODB_URI_CONCERN || '';
  const rawDb  = process.env.mongo_db_concern  || process.env.MONGO_DB_CONCERN  || '';
  const uri    = String(rawUri).trim().replace(/^['"]|['"]$/g, '');
  const dbName = String(rawDb).trim().replace(/^['"]|['"]$/g, '');

  if (!uri || !dbName) {
    throw new Error('Portal MongoDB config missing (mongodb_uri_concern / mongo_db_concern)');
  }

  portalMongoConnPromise = mongoose
    .createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 })
    .asPromise()
    .then((conn) => {
      console.log('[PORTAL-MONGO] Connected', { dbName: conn?.name || dbName, readyState: conn?.readyState });
      return conn;
    })
    .catch((err) => {
      console.error('[PORTAL-MONGO] Connect failed', err?.message || err);
      portalMongoConnPromise = null;
      throw err;
    });

  return portalMongoConnPromise;
}

async function isEmailRegisteredInPortal(email) {
  if (!email) return false;
  try {
    const conn = await getPortalMongoConnection();
    const pattern = new RegExp(`^${escapeRegexLiteral(String(email).trim())}$`, 'i');
    const doc = await conn.collection('tenants').findOne(
      { email: pattern },
      { projection: { _id: 1 } }
    );
    return !!doc;
  } catch (err) {
    console.error('[PORTAL-REG-CHECK] Lookup failed for', email, '-', err?.message || err);
    return false;
  }
}

async function getCompanyCodeByEmail(pool, email) {
  if (!email) return null;
  try {
    const result = await pool.request()
      .input('Email', sql.NVarChar(255), String(email).trim())
      .query(`
        SELECT TOP 1 lm.LedgerCodeString
        FROM ConcernPersonMaster cpm
        INNER JOIN LedgerMaster lm ON lm.LedgerID = cpm.LedgerID
        WHERE cpm.Email = @Email
          AND ISNULL(cpm.IsDeleted, 0) = 0
          AND ISNULL(cpm.IsDeletedTransaction, 0) = 0
          AND ISNULL(lm.IsDeleted, 0) = 0
      `);
    return result.recordset?.[0]?.LedgerCodeString || null;
  } catch (err) {
    console.error('[PORTAL-COMPANY-CODE] Lookup failed for', email, '-', err?.message || err);
    return null;
  }
}

/**
 * Build the portal-tracking block to append at the end of WhatsApp /
 * email templates. Picks one of three scenarios based on whether the
 * customer email is present and whether it's already registered.
 */
async function buildPortalAppend({ pool, customerEmail }) {
  let scenarioText;
  let scenarioId;

  if (!customerEmail) {
    scenarioId = 1;
    scenarioText =
      "We'd love to give you access to our customer portal, where you can see real-time status on all your orders plus your complete order history. Please share your email ID so we can register you.";
  } else {
    const registered = await isEmailRegisteredInPortal(customerEmail);

    if (registered) {
      scenarioId = 3;
      scenarioText =
`Track all your orders in real time on our customer portal, along with your full order history.

log in at: https://crm.cdcprinters.com
using your mail id: ${customerEmail}`;
    } else {
      scenarioId = 2;
      // companyCode placeholder fallback if no ConcernPersonMaster match
      const companyCode = (await getCompanyCodeByEmail(pool, customerEmail)) || '';
      scenarioText =
`You can now track all your orders in real time on our customer portal, along with your full order history. To get started:

log in at: https://crm.cdcprinters.com
using your mail id: ${customerEmail}
and company code: ${companyCode}`;
    }
  }

  console.log('[PORTAL] Append built', { scenarioId, customerEmail: customerEmail || null });

  return `\n\n—\n\n🔗 Track your orders online\n${scenarioText}`;
}

// Background worker function
async function processJobInBackground(jobId, jobType, requestData, database) {
  try {
    console.log(`[JOB ${jobId}] Starting ${jobType} operation`);
    
    // Update job status to processing
    if (jobs.has(jobId)) {
      jobs.get(jobId).status = 'processing';
      jobs.get(jobId).startedAt = new Date();
    }

    const pool = await getPool(database);
    const request = pool.request();
    request.timeout = 180000; // 3 minutes

    let result;
    let productionId;
    
    // Execute based on job type
    if (jobType === 'start') {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[JOB ${jobId}] CALLING START PROCEDURE`);
      console.log(`Procedure: dbo.Production_Start_Manu_v2`);
      console.log(`Parameters:`);
      console.log(`  - UserID: ${requestData.UserID} (${typeof requestData.UserID})`);
      console.log(`  - EmployeeID: ${requestData.EmployeeID} (${typeof requestData.EmployeeID})`);
      console.log(`  - ProcessID: ${requestData.ProcessID} (${typeof requestData.ProcessID})`);
      console.log(`  - JobBookingJobCardContentsID: ${requestData.JobBookingJobCardContentsID} (${typeof requestData.JobBookingJobCardContentsID})`);
      console.log(`  - MachineID: ${requestData.MachineID} (${typeof requestData.MachineID})`);
      console.log(`  - JobCardFormNo: ${requestData.JobCardFormNo} (${typeof requestData.JobCardFormNo})`);
      console.log(`Database: ${database}`);
      console.log(`${'='.repeat(80)}\n`);
      
      result = await request
        .input('UserID', sql.Int, requestData.UserID)
        .input('EmployeeID', sql.Int, requestData.EmployeeID)
        .input('ProcessID', sql.Int, requestData.ProcessID)
        .input('JobBookingJobCardContentsID', sql.Int, requestData.JobBookingJobCardContentsID)
        .input('MachineID', sql.Int, requestData.MachineID)
        .input('JobCardFormNo', sql.NVarChar(255), requestData.JobCardFormNo)
        .execute('dbo.Production_Start_Manu_v2');
      
      // Extract ProductionID from the result
      if (result.recordset && result.recordset.length > 0 && result.recordset[0].ProductionID) {
        productionId = result.recordset[0].ProductionID;
        console.log(`[JOB ${jobId}] ✅ ProductionID returned: ${productionId}`);
      }
    } 
    else if (jobType === 'complete') {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[JOB ${jobId}] CALLING COMPLETE PROCEDURE`);
      console.log(`Procedure: dbo.Production_End_Manu_v2`);
      console.log(`Parameters:`);
      console.log(`  - UserID: ${requestData.UserID} (${typeof requestData.UserID})`);
      console.log(`  - ProductionID: ${requestData.ProductionID} (${typeof requestData.ProductionID})`);
      console.log(`  - ProductionQty: ${requestData.ProductionQty} (${typeof requestData.ProductionQty})`);
      console.log(`  - WastageQty: ${requestData.WastageQty} (${typeof requestData.WastageQty})`);
      console.log(`Database: ${database}`);
      console.log(`${'='.repeat(80)}\n`);
      
      result = await request
        .input('UserID', sql.Int, requestData.UserID)
        .input('ProductionID', sql.Int, requestData.ProductionID)
        .input('ProductionQty', sql.Int, requestData.ProductionQty)
        .input('WastageQty', sql.Int, requestData.WastageQty)
        .execute('dbo.Production_End_Manu_v2');
    }
    else if (jobType === 'cancel') {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[JOB ${jobId}] CALLING CANCEL PROCEDURE`);
      console.log(`Procedure: dbo.Production_Cancel_Manu_v2`);
      console.log(`Parameters:`);
      console.log(`  - UserID: ${requestData.UserID} (${typeof requestData.UserID})`);
      console.log(`  - ProductionID: ${requestData.ProductionID} (${typeof requestData.ProductionID})`);
      console.log(`Database: ${database}`);
      console.log(`${'='.repeat(80)}\n`);
      
      result = await request
        .input('UserID', sql.Int, requestData.UserID)
        .input('ProductionID', sql.Int, requestData.ProductionID)
        .execute('dbo.Production_Cancel_Manu_v2');
    }

    console.log(`[JOB ${jobId}] ✅ ${jobType} operation completed successfully`);

    // Check for status warnings
    const statusWarning = _checkStatusOnlyResponse(result.recordset);

    // Update job as completed
    if (jobs.has(jobId)) {
      jobs.get(jobId).status = 'completed';
      jobs.get(jobId).result = result.recordset || [];
      jobs.get(jobId).productionId = productionId; // Store ProductionID for start jobs
      jobs.get(jobId).statusWarning = statusWarning;
      jobs.get(jobId).completedAt = new Date();
    }

    // Auto-delete job after 5 minutes to prevent memory leaks
    setTimeout(() => {
      if (jobs.has(jobId)) {
        console.log(`[JOB ${jobId}] Auto-deleting completed job`);
        jobs.delete(jobId);
      }
    }, 300000);

  } catch (error) {
    console.error(`[JOB ${jobId}] Failed:`, error);
    
    // Update job as failed
    if (jobs.has(jobId)) {
      jobs.get(jobId).status = 'failed';
      jobs.get(jobId).error = error.message;
      jobs.get(jobId).completedAt = new Date();
    }

    // Auto-delete failed job after 5 minutes
    setTimeout(() => {
      if (jobs.has(jobId)) {
        console.log(`[JOB ${jobId}] Auto-deleting failed job`);
        jobs.delete(jobId);
      }
    }, 300000);
  }
}

// ============================================
// End of Job Processing System
// ============================================

// Configure multer for file uploads
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 5 * 1024 * 1024, // 5MB limit
	},
	fileFilter: (req, file, cb) => {
		try {
			// Some Android pickers/cameras send "application/octet-stream" or omit mimetype.
			// Allow clear image mimetypes or unknown types and let Jimp validate later.
			const type = (file.mimetype || '').toLowerCase();
			const looksLikeImage = type.startsWith('image/');
			const isUnknown = type === '' || type === 'application/octet-stream';
			if (looksLikeImage || isUnknown) {
				return cb(null, true);
			}
			return cb(new Error('Only image files are allowed'), false);
		} catch (e) {
			return cb(new Error('Only image files are allowed'), false);
		}
	}
});

// ---- Simple file logger for QR endpoints ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, '..', 'logs');
const qrLogFile = path.join(logsDir, 'qr.log');
const processStartLogFile = path.join(logsDir, 'process-start.log');
const authLogFile = path.join(logsDir, 'auth.log');

let _logsDirReady = false;
function ensureLogsDir() {
	if (_logsDirReady) return;
	try {
		if (!fs.existsSync(logsDir)) {
			fs.mkdirSync(logsDir, { recursive: true });
		}
		_logsDirReady = true;
	} catch (e) {
		console.error('Failed to create logs directory:', e);
	}
}

function logQr(message, extra = {}) {
	try {
		ensureLogsDir();
		const entry = { ts: new Date().toISOString(), message, ...extra };
		fs.appendFile(qrLogFile, JSON.stringify(entry) + '\n', () => {});
	} catch (e) {
		console.error('Failed to write QR log entry:', e);
	}
}

function logProcessStart(message, extra = {}) {
	try {
		ensureLogsDir();
		const entry = { ts: new Date().toISOString(), message, ...extra };
		fs.appendFile(processStartLogFile, JSON.stringify(entry) + '\n', () => {});
	} catch (e) {
		console.error('Failed to write process-start log entry:', e);
	}
}

function logAuth(message, extra = {}) {
	try {
		ensureLogsDir();
		const entry = { ts: new Date().toISOString(), message, ...extra };
		fs.appendFile(authLogFile, JSON.stringify(entry) + '\n', () => {});
	} catch (e) {
		console.error('Failed to write auth log entry:', e);
	}
}

// Helper function to check if result contains only Status column




/* ---- Build readiness order lines (each order may have its own cartons/qty/date) ---- */
function buildReadinessLines(rows, readinessByObdId) {
  return rows.map(r => {
    const id = Number(r.OrderBookingDetailsID);
    const rd = readinessByObdId.get(id); // must exist

    return [
      `• Item: ${r["JobName"] || ""}`,
      `  Qty: ${r["Order Qty"]}`,
      `  Job No: ${r["JobCard Num"] || ""}`,
      `  Ready Date: ${fmtDate(rd.readyForDispatchDate)}`,
      `  Cartons: ${rd.noOfCarton}`,
      `  Qty/Carton: ${rd.qtyPerCarton}`
    ].join("\n");
  }).join("\n\n");
}


function _checkStatusOnlyResponse(recordset) {
    if (!Array.isArray(recordset) || recordset.length === 0) {
        return null;
    }
    
    const firstRow = recordset[0];
    const columns = Object.keys(firstRow);
    
    // Check if there's only one column and it's named "Status" (case insensitive)
    if (columns.length === 1) {
        const columnName = columns[0];
        if (columnName.toLowerCase() === 'status') {
            return {
                message: `Status: ${firstRow[columnName]}`,
                statusValue: firstRow[columnName]
            };
        }
    }
    
    return null;
}


router.post("/comm/first-intimation/send", async (req, res) => {
    try {
      const { username, orderBookingDetailsIds } = req.body || {};
  
      if (!username || !Array.isArray(orderBookingDetailsIds) || orderBookingDetailsIds.length === 0) {
        return res.status(400).json({ ok: false, message: "username and orderBookingDetailsIds[] required" });
      }
  
      const pool = await getPool('KOL');
  
      // 1) get credentials
      const credReq = pool.request();
      credReq.input("Username", sql.NVarChar(100), username);
      const credRes = await credReq.execute("dbo.comm_get_user_credentials");
  
      const creds = credRes.recordset?.[0];
      if (!creds) {
        return res.status(400).json({ ok: false, message: "Credentials not found" });
      }
  
      const senderName = username;
      const senderPhone = creds.ContactNo || "";
  
      // 2) TVP
      const tvp = new sql.Table("dbo.IdList");
      tvp.columns.add("Id", sql.Int, { nullable: false });
      orderBookingDetailsIds.forEach(id => tvp.rows.add(Number(id)));
  
      // 3) fetch pending details
      const detReq = pool.request();
      detReq.input("Ids", tvp);
      const detRes = await detReq.execute("dbo.comm_first_intimation_details_by_ids");
      console.log(detRes,'----------------------------------detRes');
  
      const rows = detRes.recordset || [];
      if (!rows.length) {
        return res.json({ ok: true, message: "No pending items found." });
      }
  
      // 4) group by client
      const byClient = new Map();
      for (const r of rows) {
        if (!byClient.has(r.ClientLedgerID)) byClient.set(r.ClientLedgerID, []);
        byClient.get(r.ClientLedgerID).push(r);
      }
  
      const results = [];
  
      for (const [ledgerId, clientRows] of byClient.entries()) {
        const clientName = clientRows[0]["Client Name"];
        const contactName =
          (clientRows[0]["Contact Person"] || "").split(",")[0] || clientName;
  
        const orderLines = buildOrderLines(clientRows);
  
        let whatsappText =
  `Dear ${contactName},
  
Warm greetings from CDC Printers Pvt Ltd 😊
  
Your order(s) have been planned in our system. Details below:
  
  ${orderLines}
  
—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;
  
        const emailSubject = `Order Planned & Delivery Commitment | ${clientName}`;
        let emailBody =
  `Dear ${contactName},
  
  Warm greetings from CDC Printers Pvt Ltd.
  
  Your order(s) have been planned in our system. Details below:
  
  ${orderLines}
  
  Regards,
  ${senderName}
  Customer Relationship Manager
  CDC Printers Pvt Ltd
  ${senderPhone}`;
  
        const emailList = splitCsv(clientRows[0]["Concern Email"]);
        const mobileList = splitCsv(clientRows[0]["Concern Mobile No"])
          .map(normalizeINPhone)
          .filter(Boolean);

        // Append "Track your orders online" portal block (Scenario 1/2/3)
        const portalAppend = await buildPortalAppend({
          pool,
          customerEmail: emailList[0] || null
        });
        whatsappText += portalAppend;
        emailBody += portalAppend;

        let sentEmail = false;
        let sentWhatsapp = false;
        let whatsappError = null;
        let emailError = null;
  
        if (mobileList.length) {
          for (const to of mobileList) {
            try {
              await sendWhatsAppMaytapi({
                productId: creds.ProductID,
                phoneId: creds.PhoneID,
                apiKey: creds.ApiKey,
                toNumber: to,
                text: whatsappText
              });
              sentWhatsapp = true;
            } catch (waErr) {
              const detail = waErr.response?.data
                ? JSON.stringify(waErr.response.data)
                : waErr.message;
              console.error('[WHATSAPP ERROR]', detail);
              whatsappError = detail;
            }
          }
        }
  
        if (emailList.length) {
          try {
            console.log('[EMAIL] SMTP Config:', {
              host: creds.SMTPServer,
              port: creds.SMTPServerPort,
              secure: Number(creds.SMTPServerPort) === 465
            });
            await sendEmailSMTP({
              creds,
              to: emailList.join(","),
              subject: emailSubject,
              text: emailBody
            });
            sentEmail = true;
          } catch (emailErr) {
            console.error('[EMAIL ERROR]', emailErr.message);
            emailError = emailErr.message;
          }
        }
  
        let markError = null;
        if (sentEmail || sentWhatsapp) {
          const idsToMark = clientRows
            .map(r => Number(r.OrderBookingDetailsID))
            .filter(id => Number.isInteger(id) && id > 0);

          if (!idsToMark.length) {
            markError = 'No valid OrderBookingDetailsID values to mark';
            console.error('[FIRST-INTIMATION MARK ERROR]', {
              reason: markError,
              sampleRow: clientRows[0] || null
            });
          } else {
            try {
              // Before marking first intimation as sent, ensure no duplicate job cards exist
              // for the selected OrderBookingDetailsID rows.
              const tvpForDuplicateCheck = new sql.Table("dbo.IdList");
              tvpForDuplicateCheck.columns.add("Id", sql.Int, { nullable: false });
              idsToMark.forEach(id => tvpForDuplicateCheck.rows.add(id));

              const duplicateCheckReq = pool.request();
              duplicateCheckReq.input("Ids", tvpForDuplicateCheck);
              const duplicateCheckRes = await duplicateCheckReq.query(`
                SELECT
                  jb.OrderBookingDetailsID,
                  COUNT(*) AS JobCardCount
                FROM dbo.JobBookingJobCard jb
                INNER JOIN @Ids ids ON ids.Id = jb.OrderBookingDetailsID
                WHERE ISNULL(jb.IsDeletedTransaction, 0) = 0
                  AND ISNULL(jb.IsCancel, 0) = 0
                GROUP BY jb.OrderBookingDetailsID
                HAVING COUNT(*) > 1
              `);

              const duplicateRows = duplicateCheckRes.recordset || [];
              if (duplicateRows.length > 0) {
                const duplicateIds = duplicateRows.map(r => Number(r.OrderBookingDetailsID));
                const duplicateError = new Error(
                  `Duplicate job number exists for OrderBookingDetailsID: ${duplicateIds.join(", ")}`
                );
                duplicateError.statusCode = 409;
                duplicateError.duplicateOrderBookingDetailsIds = duplicateIds;
                throw duplicateError;
              }

              const tvpClient = new sql.Table("dbo.IdList");
              tvpClient.columns.add("Id", sql.Int, { nullable: false });
              idsToMark.forEach(id => tvpClient.rows.add(id));

              const markReq = pool.request();
              markReq.input("OrderBookingDetailsIds", tvpClient);
              markReq.input("SentEmail", sql.Bit, sentEmail ? 1 : 0);
              markReq.input("SentWhatsapp", sql.Bit, sentWhatsapp ? 1 : 0);
              markReq.input("SentByUser", sql.NVarChar(100), username);
              await markReq.execute("dbo.comm_mark_first_intimation_sent");
            } catch (markErr) {
              markError =
                markErr?.message ||
                markErr?.originalError?.info?.message ||
                markErr?.precedingErrors?.[0]?.message ||
                'Failed to mark first intimation as sent';

              console.error('[FIRST-INTIMATION MARK ERROR]', {
                message: markErr?.message,
                code: markErr?.code,
                number: markErr?.number,
                state: markErr?.state,
                class: markErr?.class,
                lineNumber: markErr?.lineNumber,
                serverName: markErr?.serverName,
                procName: markErr?.procName,
                originalError: markErr?.originalError,
                precedingErrors: markErr?.precedingErrors,
                idsToMarkSample: idsToMark.slice(0, 10),
                idsToMarkCount: idsToMark.length
              });
            }
          }
        }
  
        // Add per-job details to results
        clientRows.forEach(row => {
          results.push({
            orderBookingDetailsID: row.OrderBookingDetailsID,
            jobCardNo: row["Job Card No"] || row["JobCardNo"] || '',
            orderQty: row["Order Qty"] || row["OrderQty"] || '',
            clientName: row["Client Name"] || row["ClientName"] || clientName,
            jobName: row["Job Name"] || row["JobName"] || '',
            finalDeliveryDate: row["Final Delivery Date"] || row["FinalDeliveryDate"] || '',
            contactPerson: row["Contact Person"] || row["ContactPerson"] || '',
            mailSent: sentEmail ? 'Yes' : (emailError ? `Failed: ${emailError}` : 'No'),
            whatsappSent: sentWhatsapp ? 'Yes' : (whatsappError ? `Failed: ${whatsappError}` : 'No'),
            markStatus: markError ? `Failed: ${markError}` : 'Marked'
          });
        });
      }
  
      res.json({ ok: true, results });
    } catch (err) {
      const finalMessage =
        err?.message ||
        err?.originalError?.info?.message ||
        err?.precedingErrors?.[0]?.message ||
        'Internal server error';

      console.error('[FIRST-INTIMATION SEND ERROR]', {
        message: finalMessage,
        rawMessage: err?.message,
        code: err?.code,
        number: err?.number,
        state: err?.state,
        class: err?.class,
        lineNumber: err?.lineNumber,
        serverName: err?.serverName,
        procName: err?.procName,
        originalError: err?.originalError,
        precedingErrors: err?.precedingErrors,
        stack: err?.stack,
        responseStatus: err?.response?.status,
        responseData: err?.response?.data
      });
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      res.status(statusCode).json({
        ok: false,
        message: finalMessage,
        duplicateOrderBookingDetailsIds: err?.duplicateOrderBookingDetailsIds || []
      });
    }
  });


/* ---- Route ---- */
router.post("/comm/material-readiness/send", async (req, res) => {
  try {
    const { username, items } = req.body || {};

    if (!username || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, message: "username and items[] are required" });
    }

    // 1) Build readiness map from FRONTEND payload ONLY
    const readinessByObdId = new Map();
    const ids = [];
    const missing = [];

    for (const it of items) {
      const id = Number(it.orderBookingDetailsId);
      if (!id) {
        return res.status(400).json({ ok: false, message: "Invalid orderBookingDetailsId in items[]" });
      }

      const readyForDispatchDate = it.readyForDispatchDate;
      const noOfCarton = Number(it.noOfCarton || 0);
      const qtyPerCarton = Number(it.qtyPerCarton || 0);

      if (!readyForDispatchDate) missing.push({ id, field: "readyForDispatchDate" });
      if (!noOfCarton) missing.push({ id, field: "noOfCarton" });
      if (!qtyPerCarton) missing.push({ id, field: "qtyPerCarton" });

      readinessByObdId.set(id, { readyForDispatchDate, noOfCarton, qtyPerCarton });
      ids.push(id);
    }

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        message: "Please fill Ready Date, No of Cartons, and Qty per Carton for all selected orders.",
        missing
      });
    }

    const pool = await getPool('KOL');

    // 2) Get sender credentials
    const credRes = await pool.request()
      .input("Username", sql.NVarChar(100), username)
      .execute("dbo.comm_get_user_credentials");

    const creds = credRes.recordset?.[0];
    if (!creds) return res.status(400).json({ ok: false, message: "Credentials not found" });

    const senderName = username;
    const senderPhone = creds.ContactNo || "";

    // 3) Fetch ONLY selected rows from DB (fast + safe)
    const tvp = new sql.Table("dbo.IdList");
    tvp.columns.add("Id", sql.Int, { nullable: false });
    ids.forEach(id => tvp.rows.add(id));

    const dataRes = await pool.request()
      .input("Ids", tvp)
      .execute("dbo.comm_pending_delivery_followup_by_ids");

    const rows = dataRes.recordset || [];
    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: "No matching pending rows found for selected IDs (maybe already delivered/closed or DispatchSchedule missing)."
      });
    }

    // 4) Ensure DB rows correspond exactly to payload IDs
    const foundSet = new Set(rows.map(r => Number(r.OrderBookingDetailsID)));
    const notFound = ids.filter(id => !foundSet.has(Number(id)));
    if (notFound.length) {
      return res.status(400).json({
        ok: false,
        message: "Some selected IDs were not returned by DB (may be closed / already delivered / not eligible).",
        notFound
      });
    }

    // 5) Group by client ledger → 1 message per client
    const byClient = new Map();
    for (const r of rows) {
      const ledgerId = Number(r.ClientLedgerID);
      if (!byClient.has(ledgerId)) byClient.set(ledgerId, []);
      byClient.get(ledgerId).push(r);
    }

    const results = [];

    for (const [clientLedgerId, clientRowsRaw] of byClient.entries()) {
      // safety: only rows we have payload for
      const clientRows = clientRowsRaw.filter(r => readinessByObdId.has(Number(r.OrderBookingDetailsID)));
      if (!clientRows.length) continue;

      // message header info
      const clientName = clientRows[0]["Client Name"] || "";
      const contactName = (clientRows[0]["Contact Person"] || "").split(",")[0].trim() || clientName;

      const readinessLines = buildReadinessLines(clientRows, readinessByObdId);

      let whatsappMessage =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

Your material is ready and planned for dispatch as per details below:

${readinessLines}

For any coordination required, please reply here.

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`.trim();

      const emailSubject = `Material Ready for Dispatch | ${clientName}`;
      let emailBody =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd.

Your material is ready and planned for dispatch as per details below:

${readinessLines}

For any coordination required, please reply to this email.

Regards,
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`.trim();

      // recipients (already filtered by flags in SQL proc)
      const emailList = splitCsv(clientRows[0]["Contact Email"]);
      const mobileList = splitCsv(clientRows[0]["Contact phone"])
        .map(normalizeINPhone)
        .filter(Boolean);

      // Append "Track your orders online" portal block (Scenario 1/2/3)
      const portalAppend = await buildPortalAppend({
        pool,
        customerEmail: emailList[0] || null
      });
      whatsappMessage += portalAppend;
      emailBody += portalAppend;

      let sentEmail = false;
      let sentWhatsapp = false;
      const errors = [];

      // WhatsApp
      if (mobileList.length && creds.ProductID && creds.ApiKey && creds.PhoneID) {
        for (const to of mobileList) {
          try {
            await sendWhatsAppMaytapi({
              productId: creds.ProductID,
              phoneId: creds.PhoneID,
              apiKey: creds.ApiKey,
              toNumber: to,
              text: whatsappMessage
            });
            sentWhatsapp = true;
          } catch (e) {
            errors.push({ channel: "whatsapp", to, error: e?.response?.data || e.message });
          }
        }
      }

      // Email
      if (emailList.length && creds.SMTPServer && creds.SMTPUserName && creds.SMTPUserPassword) {
        try {
          await sendEmailSMTP({
            creds,
            to: emailList.join(","),
            subject: emailSubject,
            text: emailBody
          });
          sentEmail = true;
        } catch (e) {
          errors.push({ channel: "email", to: emailList, error: e?.response?.data || e.message });
        }
      }

      // 6) Update DispatchSchedule for each order (values differ per order)
      if (sentEmail || sentWhatsapp) {
        for (const r of clientRows) {
          const id = Number(r.OrderBookingDetailsID);
          const rd = readinessByObdId.get(id);

          const tvpOne = new sql.Table("dbo.IdList");
          tvpOne.columns.add("Id", sql.Int, { nullable: false });
          tvpOne.rows.add(id);

          await pool.request()
            .input("OrderBookingDetailsIds", tvpOne)
            .input("ReadyForDispatchDate", sql.DateTime, new Date(rd.readyForDispatchDate))
            .input("NoOfCarton", sql.Int, rd.noOfCarton)
            .input("QtyPerCarton", sql.Int, rd.qtyPerCarton)
            .input("SentEmail", sql.Bit, sentEmail ? 1 : 0)
            .input("SentWhatsapp", sql.Bit, sentWhatsapp ? 1 : 0)
            .execute("dbo.comm_mark_readiness_message_sent");
        }
      }

      results.push({
        clientLedgerId,
        clientName,
        orderCount: clientRows.length,
        sentEmail,
        sentWhatsapp,
        errors
      });
    }

    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/auth/login', async (req, res) => {
	try {
		const { username, database } = req.query || {};
        logAuth('Login request received', { route: '/auth/login', ip: req.ip, rawQuery: req.query });
		if (!username || username.trim() === '') {
            logAuth('Login rejected - missing username', { route: '/auth/login' });
			return res.status(400).json({ status: false, error: 'Missing username' });
		}

		const trimmedUsername = username.trim();
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            logAuth('Login rejected - invalid database', { database });
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        logAuth('Login params normalized', { username: trimmedUsername, databaseParam: database ?? null, selectedDatabase });

	console.log(`Login attempt - Username: ${trimmedUsername}, Database: ${selectedDatabase}`);
        logAuth('Attempting to get DB pool', { selectedDatabase });

	const pool = await getPool(selectedDatabase);
        logAuth('DB pool acquired', { selectedDatabase });

        // Ensure pool is fully connected and ready before proceeding
        if (!pool.connected) {
            console.warn(`[AUTH] Pool not connected yet, waiting...`);
            // Wait a bit for pool to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check again
            if (!pool.connected) {
                logAuth('Pool connection failed', { selectedDatabase });
                return res.status(500).json({ 
                    status: false, 
                    error: 'Database connection not ready. Please try again.' 
                });
            }
        }
        
        // Verify pool is healthy with a quick test query
        try {
            await pool.request().query('SELECT 1 AS test');
            console.log(`[AUTH] Pool verified as healthy for ${selectedDatabase}`);
        } catch (verifyErr) {
            console.error(`[AUTH] Pool health verification failed:`, verifyErr);
            return res.status(500).json({ 
                status: false, 
                error: 'Database connection error. Please try again.' 
            });
        }

        // Diagnostics: verify actual DB context and SP existence
        let currentDb = null;
        let getMachinesForUserExists = null;
        try {
            const dbInfo = await pool.request().query("SELECT DB_NAME() AS currentDb");
            currentDb = dbInfo?.recordset?.[0]?.currentDb || null;
            const spCheck = await pool.request().query("SELECT OBJECT_ID('dbo.GetMachinesForUser') AS spId");
            const spId = spCheck?.recordset?.[0]?.spId || null;
            getMachinesForUserExists = !!spId;
            logAuth('Diagnostics - DB and SP availability', { selectedDatabase, currentDb, getMachinesForUserExists, spId });
            
            // Check if required stored procedure exists
            if (!spId) {
                logAuth('Required stored procedure missing', { selectedDatabase, currentDb, missingProcedure: 'dbo.GetMachinesForUser' });
                return res.status(500).json({ 
                    status: false, 
                    error: `Database ${selectedDatabase} is not properly configured. Missing required stored procedure: dbo.GetMachinesForUser` 
                });
            }
        } catch (diagErr) {
            logAuth('Diagnostics failed', { selectedDatabase, error: String(diagErr) });
        }
        
	const result = await pool.request()
		.input('UserName', sql.NVarChar(255), trimmedUsername)
		.execute('dbo.GetMachinesForUser');

	// Enhanced logging to debug empty results
        console.log('[AUTH] Stored procedure executed', {
            database: selectedDatabase,
            username: trimmedUsername,
            actualDb: currentDb,
            rowCount: result.recordset?.length || 0
        });
        
        if (result.recordset.length > 0) {
            console.log('[AUTH] First row columns:', Object.keys(result.recordset[0]));
            console.log('[AUTH] First row data:', result.recordset[0]);
        } else {
            console.warn('[AUTH] No rows returned from GetMachinesForUser', {
                username: trimmedUsername,
                database: selectedDatabase,
                actualDb: currentDb
            });
        }

        logAuth('Login SP executed', {
            storedProcedure: 'dbo.GetMachinesForUser',
            selectedDatabase,
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : []
        });

		const machines = result.recordset.map(r => ({
			// Mobile app expects camelCase
			machineId: r.machineid || r.MachineID,
			machineName: r.machinename || r.MachineName,
			departmentId: r.departmentid || r.DepartmentID,
			productUnitId: r.productunitid || r.ProductUnitID,
			// Web app expects PascalCase
			MachineID: r.machineid || r.MachineID,
			MachineName: r.machinename || r.MachineName,
			DepartmentID: r.departmentid || r.DepartmentID,
			ProductUnitID: r.productunitid || r.ProductUnitID
		}));
		if (machines.length === 0) {
            logAuth('Login completed - no machines for user', { selectedDatabase, username: trimmedUsername, currentDb, getMachinesForUserExists });
            return res.json({ status: false, error: 'No machines found for this user in selected database', selectedDatabase, currentDb });
		}

		// Attempt to read userId and ledgerId from first row if provided by SP
		const first = result.recordset[0] || {};
		const userId = first.UserID ?? first.userid ?? first.userId ?? null;
		const ledgerId = first.LedgerID ?? first.ledgerid ?? first.ledgerID ?? null;
        logAuth('Login success', { selectedDatabase, username: trimmedUsername, userId, ledgerId, machinesCount: machines.length, currentDb });
        return res.json({ status: true, userId, ledgerId, machines, selectedDatabase, currentDb });
	} catch (err) {
		console.error('DB login error:', err);
        logAuth('Login failed', { route: '/auth/login', ip: req.ip, error: String(err), stack: err?.stack });
		return res.status(500).json({ status: false, error: 'Internal server error' });
	}
});

/** Hardcoded app PIN for CDC Web admin username (case-insensitive "admin"). */
const CDC_WEB_ADMIN_APP_PIN = '020796';

router.post('/auth/admin-pin', async (req, res) => {
	try {
		const pin = req.body?.pin != null ? String(req.body.pin).trim() : '';
		if (pin === CDC_WEB_ADMIN_APP_PIN) {
			logAuth('Admin PIN verified', { route: '/auth/admin-pin', ip: req.ip });
			return res.json({ status: true });
		}
		logAuth('Admin PIN rejected', { route: '/auth/admin-pin', ip: req.ip });
		return res.json({ status: false, error: 'Invalid PIN. Login denied.' });
	} catch (err) {
		console.error('Admin PIN error:', err);
		return res.status(500).json({ status: false, error: 'Internal server error' });
	}
});

// Logout endpoint to clear session/cookies AND database pool cache
router.post('/auth/logout', async (req, res) => {
	try {
		logAuth('Logout request received', { route: '/auth/logout', ip: req.ip });
		
		// Clear any session data if using express-session
		if (req.session) {
			req.session.destroy((err) => {
				if (err) {
					console.error('Session destroy error:', err);
					logAuth('Logout - session destroy failed', { error: String(err) });
				}
			});
		}
		
		// Clear cookies
		res.clearCookie('connect.sid'); // Default express-session cookie name
		res.clearCookie('session'); // Alternative session cookie name
		
		logAuth('Logout successful - session, cookies, and DB pools cleared', { route: '/auth/logout', ip: req.ip });
		return res.json({ status: true, message: 'Logged out successfully' });
	} catch (err) {
		console.error('Logout error:', err);
		logAuth('Logout failed', { route: '/auth/logout', ip: req.ip, error: String(err) });
		return res.status(500).json({ status: false, error: 'Logout failed' });
	}
});

// Create new user for voice note tool
router.post('/voice-note-tool/users', async (req, res) => {
	try {
		const { username, password } = req.body;

		if (!username || !password) {
			return res.status(400).json({ error: 'Username and password are required' });
		}

		if (username.trim().length === 0 || password.trim().length === 0) {
			return res.status(400).json({ error: 'Username and password cannot be empty' });
		}

		const VoiceNoteUser = await getVoiceNoteUserModel();

		// Check if user already exists
		const existingUser = await VoiceNoteUser.findOne({ username: username.toLowerCase().trim() });
		if (existingUser) {
			return res.status(400).json({ error: 'Username already exists' });
		}

		// Create new user (password stored as plain text as per requirement)
		const newUser = new VoiceNoteUser({
			username: username.toLowerCase().trim(),
			password: password // Storing as plain text
		});

		await newUser.save();

		res.status(201).json({
			message: 'User created successfully',
			username: newUser.username,
			createdAt: newUser.createdAt
		});
	} catch (error) {
		console.error('Error creating user:', error);
		if (error.code === 11000) {
			return res.status(400).json({ error: 'Username already exists' });
		}
		res.status(500).json({ error: 'Error creating user: ' + error.message });
	}
});

// Login for voice note tool (username and password)
router.post('/auth/login-voice-note', async (req, res) => {
	try {
		const { username, password } = req.body;

		if (!username || !password) {
			return res.status(400).json({ error: 'Username and password are required' });
		}

		const VoiceNoteUser = await getVoiceNoteUserModel();

		// Find user by username
		const user = await VoiceNoteUser.findOne({ username: username.toLowerCase().trim() });

		if (!user) {
			return res.status(401).json({ error: 'Invalid username or password' });
		}

		// Compare passwords (plain text comparison as per requirement)
		if (user.password !== password) {
			return res.status(401).json({ error: 'Invalid username or password' });
		}

		// Generate JWT token
		const token = jwt.sign(
			{ username: user.username, tool: 'voice-note' },
			process.env.JWT_SECRET || 'your-secret-key',
			{ expiresIn: '24h' }
		);

		res.json({
			token,
			username: user.username, // Return DB username (lowercase)
			userId: user._id.toString() // Return user ID
		});
	} catch (error) {
		console.error('Voice note login error:', error);
		res.status(500).json({ error: 'Server error during login' });
	}
});

router.get('/processes/pending', async (req, res) => {
	try {
		const { MachineID, jobcardcontentno, UserID, isManualEntry, database } = req.query || {};
		const machineIdNum = Number(MachineID);
		const userIdNum = Number(UserID);
		const isManualEntryMode = isManualEntry === 'true';
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
		
		if (!Number.isInteger(machineIdNum)) {
			return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
		}
		if (!Number.isInteger(userIdNum)) {
			return res.status(400).json({ status: false, error: 'UserID must be an integer' });
		}
		if (!jobcardcontentno || jobcardcontentno.trim() === '') {
			return res.status(400).json({ status: false, error: 'Missing jobcardcontentno' });
		}

		const trimmedJobCardContentNo = jobcardcontentno.trim();

		const pool = await getPool(selectedDatabase);
		let result;
		
		if (isManualEntryMode) {
			// Two-step process for manual entry:
			// 1. First, find job card numbers that match the partial input
			const jobCardSearchResult = await pool.request()
				.input('NumberPart', sql.NVarChar(255), trimmedJobCardContentNo)
				.execute('dbo.FindJobCardsByPartialNumber');
      console.log('[PENDING] jobCardSearchResult:', JSON.stringify(jobCardSearchResult.recordset));
			
			if (jobCardSearchResult.recordset.length === 0) {
				return res.json({ status: false, error: 'No job cards found matching the partial number' });
			}
			
			// 2. Collect processes from all matching job card numbers
			let allProcesses = [];
			
			for (const jobCardRow of jobCardSearchResult.recordset) {
				// Try different possible column names for the job card content number
				const jobCardNumber = jobCardRow.JobCardContentNo || 
									  jobCardRow.jobcardcontentno ||
									  jobCardRow.JobCardNumber ||
									  jobCardRow.Number ||
									  jobCardRow.JobCardNo ||
									  jobCardRow.jobcardno;
				
				if (jobCardNumber) {
					try {
						// Search for processes using this job card number
						const processResult = await pool.request()
							.input('UserID', sql.Int, userIdNum)
							.input('MachineID', sql.Int, machineIdNum)
							.input('JobCardContentNo', sql.NVarChar(255), jobCardNumber.toString())
							.execute('dbo.GetPendingProcesses_ForMachineAndContent');
						console.log('[PENDING2] processResult:', JSON.stringify(processResult.recordset));
            console.log('[PENDING2] machineIdNum, jobCardNumber:', machineIdNum, jobCardNumber);
						// Add processes from this job card to our collection
						if (processResult.recordset && processResult.recordset.length > 0) {
							allProcesses = allProcesses.concat(processResult.recordset);
						}
					} catch (processErr) {
						// Log error but continue with other job cards
						console.error(`Error fetching processes for job card ${jobCardNumber}:`, processErr);
					}
				}
			}
			
			// Create a result object with all collected processes
			result = { recordset: allProcesses };
		} else {
			// Use original stored procedure for QR code scanning
			result = await pool.request()
				.input('UserID', sql.Int, userIdNum)
				.input('MachineID', sql.Int, machineIdNum)
				.input('JobCardContentNo', sql.NVarChar(255), trimmedJobCardContentNo)
				.execute('dbo.GetPendingProcesses_ForMachineAndContent');
        console.log('[PENDING3] result:', JSON.stringify(result.recordset));

		}

		// Debug: Log the first row to see available columns
		if (result.recordset.length > 0) {
			//console.log('[DEBUG] First process row columns:', Object.keys(result.recordset[0]));
			//console.log('[DEBUG] First process row data:', result.recordset[0]);
		}

		const processes = result.recordset.map(r => ({
			// Mobile app expects camelCase
			pwoNo: r.PWOno || r.PWONo,
			pwoDate: r.PWODate,
			client: r.Client,
			jobName: r.JobName,
			componentName: r.ComponentName ?? r.COmponentname,
			formNo: r.FormNo,
			scheduleQty: r.ScheduleQty,
			qtyProduced: r.QtyProduced,
			paperIssuedQty: r.PaperIssuedQty ?? null,
			currentStatus: r.CurrentStatus ?? null,
			jobcardContentNo: r.JobCardContentNo ?? r.jobcardcontentno,
			jobBookingJobcardContentsId: parseInt(r.JobBookingJobCardContentsID) || 0,
			processName: r.ProcessName,
			processId: parseInt(r.ProcessID) || 0,
			runningProductionID: r.RunningProductionID ? parseInt(r.RunningProductionID) : null,
			runningMachineID: r.RunningMachineID ? parseInt(r.RunningMachineID) : null,
			// Web app expects PascalCase
			PWONo: r.PWOno || r.PWONo,
			PWODate: r.PWODate,
			Client: r.Client,
			JobName: r.JobName,
			ComponentName: r.ComponentName ?? r.COmponentname,
			FormNo: r.FormNo,
			ScheduleQty: r.ScheduleQty,
			QtyProduced: r.QtyProduced,
			PaperIssuedQty: r.PaperIssuedQty ?? null,
			CurrentStatus: r.CurrentStatus ?? null,
			JobCardContentNo: r.JobCardContentNo ?? r.jobcardcontentno,
			JobBookingJobCardContentsID: parseInt(r.JobBookingJobCardContentsID) || 0,
			ProcessName: r.ProcessName,
			ProcessID: parseInt(r.ProcessID) || 0,
			RunningProductionID: r.RunningProductionID ? parseInt(r.RunningProductionID) : null,
			RunningMachineID: r.RunningMachineID ? parseInt(r.RunningMachineID) : null
		}));

		if (processes.length === 0) {
			return res.json({ status: false });
		}
		return res.json({ status: true, processes });
	} catch (err) {
		console.error('Pending processes error:', err);
		return res.status(500).json({ status: false, error: 'Internal server error' });
	}
});

router.post('/processes/start', async (req, res) => {
    try {
        // Log raw incoming payload for traceability
        //console.log('[START] /api/processes/start called with body:', req.body);
        const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, database } = req.body || {};

        const userIdNum = Number(UserID);
        const employeeIdNum = Number(EmployeeID);
        const processIdNum = Number(ProcessID);
        const jobBookingIdNum = Number(JobBookingJobCardContentsID);
        const machineIdNum = Number(MachineID);
        const jobCardFormNoStr = (JobCardFormNo || '').toString().trim();
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(employeeIdNum)) {
            return res.status(400).json({ status: false, error: 'EmployeeID must be an integer' });
        }
        if (!Number.isInteger(processIdNum)) {
            return res.status(400).json({ status: false, error: 'ProcessID must be an integer' });
        }
        if (!Number.isInteger(jobBookingIdNum)) {
            return res.status(400).json({ status: false, error: 'JobBookingJobCardContentsID must be an integer' });
        }
        if (!Number.isInteger(machineIdNum)) {
            return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
        }
        if (!jobCardFormNoStr) {
            return res.status(400).json({ status: false, error: 'JobCardFormNo is required' });
        }

        logProcessStart('Start process called', {
            route: '/processes/start', ip: req.ip, db: selectedDatabase,
            UserID: userIdNum, ProcessID: processIdNum, MachineID: machineIdNum
        });

        const pool = await getPool(selectedDatabase);
        const request = pool.request();
        request.timeout = 180000;
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('EmployeeID', sql.Int, employeeIdNum)
            .input('ProcessID', sql.Int, processIdNum)
            .input('JobBookingJobCardContentsID', sql.Int, jobBookingIdNum)
            .input('MachineID', sql.Int, machineIdNum)
            .input('JobCardFormNo', sql.NVarChar(255), jobCardFormNoStr)
            .execute('dbo.Production_Start_Manu_v2');

        let productionId = null;
        if (result.recordset && result.recordset.length > 0 && result.recordset[0].ProductionID) {
            productionId = result.recordset[0].ProductionID;
        }

        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        logProcessStart('Start process completed', {
            route: '/processes/start', ip: req.ip, db: selectedDatabase,
            productionId, statusWarning: !!statusWarning
        });

        return res.json({
            status: true,
            result: result.recordset || [],
            productionId: productionId,
            ...(statusWarning ? { statusWarning } : {})
        });
    } catch (err) {
        console.error('Start process error:', err);
        logProcessStart('Start process failed', { route: '/processes/start', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// QR Code processing endpoint
router.post('/qr/process', upload.single('qrImage'), async (req, res) => {
	try {
		if (!req.file) {
			logQr('No image provided to /qr/process', { route: '/qr/process', ip: req.ip });
			return res.status(400).json({ 
				status: false, 
				error: 'No image file provided' 
			});
		}

		// Process the uploaded image with Jimp
		let image;
		try {
			image = await Jimp.read(req.file.buffer);
		} catch (e) {
			logQr('Failed to read image with Jimp', { error: String(e) });
			return res.status(400).json({ status: false, error: 'Invalid image file' });
		}
		
		// Create QR code reader
		const qr = new QrCode();
		
		// Convert image to format that qrcode-reader can process
		const imageData = {
			data: new Uint8ClampedArray(image.bitmap.data),
			width: image.bitmap.width,
			height: image.bitmap.height
		};

		// Process QR code
		const qrResult = await new Promise((resolve, reject) => {
			qr.callback = (err, value) => {
				if (err) {
					reject(err);
				} else {
					resolve(value);
				}
			};
			qr.decode(imageData);
		});

		if (qrResult && qrResult.result) {
			logQr('QR decoded successfully', { route: '/qr/process' });
			return res.json({ 
				status: true, 
				jobCardContentNo: qrResult.result.trim()
			});
		} else {
			logQr('No QR code found in image', { route: '/qr/process' });
			return res.json({ 
				status: false, 
				error: 'No QR code found in the image' 
			});
		}

	} catch (err) {
		console.error('QR processing error:', err);
		logQr('Unhandled error in /qr/process', { error: String(err), stack: err?.stack });
		return res.status(500).json({ 
			status: false, 
			error: 'Failed to process QR code' 
		});
	}
});

// QR Code processing endpoint for base64 data (for camera captures)
router.post('/qr/process-base64', async (req, res) => {
	try {
		const { imageData } = req.body;
		
		if (!imageData) {
			logQr('No imageData provided to /qr/process-base64', { route: '/qr/process-base64', ip: req.ip });
			return res.status(400).json({ 
				status: false, 
				error: 'No image data provided' 
			});
		}

		// Remove data URL prefix if present
		const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, '');
		const buffer = Buffer.from(base64Data, 'base64');

		// Process the image with Jimp
		let image;
		try {
			image = await Jimp.read(buffer);
		} catch (e) {
			logQr('Failed to read base64 image with Jimp', { error: String(e) });
			return res.status(400).json({ status: false, error: 'Invalid image data' });
		}
		
		// Create QR code reader
		const qr = new QrCode();
		
		// Convert image to format that qrcode-reader can process
		const imageDataObj = {
			data: new Uint8ClampedArray(image.bitmap.data),
			width: image.bitmap.width,
			height: image.bitmap.height
		};

		// Process QR code
		const qrResult = await new Promise((resolve, reject) => {
			qr.callback = (err, value) => {
				if (err) {
					reject(err);
				} else {
					resolve(value);
				}
			};
			qr.decode(imageDataObj);
		});

		if (qrResult && qrResult.result) {
			logQr('QR decoded successfully (base64)', { route: '/qr/process-base64' });
			return res.json({ 
				status: true, 
				jobCardContentNo: qrResult.result.trim()
			});
		} else {
			logQr('No QR code found in base64 image', { route: '/qr/process-base64' });
			return res.json({ 
				status: false, 
				error: 'No QR code found in the image' 
			});
		}

	} catch (err) {
		console.error('QR processing error:', err);
		logQr('Unhandled error in /qr/process-base64', { error: String(err), stack: err?.stack });
		return res.status(500).json({ 
			status: false, 
			error: 'Failed to process QR code' 
		});
	}
});

// Complete production endpoint
router.post('/processes/complete', async (req, res) => {
    try {
        //console.log('[COMPLETE] /api/processes/complete called with body:', req.body);
        const { UserID, ProductionID, ProductionQty, WastageQty, database } = req.body || {};

        const userIdNum = Number(UserID);
        const productionIdNum = Number(ProductionID);
        const productionQtyNum = Number(ProductionQty);
        const wastageQtyNum = Number(WastageQty);
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(productionIdNum)) {
            return res.status(400).json({ status: false, error: 'ProductionID must be an integer' });
        }
        if (!Number.isInteger(productionQtyNum)) {
            return res.status(400).json({ status: false, error: 'ProductionQty must be an integer' });
        }
        if (!Number.isInteger(wastageQtyNum)) {
            return res.status(400).json({ status: false, error: 'WastageQty must be an integer' });
        }

        logProcessStart('Complete process called', {
            route: '/processes/complete', ip: req.ip, db: selectedDatabase,
            UserID: userIdNum, ProductionID: productionIdNum
        });

        const pool = await getPool(selectedDatabase);
        const request = pool.request();
        request.timeout = 180000;
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('ProductionID', sql.Int, productionIdNum)
            .input('ProductionQty', sql.Int, productionQtyNum)
            .input('WastageQty', sql.Int, wastageQtyNum)
            .execute('dbo.Production_End_Manu_v2');

        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        logProcessStart('Complete process done', {
            route: '/processes/complete', ip: req.ip, db: selectedDatabase,
            ProductionID: productionIdNum, statusWarning: !!statusWarning
        });

        return res.json({
            status: true,
            result: result.recordset || [],
            ...(statusWarning ? { statusWarning } : {})
        });
    } catch (err) {
        console.error('Complete process error:', err);
        logProcessStart('Complete process failed', { route: '/processes/complete', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// Cancel production endpoint
router.post('/processes/cancel', async (req, res) => {
    try {
        //console.log('[CANCEL] /api/processes/cancel called with body:', req.body);
        const { UserID, ProductionID, database } = req.body || {};

        const userIdNum = Number(UserID);
        const productionIdNum = Number(ProductionID);
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(productionIdNum)) {
            return res.status(400).json({ status: false, error: 'ProductionID must be an integer' });
        }

        logProcessStart('Cancel process called', {
            route: '/processes/cancel', ip: req.ip, db: selectedDatabase,
            UserID: userIdNum, ProductionID: productionIdNum
        });

        const pool = await getPool(selectedDatabase);
        const request = pool.request();
        request.timeout = 180000;
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('ProductionID', sql.Int, productionIdNum)
            .execute('dbo.Production_Cancel_Manu_v2');

        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        logProcessStart('Cancel process done', {
            route: '/processes/cancel', ip: req.ip, db: selectedDatabase,
            ProductionID: productionIdNum, statusWarning: !!statusWarning
        });

        return res.json({
            status: true,
            result: result.recordset || [],
            ...(statusWarning ? { statusWarning } : {})
        });
    } catch (err) {
        console.error('Cancel process error:', err);
        logProcessStart('Cancel process failed', { route: '/processes/cancel', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// Production history search by job card content (partial text, min 4 chars in UI; API enforces min 1 non-empty)
router.get('/production/search-by-job-card', async (req, res) => {
	try {
		const { searchText, database, companyId, branchId } = req.query || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const text = (searchText != null ? String(searchText) : '').trim();
		if (text.length < 4) {
			return res.status(400).json({ status: false, error: 'Search text must be at least 4 characters' });
		}

		const companyParsed = Number(companyId);
		const branchParsed = Number(branchId);
		const companyIdNum = Number.isInteger(companyParsed) ? companyParsed : 2;
		const branchIdNum = Number.isInteger(branchParsed) ? branchParsed : 0;

		const pool = await getPool(selectedDatabase);
		const result = await pool.request()
			.input('SearchText', sql.NVarChar(100), text.slice(0, 100))
			.input('CompanyID', sql.Int, companyIdNum)
			.input('BranchID', sql.Int, branchIdNum)
			.execute('dbo.Production_Search_By_JobCardContentNo');

		return res.json({ status: true, rows: result.recordset || [] });
	} catch (err) {
		console.error('Production search by job card error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

// Machine master list (active machines only)
router.get('/machines/master-list', async (req, res) => {
	try {
		const { database } = req.query || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const pool = await getPool(selectedDatabase);
		const result = await pool.request().query(`
			SELECT MachineId, MachineName
			FROM dbo.MachineMaster
			WHERE ISNULL(isdeletedtransaction, 0) = 0
			ORDER BY MachineName
		`);

		return res.json({ status: true, rows: result.recordset || [] });
	} catch (err) {
		console.error('Machine master list error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

// Production history search by machine and date range
router.get('/production/search-by-machine', async (req, res) => {
	try {
		const { startDate, endDate, machineId, database } = req.query || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const start = (startDate || '').trim();
		const end = (endDate || '').trim();
		if (!start || !end) {
			return res.status(400).json({ status: false, error: 'startDate and endDate are required' });
		}

		const startParsed = new Date(start);
		const endParsed = new Date(end);
		if (isNaN(startParsed.getTime()) || isNaN(endParsed.getTime())) {
			return res.status(400).json({ status: false, error: 'Invalid date format for startDate or endDate' });
		}

		const machineIdNum = parseInt(machineId, 10);
		if (!Number.isInteger(machineIdNum) || machineIdNum <= 0) {
			return res.status(400).json({ status: false, error: 'machineId must be a positive integer' });
		}

		const pool = await getPool(selectedDatabase);
		const result = await pool.request()
			.input('StartDate', sql.DateTime, startParsed)
			.input('EndDate', sql.DateTime, endParsed)
			.input('MachineID', sql.Int, machineIdNum)
			.execute('dbo.Production_Search_By_Machine_DateRange');

		return res.json({ status: true, rows: result.recordset || [] });
	} catch (err) {
		console.error('Production search by machine error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

// Client master list (active clients only, from LedgerMaster)
router.get('/clients/master-list', async (req, res) => {
	try {
		const { database } = req.query || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const pool = await getPool(selectedDatabase);
		const result = await pool.request().query(`
			SELECT LedgerName
			FROM dbo.LedgerMaster
			WHERE LedgerType = 'Clients' AND IsDeleted = 0 AND IsDeletedTransaction = 0
			ORDER BY LedgerName
		`);

		return res.json({ status: true, rows: result.recordset || [] });
	} catch (err) {
		console.error('Client master list error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

// Production history search by client and date range (detail or summary mode)
router.get('/production/search-by-client', async (req, res) => {
	try {
		const { startDate, endDate, clientName, summary, database } = req.query || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const start = (startDate || '').trim();
		const end = (endDate || '').trim();
		if (!start || !end) {
			return res.status(400).json({ status: false, error: 'startDate and endDate are required' });
		}

		const startParsed = new Date(start);
		const endParsed = new Date(end);
		if (isNaN(startParsed.getTime()) || isNaN(endParsed.getTime())) {
			return res.status(400).json({ status: false, error: 'Invalid date format for startDate or endDate' });
		}

		const clientText = (clientName != null ? String(clientName) : '').trim();
		const isSummary = summary === '1' || String(summary).toLowerCase() === 'true';

		const pool = await getPool(selectedDatabase);
		const result = await pool.request()
			.input('StartDate', sql.DateTime, startParsed)
			.input('EndDate', sql.DateTime, endParsed)
			.input('ClientName', sql.NVarChar(200), clientText)
			.input('Summary', sql.Bit, isSummary ? 1 : 0)
			.execute('dbo.Production_Search_By_Client_DateRange');

		return res.json({ status: true, rows: result.recordset || [], summary: isSummary });
	} catch (err) {
		console.error('Production search by client error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

const PRODUCTION_REVERSE_SUCCESS = 'Success: Reversed';

router.post('/production/reverse', async (req, res) => {
	try {
		const { UserID, ProductionID, database, companyId, branchId } = req.body || {};
		const selectedDatabase = (database || '').toUpperCase();
		if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
			return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
		}

		const userIdNum = Number(UserID);
		const productionIdNum = Number(ProductionID);
		if (!Number.isInteger(userIdNum)) {
			return res.status(400).json({ status: false, error: 'UserID must be an integer' });
		}
		if (!Number.isInteger(productionIdNum)) {
			return res.status(400).json({ status: false, error: 'ProductionID must be an integer' });
		}

		const companyParsed = Number(companyId);
		const branchParsed = Number(branchId);
		const companyIdNum = Number.isInteger(companyParsed) ? companyParsed : 2;
		const branchIdNum = Number.isInteger(branchParsed) ? branchParsed : 0;

		const pool = await getPool(selectedDatabase);
		const result = await pool.request()
			.input('UserID', sql.Int, userIdNum)
			.input('ProductionID', sql.Int, productionIdNum)
			.input('CompanyID', sql.Int, companyIdNum)
			.input('BranchID', sql.Int, branchIdNum)
			.execute('dbo.Production_Reverse_Manu_v2');

		const rows = result.recordset || [];
		const first = rows[0] || {};
		const statusText =
			first.Status != null
				? String(first.Status).trim()
				: first.status != null
					? String(first.status).trim()
					: '';

		const reversed = statusText === PRODUCTION_REVERSE_SUCCESS;

		return res.json({
			status: true,
			reversed,
			spStatus: statusText || 'No status returned from procedure',
		});
	} catch (err) {
		console.error('Production reverse error:', err);
		return res.status(500).json({ status: false, error: err.message || 'Internal server error' });
	}
});

// ============================================
// Async Process Endpoints (Background Jobs)
// ============================================

// Start Process Async
router.post('/processes/start-async', async (req, res) => {
  try {
    const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, database } = req.body || {};
    
    // Validate database
    const selectedDatabase = (database || '').toUpperCase();
    if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
      return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    // Validate required fields
    if (!Number.isInteger(Number(UserID)) || !Number.isInteger(Number(EmployeeID)) || 
        !Number.isInteger(Number(ProcessID)) || !Number.isInteger(Number(JobBookingJobCardContentsID)) ||
        !Number.isInteger(Number(MachineID)) || !JobCardFormNo) {
      return res.status(400).json({ status: false, error: 'Missing or invalid required fields' });
    }

    const jobId = generateJobId();
    
    // Store job in memory
    jobs.set(jobId, {
      id: jobId,
      type: 'start',
      status: 'pending',
      requestData: {
        UserID: Number(UserID),
        EmployeeID: Number(EmployeeID),
        ProcessID: Number(ProcessID),
        JobBookingJobCardContentsID: Number(JobBookingJobCardContentsID),
        MachineID: Number(MachineID),
        JobCardFormNo: String(JobCardFormNo)
      },
      createdAt: new Date()
    });

    console.log(`[JOB ${jobId}] Created start process job`);

    // Start background processing (non-blocking)
    setImmediate(() => processJobInBackground(jobId, 'start', jobs.get(jobId).requestData, selectedDatabase));

    // Return immediately
    return res.json({
      status: true,
      jobId: jobId,
      message: 'Job created. Processing in background...'
    });

  } catch (err) {
    console.error('Start async error:', err);
    return res.status(500).json({ status: false, error: 'Internal server error' });
  }
});

// Complete Process Async
router.post('/processes/complete-async', async (req, res) => {
  try {
    const { UserID, ProductionID, ProductionQty, WastageQty, database } = req.body || {};
    
    // Validate database
    const selectedDatabase = (database || '').toUpperCase();
    if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
      return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    // Validate required fields
    if (!Number.isInteger(Number(UserID)) || !Number.isInteger(Number(ProductionID)) || 
        !Number.isInteger(Number(ProductionQty)) || !Number.isInteger(Number(WastageQty))) {
      return res.status(400).json({ status: false, error: 'Missing or invalid required fields' });
    }

    const jobId = generateJobId();
    
    console.log(`[JOB ${jobId}] Creating complete job with params:`, {
      UserID: Number(UserID),
      ProductionID: Number(ProductionID),
      ProductionQty: Number(ProductionQty),
      WastageQty: Number(WastageQty),
      database: selectedDatabase
    });
    
    jobs.set(jobId, {
      id: jobId,
      type: 'complete',
      status: 'pending',
      requestData: {
        UserID: Number(UserID),
        ProductionID: Number(ProductionID),
        ProductionQty: Number(ProductionQty),
        WastageQty: Number(WastageQty)
      },
      createdAt: new Date()
    });

    console.log(`[JOB ${jobId}] Created complete process job`);

    setImmediate(() => processJobInBackground(jobId, 'complete', jobs.get(jobId).requestData, selectedDatabase));

    return res.json({
      status: true,
      jobId: jobId,
      message: 'Job created. Processing in background...'
    });

  } catch (err) {
    console.error('Complete async error:', err);
    return res.status(500).json({ status: false, error: 'Internal server error' });
  }
});

// Cancel Process Async
router.post('/processes/cancel-async', async (req, res) => {
  try {
    const { UserID, ProductionID, database } = req.body || {};
    
    // Validate database
    const selectedDatabase = (database || '').toUpperCase();
    if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
      return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    // Validate required fields
    if (!Number.isInteger(Number(UserID)) || !Number.isInteger(Number(ProductionID))) {
      return res.status(400).json({ status: false, error: 'Missing or invalid required fields' });
    }

    const jobId = generateJobId();
    
    console.log(`[JOB ${jobId}] Creating cancel job with params:`, {
      UserID: Number(UserID),
      ProductionID: Number(ProductionID),
      database: selectedDatabase
    });
    
    jobs.set(jobId, {
      id: jobId,
      type: 'cancel',
      status: 'pending',
      requestData: {
        UserID: Number(UserID),
        ProductionID: Number(ProductionID)
      },
      createdAt: new Date()
    });

    console.log(`[JOB ${jobId}] Created cancel process job`);

    setImmediate(() => processJobInBackground(jobId, 'cancel', jobs.get(jobId).requestData, selectedDatabase));

    return res.json({
      status: true,
      jobId: jobId,
      message: 'Job created. Processing in background...'
    });

  } catch (err) {
    console.error('Cancel async error:', err);
    return res.status(500).json({ status: false, error: 'Internal server error' });
  }
});

// Check Job Status
router.get('/jobs/:jobId/status', (req, res) => {
  const { jobId } = req.params;
  
  if (!jobs.has(jobId)) {
    return res.status(404).json({
      status: false,
      error: 'Job not found or expired'
    });
  }

  const job = jobs.get(jobId);
  
  // Log job status with ProductionID if available
  if (job.productionId) {
    console.log(`[JOB ${jobId}] Status polled - ProductionID: ${job.productionId}, Status: ${job.status}`);
  }
  
  return res.json({
    status: true,
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      result: job.result,
      productionId: job.productionId,  // Include ProductionID for start jobs
      statusWarning: job.statusWarning,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    }
  });
});

// ============================================
// End of Async Process Endpoints
// ============================================

// Log viewer endpoint for debugging and monitoring
router.get('/logs/process-start', async (req, res) => {
    try {
        const { lines = 50 } = req.query;
        const maxLines = Math.min(parseInt(lines) || 50, 1000); // Limit to 1000 lines max
        
        if (!fs.existsSync(processStartLogFile)) {
            return res.json({ 
                status: true, 
                logs: [], 
                message: 'No log file found' 
            });
        }
        
        const fileContent = fs.readFileSync(processStartLogFile, 'utf8');
        const allLines = fileContent.trim().split('\n').filter(line => line.trim());
        
        // Get the last N lines
        const recentLines = allLines.slice(-maxLines);
        
        // Parse JSON logs
        const parsedLogs = recentLines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return { raw: line, parseError: true };
            }
        });
        
        return res.json({
            status: true,
            logs: parsedLogs,
            totalLines: allLines.length,
            displayedLines: parsedLogs.length
        });
    } catch (err) {
        console.error('Error reading process logs:', err);
        return res.status(500).json({ 
            status: false, 
            error: 'Failed to read logs' 
        });
    }
});

// Serve log viewer HTML page
router.get('/logs/viewer', (req, res) => {
    try {
        const logViewerPath = path.join(__dirname, '..', 'log-viewer.html');
        if (fs.existsSync(logViewerPath)) {
            res.sendFile(logViewerPath);
        } else {
            res.status(404).send('Log viewer not found');
        }
    } catch (err) {
        console.error('Error serving log viewer:', err);
        res.status(500).send('Error loading log viewer');
    }
});

// Auth logs endpoint (to inspect login flow)
router.get('/logs/auth', async (req, res) => {
    try {
        const { lines = 200 } = req.query;
        const maxLines = Math.min(parseInt(lines) || 200, 2000);

        if (!fs.existsSync(authLogFile)) {
            return res.json({ status: true, logs: [], message: 'No auth log file found' });
        }

        const fileContent = fs.readFileSync(authLogFile, 'utf8');
        const allLines = fileContent.trim().split('\n').filter(line => line.trim());
        const recentLines = allLines.slice(-maxLines);
        const parsedLogs = recentLines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return { raw: line, parseError: true };
            }
        });
        return res.json({ status: true, logs: parsedLogs, totalLines: allLines.length, displayedLines: parsedLogs.length });
    } catch (err) {
        console.error('Error reading auth logs:', err);
        return res.status(500).json({ status: false, error: 'Failed to read auth logs' });
    }
});

// Clear database pool cache endpoint
router.post('/admin/clear-db-cache', async (req, res) => {
    try {
        const { closeAllPools } = await import('./db.js');
        await closeAllPools();
        console.log('[ADMIN] Database pool cache cleared');
        logAuth('Database pool cache cleared', { route: '/admin/clear-db-cache', ip: req.ip });
        return res.json({ status: true, message: 'Database pool cache cleared successfully' });
    } catch (err) {
        console.error('[ADMIN] Error clearing database cache:', err);
        logAuth('Failed to clear database cache', { route: '/admin/clear-db-cache', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Failed to clear database cache' });
    }
});

// Diagnostic endpoint to check environment variables
router.get('/admin/env-check', (req, res) => {
    try {
        const envInfo = {
            DB_NAME: process.env.DB_NAME || null,
            DB_NAME_KOL: process.env.DB_NAME_KOL || null,
            DB_NAME_AHM: process.env.DB_NAME_AHM || null,
            DB_SERVER: process.env.DB_SERVER || null,
            DB_USER: process.env.DB_USER || null,
            NODE_ENV: process.env.NODE_ENV || null,
            timestamp: new Date().toISOString()
        };
        console.log('[ADMIN] Environment check:', envInfo);
        logAuth('Environment check requested', { route: '/admin/env-check', ip: req.ip, envInfo });
        return res.json({ status: true, environment: envInfo });
    } catch (err) {
        console.error('[ADMIN] Error checking environment:', err);
        return res.status(500).json({ status: false, error: 'Failed to check environment' });
    }
});

// GRN: Initiate Challan by Barcode
router.post('/grn/initiate', async (req, res) => {
    try {
        const { barcode, database, userId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const pool = await getPool(selectedDatabase);

        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'new-check')
            .input('UserID', sql.Int, userIdNum)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        // Normalize response
        const rows = result.recordset || [];
        // Try to pick ledger/client name from common columns
        const first = rows[0] || {};
        const ledgerName = first.ledgername || first.LedgerName || first.client || first.Client || null;

        // Handle Fail statuses from SP gracefully
        const statusText = first.Status || first.status || '';
        if (typeof statusText === 'string' && statusText.toLowerCase().startsWith('fail')) {
            return res.json({ status: false, error: statusText });
        }

        return res.json({ status: true, data: rows, ledgerName });
    } catch (err) {
        console.error('GRN initiate error:', err?.message || err);
        return res.status(500).json({ 
            status: false, 
            error: 'Failed to initiate challan',
            details: err?.message || String(err)
        });
    }
});

// GRN: Save Delivery Note
router.post('/grn/save-delivery-note', async (req, res) => {
    try {
        const { barcode, database, userId, clientName, modeOfTransport, containerNumber, sealNumber, transporterName, transporterLedgerId, vehicleNumber } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        // Validate required fields
        if (!clientName || !modeOfTransport || !containerNumber || !sealNumber || !transporterName || !vehicleNumber) {
            return res.status(400).json({ status: false, error: 'All fields are mandatory' });
        }

        const transporterIdNum = Number(transporterLedgerId);
        if (!Number.isInteger(transporterIdNum) || transporterIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing transporterLedgerId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'new-start')
            .input('UserID', sql.Int, userIdNum)
            .input('TransporterLedgerID', sql.Int, transporterIdNum)
            .input('ModeOfTransport', sql.NVarChar(255), modeOfTransport)
            .input('VehicleNo', sql.NVarChar(255), vehicleNumber)
            .input('ContainerNo', sql.NVarChar(255), containerNumber)
            .input('SealNo', sql.NVarChar(255), sealNumber)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const normalized = {
            statusText: first.Status || first.status || null,
            transactionId: first.FGTransactionID || first.fgtransactionid || null,
            voucherNo: first.VoucherNo || first.voucherno || null,
            jobName: first.JobName || first.jobname || null,
            orderQty: first.OrderQty || first.OrderQty || first.orderqty || null,
            gpnQty: first.GPNQty || first.gpnqty || null,
            deliveredThisVoucher: first.DeliveredThisVoucher || first.deliveredthisvoucher || null,
            deliveredTotal: first.DeliveredTotal || first.deliveredtotal || null,
            cartonCount: first.CartonCt || first.cartonct || null,
            batchNo: first.BatchNo || first.batchno || null
        };

        // Handle known failure from SP (e.g., "Fail: Barcode already dispatched")
        const statusTextLower = (normalized.statusText || '').toString().toLowerCase();
        if (statusTextLower.startsWith('fail')) {
            let msg = normalized.statusText || 'Operation failed';
            if (statusTextLower.includes('barcode already dispatched')) {
                msg = 'Barcode already dispatched';
            }
            return res.json({ status: false, error: msg, sp: normalized });
        }

        return res.json({ 
            status: true,
            deliveryNoteNumber: normalized.voucherNo || '25-26/26',
            data: {
                clientName,
                modeOfTransport,
                containerNumber,
                sealNumber,
                transporterName,
                transporterLedgerId: transporterIdNum,
                vehicleNumber,
                barcode: barcodeNum
            },
            sp: normalized
        });
    } catch (err) {
        console.error('GRN save delivery note error:', err);
        return res.status(500).json({ status: false, error: 'Failed to save delivery note' });
    }
});

// GRN: Update Delivery Note (append line items)
router.post('/grn/update-delivery-note', async (req, res) => {
    try {
        const { barcode, database, userId, fgTransactionId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }
        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }
        const fgIdNum = Number(fgTransactionId);
        if (!Number.isInteger(fgIdNum) || fgIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing FGTransactionID' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'update')
            .input('UserID', sql.Int, userIdNum)
            .input('FGTransactionID', sql.Int, fgIdNum)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const normalized = {
            statusText: first.Status || first.status || null,
            transactionId: first.FGTransactionID || first.fgtransactionid || null,
            voucherNo: first.VoucherNo || first.voucherno || null,
            jobName: first.JobName || first.jobname || null,
            orderQty: first.OrderQty || first.orderqty || null,
            gpnQty: first.GPNQty || first.gpnqty || null,
            deliveredThisVoucher: first.DeliveredThisVoucher || first.deliveredthisvoucher || null,
            deliveredTotal: first.DeliveredTotal || first.deliveredtotal || null,
            cartonCount: first.CartonCt || first.cartonct || null,
            batchNo: first.BatchNo || first.batchno || null
        };

        // Fail handling
        const statusTextLower = (normalized.statusText || '').toString().toLowerCase();
        if (statusTextLower.startsWith('fail')) {
            return res.json({ status: false, error: normalized.statusText || 'Operation failed', sp: normalized });
        }

        return res.json({ status: true, sp: normalized });
    } catch (err) {
        console.error('GRN update delivery note error:', err);
        return res.status(500).json({ status: false, error: 'Failed to update delivery note' });
    }
});

// GRN: Delete Delivery Note entry for a barcode
router.post('/grn/delete-delivery-note', async (req, res) => {
    try {
        const { barcode, database, userId, companyId = 2, branchId = 0 } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const companyIdNum = Number(companyId);
        if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid companyId' });
        }

        const branchIdNum = Number(branchId);
        if (!Number.isInteger(branchIdNum)) {
            return res.status(400).json({ status: false, error: 'Invalid branchId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('UserID', sql.Int, userIdNum)
            .input('CompanyID', sql.Int, companyIdNum)
            .input('BranchID', sql.Int, branchIdNum)
            .execute('dbo.DeleteDeliveryNoteByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const statusText = first.Status || first.status || '';

        if (typeof statusText === 'string' && statusText.toLowerCase().startsWith('fail')) {
            return res.json({ status: false, error: statusText || 'Failed to delete delivery note', sp: first });
        }

        return res.json({
            status: true,
            message: 'Delivery note deleted successfully',
            sp: first
        });
    } catch (err) {
        console.error('GRN delete delivery note error:', err);
        return res.status(500).json({ status: false, error: 'Failed to delete delivery note' });
    }
});

// GRN: List Transporters for dropdown
router.get('/grn/transporters', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        const pool = await getPool(selectedDatabase);
        const result = await pool.request().query("SELECT ledgerid, ledgername FROM ledgermaster WHERE ledgertype LIKE 'trans%' AND ISNULL(IsDeletedTransaction, 0) = 0");
        const rows = (result.recordset || []).map(r => ({
            ledgerId: r.ledgerid,
            ledgerName: r.ledgername
        }));
        return res.json({ status: true, transporters: rows });
    } catch (err) {
        console.error('GRN transporters error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch transporters' });
    }
});

// GRN: Pending vouchers for delivery amount entry
router.get('/grn/pending-delivery-amount', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const columnCheck = await pool.request().query(`
            SELECT
                CASE WHEN COL_LENGTH('FinishGoodsTransactionMain', 'SealNo') IS NULL THEN 0 ELSE 1 END AS hasSealNo,
                CASE WHEN COL_LENGTH('FinishGoodsTransactionMain', 'NetAmount') IS NULL THEN 0 ELSE 1 END AS hasNetAmount;
        `);
        const hasSealNo = Number(columnCheck.recordset?.[0]?.hasSealNo) === 1;
        const hasNetAmount = Number(columnCheck.recordset?.[0]?.hasNetAmount) === 1;
        const transportTypeSelect = hasSealNo ? 'FGM.SealNo AS TransportType' : "CAST('local' AS NVARCHAR(200)) AS TransportType";
        const deliveryAmountSelect = hasNetAmount ? 'FGM.NetAmount AS DeliveryAmount' : 'CAST(NULL AS DECIMAL(18,2)) AS DeliveryAmount';

        const query = `
            SELECT
                FGM.FGTransactionID,
                FGM.VoucherNo,
                FGM.VoucherDate,
                FGM.VehicleNo,
                FGM.TransporterName,
                LM.ledgername AS Clientname,
                ${transportTypeSelect},
                ${deliveryAmountSelect}
            FROM FinishGoodsTransactionMain FGM
            JOIN LedgerMaster LM ON FGM.LedgerID = LM.LedgerID
            WHERE FGM.voucherid = -51
              AND FGM.VoucherDate > '2026-03-24'
              AND ISNULL(FGM.IsDeletedTransaction, 0) = 0
              AND LOWER(LTRIM(RTRIM(ISNULL(FGM.SealNo, '')))) <> 'local'
              AND ISNULL(FGM.NetAmount, 0) = 0
              AND NOT (
                    ISNULL(FGM.VehicleNo, '') LIKE '%3703%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%8123%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%3931%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%3212%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%1667%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%0549%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%2332%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%8600%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%9844%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%5034%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%9362%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%4695%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%2196%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%6354%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%5327%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%4614%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%2906%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%7585%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%6362%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%0342%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%7500%'
                 OR ISNULL(FGM.VehicleNo, '') LIKE '%6313%'
              )
              and isnull(FGM.IsDeletedTransaction, 0) = 0
            ORDER BY FGM.VoucherDate DESC;
        `;

        const result = await pool.request().query(query);
        const records = (result.recordset || []).map((row) => ({
            fgTransactionId: row.FGTransactionID ?? row.fgtransactionid,
            voucherNo: row.VoucherNo ?? row.voucherno ?? null,
            voucherDate: row.VoucherDate ?? row.voucherdate ?? null,
            vehicleNo: row.VehicleNo ?? row.vehicleno ?? null,
            transporterName: row.TransporterName ?? row.transportername ?? null,
            clientName: row.Clientname ?? row.clientname ?? null,
            transportType: String(row.TransportType || row.transporttype || '').trim().toLowerCase() === 'non local' ? 'non local' : 'local',
            deliveryAmount: row.DeliveryAmount ?? row.deliveryamount ?? null
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('GRN pending delivery amount error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch pending delivery amount records' });
    }
});

// GRN: Completed vouchers for delivery amount view
router.get('/grn/completed-delivery-amount', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const query = `
            SELECT
                FGM.FGTransactionID,
                FGM.VoucherNo,
                FGM.VoucherDate,
                FGM.VehicleNo,
                FGM.TransporterName,
                LM.ledgername AS Clientname,
                FGM.SealNo AS TransportType,
                FGM.NetAmount AS DeliveryAmount
            FROM FinishGoodsTransactionMain FGM
            JOIN LedgerMaster LM ON FGM.LedgerID = LM.LedgerID
            WHERE FGM.voucherid = -51
              AND FGM.VoucherDate > '2026-03-24'
              AND ISNULL(FGM.IsDeletedTransaction, 0) = 0
              AND (
                    LOWER(LTRIM(RTRIM(ISNULL(FGM.SealNo, '')))) = 'local'
                    OR ISNULL(FGM.NetAmount, 0) > 0
              )
            ORDER BY FGM.VoucherDate DESC;
        `;

        const result = await pool.request().query(query);
        const records = (result.recordset || []).map((row) => ({
            fgTransactionId: row.FGTransactionID ?? row.fgtransactionid,
            voucherNo: row.VoucherNo ?? row.voucherno ?? null,
            voucherDate: row.VoucherDate ?? row.voucherdate ?? null,
            vehicleNo: row.VehicleNo ?? row.vehicleno ?? null,
            transporterName: row.TransporterName ?? row.transportername ?? null,
            clientName: row.Clientname ?? row.clientname ?? null,
            transportType: String(row.TransportType || row.transporttype || '').trim().toLowerCase() === 'non local' ? 'non local' : 'local',
            deliveryAmount: row.DeliveryAmount ?? row.deliveryamount ?? null
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('GRN completed delivery amount error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch completed delivery amount records' });
    }
});

function pickGrnRowField(row, ...keys) {
    if (!row || typeof row !== 'object') return null;
    for (const key of keys) {
        const direct = normalizeGrnScalar(row[key]);
        if (direct != null && direct !== '') return direct;
        const target = String(key).toLowerCase();
        for (const [rk, rv] of Object.entries(row)) {
            if (String(rk).toLowerCase() === target) {
                const normalized = normalizeGrnScalar(rv);
                if (normalized != null && normalized !== '') return normalized;
            }
        }
    }
    return null;
}

function getGrnOrderedColumnKeys(recordset) {
    if (!recordset || !recordset.columns || typeof recordset.columns !== 'object') return [];
    const cols = recordset.columns;
    return Object.keys(cols).sort((a, b) => cols[a].index - cols[b].index);
}

function pickGrnRowFieldLoose(row, pattern) {
    if (!row || typeof row !== 'object') return null;
    for (const [rk, rv] of Object.entries(row)) {
        const normalized = String(rk).toLowerCase().replace(/[\s_]/g, '');
        if (pattern.test(normalized) && rv != null && rv !== '') return rv;
    }
    return null;
}

function pickGrnRowFieldByColumnPattern(row, recordset, pattern) {
    if (!row) return null;

    const loose = pickGrnRowFieldLoose(row, pattern);
    if (loose != null && loose !== '') return loose;

    const orderedKeys = getGrnOrderedColumnKeys(recordset);
    const cols = recordset?.columns;
    if (!cols || orderedKeys.length === 0) return null;

    for (const colKey of orderedKeys) {
        const col = cols[colKey];
        const colName = col?.metadata?.colName || colKey || '';
        const normalized = String(colName).toLowerCase().replace(/[\s_]/g, '');
        if (!pattern.test(normalized)) continue;

        const byKey = normalizeGrnScalar(row[colKey]);
        if (byKey != null && byKey !== '') return byKey;

        if (col?.index != null) {
            const byIndex = normalizeGrnScalar(row[col.index]);
            if (byIndex != null && byIndex !== '') return byIndex;
        }
    }
    return null;
}

function normalizeGrnScalar(value) {
    if (Array.isArray(value)) {
        return value.length ? value[0] : null;
    }
    return value;
}

function parseGrnPositiveInt(value) {
    const num = Number(normalizeGrnScalar(value));
    return Number.isInteger(num) && num > 0 ? num : null;
}

function parseGrnIsoDate(value, label) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        throw new Error(`Invalid or missing ${label} (expected yyyy-MM-dd)`);
    }
    return text;
}

// GRN: Processed delivery notes for Challan Detail screen
router.get('/grn/processed-delivery-notes', async (req, res) => {
    try {
        const { database, fromDate, toDate } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const fromDateStr = parseGrnIsoDate(fromDate, 'fromDate');
        const toDateStr = parseGrnIsoDate(toDate, 'toDate');

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('FromDate', sql.Date, fromDateStr)
            .input('ToDate', sql.Date, toDateStr)
            .execute('dbo.GetProcessedDeliveryNotes');

        const recordset = result.recordset || [];
        const records = recordset.map((row) => {
            const fgTransactionIdRaw = pickGrnRowField(
                row,
                'FGTransactionID',
                'FGTransactionId',
                'fgTransactionId',
                'FG Transaction ID',
                'FgTransactionID'
            ) ?? pickGrnRowFieldByColumnPattern(row, recordset, /^fgtransactionid$/);
            const fgTransactionId = parseGrnPositiveInt(fgTransactionIdRaw);
            const totalDeliveredCartons = pickGrnRowField(
                row,
                'Total Delivered Carton',
                'Total Delivered Cartons',
                'TotalDeliveredCarton',
                'TotalDeliveredCartons'
            ) ?? pickGrnRowFieldByColumnPattern(row, recordset, /^totaldeliveredcartons?$/);
            const totalQty = pickGrnRowField(row, 'Total Qty', 'TotalQty')
                ?? pickGrnRowFieldByColumnPattern(row, recordset, /^totalqty$/);
            const canUpdateRaw = pickGrnRowField(row, 'Update Challan Details', 'UpdateChallanDetails', 'CanUpdate')
                ?? pickGrnRowFieldByColumnPattern(row, recordset, /^updatechallandetails$/);
            const canUpdateExplicitFalse = canUpdateRaw === 0
                || canUpdateRaw === false
                || String(canUpdateRaw).trim().toLowerCase() === '0'
                || String(canUpdateRaw).trim().toLowerCase() === 'false'
                || String(canUpdateRaw).trim().toLowerCase() === 'no';
            const canUpdateExplicitTrue = canUpdateRaw === 1
                || canUpdateRaw === true
                || String(canUpdateRaw).trim() === '1'
                || String(canUpdateRaw).trim().toLowerCase() === 'true'
                || String(canUpdateRaw).trim().toLowerCase() === 'yes';

            return {
                fgTransactionId,
                deliveryNoteNo: pickGrnRowField(row, 'Delivery Note No.', 'DeliveryNoteNo', 'VoucherNo')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^deliverynoteno$/),
                deliveryNoteDate: pickGrnRowField(row, 'Delivery Note Date', 'DeliveryNoteDate', 'VoucherDate')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^deliverynotedate$/),
                clientName: pickGrnRowField(row, 'Client Name', 'ClientName', 'Clientname')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^clientname$/),
                poDate: pickGrnRowField(row, 'PO Date', 'PODate')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^podate$/),
                totalDeliveredCartons: totalDeliveredCartons != null ? Number(totalDeliveredCartons) : null,
                totalQty: totalQty != null ? Number(totalQty) : null,
                canUpdate: canUpdateExplicitFalse
                    ? false
                    : (canUpdateExplicitTrue || Boolean(fgTransactionId)),
                jobBookingId: pickGrnRowField(row, 'JobBookingID', 'JobBookingId')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^jobbookingid$/),
                jobBookingNo: pickGrnRowField(row, 'JobBookingNo', 'JobBookingNo')
                    ?? pickGrnRowFieldByColumnPattern(row, recordset, /^jobbookingno$/)
            };
        });

        return res.json({ status: true, records });
    } catch (err) {
        console.error('GRN processed delivery notes error:', err);
        const msg = err?.message || String(err);
        if (msg.includes('Invalid or missing fromDate') || msg.includes('Invalid or missing toDate')) {
            return res.status(400).json({ status: false, error: msg });
        }
        return res.status(500).json({ status: false, error: 'Failed to fetch processed delivery notes' });
    }
});

// GRN: GPNs pending for Delivery Note (no DN against the barcode yet)
router.get('/grn/pending-gpns-for-delivery-note', async (req, res) => {
    try {
        const { database, fromDate, toDate, companyId } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const fromDateStr = parseGrnIsoDate(fromDate, 'fromDate');
        const toDateStr = parseGrnIsoDate(toDate, 'toDate');
        const companyParsed = Number(companyId);
        const companyIdNum = Number.isInteger(companyParsed) && companyParsed > 0 ? companyParsed : 2;

        // Anti-join + sargable date range (avoids CAST/correlated NOT EXISTS timeouts)
        const pool = await getLongQueryPool(selectedDatabase);
        const request = pool.request();
        request.timeout = 180000;
        const result = await request
            .input('CompanyID', sql.Int, companyIdNum)
            .input('FromDate', sql.Date, fromDateStr)
            .input('ToDate', sql.Date, toDateStr)
            .query(`
                ;WITH GpnRows AS (
                    SELECT
                        d.Barcode,
                        d.JobBookingID,
                        d.CreatedDate,
                        m.VoucherNo
                    FROM FinishGoodsTransactionDetail AS d WITH (NOLOCK)
                    INNER JOIN FinishGoodsTransactionMain AS m WITH (NOLOCK)
                        ON d.FGTransactionID = m.FGTransactionID
                    WHERE ISNULL(d.ParentFGTransactionID, 0) = 0
                      AND ISNULL(d.IsDeletedTransaction, 0) = 0
                      AND ISNULL(m.IsDeletedTransaction, 0) = 0
                      AND d.CreatedDate >= @FromDate
                      AND d.CreatedDate < DATEADD(DAY, 1, @ToDate)
                ),
                DnBarcodes AS (
                    SELECT DISTINCT dn.Barcode
                    FROM FinishGoodsTransactionDetail AS dn WITH (NOLOCK)
                    INNER JOIN FinishGoodsTransactionMain AS dm WITH (NOLOCK)
                        ON dn.FGTransactionID = dm.FGTransactionID
                    INNER JOIN GpnRows AS g
                        ON g.Barcode = dn.Barcode
                    WHERE ISNULL(dn.ParentFGTransactionID, 0) > 0
                      AND ISNULL(dn.IsDeletedTransaction, 0) = 0
                      AND ISNULL(dm.IsDeletedTransaction, 0) = 0
                )
                SELECT
                    g.Barcode                                   AS BarcodeNo,
                    b.JobBookingNo                              AS JobNumber,
                    b.JobName                                   AS JobName,
                    l.LedgerName                                AS ClientName,
                    g.VoucherNo                                 AS GPNNo,
                    g.CreatedDate                               AS GPNDate,
                    DATEDIFF(DAY, g.CreatedDate, GETDATE())     AS DaysPending
                FROM GpnRows AS g
                INNER JOIN JobBookingJobCard AS b WITH (NOLOCK)
                    ON g.JobBookingID = b.JobBookingID
                   AND b.CompanyID = @CompanyID
                LEFT JOIN LedgerMaster AS l WITH (NOLOCK)
                    ON b.LedgerID = l.LedgerID
                LEFT JOIN DnBarcodes AS dn
                    ON dn.Barcode = g.Barcode
                WHERE dn.Barcode IS NULL
                ORDER BY g.CreatedDate DESC
            `);

        const records = (result.recordset || []).map((row) => ({
            barcodeNo: pickGrnRowField(row, 'BarcodeNo', 'Barcode'),
            jobNumber: pickGrnRowField(row, 'JobNumber', 'JobBookingNo'),
            jobName: pickGrnRowField(row, 'JobName'),
            clientName: pickGrnRowField(row, 'ClientName', 'LedgerName'),
            gpnNo: pickGrnRowField(row, 'GPNNo', 'VoucherNo'),
            gpnDate: pickGrnRowField(row, 'GPNDate', 'CreatedDate'),
            daysPending: (() => {
                const raw = pickGrnRowField(row, 'DaysPending');
                return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
            })()
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('GRN pending GPNs for delivery note error:', err);
        const msg = err?.message || String(err);
        if (msg.includes('Invalid or missing fromDate') || msg.includes('Invalid or missing toDate')) {
            return res.status(400).json({ status: false, error: msg });
        }
        return res.status(500).json({
            status: false,
            error: 'Failed to fetch pending GPNs',
            detail: msg
        });
    }
});

// GRN: Delivery note challan header for Update Challan Details screen
router.get('/grn/delivery-note-challan-details', async (req, res) => {
    try {
        const { database, fgTransactionId } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const fgId = Number(fgTransactionId);
        if (!Number.isInteger(fgId) || fgId <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing fgTransactionId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('FGTransactionID', sql.Int, fgId)
            .execute('dbo.GetDeliveryNoteChallanDetails');

        const row = (result.recordset || [])[0];
        if (!row) {
            return res.status(404).json({ status: false, error: 'Delivery note not found' });
        }

        const consigneeLedgerIdRaw = pickGrnRowField(row, 'ConsigneeLedgerID', 'ConsigneeLedgerId');
        const transporterLedgerIdRaw = pickGrnRowField(row, 'TransporterLedgerID', 'TransporterLedgerId');
        const clientIdRaw = pickGrnRowField(row, 'ClientID', 'ClientId');

        const details = {
            fgTransactionId: fgId,
            deliveryNoteNo: pickGrnRowField(row, 'DeliveryNoteNo', 'Delivery Note No.'),
            deliveryNoteDate: pickGrnRowField(row, 'DeliveryNoteDate', 'Delivery Note Date'),
            clientId: clientIdRaw != null ? Number(clientIdRaw) : null,
            clientName: pickGrnRowField(row, 'ClientName', 'Client Name'),
            consigneeLedgerId: consigneeLedgerIdRaw != null ? Number(consigneeLedgerIdRaw) : null,
            consigneeName: pickGrnRowField(row, 'ConsigneeName', 'Consignee Name'),
            modeOfTransport: pickGrnRowField(row, 'ModeOfTransport', 'Mode Of Transport'),
            transporterLedgerId: transporterLedgerIdRaw != null ? Number(transporterLedgerIdRaw) : null,
            transporterName: pickGrnRowField(row, 'TransporterName', 'Transporter Name'),
            vehicleNo: pickGrnRowField(row, 'VehicleNo', 'Vehicle No'),
            podNo: pickGrnRowField(row, 'PODNo', 'POD No'),
            containerNo: pickGrnRowField(row, 'ContainerNo', 'Container No'),
            sealNo: pickGrnRowField(row, 'SealNo', 'Seal No'),
            remark: pickGrnRowField(row, 'Remark')
        };

        return res.json({ status: true, details });
    } catch (err) {
        console.error('GRN delivery note challan details error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch delivery note challan details' });
    }
});

// GRN: Consignee options for Update Challan Details dropdown
router.get('/grn/consignees', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request().query(`
            SELECT LedgerID, LedgerName
            FROM LedgerMaster
            WHERE LedgerType = 'Consignee'
              AND ISNULL(IsDeleted, 0) = 0
              AND ISNULL(IsDeletedTransaction, 0) = 0
            ORDER BY LedgerName;
        `);

        const consignees = (result.recordset || []).map((row) => ({
            ledgerId: row.LedgerID ?? row.ledgerid ?? null,
            ledgerName: row.LedgerName ?? row.ledgername ?? ''
        }));

        return res.json({ status: true, consignees });
    } catch (err) {
        console.error('GRN consignees error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch consignees' });
    }
});

// GRN: Update delivery note challan header (Update Challan Details screen)
router.post('/grn/update-delivery-note-challan-details', async (req, res) => {
    try {
        const {
            database,
            userId,
            fgTransactionId,
            consigneeLedgerId,
            modeOfTransport,
            transporterLedgerId,
            vehicleNo,
            podNo,
            containerNo,
            sealNo,
            remark
        } = req.body || {};

        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const fgId = Number(fgTransactionId);
        if (!Number.isInteger(fgId) || fgId <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing fgTransactionId' });
        }

        const transporterIdNum = Number(transporterLedgerId);
        if (!Number.isInteger(transporterIdNum) || transporterIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing transporterLedgerId' });
        }

        const modeText = String(modeOfTransport || '').trim();
        const vehicleText = String(vehicleNo || '').trim();
        if (!modeText || !vehicleText) {
            return res.status(400).json({ status: false, error: 'Mode of transport and vehicle number are required' });
        }

        const consigneeIdNum = consigneeLedgerId == null || consigneeLedgerId === ''
            ? 0
            : Number(consigneeLedgerId);
        if (!Number.isInteger(consigneeIdNum) || consigneeIdNum < 0) {
            return res.status(400).json({ status: false, error: 'Invalid consigneeLedgerId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('FGTransactionID', sql.Int, fgId)
            .input('UserID', sql.Int, userIdNum)
            .input('ConsigneeLedgerID', sql.Int, consigneeIdNum)
            .input('ModeOfTransport', sql.NVarChar(255), modeText)
            .input('TransporterLedgerID', sql.Int, transporterIdNum)
            .input('VehicleNo', sql.NVarChar(255), vehicleText)
            .input('PODNo', sql.NVarChar(255), String(podNo || '').trim())
            .input('ContainerNo', sql.NVarChar(255), String(containerNo || '').trim())
            .input('SealNo', sql.NVarChar(255), String(sealNo || '').trim())
            .input('Remark', sql.NVarChar(1000), String(remark || '').trim())
            .execute('dbo.UpdateDeliveryNoteHeader_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const statusText = pickGrnRowField(first, 'Status', 'Result', 'Message') || '';
        const statusLower = String(statusText).toLowerCase();
        if (statusLower !== 'success') {
            return res.json({
                status: false,
                error: statusText || 'Update failed',
                sp: first
            });
        }

        return res.json({
            status: true,
            message: statusText || 'Challan details updated successfully',
            sp: first
        });
    } catch (err) {
        console.error('GRN update delivery note challan details error:', err);
        return res.status(500).json({ status: false, error: 'Failed to update delivery note challan details' });
    }
});

// GRN: Download dispatch details PDF for a delivery note
router.get('/grn/delivery-note-dispatch-pdf', async (req, res) => {
    try {
        const { database, voucherNo, username } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const voucherNoText = String(voucherNo || '').trim();
        if (!voucherNoText) {
            return res.status(400).json({ status: false, error: 'Invalid or missing voucherNo' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('VoucherNo', sql.NVarChar(255), voucherNoText)
            .execute('dbo.GetDeliveryNoteDetailsByBarcode_Manu');

        const headerRow = (result.recordsets?.[0] || result.recordset || [])[0];
        const header = normalizeDispatchHeader(headerRow);
        if (!header) {
            return res.status(404).json({ status: false, error: 'Delivery note not found' });
        }

        const statusLower = String(header.status || '').toLowerCase();
        if (statusLower && statusLower !== 'success') {
            return res.status(400).json({ status: false, error: header.status || 'Failed to load delivery note details' });
        }

        const lineRows = result.recordsets?.[1] || [];
        const lines = lineRows.map(normalizeDispatchLine).filter(Boolean);

        const pdfBytes = await generateDispatchNotePdf(header, lines, {
            createdBy: String(username || '').trim()
        });

        const safeName = voucherNoText.replace(/[^\w.-]+/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Dispatch_${safeName}.pdf"`);
        return res.send(Buffer.from(pdfBytes));
    } catch (err) {
        console.error('GRN delivery note dispatch PDF error:', err);
        return res.status(500).json({ status: false, error: 'Failed to generate dispatch PDF' });
    }
});

// GRN: Pending purchase orders where GRN is not fully delivered
router.get('/grn/pending-po-not-fully-delivered', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const query = `
            SELECT
    ITM_PO.VoucherNo                                        AS PONumber,
    ITM_PO.TransactionID                                    AS POTransactionID,
    ITD_PO.TransactionDetailID                                AS PODetailID,
    ITD_PO.ItemID                                           AS ItemID,
    ITD_PO.PurchaseTransactionID                            AS PurchaseTransactionID,
    ITM_PO.VoucherDate                                      AS PODate,
    ITD_PO.ExpectedDeliveryDate,
    IM.ItemCode,
    IM.ItemName,
    IM.Quality,
    IM.GSM,
    IM.SizeW,
    IM.SizeL,
    IM.StockUnit,
    IGM.ItemGroupName,
    LM.LedgerName                                           AS Supplier,

    -- PO qty in StockUnit
    CASE
        WHEN UPPER(IM.StockUnit) = 'KG'
        THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
        ELSE ISNULL(ITD_PO.ChallanWeight, 0)
    END                                                     AS POQty,

    -- Total GRN received so far
    ISNULL(GRN.ReceivedQty, 0)                              AS ReceivedQty,

    -- Balance still pending
    CASE
        WHEN UPPER(IM.StockUnit) = 'KG'
        THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
        ELSE ISNULL(ITD_PO.ChallanWeight, 0)
    END - ISNULL(GRN.ReceivedQty, 0)                       AS PendingQty,

    -- % received (for visibility / debugging)
    CASE
        WHEN
            CASE
                WHEN UPPER(IM.StockUnit) = 'KG'
                THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
                ELSE ISNULL(ITD_PO.ChallanWeight, 0)
            END = 0 THEN 0
        ELSE
            ISNULL(GRN.ReceivedQty, 0) * 100.0 /
            CASE
                WHEN UPPER(IM.StockUnit) = 'KG'
                THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
                ELSE ISNULL(ITD_PO.ChallanWeight, 0)
            END
    END                                                     AS PctReceived,

    -- Job component this PO was raised for (if job-linked)
    ITD_PO.RefJobBookingJobCardContentsID                   AS JBJCC_ID,
    JEJ.JobBookingNo,
    JEJ.JobName,
    ITD_PO.TransactionDetailID

FROM dbo.ItemTransactionMain  ITM_PO
JOIN dbo.ItemTransactionDetail ITD_PO
    ON  ITD_PO.TransactionID         = ITM_PO.TransactionID
JOIN dbo.ItemMaster IM
    ON  IM.ItemID                    = ITD_PO.ItemID
LEFT JOIN dbo.ItemGroupMaster IGM
    ON  IGM.ItemGroupID              = IM.ItemGroupID
LEFT JOIN dbo.LedgerMaster LM
    ON  LM.LedgerID                  = ITM_PO.LedgerID

-- Aggregate GRN receipts for this PO line
LEFT JOIN (
    SELECT
        ITD_GRN.PurchaseTransactionID,
        ITD_GRN.ItemID,
        SUM(ISNULL(ITD_GRN.ReceiptQuantity, 0)) AS ReceivedQty
    FROM dbo.ItemTransactionDetail  ITD_GRN
    JOIN dbo.ItemTransactionMain    ITM_GRN
        ON  ITM_GRN.TransactionID             = ITD_GRN.TransactionID
    WHERE ITM_GRN.VoucherID                   = -14   -- GRN
      AND ISNULL(ITD_GRN.IsDeletedTransaction, 0) = 0
      AND ISNULL(ITM_GRN.IsDeletedTransaction, 0) = 0
      AND ISNULL(ITD_GRN.IsCancelled, 0)          = 0
    GROUP BY ITD_GRN.PurchaseTransactionID, ITD_GRN.ItemID
) GRN
    ON  GRN.PurchaseTransactionID    = ITM_PO.TransactionID
    AND GRN.ItemID                   = ITD_PO.ItemID

-- Job card (if this PO was job-linked via alloc's RefJBJCC)
LEFT JOIN dbo.JobBookingJobCard JEJ
    ON  JEJ.JobBookingID = (
            SELECT TOP 1 JEJC.JobBookingID
            FROM dbo.JobBookingJobCardContents JEJC
            WHERE JEJC.JobBookingJobCardContentsID = ITD_PO.RefJobBookingJobCardContentsID
        )

WHERE ITM_PO.VoucherID                          = -11   -- Purchase Orders only
  AND ISNULL(ITD_PO.IsDeletedTransaction, 0)    = 0
  AND ISNULL(ITM_PO.IsDeletedTransaction, 0)    = 0
  AND ISNULL(ITD_PO.IsCancelled, 0)             = 0
  AND ISNULL(ITD_PO.IsCompleted, 0)             = 0   -- NEW: exclude completed PO lines

  -- Pending qty > 0  (not fully received)
  AND (
        CASE
            WHEN UPPER(IM.StockUnit) = 'KG'
            THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
            ELSE ISNULL(ITD_PO.ChallanWeight, 0)
        END - ISNULL(GRN.ReceivedQty, 0)
      ) > 0

  -- NEW: exclude POs where receipt is >= 90% of ordered qty
  AND (
        CASE
            WHEN
                CASE
                    WHEN UPPER(IM.StockUnit) = 'KG'
                    THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
                    ELSE ISNULL(ITD_PO.ChallanWeight, 0)
                END = 0 THEN 1    -- guard: qty 0 treated as 'not yet received'
            ELSE
                CASE
                    WHEN ISNULL(GRN.ReceivedQty, 0) * 1.0 /
                        CASE
                            WHEN UPPER(IM.StockUnit) = 'KG'
                            THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
                            ELSE ISNULL(ITD_PO.ChallanWeight, 0)
                        END < 0.9 THEN 1
                    ELSE 0
                END
        END = 1
      )

  -- Exclude Kraft (remove this line if you want Kraft too)
  AND ISNULL(IM.Quality, '') NOT LIKE '%Kraft%'

ORDER BY ITD_PO.ExpectedDeliveryDate, ITM_PO.VoucherDate;
        `;

        const result = await pool.request().query(query);
        const records = (result.recordset || []).map((row) => ({
            poTransactionId: row.POTransactionID ?? row.potransactionid ?? null,
            itemId: row.ItemID ?? row.itemid ?? null,
            poNumber: row.PONumber ?? row.ponumber ?? null,
            poDate: row.PODate ?? row.podate ?? null,
            expectedDeliveryDate: row.ExpectedDeliveryDate ?? row.expecteddeliverydate ?? null,
            itemCode: row.ItemCode ?? row.itemcode ?? '',
            itemName: row.ItemName ?? row.itemname ?? '',
            itemGroupName: row.ItemGroupName ?? row.itemgroupname ?? '',
            quality: row.Quality ?? row.quality ?? '',
            gsm: Number(row.GSM ?? row.gsm ?? 0),
            sizeW: Number(row.SizeW ?? row.sizew ?? 0),
            sizeL: Number(row.SizeL ?? row.sizel ?? 0),
            stockUnit: row.StockUnit ?? row.stockunit ?? '',
            supplier: row.Supplier ?? row.supplier ?? '',
            poQty: Number(row.POQty ?? row.poqty ?? 0),
            receivedQty: Number(row.ReceivedQty ?? row.receivedqty ?? 0),
            pendingQty: Number(row.PendingQty ?? row.pendingqty ?? 0),
            jbjccId: row.JBJCC_ID ?? row.jbjcc_id ?? null,
            jobBookingNo: row.JobBookingNo ?? row.jobbookingno ?? '',
            jobName: row.JobName ?? row.jobname ?? ''
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('GRN pending PO not fully delivered error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch pending PO records' });
    }
});

// GRN: Update expected delivery date for pending PO row
router.post('/grn/pending-po-expected-delivery-date', async (req, res) => {
    try {
        const { database, poTransactionId, itemId, itemCode, newExpectedDeliveryDate } = req.body || {};
        const selectedDatabase = String(database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeExpectedDate = String(newExpectedDeliveryDate || '').trim();
        if (!dateRegex.test(safeExpectedDate)) {
            return res.status(400).json({ status: false, error: 'Invalid newExpectedDeliveryDate. Expected YYYY-MM-DD.' });
        }

        const txId = Number(poTransactionId || 0);
        const itmId = Number(itemId || 0);
        const safeItemCode = String(itemCode || '').trim();

        if (!(Number.isInteger(txId) && txId > 0) || !(Number.isInteger(itmId) && itmId > 0)) {
            return res.status(400).json({ status: false, error: 'Missing row identifiers. Provide poTransactionId and itemId.' });
        }
        if (!safeItemCode) {
            return res.status(400).json({ status: false, error: 'Missing itemCode.' });
        }

        const pool = await getPool(selectedDatabase);

        const verifyRequest = pool.request()
            .input('POTransactionID', sql.Int, txId)
            .input('ItemID', sql.Int, itmId)
            .input('ItemCode', sql.NVarChar(100), safeItemCode);

        const verifyResult = await verifyRequest.query(`
            SELECT TOP 1
                ITM_PO.TransactionID AS POTransactionID,
                ITD_PO.ItemID AS ItemID,
                IM.ItemCode AS ItemCode,
                ITM_PO.VoucherNo AS PONumber,
                ITD_PO.ExpectedDeliveryDate,
                CASE
                    WHEN UPPER(IM.StockUnit) = 'KG'
                    THEN ISNULL(ITD_PO.PurchaseOrderQuantity, 0)
                    ELSE ISNULL(ITD_PO.ChallanWeight, 0)
                END - ISNULL(GRN.ReceivedQty, 0) AS PendingQty
            FROM dbo.ItemTransactionMain ITM_PO
            JOIN dbo.ItemTransactionDetail ITD_PO
                ON ITD_PO.TransactionID = ITM_PO.TransactionID
            JOIN dbo.ItemMaster IM
                ON IM.ItemID = ITD_PO.ItemID
            LEFT JOIN (
                SELECT
                    ITD_GRN.PurchaseTransactionID,
                    ITD_GRN.ItemID,
                    SUM(ISNULL(ITD_GRN.ReceiptQuantity, 0)) AS ReceivedQty
                FROM dbo.ItemTransactionDetail ITD_GRN
                JOIN dbo.ItemTransactionMain ITM_GRN
                    ON ITM_GRN.TransactionID = ITD_GRN.TransactionID
                WHERE ITM_GRN.VoucherID = -14
                  AND ISNULL(ITD_GRN.IsDeletedTransaction, 0) = 0
                  AND ISNULL(ITM_GRN.IsDeletedTransaction, 0) = 0
                  AND ISNULL(ITD_GRN.IsCancelled, 0) = 0
                GROUP BY ITD_GRN.PurchaseTransactionID, ITD_GRN.ItemID
            ) GRN
                ON GRN.PurchaseTransactionID = ITM_PO.TransactionID
                AND GRN.ItemID = ITD_PO.ItemID
            WHERE ITM_PO.TransactionID = @POTransactionID
              AND ITD_PO.ItemID = @ItemID
              AND LTRIM(RTRIM(ISNULL(IM.ItemCode, ''))) = LTRIM(RTRIM(@ItemCode))
              AND ITM_PO.VoucherID = -11
              AND ISNULL(ITD_PO.IsDeletedTransaction, 0) = 0
              AND ISNULL(ITD_PO.IsCompleted, 0) = 0
              AND ISNULL(ITM_PO.IsDeletedTransaction, 0) = 0
              AND ISNULL(ITD_PO.IsCancelled, 0) = 0;
        `);

        if (!(verifyResult.recordset || []).length) {
            return res.status(404).json({ status: false, error: 'Target PO row not found or inactive.' });
        }

        const targetRow = verifyResult.recordset[0];
        const pendingQty = Number(targetRow.PendingQty || 0);
        if (!(pendingQty > 0)) {
            return res.status(400).json({ status: false, error: 'Expected delivery date can only be updated for rows with pending quantity.' });
        }

        const updateRequest = pool.request()
            .input('POTransactionID', sql.Int, txId)
            .input('ItemID', sql.Int, itmId)
            .input('ItemCode', sql.NVarChar(100), safeItemCode)
            .input('NewExpectedDeliveryDate', sql.Date, safeExpectedDate);

        const updateResult = await updateRequest.query(`
            UPDATE ITD_PO
            SET ITD_PO.ExpectedDeliveryDate = @NewExpectedDeliveryDate
            FROM dbo.ItemTransactionDetail ITD_PO
            JOIN dbo.ItemTransactionMain ITM_PO
                ON ITM_PO.TransactionID = ITD_PO.TransactionID
            JOIN dbo.ItemMaster IM
                ON IM.ItemID = ITD_PO.ItemID
            WHERE ITM_PO.TransactionID = @POTransactionID
              AND ITD_PO.ItemID = @ItemID
              AND LTRIM(RTRIM(ISNULL(IM.ItemCode, ''))) = LTRIM(RTRIM(@ItemCode))
              AND ITM_PO.VoucherID = -11
              AND ISNULL(ITD_PO.IsDeletedTransaction, 0) = 0
              AND ISNULL(ITM_PO.IsDeletedTransaction, 0) = 0
              AND ISNULL(ITD_PO.IsCancelled, 0) = 0;
        `);

        if (!(updateResult.rowsAffected || []).some((count) => count > 0)) {
            return res.status(400).json({ status: false, error: 'No rows updated. Please refresh and try again.' });
        }

        return res.json({
            status: true,
            message: 'Expected delivery date updated successfully.',
            record: {
                poNumber: targetRow.PONumber ?? null,
                poTransactionId: targetRow.POTransactionID ?? null,
                itemId: targetRow.ItemID ?? null,
                itemCode: targetRow.ItemCode ?? null,
                expectedDeliveryDate: safeExpectedDate
            }
        });
    } catch (err) {
        console.error('GRN pending PO expected delivery date update error:', err);
        return res.status(500).json({ status: false, error: 'Failed to update expected delivery date' });
    }
});

// Inventory Summary Tool: itemwise by item group
router.get('/inventory-summary/group', async (req, res) => {
    try {
        const { database, fromDate, toDate } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeFromDate = String(fromDate || '').trim();
        const safeToDate = String(toDate || '').trim();
        if (!dateRegex.test(safeFromDate) || !dateRegex.test(safeToDate)) {
            return res.status(400).json({ status: false, error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.' });
        }
        if (safeFromDate > safeToDate) {
            return res.status(400).json({ status: false, error: 'fromDate cannot be after toDate' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('StartDate', sql.Date, safeFromDate)
            .input('EndDate', sql.Date, safeToDate)
            .execute('dbo.GetInventorySummaryByGroup');

        const records = (result.recordset || []).map((row) => ({
            itemGroup: row.ItemGroup ?? row.itemgroup ?? '',
            itemId: row.ItemID ?? row.itemid ?? null,
            itemName: row.ItemName ?? row.itemname ?? '',
            quality: row.Quality ?? row.quality ?? '',
            gsm: row.GSM ?? row.gsm ?? 0,
            sizeW: row.SizeW ?? row.sizew ?? 0,
            sizeL: row.SizeL ?? row.sizel ?? 0,
            stockUnit: row.StockUnit ?? row.stockunit ?? '',
            openingKg: row.Opening_KG ?? row.opening_kg ?? 0,
            stockInKg: row.StockIn_KG ?? row.stockin_kg ?? 0,
            stockOutKg: row.StockOut_KG ?? row.stockout_kg ?? 0,
            closingKg: row.Closing_KG ?? row.closing_kg ?? 0
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('Inventory summary group error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch inventory summary' });
    }
});

// Inventory Summary Tool: categorywise issued (stock out by business category)
router.get('/inventory-summary/categorywise-issued', async (req, res) => {
    try {
        const { database, fromDate, toDate } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeFromDate = String(fromDate || '').trim();
        const safeToDate = String(toDate || '').trim();
        if (!dateRegex.test(safeFromDate) || !dateRegex.test(safeToDate)) {
            return res.status(400).json({ status: false, error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.' });
        }
        if (safeFromDate > safeToDate) {
            return res.status(400).json({ status: false, error: 'fromDate cannot be after toDate' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('StartDate', sql.Date, safeFromDate)
            .input('EndDate', sql.Date, safeToDate)
            .input('Category', sql.VarChar(20), null)
            .execute('dbo.GetStockOutByBusinessCategory');

        const detailRaw = (result.recordsets && result.recordsets[0]) || [];
        const summaryRaw = (result.recordsets && result.recordsets[1]) || [];

        const detail = detailRaw.map((row) => ({
            businessCategory: row.BusinessCategory ?? row.businesscategory ?? '',
            issueDate: row.IssueDate ?? row.issuedate ?? null,
            voucherNo: row.VoucherNo ?? row.voucherno ?? '',
            issueType: row.IssueType ?? row.issuetype ?? '',
            jobBookingNo: row.JobBookingNo ?? row.jobbookingno ?? null,
            jobName: row.JobName ?? row.jobname ?? null,
            clientName: row.ClientName ?? row.clientname ?? null,
            salesPerson: row.SalesPerson ?? row.salesperson ?? null,
            segmentName: row.SegmentName ?? row.segmentname ?? null,
            categoryId: row.CategoryID ?? row.categoryid ?? null,
            itemId: row.ItemID ?? row.itemid ?? null,
            itemName: row.ItemName ?? row.itemname ?? null,
            quality: row.Quality ?? row.quality ?? '',
            gsm: row.GSM ?? row.gsm ?? null,
            sizeW: row.SizeW ?? row.sizew ?? null,
            sizeL: row.SizeL ?? row.sizel ?? null,
            stockUnit: row.StockUnit ?? row.stockunit ?? '',
            itemGroup: row.ItemGroup ?? row.itemgroup ?? '',
            stockOutQty: row.StockOut_Qty ?? row.stockout_qty ?? 0,
            stockOutKg: row.StockOut_KG ?? row.stockout_kg ?? 0,
            rate: row.Rate ?? row.rate ?? 0,
            stockOutValue: row.StockOut_Value ?? row.stockout_value ?? 0,
            isJobLinked: row.IsJobLinked ?? row.isjoblinked ?? 0
        }));

        const summary = summaryRaw.map((row) => ({
            businessCategory: row.BusinessCategory ?? row.businesscategory ?? '',
            issueLines: row.IssueLines ?? row.issuelines ?? 0,
            jobs: row.Jobs ?? row.jobs ?? 0,
            firstIssueDate: row.FirstIssueDate ?? row.firstissuedate ?? null,
            lastIssueDate: row.LastIssueDate ?? row.lastissuedate ?? null,
            stockOutKg: row.StockOut_KG ?? row.stockout_kg ?? 0,
            stockOutValue: row.StockOut_Value ?? row.stockout_value ?? 0
        }));

        return res.json({ status: true, detail, summary });
    } catch (err) {
        console.error('Inventory summary categorywise-issued error:', err);
        const msg = String(err?.message || '');
        if (/StartDate|EndDate|mandatory|must not precede|cannot be after/i.test(msg)) {
            return res.status(400).json({ status: false, error: msg || 'Invalid date range' });
        }
        return res.status(500).json({ status: false, error: 'Failed to fetch categorywise issued data' });
    }
});

// Inventory Summary Tool: jobwise issued (job issue register)
router.get('/inventory-summary/jobwise-issued', async (req, res) => {
    try {
        const { database, fromDate, toDate } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeFromDate = String(fromDate || '').trim();
        const safeToDate = String(toDate || '').trim();
        if (!dateRegex.test(safeFromDate) || !dateRegex.test(safeToDate)) {
            return res.status(400).json({ status: false, error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.' });
        }
        if (safeFromDate > safeToDate) {
            return res.status(400).json({ status: false, error: 'fromDate cannot be after toDate' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('FromDate', sql.Date, safeFromDate)
            .input('ToDate', sql.Date, safeToDate)
            .input('CompanyID', sql.Int, 2)
            .input('JobBookingID', sql.Int, null)
            .input('Mode', sql.VarChar(20), 'DATEJOB')
            .input('IncludeUnissued', sql.Bit, 0)
            .input('ApplyGangPaper', sql.Bit, 1)
            .input('VoucherID', sql.Int, -19)
            .input('MatchLevel', sql.VarChar(20), 'JOB')
            .input('GsmTolerance', sql.Int, 10)
            .execute('dbo.rpt_job_issue_register_v9');

        const pick = (row, ...names) => {
            for (let i = 0; i < names.length; i += 1) {
                const want = String(names[i]).toLowerCase();
                if (Object.prototype.hasOwnProperty.call(row, names[i]) && row[names[i]] !== undefined) {
                    return row[names[i]];
                }
                const keys = Object.keys(row);
                for (let j = 0; j < keys.length; j += 1) {
                    if (String(keys[j]).toLowerCase() === want) return row[keys[j]];
                }
            }
            return null;
        };

        const records = (result.recordset || []).map((row) => ({
            issueDate: pick(row, 'Date', 'IssueDate', 'issueDate'),
            issuedItems: pick(row, 'Issued Items', 'IssuedItems', 'issuedItems') ?? '',
            itemGroup: pick(row, 'item Group', 'ItemGroup', 'itemGroup') ?? '',
            jobNum: pick(row, 'JobNUm', 'JobNum', 'JobNo', 'JobBookingNo', 'jobNum') ?? '',
            jobName: pick(row, 'Job Name', 'JobName', 'jobName') ?? '',
            clientName: pick(row, 'Client', 'ClientName', 'clientName') ?? '',
            requiredQty: pick(row, 'Required as per Job', 'RequiredQty', 'requiredQty') ?? 0,
            issuedQty: pick(row, 'Issued Qty (In same unit as required)', 'IssuedQty', 'issuedQty') ?? 0,
            openingIssued: pick(row, 'Opening Issued', 'OpeningIssued', 'openingIssued') ?? 0,
            cumulativeIssued: pick(row, 'Cumulative Issued', 'CumulativeIssued', 'cumulativeIssued') ?? 0,
            unit: pick(row, 'Unit', 'unit') ?? '',
            excessShort: pick(row, 'Excess/(Short)', 'ExcessShort', 'excessShort') ?? 0,
            varPct: pick(row, 'Var %', 'VarPct', 'varPct') ?? 0,
            issuedCost: pick(row, 'Issued Cost', 'IssuedCost', 'issuedCost') ?? 0
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('Inventory summary jobwise-issued error:', err);
        const msg = String(err?.message || '');
        if (/FromDate|ToDate|mandatory|must not precede|cannot be after/i.test(msg)) {
            return res.status(400).json({ status: false, error: msg || 'Invalid date range' });
        }
        return res.status(500).json({ status: false, error: 'Failed to fetch jobwise issued data' });
    }
});

// Inventory Summary Tool: clientwise stock movement
router.get('/inventory-summary/clientwise', async (req, res) => {
    try {
        const { database, fromDate, toDate, companyId } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeFromDate = String(fromDate || '').trim();
        const safeToDate = String(toDate || '').trim();
        if (!dateRegex.test(safeFromDate) || !dateRegex.test(safeToDate)) {
            return res.status(400).json({ status: false, error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.' });
        }
        if (safeFromDate > safeToDate) {
            return res.status(400).json({ status: false, error: 'fromDate cannot be after toDate' });
        }

        const companyIdNum = Number(companyId || 2);
        if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid companyId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('StartDate', sql.Date, safeFromDate)
            .input('EndDate', sql.Date, safeToDate)
            .input('CompanyId', sql.Int, companyIdNum)
            .execute('dbo.GetClientWiseStockMovement');

        const records = (result.recordset || []).map((row) => ({
            clientName: row.ClientName ?? row.clientname ?? '',
            clientId: row.ClientID ?? row.clientid ?? null,
            itemGroupId: row.ItemGroupID ?? row.itemgroupid ?? null,
            itemId: row.ItemID ?? row.itemid ?? null,
            itemName: row.ItemName ?? row.itemname ?? '',
            openingStockKg: row.OpeningStockKG ?? row.openingstockkg ?? 0,
            receiptKg: row.ReceiptKG ?? row.receiptkg ?? 0,
            issueKg: row.IssueKG ?? row.issuekg ?? 0,
            closingStockKg: row.ClosingStockKG ?? row.closingstockkg ?? 0
        }));

        return res.json({ status: true, records });
    } catch (err) {
        console.error('Inventory summary clientwise error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch clientwise stock movement' });
    }
});

// Inventory Summary Tool: Top 200 PO records where ClientID is null/0
router.get('/inventory-summary/po-no-client-top200', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request().execute('dbo.GetUntaggedClientStock');

        const records = (result.recordset || [])
            .map((row) => ({
                poTransactionId: row.POTransactionID ?? row.potransactionid ?? null,
                sourceType: row.SourceType ?? row.sourcetype ?? '',
                sourceTransactionId: row.SourceTransactionID ?? row.sourcetransactionid ?? null,
                pono: row.PONumber ?? row.ponumber ?? '',
                poDate: row.PODate ?? row.podate ?? null,
                clientName: row.CurrentClientName ?? row.currentclientname ?? '',
                itemId: row.ItemID ?? row.itemid ?? null,
                itemName: row.ItemName ?? row.itemname ?? '',
                itemCode: row.ItemCode ?? row.itemcode ?? '',
                stockKg: row.StockKG ?? row.stockkg ?? 0
            }))
            .filter((row) => Number(row.stockKg) > 1000);

        return res.json({ status: true, records });
    } catch (err) {
        console.error('Inventory Summary PO no-client error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch top 200 PO (no client)' });
    }
});

// Google Sheets parity: GetItemDetailsWithBufferTotal_Manu — column subset matches Apps Script colMap (1-based JDBC indices).
const STOCK_BUFFER_JDBC_COL_INDEX_ONE_BASED = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 22, 19];
const STOCK_BUFFER_HEADER_KEYS = [
    'itemCode',
    'itemName',
    'sizeW',
    'sizeL',
    'quality',
    'gsm',
    'manufacturer',
    'certification',
    'stockUnit',
    'stock',
    'freeStock',
    'clientName',
    'stockType'
];

function getStockBufferOrderedColumnNames(recordset) {
    if (!recordset || !recordset.columns || typeof recordset.columns !== 'object') return null;
    const cols = recordset.columns;
    return Object.keys(cols).sort((a, b) => cols[a].index - cols[b].index);
}

function mapStockBufferProcedureRows(recordset) {
    if (!Array.isArray(recordset) || recordset.length === 0) return [];
    const orderedNames = getStockBufferOrderedColumnNames(recordset);
    if (!orderedNames || orderedNames.length === 0) {
        return recordset.map((row) => ({ ...row }));
    }
    return recordset.map((row) => {
        const out = {};
        STOCK_BUFFER_JDBC_COL_INDEX_ONE_BASED.forEach((jdbc1, i) => {
            const idx = jdbc1 - 1;
            const prop = STOCK_BUFFER_HEADER_KEYS[i];
            if (idx < 0 || idx >= orderedNames.length) {
                out[prop] = '';
                return;
            }
            const colKey = orderedNames[idx];
            const v = row[colKey];
            out[prop] = v == null ? '' : String(v);
        });
        return out;
    });
}

// Inventory Summary Tool: stock search (dbo.GetItemDetailsWithBufferTotal_Manu)
// SP: @Quality NVARCHAR(255), @GSM INT, @SizeW FLOAT, @SizeL FLOAT (optional → NULL), @CompanyID INT
// Body: { database, quality, gsm, deckle → @SizeW, sizeL? (omit or null = not passed as NULL), companyId? (default 2) }
router.post('/inventory-summary/stock-search-buffer', async (req, res) => {
    try {
        const { database, deckle, gsm, quality, sizeL, companyId } = req.body || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const qualityStr = String(quality ?? '').trim().slice(0, 255);
        if (!qualityStr) {
            return res.status(400).json({ status: false, error: 'Quality is required' });
        }

        const gsmNum = parseInt(String(gsm), 10);
        if (!Number.isFinite(gsmNum)) {
            return res.status(400).json({ status: false, error: 'GSM must be a valid integer' });
        }

        const sizeWNum = parseFloat(String(deckle));
        if (!Number.isFinite(sizeWNum) || sizeWNum < 0) {
            return res.status(400).json({ status: false, error: 'Deckle (Size W) must be a valid non-negative number' });
        }

        let sizeLVal = null;
        if (sizeL !== undefined && sizeL !== null && String(sizeL).trim() !== '') {
            const parsedL = parseFloat(String(sizeL));
            if (!Number.isFinite(parsedL) || parsedL < 0) {
                return res.status(400).json({ status: false, error: 'Size L must be a valid non-negative number if provided' });
            }
            sizeLVal = parsedL;
        }

        let companyIdNum = parseInt(String(companyId ?? ''), 10);
        if (!Number.isFinite(companyIdNum) || companyIdNum <= 0) {
            companyIdNum = 2;
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool
            .request()
            .input('Quality', sql.NVarChar(255), qualityStr)
            .input('GSM', sql.Int, gsmNum)
            .input('SizeW', sql.Float, sizeWNum)
            .input('SizeL', sql.Float, sizeLVal)
            .input('CompanyID', sql.Int, companyIdNum)
            .execute('dbo.GetItemDetailsWithBufferTotal_Manu');

        const raw = result.recordset || [];
        const records = mapStockBufferProcedureRows(raw);
        return res.json({ status: true, records, rowCount: records.length });
    } catch (err) {
        console.error('Inventory summary stock-search-buffer error:', err);
        return res.status(500).json({
            status: false,
            error: err.message || 'Failed to search stock with buffer'
        });
    }
});

// Inventory Summary Tool — normalize all-tab-summary rows so every SELECT column is a stable JSON key
// (mssql may use different property casing; ensures TopSalesExecutive is always present for the UI).
function pickInventoryRowFieldCaseInsensitive(row, fieldName) {
    if (row == null || typeof row !== 'object') return null;
    const want = String(fieldName).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
        const direct = row[fieldName];
        return direct === undefined ? null : direct;
    }
    const keys = Object.keys(row);
    for (let i = 0; i < keys.length; i += 1) {
        if (String(keys[i]).toLowerCase() === want) {
            const v = row[keys[i]];
            return v === undefined ? null : v;
        }
    }
    const own = Object.getOwnPropertyNames(row);
    for (let i = 0; i < own.length; i += 1) {
        const k = own[i];
        if (String(k).toLowerCase() === want) {
            const v = row[k];
            return v === undefined ? null : v;
        }
    }
    return null;
}

const INVENTORY_ALL_TAB_SUMMARY_FIELDS = [
    'ItemID',
    'ItemCode',
    'ItemGroup',
    'SubGroup',
    'ItemName',
    'PhysicalStockInPU',
    'PurchaseUnit',
    'PhysicalStockSU',
    'StockUnit',
    'GSM',
    'ClientRef',
    'TopSalesExecutive',
    'IncomingStock',
    'allocatedstock',
    'FreeStock',
    'Manufecturer',
    'SizeL',
    'SizeW',
    'Quality',
    'CertificationType',
    'LastPONO',
    'LastPODate',
    'StockStatus',
    'LastGRNNO',
    'LastGRNDate',
    'Aging'
];

function mapInventoryAllTabSummaryRows(recordset) {
    const rows = Array.isArray(recordset) ? recordset : [];
    const fieldLc = new Set(INVENTORY_ALL_TAB_SUMMARY_FIELDS.map((f) => String(f).toLowerCase()));
    return rows.map((row) => {
        const out = {};
        for (let i = 0; i < INVENTORY_ALL_TAB_SUMMARY_FIELDS.length; i += 1) {
            const field = INVENTORY_ALL_TAB_SUMMARY_FIELDS[i];
            out[field] = pickInventoryRowFieldCaseInsensitive(row, field);
        }
        const keys = Object.keys(row);
        for (let j = 0; j < keys.length; j += 1) {
            const k = keys[j];
            if (fieldLc.has(String(k).toLowerCase())) continue;
            if (!Object.prototype.hasOwnProperty.call(out, k)) {
                out[k] = row[k];
            }
        }
        return out;
    });
}

// Inventory Summary Tool: all tab summary
router.get('/inventory-summary/all-tab-summary', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request().query(`
            SELECT
                ItemID,
                ItemCode,
                ItemGroup,
                SubGroup,
                ItemName,
                PhysicalStockInPU,
                PurchaseUnit,
                PhysicalStockSU,
                StockUnit,
                GSM,
                ClientRef,
                TopSalesExecutive,
                IncomingStock,
                allocatedstock,
                FreeStock,
                Manufecturer,
                SizeL,
                SizeW,
                Quality,
                CertificationType,
                LastPONO,
                LastPODate,
                StockStatus,
                LastGRNNO,
                LastGRNDate,
                CASE
                    WHEN LastGRNDate IS NULL THEN NULL
                    ELSE DATEDIFF(DAY, CAST(LastGRNDate AS DATE), CAST(GETDATE() AS DATE))
                END AS Aging
            FROM NewStockReportView_MS
            WHERE physicalstocksu > 0
              AND ItemGroupID IN (2, 14)
            ORDER BY PhysicalStockInPU DESC;
        `);

        const records = mapInventoryAllTabSummaryRows(result.recordset || []);
        return res.json({ status: true, records });
    } catch (err) {
        console.error('Inventory summary all-tab-summary error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch all tab summary' });
    }
});

// Inventory Summary Tool: client list for dropdown
router.get('/inventory-summary/client-names', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request().query(`
            SELECT DISTINCT
                ledgername AS LedgerName,
                ledgerid   AS LedgerID
            FROM ledgermaster
            WHERE (ledgertype = 'Sundry Debtors' OR ledgertype = 'Clients')
              AND ISNULL(IsDeletedTransaction, 0) = 0
            ORDER BY ledgername;
        `);

        const clients = (result.recordset || []).map((row) => ({
            ledgerId: row.LedgerID ?? row.ledgerid ?? null,
            ledgerName: row.LedgerName ?? row.ledgername ?? ''
        }));

        return res.json({ status: true, clients });
    } catch (err) {
        console.error('Inventory summary client-names error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch client names' });
    }
});

// Inventory Summary Tool: update PO detail ClientID from UI
router.post('/inventory-summary/po-noclient-update-client', async (req, res) => {
    try {
        const {
            database,
            poTransactionId,
            itemId,
            newClientId,
            sourceType,
            sourceTransactionId
        } = req.body || {};

        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const normalizedSourceType = String(sourceType || 'PO').trim().toUpperCase();
        const isPoSource = normalizedSourceType === 'PO';

        const poTransactionIdNum = Number(poTransactionId);
        if (isPoSource && (!Number.isInteger(poTransactionIdNum) || poTransactionIdNum <= 0)) {
            return res.status(400).json({ status: false, error: 'Invalid poTransactionId' });
        }

        const itemIdNum = Number(itemId);
        if (!Number.isInteger(itemIdNum) || itemIdNum <= 0) return res.status(400).json({ status: false, error: 'Invalid itemId' });

        const newClientIdNum = Number(newClientId);
        if (!Number.isInteger(newClientIdNum) || newClientIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid newClientId' });
        }

        const sourceTransactionIdNum = Number(sourceTransactionId);
        if (!isPoSource && (!Number.isInteger(sourceTransactionIdNum) || sourceTransactionIdNum <= 0)) {
            return res.status(400).json({ status: false, error: 'Invalid sourceTransactionId' });
        }

        const pool = await getPool(selectedDatabase);

        console.log('potractionid', poTransactionIdNum);
        console.log('itemid', itemIdNum);
        console.log('newclientid', newClientIdNum);
        console.log('sourceTransactionId', sourceTransactionIdNum);
        console.log('sourceType', normalizedSourceType);

        const updateResult = await pool.request()
            .input('POTransactionID', sql.Int, poTransactionIdNum)
            .input('SourceType', sql.VarChar(20), normalizedSourceType)
            .input('SourceTransactionID', sql.Int, isPoSource ? poTransactionIdNum : sourceTransactionIdNum)
            .input('ItemID', sql.Int, itemIdNum)
            .input('NewClientID', sql.Int, newClientIdNum)
            .query(`
                IF @SourceType = 'PO'
                BEGIN
                    UPDATE d
                    SET d.ClientID = @NewClientID
                    FROM dbo.ItemTransactionDetail d
                    WHERE d.TransactionID = @POTransactionID
                      AND d.ItemID = @ItemID
                      AND ISNULL(d.IsDeletedTransaction, 0) = 0
                      AND (d.ClientID = 0 OR d.ClientID IS NULL OR d.ClientID <> @NewClientID);
                END
                ELSE
                BEGIN
                    UPDATE d
                    SET d.ClientID = @NewClientID
                    FROM dbo.ItemTransactionDetail d
                    WHERE d.TransactionID = @SourceTransactionID
                      AND d.ItemID = @ItemID
                      AND ISNULL(d.IsDeletedTransaction, 0) = 0
                      AND (d.ClientID = 0 OR d.ClientID IS NULL OR d.ClientID <> @NewClientID);
                END
            `);

        

        return res.json({
            status: true,
            rowsAffected: updateResult?.rowsAffected?.[0] ?? updateResult?.rowsAffected ?? null
        });
    } catch (err) {
        console.error('PO no-client update error:', err);
        return res.status(500).json({ status: false, error: 'Failed to update PO client' });
    }
});

// CDC Invoice Wise Inventory: purchase invoice register (dbo.GetPurchaseInvoiceRegister_Manu)
router.get('/invoice-wise-inventory/purchase-register', async (req, res) => {
    try {
        const { database, fromDate, toDate, supplierLedgerId, invoiceTransactionId } = req.query || {};
        const selectedDatabase = String(database || '').trim().toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const safeFromDate = String(fromDate || '').trim();
        const safeToDate = String(toDate || '').trim();
        if (!dateRegex.test(safeFromDate) || !dateRegex.test(safeToDate)) {
            return res.status(400).json({ status: false, error: 'Invalid fromDate/toDate. Expected YYYY-MM-DD.' });
        }
        if (safeFromDate > safeToDate) {
            return res.status(400).json({ status: false, error: 'fromDate cannot be after toDate' });
        }

        let supplierLedgerIdNum = null;
        if (supplierLedgerId != null && String(supplierLedgerId).trim() !== '') {
            const parsed = parseInt(String(supplierLedgerId), 10);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                return res.status(400).json({ status: false, error: 'Invalid supplierLedgerId' });
            }
            supplierLedgerIdNum = parsed;
        }

        let invoiceTransactionIdNum = null;
        if (invoiceTransactionId != null && String(invoiceTransactionId).trim() !== '') {
            const parsed = parseInt(String(invoiceTransactionId), 10);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                return res.status(400).json({ status: false, error: 'Invalid invoiceTransactionId' });
            }
            invoiceTransactionIdNum = parsed;
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('FromDate', sql.Date, safeFromDate)
            .input('ToDate', sql.Date, safeToDate)
            .input('SupplierLedgerID', sql.Int, supplierLedgerIdNum)
            .input('InvoiceTransactionID', sql.Int, invoiceTransactionIdNum)
            .execute('dbo.GetPurchaseInvoiceRegister_Manu');

        const pick = (row, ...keys) => {
            for (const key of keys) {
                if (row[key] != null && row[key] !== '') return row[key];
            }
            return '';
        };

        const formatDateField = (value) => {
            if (value instanceof Date) return value.toISOString().slice(0, 10);
            return String(value || '').slice(0, 10);
        };

        const records = (result.recordset || []).map((row) => ({
            supplier: pick(row, 'Supplier'),
            clientRef: pick(row, 'ClientRef'),
            itemId: Number(pick(row, 'ItemID', 'ItemId') || 0) || null,
            item: pick(row, 'Item'),
            uom: pick(row, 'UOM'),
            vendorInvNum: pick(row, 'Vendor Inv Num', 'VendorInvNum'),
            vendorInvoiceDate: formatDateField(pick(row, 'Vendor Invoice Date', 'VendorInvoiceDate')),
            indusPurchaseInvNumber: pick(row, 'Indus Purchase Inv Number', 'IndusPurchaseInvNumber'),
            grnNum: pick(row, 'GRN Num', 'GRNNum'),
            grnDate: formatDateField(pick(row, 'GRN Date', 'GRNDate')),
            poNumber: pick(row, 'PO Number', 'PONumber'),
            poDate: formatDateField(pick(row, 'PO Date', 'PODate')),
            wt: Number(pick(row, 'WT') || 0),
            rate: Number(pick(row, 'Rate') || 0),
            value: Number(pick(row, 'Value') || 0),
            taxableValue: Number(pick(row, 'Taxable Value', 'TaxableValue') || 0),
            cgst: Number(pick(row, 'CGST') || 0),
            sgst: Number(pick(row, 'SGST') || 0),
            igst: Number(pick(row, 'IGST') || 0),
            total: Number(pick(row, 'Total') || 0)
        }));

        return res.json({
            status: true,
            database: selectedDatabase,
            fromDate: safeFromDate,
            toDate: safeToDate,
            count: records.length,
            records
        });
    } catch (err) {
        console.error('Invoice wise inventory purchase register error:', err);
        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes('could not find stored procedure')) {
            return res.status(502).json({
                status: false,
                error: 'Stored procedure dbo.GetPurchaseInvoiceRegister_Manu was not found on this database.'
            });
        }
        return res.status(500).json({ status: false, error: 'Failed to fetch purchase invoice register' });
    }
});

// GRN: Save delivery amount entries
router.post('/grn/save-delivery-amount', async (req, res) => {
    let transaction = null;
    try {
        const { database, userId, entries } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        if (!Array.isArray(entries) || entries.length === 0) {
            return res.status(400).json({ status: false, error: 'No entries provided' });
        }

        const pool = await getPool(selectedDatabase);
        const columnCheck = await pool.request().query(`
            SELECT
                CASE WHEN COL_LENGTH('FinishGoodsTransactionMain', 'SealNo') IS NULL THEN 0 ELSE 1 END AS hasSealNo,
                CASE WHEN COL_LENGTH('FinishGoodsTransactionMain', 'NetAmount') IS NULL THEN 0 ELSE 1 END AS hasNetAmount;
        `);
        const hasSealNo = Number(columnCheck.recordset?.[0]?.hasSealNo) === 1;
        const hasNetAmount = Number(columnCheck.recordset?.[0]?.hasNetAmount) === 1;
        if (!hasSealNo && !hasNetAmount) {
            return res.status(400).json({
                status: false,
                error: 'FinishGoodsTransactionMain does not contain SealNo/NetAmount columns in this database.'
            });
        }

        transaction = new sql.Transaction(pool);
        await transaction.begin();
        let updatedCount = 0;

        for (const item of entries) {
            const fgTransactionId = Number(item?.fgTransactionId);
            const transportTypeRaw = String(item?.transportType || '').trim().toLowerCase();
            const transportType = transportTypeRaw === 'non local' ? 'non local' : 'local';
            const deliveryAmount = transportType === 'non local'
                ? Number(item?.deliveryAmount)
                : null;

            if (!Number.isInteger(fgTransactionId) || fgTransactionId <= 0) {
                continue;
            }
            if (transportType === 'non local' && !Number.isFinite(deliveryAmount)) {
                throw new Error(`Delivery amount is required for FGTransactionID ${fgTransactionId}`);
            }

            const request = new sql.Request(transaction);
            request.input('FGTransactionID', sql.Int, fgTransactionId);
            const setClauses = [];
            if (hasSealNo && transportType === 'local') {
                request.input('SealNo', sql.NVarChar(200), transportType);
                setClauses.push('SealNo = @SealNo');
            }
            if (hasNetAmount) {
                request.input('NetAmount', sql.Decimal(18, 2), transportType === 'non local' ? deliveryAmount : 0);
                setClauses.push('NetAmount = @NetAmount');
            }
            if (setClauses.length === 0) {
                continue;
            }
            await request.query(`
                UPDATE FinishGoodsTransactionMain
                SET
                    ${setClauses.join(',\n                    ')}
                WHERE FGTransactionID = @FGTransactionID
                  AND ISNULL(IsDeletedTransaction, 0) = 0;
            `);

            const deliveryCostForDetail = transportType === 'non local' ? deliveryAmount : 0;
            const detailRequest = new sql.Request(transaction);
            detailRequest.input('FGTransactionID', sql.Int, fgTransactionId);
            detailRequest.input('DeliveryCost', sql.Decimal(18, 2), Number.isFinite(deliveryCostForDetail) ? deliveryCostForDetail : 0);
            await detailRequest.query(`
                WITH CTE AS (
                    SELECT
                        fgtd.FGTransactionDetailID,
                        fgtd.FGTransactionID,
                        fgtd.jobbookingid,
                        fgtd.quantityperpack,
                        (fgtd.quantityperpack * jobd.ChangeCost)
                        / NULLIF(SUM(fgtd.quantityperpack * jobd.ChangeCost) OVER (PARTITION BY fgtd.FGTransactionID), 0)
                        * @DeliveryCost AS totalcft
                    FROM FinishGoodsTransactionDetail fgtd
                    INNER JOIN JobBookingJobCard jbjc
                        ON fgtd.jobbookingid = jbjc.jobbookingid
                    INNER JOIN JobOrderBookingDetails jobd
                        ON jbjc.orderbookingid = jobd.orderbookingid
                    WHERE fgtd.FGTransactionID = @FGTransactionID
                      AND (fgtd.IsDeletedTransaction IS NULL OR fgtd.IsDeletedTransaction = 0)
                      AND (fgtd.IsDeleted IS NULL OR fgtd.IsDeleted = 0)
                )
                UPDATE fgtd
                SET
                    totalcft = cte.totalcft,
                    cft = cte.totalcft / NULLIF(cte.quantityperpack, 0)
                FROM FinishGoodsTransactionDetail fgtd
                INNER JOIN CTE cte
                    ON fgtd.FGTransactionDetailID = cte.FGTransactionDetailID
                WHERE fgtd.FGTransactionID = @FGTransactionID
                  AND (fgtd.IsDeletedTransaction IS NULL OR fgtd.IsDeletedTransaction = 0)
                  AND (fgtd.IsDeleted IS NULL OR fgtd.IsDeleted = 0);
            `);
            updatedCount += 1;
        }

        // Bulk fallback update on save click:
        // 1) Set NetAmount = 20000 for non-SEA rows where NetAmount is 0
        // 2) Recompute detail-level cft/totalcft for the same FGTransactionIDs with DeliveryCost = 20000
        const bulkRequest = new sql.Request(transaction);
        await bulkRequest.query(`
            DECLARE @Target TABLE (
                FGTransactionID INT PRIMARY KEY
            );

            UPDATE fgm
            SET fgm.NetAmount = 20000
            OUTPUT INSERTED.FGTransactionID INTO @Target(FGTransactionID)
            FROM FinishGoodsTransactionMain fgm
            WHERE ISNULL(fgm.IsDeletedTransaction, 0) = 0
              AND ISNULL(fgm.NetAmount, 0) = 0
              AND ISNULL(fgm.ModeOfTransport, '') LIKE '%SEA%';

            ;WITH CTE AS (
                SELECT
                    fgtd.FGTransactionDetailID,
                    fgtd.FGTransactionID,
                    fgtd.jobbookingid,
                    fgtd.quantityperpack,
                    (fgtd.quantityperpack * jobd.ChangeCost)
                    / NULLIF(SUM(fgtd.quantityperpack * jobd.ChangeCost) OVER (PARTITION BY fgtd.FGTransactionID), 0)
                    * 20000 AS totalcft
                FROM FinishGoodsTransactionDetail fgtd
                INNER JOIN JobBookingJobCard jbjc
                    ON fgtd.jobbookingid = jbjc.jobbookingid
                INNER JOIN JobOrderBookingDetails jobd
                    ON jbjc.orderbookingid = jobd.orderbookingid
                INNER JOIN @Target t
                    ON t.FGTransactionID = fgtd.FGTransactionID
                WHERE (fgtd.IsDeletedTransaction IS NULL OR fgtd.IsDeletedTransaction = 0)
                  AND (fgtd.IsDeleted IS NULL OR fgtd.IsDeleted = 0)
            )
            UPDATE fgtd
            SET
                totalcft = cte.totalcft,
                cft = cte.totalcft / NULLIF(cte.quantityperpack, 0)
            FROM FinishGoodsTransactionDetail fgtd
            INNER JOIN CTE cte
                ON fgtd.FGTransactionDetailID = cte.FGTransactionDetailID
            WHERE (fgtd.IsDeletedTransaction IS NULL OR fgtd.IsDeletedTransaction = 0)
              AND (fgtd.IsDeleted IS NULL OR fgtd.IsDeleted = 0);
        `);

        await transaction.commit();
        return res.json({ status: true, updatedCount });
    } catch (err) {
        if (transaction) {
            try { await transaction.rollback(); } catch (_) {}
        }
        console.error('GRN save delivery amount error:', err);
        return res.status(500).json({ status: false, error: err?.message || 'Failed to save delivery amount entries' });
    }
});

// GRN: Barcode status lookup across Packing Slip, GPN, and Delivery Note
router.post('/grn/barcode-status', async (req, res) => {
    try {
        const { barcode, database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        console.log(`[BARCODE STATUS] Lookup requested for barcode ${barcodeNum} (${selectedDatabase})`);

        const pool = await getPool(selectedDatabase);
        const request = pool.request();
        request.input('BarcodeNo', sql.Int, barcodeNum);

        const query = `
            SELECT
                'packing-slip' AS Category,
                p.[DateTime] AS EventDate,
                b.JobBookingNo
            FROM PackingSlipBarcodeEntry AS p
            INNER JOIN jobbookingjobcard AS b ON p.JobBookingID = b.JobBookingID
            WHERE p.BarcodeNo = @BarcodeNo

            UNION

            SELECT
                'GPN' AS Category,
                p.CreatedDate AS EventDate,
                b.JobBookingNo
            FROM FinishGoodsTransactionDetail AS p
            INNER JOIN jobbookingjobcard AS b ON p.JobBookingID = b.JobBookingID
            INNER JOIN FinishGoodsTransactionMain AS p2 ON p.FGTransactionID = p2.FGTransactionID
            WHERE p.Barcode = @BarcodeNo
              AND ISNULL(p.ParentFGTransactionID, 0) = 0
              AND ISNULL(p.IsDeletedTransaction, 0) = 0
              AND ISNULL(p2.IsDeletedTransaction, 0) = 0

            UNION

            SELECT
                'Delivery Note' AS Category,
                p.CreatedDate AS EventDate,
                b.JobBookingNo
            FROM FinishGoodsTransactionDetail AS p
            INNER JOIN jobbookingjobcard AS b ON p.JobBookingID = b.JobBookingID
            INNER JOIN FinishGoodsTransactionMain AS p2 ON p.FGTransactionID = p2.FGTransactionID
            WHERE p.Barcode = @BarcodeNo
              AND ISNULL(p.ParentFGTransactionID, 0) > 0
              AND ISNULL(p.IsDeletedTransaction, 0) = 0
              AND ISNULL(p2.IsDeletedTransaction, 0) = 0
        `;

        const result = await request.query(query);
        const records = result.recordset || [];

        console.log(`[BARCODE STATUS] Records found: ${records.length}`);
        if (records.length > 0) {
            console.log('[BARCODE STATUS] First record:', records[0]);
        }

        return res.json({
            status: true,
            records
        });
    } catch (err) {
        console.error('[BARCODE STATUS] Error fetching status:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch barcode status' });
    }
});

// GPN Portal - Save Finish Goods by Barcode
router.post('/gpn/save-finish-goods', async (req, res) => {
    try {
        const { barcode, database, userId, companyId = 2, branchId = 0, status = 'new', fgTransactionId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const companyIdNum = Number(companyId);
        if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid companyId' });
        }

        const branchIdNum = Number(branchId);
        if (!Number.isInteger(branchIdNum)) {
            return res.status(400).json({ status: false, error: 'Invalid branchId' });
        }

        // For update status, FGTransactionID is required
        if (status === 'update') {
            const fgIdNum = Number(fgTransactionId);
            if (!Number.isInteger(fgIdNum) || fgIdNum <= 0) {
                return res.status(400).json({ status: false, error: 'Invalid or missing FGTransactionID for update status' });
            }
        }

        console.log(`[GPN] Calling SaveFinishGoodsByBarcode_Manu_v2`);
        console.log(`  - BarcodeNo: ${barcodeNum}`);
        console.log(`  - Status: ${status}`);
        console.log(`  - UserID: ${userIdNum}`);
        console.log(`  - CompanyID: ${companyIdNum}`);
        console.log(`  - BranchID: ${branchIdNum}`);
        if (fgTransactionId) {
            console.log(`  - FGTransactionID: ${fgTransactionId}`);
        }
        console.log(`  - Database: ${selectedDatabase}`);

        const pool = await getPool(selectedDatabase);
        const request = pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), status)
            .input('UserID', sql.Int, userIdNum)
            .input('CompanyID', sql.Int, companyIdNum)
            .input('BranchID', sql.Int, branchIdNum);

        // Only add FGTransactionID parameter if it's provided (for update status)
        if (fgTransactionId) {
            request.input('FGTransactionID', sql.Int, Number(fgTransactionId));
        }

        const result = await request.execute('dbo.SaveFinishGoodsByBarcode_Manu_v2');

        const rows = result.recordset || [];
        console.log(`[GPN] Stored procedure executed. Rows returned: ${rows.length}`);
        console.log(`[GPN] Request barcode: ${barcodeNum}, Status: ${status}`);
        if (fgTransactionId) {
            console.log(`[GPN] Input FGTransactionID: ${fgTransactionId}`);
        }
        
        if (rows.length > 0) {
            console.log('[GPN] Procedure response (first row):', JSON.stringify(rows[0], null, 2));
            const first = rows[0];
            const returnedFgId = first.FGTransactionID || first.fgtransactionid || first.FGTransactionId || null;
            if (returnedFgId) {
                console.log(`[GPN] Returned FGTransactionID: ${returnedFgId}`);
            } else {
                console.log('[GPN] WARNING: No FGTransactionID in response');
            }
        } else {
            console.log('[GPN] Procedure response: <no rows>');
        }

        // Check for error status in response
        const first = rows[0] || {};
        const statusText = first.Status || first.status || '';
        
        if (typeof statusText === 'string' && statusText.toLowerCase().startsWith('fail')) {
            console.log(`[GPN] Procedure returned failure: ${statusText}`);
            return res.json({
                status: false,
                error: statusText || 'Failed to save finish goods'
            });
        }

        console.log(`[GPN] Success response being sent to client`);
        return res.json({
            status: true,
            message: 'Finish goods saved successfully',
            data: first
        });
    } catch (err) {
        console.error('[GPN] Error saving finish goods:', err);
        return res.status(500).json({ 
            status: false, 
            error: 'Failed to save finish goods: ' + (err.message || 'Unknown error')
        });
    }
});

// GPN Portal - Delete Finish Goods entry for a barcode
router.post('/gpn/delete-finish-goods', async (req, res) => {
    try {
        const { barcode, database, userId, companyId = 2, branchId = 0 } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const companyIdNum = Number(companyId);
        if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid companyId' });
        }

        const branchIdNum = Number(branchId);
        if (!Number.isInteger(branchIdNum)) {
            return res.status(400).json({ status: false, error: 'Invalid branchId' });
        }

        console.log(`[GPN DELETE] Calling DeleteFinishGoodsByBarcode_Manu`);
        console.log(`  - BarcodeNo: ${barcodeNum}`);
        console.log(`  - UserID: ${userIdNum}`);
        console.log(`  - CompanyID: ${companyIdNum}`);
        console.log(`  - BranchID: ${branchIdNum}`);
        console.log(`  - Database: ${selectedDatabase}`);

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('UserID', sql.Int, userIdNum)
            .input('CompanyID', sql.Int, companyIdNum)
            .input('BranchID', sql.Int, branchIdNum)
            .execute('dbo.DeleteFinishGoodsByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const statusText = first.Status || first.status || '';

        if (typeof statusText === 'string' && statusText.toLowerCase().startsWith('fail')) {
            console.log(`[GPN DELETE] Procedure returned failure: ${statusText}`);
            return res.json({
                status: false,
                error: statusText || 'Failed to delete finish goods entry',
                sp: first
            });
        }

        console.log(`[GPN DELETE] Success response being sent to client`);
        return res.json({
            status: true,
            message: 'Finish goods entry deleted successfully',
            sp: first
        });
    } catch (err) {
        console.error('[GPN DELETE] Error deleting finish goods:', err);
        return res.status(500).json({
            status: false,
            error: 'Failed to delete finish goods entry'
        });
    }
});

// Get machine floor screen data for a specific machine
router.get('/machine-floor/:machineId', async (req, res) => {
    try {
        const { machineId } = req.params;
        const { database = 'KOL' } = req.query || {};

        const machineIdNum = Number(machineId);
        if (!Number.isInteger(machineIdNum) || machineIdNum <= 0) {
            return res.status(400).json({
                status: false,
                error: 'machineId must be a positive integer'
            });
        }

        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({
                status: false,
                error: 'Invalid or missing database (must be KOL or AHM)'
            });
        }

        console.log(`[MACHINE-FLOOR] Fetching screen data for MachineID ${machineIdNum} (${selectedDatabase})`);

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('MachineID', sql.Int, machineIdNum)
            .execute('GetMachineFloorScreenData');

        const raw = (result.recordset && result.recordset.length > 0)
            ? result.recordset[0]
            : null;

        if (!raw) {
            let machineName = null;
            try {
                const nameResult = await pool.request()
                    .input('MachineID', sql.Int, machineIdNum)
                    .query(`
                        SELECT TOP 1 MachineName
                        FROM dbo.MachineMaster
                        WHERE MachineID = @MachineID AND ISNULL(IsDeletedTransaction, 0) = 0
                    `);
                if (nameResult.recordset && nameResult.recordset.length > 0) {
                    const nm = nameResult.recordset[0];
                    machineName = nm.MachineName ?? nm.machinename ?? null;
                }
            } catch (nameErr) {
                console.error('[MACHINE-FLOOR] Failed to resolve machine name from MachineMaster:', nameErr);
            }
            return res.json({
                status: false,
                noFloorData: true,
                machineId: machineIdNum,
                machineName,
                error: 'No floor screen data returned for this machine'
            });
        }

        const normalizeBoolean = (value) => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'number') return value === 1;
            if (typeof value === 'string') {
                const trimmed = value.trim().toLowerCase();
                return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
            }
            return false;
        };

        const normalized = {
            MachineID: raw.MachineID ?? raw.machineid ?? machineIdNum,
            MachineName: raw.MachineName ?? raw.machinename ?? null,
            MachineStatus: raw.MachineStatus ?? raw.machinestatus ?? null,
            IsRunning: normalizeBoolean(raw.IsRunning ?? raw.isrunning),
            CurrentJobNumber: raw.CurrentJobNumber ?? raw.currentjobnumber ?? null,
            CurrentJobName: raw.CurrentJobName ?? raw.currentjobname ?? null,
            CurrentJobStartedAt: raw.CurrentJobStartedAt ?? raw.currentjobstartedat ?? null,
            RunningSinceMinutes: raw.RunningSinceMinutes ?? raw.runningsinceminutes ?? null,
            PlanQty: raw.PlanQty ?? raw.planqty ?? null,
            ProducedQty: raw.ProducedQty ?? raw.producedqty ?? null,
            RemainingQty: raw.RemainingQty ?? raw.remainingqty ?? null,
            MachineSpeedUPM: raw.MachineSpeedUPM ?? raw.machinespeedupm ?? null,
            ChangeOverMinutes: raw.ChangeOverMinutes ?? raw.changeoverminutes ?? null,
            TargetMinutesToFinish: raw.TargetMinutesToFinish ?? raw.targetminutestofinish ?? null,
            TargetFinishAt: raw.TargetFinishAt ?? raw.targetfinishat ?? null,
            IsBehindSchedule: normalizeBoolean(raw.IsBehindSchedule ?? raw.isbehindschedule),
            StatusColor: raw.StatusColor ?? raw.statuscolor ?? null,
            LastCompletedJobNumber: raw.LastCompletedJobNumber ?? raw.lastcompletedjobnumber ?? null,
            LastCompletedJobName: raw.LastCompletedJobName ?? raw.lastcompletedjobname ?? null,
            LastCompletedAt: raw.LastCompletedAt ?? raw.lastcompletedat ?? null,
            IdleSinceMinutes: raw.IdleSinceMinutes ?? raw.idlesinceminutes ?? null,
            BacklogJobsOnMachine: raw.BacklogJobsOnMachine ?? raw.backlogjobsonmachine ?? null,
            BacklogJobsForProcess: raw.BacklogJobsForProcess ?? raw.backlogjobsforprocess ?? null
        };

        return res.json({
            status: true,
            data: normalized,
            message: 'Machine floor data retrieved successfully'
        });
    } catch (error) {
        console.error('[MACHINE-FLOOR] Error fetching data:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to fetch machine floor data'
        });
    }
});

// Get latest machine status per machine
router.post('/machine-status/latest', async (req, res) => {
    try {
        const { database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ 
                status: false, 
                error: 'Invalid or missing database (must be KOL or AHM)' 
            });
        }

        console.log(`[MACHINE-STATUS] Getting latest machine status for database: ${selectedDatabase}`);
        
        const pool = await getPool(selectedDatabase);
        
        // Execute the stored procedure
        const result = await pool.request()
            .execute('GetLatestMachineStatusPerMachine');
        
        console.log(`[MACHINE-STATUS] Query completed. Records found: ${result.recordset?.length || 0}`);
        
        // Log first record for debugging
        if (result.recordset && result.recordset.length > 0) {
            console.log('[MACHINE-STATUS] First record columns:', Object.keys(result.recordset[0]));
            console.log('[MACHINE-STATUS] First record data:', result.recordset[0]);
        }
        
        return res.json({
            status: true,
            data: result.recordset || [],
            message: 'Machine statuses retrieved successfully'
        });
    } catch (error) {
        console.error('[MACHINE-STATUS] Error getting machine statuses:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to get machine statuses: ' + error.message
        });
    }
});

// Get Process Inspection Template for QC Audit
router.post('/qc/inspection-template', async (req, res) => {
    try {
        const { processId, database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ 
                status: false, 
                error: 'Invalid or missing database (must be KOL or AHM)' 
            });
        }

        // Use the ProcessID from the request (from GetLatestMachineStatusPerMachine output)
        if (!processId) {
            return res.status(400).json({
                status: false,
                error: 'ProcessID is required'
            });
        }
        
        console.log(`[QC-INSPECTION] Getting inspection template for ProcessID: ${processId}, Database: ${selectedDatabase}`);
        
        const pool = await getPool(selectedDatabase);
        
        // Execute the stored procedure
        const result = await pool.request()
            .input('ProcessID', sql.Int, processId)
            .execute('GetProcessInspectionTemplate');
        
        console.log(`[QC-INSPECTION] Query completed. Records found: ${result.recordset?.length || 0}`);
        
        // Parse the JSON from SQL Server's FOR JSON output
        let inspectionData = [];
        
        if (result.recordset && result.recordset.length > 0) {
            const firstRecord = result.recordset[0];
            console.log('[QC-INSPECTION] First record columns:', Object.keys(firstRecord));
            
            // SQL Server returns JSON in a column with auto-generated name like 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'
            // We need to find that column and parse its value
            const jsonColumnKey = Object.keys(firstRecord).find(key => key.startsWith('JSON_'));
            
            if (jsonColumnKey && firstRecord[jsonColumnKey]) {
                try {
                    let jsonString = firstRecord[jsonColumnKey];
                    console.log('[QC-INSPECTION] Raw JSON string:', jsonString);
                    
                    // Fix malformed JSON where "options": is followed by } or ,
                    // Replace "options":} with "options":null}
                    // Replace "options":, with "options":null,
                    jsonString = jsonString.replace(/"options":\s*}/g, '"options":null}');
                    jsonString = jsonString.replace(/"options":\s*,/g, '"options":null,');
                    
                    console.log('[QC-INSPECTION] Fixed JSON string:', jsonString);
                    
                    inspectionData = JSON.parse(jsonString);
                    console.log('[QC-INSPECTION] Parsed inspection data:', inspectionData);
                } catch (parseError) {
                    console.error('[QC-INSPECTION] Error parsing JSON:', parseError);
                    console.error('[QC-INSPECTION] Problematic JSON string:', firstRecord[jsonColumnKey]);
                    throw new Error('Failed to parse inspection template data');
                }
            }
        }
        
        return res.json({
            status: true,
            data: inspectionData,
            processId: processId,
            message: 'Inspection template retrieved successfully'
        });
    } catch (error) {
        console.error('[QC-INSPECTION] Error getting inspection template:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to get inspection template: ' + error.message
        });
    }
});

// Save Process Inspection (QC Audit)
router.post('/qc/save-inspection', async (req, res) => {
    try {
        const { userId, productionId, processId, jobBookingJobCardContentsId, jobBookingId, items, database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ 
                status: false, 
                error: 'Invalid or missing database (must be KOL or AHM)' 
            });
        }
        
        // Validate required fields
        if (!userId || !productionId || !processId || !jobBookingJobCardContentsId || !jobBookingId || !items) {
            return res.status(400).json({
                status: false,
                error: 'Missing required fields: userId, productionId, processId, jobBookingJobCardContentsId, jobBookingId, items'
            });
        }
        
        // Build the inspection JSON
        const inspectionJson = {
            voucherPrefix: "QC",
            companyID: 2,
            jobBookingJobCardContentsID: jobBookingJobCardContentsId,
            jobBookingID: jobBookingId, // Use actual JobBookingID from GetLatestMachineStatusPerMachine
            items: items
        };
        
        console.log(`[QC-SAVE] Saving inspection for UserID: ${userId}, ProductionID: ${productionId}, ProcessID: ${processId}`);
        console.log('[QC-SAVE] Inspection JSON:', JSON.stringify(inspectionJson, null, 2));
        
        const pool = await getPool(selectedDatabase);
        
        // Execute the stored procedure
        const result = await pool.request()
            .input('UserID', sql.Int, userId)
            .input('ProductionID', sql.Int, productionId)
            .input('ProcessID', sql.Int, processId)
            .input('InspectionJson', sql.NVarChar(sql.MAX), JSON.stringify(inspectionJson))
            .execute('SaveProcessInspection');
        
        // Check SP return value: 0 = success, non-zero = failure (common SQL convention)
        const returnVal = result.returnValue;
        if (returnVal !== undefined && returnVal !== null && returnVal !== 0) {
            console.log('[QC-SAVE] Stored procedure returned failure code:', returnVal);
            return res.status(400).json({
                status: false,
                error: 'Database returned failure (code ' + returnVal + '). Inspection was not saved.'
            });
        }
        
        // Check first recordset row for Success/Status/ErrorMessage (if SP returns a result set)
        const recordset = result.recordset || [];
        const firstRow = recordset[0];
        if (firstRow && typeof firstRow === 'object') {
            const success = firstRow.Success ?? firstRow.success;
            const status = (firstRow.Status ?? firstRow.status ?? '').toString().toLowerCase();
            const msg = firstRow.ErrorMessage ?? firstRow.Message ?? firstRow.errorMessage ?? firstRow.message ?? firstRow.Error ?? firstRow.error;
            if (success === 0 || success === false || status === 'failure' || status === 'error' || status === 'failed') {
                const failureMessage = (msg && String(msg).trim()) || ('Database returned failure (code ' + (returnVal ?? 'N/A') + ').');
                console.log('[QC-SAVE] Stored procedure indicated failure:', failureMessage);
                return res.status(400).json({
                    status: false,
                    error: failureMessage
                });
            }
        }
        
        // Extract voucher number from SP result (SaveProcessInspection returns column: voucherNo)
        const voucherNumber = firstRow && (firstRow.voucherNo ?? firstRow.VoucherNo ?? firstRow.VoucherNumber ?? firstRow.VoucherNum ?? firstRow.VoucherCode ?? firstRow.Voucher ?? firstRow.voucherNumber ?? firstRow.voucherNum ?? firstRow.voucherCode ?? firstRow.voucher);
        
        console.log('[QC-SAVE] Inspection saved successfully', voucherNumber != null ? ', Voucher: ' + voucherNumber : '');
        
        return res.json({
            status: true,
            message: 'Inspection saved successfully',
            voucherNumber: voucherNumber != null ? String(voucherNumber) : undefined,
            result: recordset
        });
    } catch (error) {
        console.error('[QC-SAVE] Error saving inspection:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to save inspection: ' + error.message
        });
    }
});

// QC Inspector Daily Performance Dashboard
router.post('/reports/qc-inspector-performance', async (req, res) => {
    try {
        const { startDate, endDate, database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();

        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({
                status: false,
                error: 'Invalid or missing database (must be KOL or AHM)'
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({
                status: false,
                error: 'Start date and end date are required'
            });
        }

        const parsedStart = new Date(startDate);
        const parsedEnd = new Date(endDate);

        if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
            return res.status(400).json({
                status: false,
                error: 'Invalid date format. Use YYYY-MM-DD.'
            });
        }

        if (parsedStart.getTime() > parsedEnd.getTime()) {
            return res.status(400).json({
                status: false,
                error: 'Start date cannot be after end date'
            });
        }

        console.log(`[QC-REPORT] Fetching inspector performance for ${selectedDatabase} from ${startDate} to ${endDate}`);

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('StartDateParam', sql.Date, parsedStart)
            .input('EndDateParam', sql.Date, parsedEnd)
            .query('EXEC Report_QCInspector_DailyPerformance @StartDateParam, @EndDateParam');

        console.log(`[QC-REPORT] Records returned: ${result.recordset?.length || 0}`);

        return res.json({
            status: true,
            data: result.recordset || [],
            message: 'QC inspector performance data retrieved successfully'
        });
    } catch (error) {
        console.error('[QC-REPORT] Error fetching inspector performance:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to fetch QC inspector performance data'
        });
    }
});

// QC Inspector Audit Detail (drill-down by date range + UserID)
const QC_INSPECTOR_AUDIT_DETAIL_QUERY = `
SELECT
    CAST(PEP.VoucherDate AS DATE) AS AuditDate,
    UM.UserName,
    JC.JobBookingNo,
    COUNT(*) AS AuditCount,
    MIN(PEP.CreatedDate) AS FirstEntryAt,
    MAX(PEP.CreatedDate) AS LastEntryAt
FROM ProductionEntryProcessInspectionMain PEP
LEFT JOIN JobBookingJobCard JC
    ON PEP.JobBookingID = JC.JobBookingID
LEFT JOIN UserMaster UM
    ON PEP.UserID = UM.UserID
WHERE
    CAST(PEP.VoucherDate AS DATE) BETWEEN @StartDate AND @EndDate
    AND ISNULL(PEP.IsDeletedTransaction,0) = 0
    AND UM.UserID = @UserID
GROUP BY
    CAST(PEP.VoucherDate AS DATE),
    UM.UserName,
    JC.JobBookingNo
ORDER BY
    AuditDate,
    UM.UserName,
    JC.JobBookingNo;
`;

router.post('/reports/qc-inspector-audit-detail', async (req, res) => {
    try {
        const { startDate, endDate, database, userId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();

        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({
                status: false,
                error: 'Invalid or missing database (must be KOL or AHM)'
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({
                status: false,
                error: 'Start date and end date are required'
            });
        }

        const userIdNum = userId != null && userId !== '' ? parseInt(userId, 10) : NaN;
        if (!Number.isInteger(userIdNum) || userIdNum < 0) {
            return res.status(400).json({
                status: false,
                error: 'Valid user ID is required'
            });
        }

        const parsedStart = new Date(startDate);
        const parsedEnd = new Date(endDate);

        if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
            return res.status(400).json({
                status: false,
                error: 'Invalid date format. Use YYYY-MM-DD.'
            });
        }

        if (parsedStart.getTime() > parsedEnd.getTime()) {
            return res.status(400).json({
                status: false,
                error: 'Start date cannot be after end date'
            });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('StartDate', sql.Date, parsedStart)
            .input('EndDate', sql.Date, parsedEnd)
            .input('UserID', sql.Int, userIdNum)
            .query(QC_INSPECTOR_AUDIT_DETAIL_QUERY);

        const rows = result.recordset || [];
        return res.json({
            status: true,
            data: rows,
            message: 'Audit detail retrieved successfully'
        });
    } catch (error) {
        console.error('[QC-REPORT] Audit detail error:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to fetch audit detail'
        });
    }
});

// QC Job Card parameter-wise summary by Job Card Number (for QC Tool home page search)
const QC_JOB_CARD_ENTRIES_QUERY = `
;WITH JobNumberResolved AS (
    SELECT TOP 1 jc.JobBookingNo AS JobNumber
    FROM dbo.ProductionEntryProcessInspectionMain m
    INNER JOIN dbo.JobBookingJobCard jc ON m.JobBookingID = jc.JobBookingID
    WHERE jc.JobBookingNo LIKE N'%' + @JobBookingNo + N'%'
      AND ISNULL(m.IsDeletedTransaction, 0) = 0
    ORDER BY m.VoucherDate DESC, m.TransactionID DESC
),
InspectionBase AS
(
    SELECT
        m.TransactionID,
        m.ProcessID
    FROM dbo.ProductionEntryProcessInspectionMain m
    LEFT JOIN dbo.JobBookingJobCard jc
        ON m.JobBookingID = jc.JobBookingID
    WHERE
        jc.JobBookingNo LIKE N'%' + @JobBookingNo + N'%'
        AND ISNULL(m.IsDeletedTransaction, 0) = 0
),
DetailResults AS
(
    SELECT
        ib.ProcessID,
        d.ParameterName,
        MAX(d.InputFieldType) AS InputFieldType,
        COUNT(*) AS AuditCount,
        MIN(d.ModifiedDate) AS InspectionStartAt,
        MAX(d.ModifiedDate) AS InspectionEndAt,
        SUM(CASE
                WHEN d.InputFieldType = 'Text Field' THEN 0
                WHEN TRY_CAST(d.Result AS DECIMAL(18,4)) IS NOT NULL THEN 0
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NA','N/A') THEN 1
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('OK','PASS') THEN 1
                ELSE 0
            END) AS OKCount,
        SUM(CASE
                WHEN d.InputFieldType = 'Text Field' THEN 0
                WHEN TRY_CAST(d.Result AS DECIMAL(18,4)) IS NOT NULL THEN 0
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NA','N/A') THEN 0
                WHEN d.Result IS NULL THEN 1
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NOT OK','FAIL','NG') THEN 1
                ELSE 0
            END) AS NotOKCount,
        STUFF((
            SELECT N'|' + d2.Result
            FROM dbo.ProductionEntryProcessInspectionDetail d2
            JOIN InspectionBase ib2
                ON ib2.TransactionID = d2.TransactionID
                AND ib2.ProcessID = ib.ProcessID
            WHERE
                d2.ParameterName = d.ParameterName
                AND ISNULL(d2.IsDeletedTransaction, 0) = 0
                AND d2.InputFieldType = 'Text Field'
                AND d2.Result IS NOT NULL
                AND LTRIM(RTRIM(d2.Result)) <> ''
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 1, '') AS TextResults
    FROM InspectionBase ib
    JOIN dbo.ProductionEntryProcessInspectionDetail d
        ON d.TransactionID = ib.TransactionID
        AND ISNULL(d.IsDeletedTransaction, 0) = 0
    GROUP BY
        ib.ProcessID,
        d.ParameterName
    HAVING
        MAX(d.InputFieldType) = 'Text Field'
        OR
        SUM(CASE
                WHEN TRY_CAST(d.Result AS DECIMAL(18,4)) IS NOT NULL THEN 0
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NA','N/A') THEN 0
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('OK','PASS') THEN 1
                ELSE 0
            END) > 0
        OR
        SUM(CASE
                WHEN TRY_CAST(d.Result AS DECIMAL(18,4)) IS NOT NULL THEN 0
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NA','N/A') THEN 0
                WHEN d.Result IS NULL THEN 1
                WHEN LTRIM(RTRIM(UPPER(d.Result))) IN ('NOT OK','FAIL','NG') THEN 1
                ELSE 0
            END) > 0
)
SELECT
    (SELECT jnr.JobNumber FROM JobNumberResolved jnr) AS [Job Number],
    pm.ProcessName,
    dr.ParameterName,
    dr.AuditCount AS [Audit Count],
    dr.OKCount AS [Number of OK],
    dr.NotOKCount AS [Number of Not OK],
    CASE WHEN dr.InputFieldType = 'Text Field'
         THEN ISNULL(dr.TextResults, '')
         ELSE ''
    END AS [Result],
    CONVERT(VARCHAR(19), CAST((dr.InspectionStartAt AT TIME ZONE 'India Standard Time') AS DATETIME2(0)), 120) + ' IST' AS [Inspection Start At],
    CONVERT(VARCHAR(19), CAST((dr.InspectionEndAt AT TIME ZONE 'India Standard Time') AS DATETIME2(0)), 120) + ' IST' AS [Inspection End At]
FROM DetailResults dr
LEFT JOIN dbo.ProcessMaster pm
    ON pm.ProcessID = dr.ProcessID
ORDER BY
    pm.ProcessName,
    dr.ParameterName;
`;

const QC_JOB_CARD_USERWISE_QUERY = `
;WITH JobNumberResolved AS (
    SELECT TOP 1 jc.JobBookingNo AS JobNumber
    FROM dbo.ProductionEntryProcessInspectionMain m
    INNER JOIN dbo.JobBookingJobCard jc ON m.JobBookingID = jc.JobBookingID
    WHERE jc.JobBookingNo LIKE N'%' + @JobBookingNo + N'%'
      AND ISNULL(m.IsDeletedTransaction, 0) = 0
    ORDER BY m.VoucherDate DESC, m.TransactionID DESC
),
Base AS
(
    SELECT
        UM.UserName,
        PM.ProcessName,
        CAST(PEP.VoucherDate AS DATE) AS EntryDate,
        MIN(PEP.CreatedDate) AS FirstEntryAt,
        MAX(PEP.CreatedDate) AS LastEntryAt,
        COUNT(*) AS EntryCount,
        DATEDIFF(SECOND, MIN(PEP.CreatedDate), MAX(PEP.CreatedDate)) AS SpanSeconds
    FROM ProductionEntryProcessInspectionMain PEP
    LEFT JOIN JobBookingJobCard JC
        ON PEP.JobBookingID = JC.JobBookingID
    LEFT JOIN UserMaster UM
        ON PEP.UserID = UM.UserID
    LEFT JOIN ProcessMaster PM
        ON PM.ProcessID = PEP.ProcessID
    WHERE
        jc.JobBookingNo LIKE N'%' + @JobBookingNo + N'%'
        AND ISNULL(PEP.IsDeletedTransaction,0) = 0
    GROUP BY
        UM.UserName,
        PM.ProcessName,
        CAST(PEP.VoucherDate AS DATE)
)
SELECT
    (SELECT jnr.JobNumber FROM JobNumberResolved jnr) AS [Job Number],
    UserName,
    ProcessName,
    EntryDate,
    EntryCount,
    CONVERT(VARCHAR(19), CAST((FirstEntryAt AT TIME ZONE 'India Standard Time') AS DATETIME2(0)), 120) + ' IST' AS FirstEntryAt,
    CONVERT(VARCHAR(19), CAST((LastEntryAt AT TIME ZONE 'India Standard Time') AS DATETIME2(0)), 120) + ' IST' AS LastEntryAt,
    CASE
        WHEN EntryCount = 1 THEN 1
        WHEN SpanSeconds <= 0 THEN NULL
        ELSE
            CAST(EntryCount AS DECIMAL(18,4)) /
            (CAST(SpanSeconds AS DECIMAL(18,4)) / 3600.0)
    END AS EntriesPerHour
FROM Base
ORDER BY
    EntryDate,
    UserName,
    ProcessName;
`;

router.post('/reports/qc-job-card-entries', async (req, res) => {
    try {
        const { database, jobBookingNo, viewMode } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();

        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({
                status: false,
                error: 'Invalid or missing database (must be KOL or AHM)'
            });
        }

        const trimmedJobNo = typeof jobBookingNo === 'string' ? jobBookingNo.trim() : '';
        if (!trimmedJobNo) {
            return res.status(400).json({
                status: false,
                error: 'Job card number (JobBookingNo) is required'
            });
        }
        if (!/^\d{4}$/.test(trimmedJobNo)) {
            return res.status(400).json({
                status: false,
                error: 'Job card number must be exactly 4 digits'
            });
        }

        const selectedViewMode = String(viewMode || 'process').toLowerCase() === 'user' ? 'user' : 'process';

        console.log(`[QC-JOB-CARD] Fetching ${selectedViewMode} entries for JobBookingNo: ${trimmedJobNo}, database: ${selectedDatabase}`);

        const pool = await getPool(selectedDatabase);
        const queryToRun = selectedViewMode === 'user' ? QC_JOB_CARD_USERWISE_QUERY : QC_JOB_CARD_ENTRIES_QUERY;
        const result = await pool.request()
            .input('JobBookingNo', sql.NVarChar(50), trimmedJobNo)
            .query(queryToRun);

        const rawRows = result.recordset || [];
        const rows =
            selectedViewMode === 'process'
                ? rawRows.map((row) => {
                      const auditCountRaw =
                          row['Audit Count'] ?? row.AuditCount ?? row.auditcount;
                      const resultRaw = row['Result'] ?? row.Result ?? row.result ?? '';
                      const auditCountNum =
                          auditCountRaw != null && auditCountRaw !== ''
                              ? Number(auditCountRaw)
                              : null;
                      return {
                          ...row,
                          auditCount:
                              auditCountNum != null && !Number.isNaN(auditCountNum)
                                  ? auditCountNum
                                  : null,
                          result: resultRaw != null ? String(resultRaw) : '',
                      };
                  })
                : rawRows;
        console.log(`[QC-JOB-CARD] Records returned: ${rows.length}`);

        const jobNumberFromRow =
            rawRows[0]?.['Job Number'] ??
            rawRows[0]?.JobNumber ??
            rawRows[0]?.jobnumber;
        const jobNumber =
            jobNumberFromRow != null && String(jobNumberFromRow).trim() !== ''
                ? String(jobNumberFromRow).trim()
                : trimmedJobNo;

        return res.json({
            status: true,
            data: rows,
            jobNumber,
            message: 'Job card entries retrieved successfully'
        });
    } catch (error) {
        console.error('[QC-JOB-CARD] Error:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to fetch job card entries'
        });
    }
});

// ============================================
// WhatsApp Messaging Routes
// ============================================

// ============================================
// TEMPLATE PREVIEW ENDPOINTS (Postman-friendly, NO side effects)
// --------------------------------------------------------------
// These endpoints render the exact WhatsApp / Email text that the
// matching "send" endpoint would generate, including the new
// "🔗 Track your orders online" portal block, but do NOT
// actually send anything or mark anything as sent.
// ============================================

// 1) Quick portal-block scenario tester — no SQL data fetch required.
//    Body: { customerEmail?: string }
//      - omit customerEmail or pass "" -> Scenario 1
//      - present + not in tenants       -> Scenario 2 (with companyCode lookup)
//      - present + in tenants            -> Scenario 3
router.post('/whatsapp/preview/portal-block', async (req, res) => {
    try {
        const rawEmail = (req.body?.customerEmail ?? '').toString().trim();
        const customerEmail = rawEmail || null;

        const pool = await getPool('KOL');

        let scenario = 1;
        let isRegistered = false;
        let companyCode = null;

        if (customerEmail) {
            isRegistered = await isEmailRegisteredInPortal(customerEmail);
            if (isRegistered) {
                scenario = 3;
            } else {
                scenario = 2;
                companyCode = await getCompanyCodeByEmail(pool, customerEmail);
            }
        }

        const portalBlock = await buildPortalAppend({ pool, customerEmail });

        return res.json({
            ok: true,
            input: { customerEmail },
            scenario,
            isRegistered,
            companyCode: companyCode || (scenario === 2 ? '<COMPANY_CODE>' : null),
            portalBlock
        });
    } catch (err) {
        console.error('[PREVIEW/portal-block] Error:', err);
        return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

// 2) 1st Intimation full template preview
//    Body: { username: string, orderBookingDetailsIds: number[] }
//    Mirrors POST /comm/first-intimation/send but does NOT send / mark.
router.post('/whatsapp/preview/first-intimation', async (req, res) => {
    try {
        const { username, orderBookingDetailsIds } = req.body || {};

        if (!username || !Array.isArray(orderBookingDetailsIds) || orderBookingDetailsIds.length === 0) {
            return res.status(400).json({ ok: false, error: 'username and orderBookingDetailsIds[] required' });
        }

        const pool = await getPool('KOL');

        const credRes = await pool.request()
            .input('Username', sql.NVarChar(100), username)
            .execute('dbo.comm_get_user_credentials');
        const creds = credRes.recordset?.[0];
        if (!creds) return res.status(400).json({ ok: false, error: 'Credentials not found' });

        const senderName = username;
        const senderPhone = creds.ContactNo || '';

        const tvp = new sql.Table('dbo.IdList');
        tvp.columns.add('Id', sql.Int, { nullable: false });
        orderBookingDetailsIds.forEach(id => tvp.rows.add(Number(id)));

        const detRes = await pool.request()
            .input('Ids', tvp)
            .execute('dbo.comm_first_intimation_details_by_ids');

        const rows = detRes.recordset || [];
        if (!rows.length) {
            return res.json({ ok: true, message: 'No pending items found.', previews: [] });
        }

        const byClient = new Map();
        for (const r of rows) {
            if (!byClient.has(r.ClientLedgerID)) byClient.set(r.ClientLedgerID, []);
            byClient.get(r.ClientLedgerID).push(r);
        }

        const previews = [];

        for (const [ledgerId, clientRows] of byClient.entries()) {
            const clientName = clientRows[0]['Client Name'];
            const contactName = (clientRows[0]['Contact Person'] || '').split(',')[0] || clientName;
            const orderLines = buildOrderLines(clientRows);

            let whatsappText =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

Your order(s) have been planned in our system. Details below:

  ${orderLines}

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailSubject = `Order Planned & Delivery Commitment | ${clientName}`;
            let emailBody =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd.

Your order(s) have been planned in our system. Details below:

  ${orderLines}

Regards,
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailList = splitCsv(clientRows[0]['Concern Email']);
            const mobileList = splitCsv(clientRows[0]['Concern Mobile No'])
                .map(normalizeINPhone)
                .filter(Boolean);

            const customerEmail = emailList[0] || null;
            const portalAppend = await buildPortalAppend({ pool, customerEmail });
            whatsappText += portalAppend;
            emailBody += portalAppend;

            previews.push({
                clientLedgerId: ledgerId,
                clientName,
                contactName,
                emailList,
                mobileList,
                portalCustomerEmail: customerEmail,
                emailSubject,
                whatsappText,
                emailBody
            });
        }

        return res.json({ ok: true, previews });
    } catch (err) {
        console.error('[PREVIEW/first-intimation] Error:', err);
        return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

// 3) 2nd Intimation / Material-Readiness full template preview
//    Body: { username, items: [{ orderBookingDetailsId, readyForDispatchDate, noOfCarton, qtyPerCarton }] }
//    Mirrors POST /comm/material-readiness/send but does NOT send / update DispatchSchedule.
router.post('/whatsapp/preview/material-readiness', async (req, res) => {
    try {
        const { username, items } = req.body || {};
        if (!username || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ ok: false, error: 'username and items[] are required' });
        }

        const readinessByObdId = new Map();
        const ids = [];
        for (const it of items) {
            const id = Number(it.orderBookingDetailsId);
            if (!id) return res.status(400).json({ ok: false, error: 'Invalid orderBookingDetailsId in items[]' });
            readinessByObdId.set(id, {
                readyForDispatchDate: it.readyForDispatchDate,
                noOfCarton: Number(it.noOfCarton || 0),
                qtyPerCarton: Number(it.qtyPerCarton || 0)
            });
            ids.push(id);
        }

        const pool = await getPool('KOL');

        const credRes = await pool.request()
            .input('Username', sql.NVarChar(100), username)
            .execute('dbo.comm_get_user_credentials');
        const creds = credRes.recordset?.[0];
        if (!creds) return res.status(400).json({ ok: false, error: 'Credentials not found' });

        const senderName = username;
        const senderPhone = creds.ContactNo || '';

        const tvp = new sql.Table('dbo.IdList');
        tvp.columns.add('Id', sql.Int, { nullable: false });
        ids.forEach(id => tvp.rows.add(id));

        const dataRes = await pool.request()
            .input('Ids', tvp)
            .execute('dbo.comm_pending_delivery_followup_by_ids');

        const rows = dataRes.recordset || [];
        if (!rows.length) return res.json({ ok: true, message: 'No matching rows for selected IDs.', previews: [] });

        const byClient = new Map();
        for (const r of rows) {
            const ledgerId = Number(r.ClientLedgerID);
            if (!byClient.has(ledgerId)) byClient.set(ledgerId, []);
            byClient.get(ledgerId).push(r);
        }

        const previews = [];

        for (const [clientLedgerId, clientRowsRaw] of byClient.entries()) {
            const clientRows = clientRowsRaw.filter(r => readinessByObdId.has(Number(r.OrderBookingDetailsID)));
            if (!clientRows.length) continue;

            const clientName = clientRows[0]['Client Name'] || '';
            const contactName = (clientRows[0]['Contact Person'] || '').split(',')[0].trim() || clientName;
            const readinessLines = buildReadinessLines(clientRows, readinessByObdId);

            let whatsappMessage =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

Your material is ready and planned for dispatch as per details below:

${readinessLines}

For any coordination required, please reply here.

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`.trim();

            const emailSubject = `Material Ready for Dispatch | ${clientName}`;
            let emailBody =
`Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd.

Your material is ready and planned for dispatch as per details below:

${readinessLines}

For any coordination required, please reply to this email.

Regards,
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`.trim();

            const emailList = splitCsv(clientRows[0]['Contact Email']);
            const mobileList = splitCsv(clientRows[0]['Contact phone']).map(normalizeINPhone).filter(Boolean);

            const customerEmail = emailList[0] || null;
            const portalAppend = await buildPortalAppend({ pool, customerEmail });
            whatsappMessage += portalAppend;
            emailBody += portalAppend;

            previews.push({
                clientLedgerId,
                clientName,
                contactName,
                emailList,
                mobileList,
                portalCustomerEmail: customerEmail,
                emailSubject,
                whatsappText: whatsappMessage,
                emailBody
            });
        }

        return res.json({ ok: true, previews });
    } catch (err) {
        console.error('[PREVIEW/material-readiness] Error:', err);
        return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

// 4) Updated Delivery Dates full template preview
//    Body: { username, items: [{ orderBookingDetailsID, newExpectedDeliveryDate: 'YYYY-MM-DD' }] }
//    Mirrors POST /whatsapp/update-delivery-dates-and-send but does NOT update SQL dates or send.
router.post('/whatsapp/preview/update-delivery-dates', async (req, res) => {
    try {
        const { username, items } = req.body || {};
        if (!username || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ ok: false, error: 'username and items[] are required' });
        }

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        for (const item of items) {
            if (!item.orderBookingDetailsID || typeof item.orderBookingDetailsID !== 'number') {
                return res.status(400).json({ ok: false, error: 'Each item must have orderBookingDetailsID (number)' });
            }
            if (!item.newExpectedDeliveryDate || !dateRegex.test(item.newExpectedDeliveryDate)) {
                return res.status(400).json({ ok: false, error: 'Each item must have newExpectedDeliveryDate (YYYY-MM-DD)' });
            }
        }

        const pool = await getPool('KOL');

        const credRes = await pool.request()
            .input('Username', sql.NVarChar(100), username)
            .execute('dbo.comm_get_user_credentials');
        const creds = credRes.recordset?.[0];
        if (!creds) return res.status(400).json({ ok: false, error: 'Credentials not found' });

        const senderName = username;
        const senderPhone = creds.ContactNo || '';

        const dateUpdatesMap = new Map();
        items.forEach(it => dateUpdatesMap.set(Number(it.orderBookingDetailsID), it.newExpectedDeliveryDate));

        const tvp = new sql.Table('dbo.IdList');
        tvp.columns.add('Id', sql.Int, { nullable: false });
        items.forEach(it => { const id = Number(it.orderBookingDetailsID); if (id) tvp.rows.add(id); });

        const detRes = await pool.request().input('Ids', tvp).execute('dbo.comm_pending_delivery_followup_by_ids');
        const rows = detRes.recordset || [];
        if (!rows.length) return res.json({ ok: true, message: 'No order details found for selected items.', previews: [] });

        rows.forEach(row => {
            const newDate = dateUpdatesMap.get(Number(row.OrderBookingDetailsID));
            if (newDate) {
                row['Final Delivery Date'] = newDate;
                row.FinalDeliveryDate = newDate;
            }
        });

        const byClient = new Map();
        for (const r of rows) {
            if (!byClient.has(r.ClientLedgerID)) byClient.set(r.ClientLedgerID, []);
            byClient.get(r.ClientLedgerID).push(r);
        }

        function buildOrderLinesWithUpdatedDates(clientRows) {
            if (!clientRows.length) return '';
            const firstRow = clientRows[0];
            const columnNames = Object.keys(firstRow);
            const jobNumberColumnIndex = 2;
            const jobNameColumnIndex = 4;

            let orderQtyColumnName = null;
            for (const key of columnNames) {
                const keyLower = key.toLowerCase();
                if ((keyLower.includes('order') && keyLower.includes('qty')) || key === 'Order Qty' || key === 'OrderQty') {
                    orderQtyColumnName = key; break;
                }
            }

            return clientRows.map(r => {
                const updatedDate = dateUpdatesMap.get(Number(r.OrderBookingDetailsID)) || r['Committed Delivery Date'] || r['CommittedDeliveryDate'] || r['Final Delivery Date'] || r.FinalDeliveryDate;
                const jobNumber = (columnNames[jobNumberColumnIndex] && r[columnNames[jobNumberColumnIndex]]) ? String(r[columnNames[jobNumberColumnIndex]]) : '';
                const jobName = (columnNames[jobNameColumnIndex] && r[columnNames[jobNameColumnIndex]]) ? String(r[columnNames[jobNameColumnIndex]]) : '';
                const orderQty = orderQtyColumnName ? (r[orderQtyColumnName] ? String(r[orderQtyColumnName]) : '') : '';
                return [
                    `• Item: ${jobName}`,
                    `  Qty: ${orderQty}`,
                    `  Job No: ${jobNumber}`,
                    `  Updated Committed Delivery: ${fmtDate(updatedDate)}`
                ].join('\n');
            }).join('\n\n');
        }

        const previews = [];

        for (const [ledgerId, clientRows] of byClient.entries()) {
            const clientName = clientRows[0]['Client Name'] || clientRows[0]['ClientName'] || '';
            const contactPerson = clientRows[0]['Contact Person'] || clientRows[0]['ContactPerson'] || '';
            const contactName = (contactPerson.split(',')[0] || clientName).trim();

            const orderLines = buildOrderLinesWithUpdatedDates(clientRows);

            let whatsappText = `Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

We regret to inform you that due to unforeseen circumstances, we will not be able to deliver the below jobs within the committed timeframe. Please find the updated committed delivery dates below:

  ${orderLines}

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailSubject = `Updated Delivery Schedule | ${clientName}`;
            let emailBody = `Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd.

We regret to inform you that due to unforeseen circumstances, we will not be able to deliver the below jobs within the committed timeframe. Please find the updated committed delivery dates below:

  ${orderLines}

Regards,
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailList = splitCsv(clientRows[0]['Contact Email'] || clientRows[0]['ContactEmail'] || clientRows[0]['Concern Email'] || clientRows[0]['ConcernEmail'] || '');
            const mobileList = splitCsv(clientRows[0]['Contact phone'] || clientRows[0]['Contactphone'] || clientRows[0]['Concern Mobile No'] || clientRows[0]['ConcernMobileNo'] || '')
                .map(normalizeINPhone)
                .filter(Boolean);

            const customerEmail = emailList[0] || null;
            const portalAppend = await buildPortalAppend({ pool, customerEmail });
            whatsappText += portalAppend;
            emailBody += portalAppend;

            previews.push({
                clientLedgerId: ledgerId,
                clientName,
                contactName,
                emailList,
                mobileList,
                portalCustomerEmail: customerEmail,
                emailSubject,
                whatsappText,
                emailBody
            });
        }

        return res.json({ ok: true, previews });
    } catch (err) {
        console.error('[PREVIEW/update-delivery-dates] Error:', err);
        return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
});

// Login endpoint for WhatsApp Web UI
router.post('/whatsapp/login', async (req, res) => {
    try {
        const { username } = req.body;

        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Username is required'
            });
        }

        const trimmedUsername = username.trim();

        // Validate username is one of the allowed values
        if (trimmedUsername !== 'Sourav' && trimmedUsername !== 'Swarnali') {
            return res.status(400).json({
                status: false,
                error: 'Invalid username'
            });
        }

        // WhatsApp app uses Kolkata (KOL) database only
        const selectedDatabase = 'KOL';
        
        console.log(`[WHATSAPP-LOGIN] Attempting login for user: ${trimmedUsername}, Database: ${selectedDatabase}`);

        const pool = await getPool(selectedDatabase);

        // Call the stored procedure comm_get_user_credentials
        // The procedure takes username as input and has an inout parameter
        // Try with dbo schema first, fallback to no schema if needed
        let result;
        try {
            result = await pool.request()
                .input('username', sql.NVarChar(255), trimmedUsername)
                .execute('dbo.comm_get_user_credentials');
        } catch (schemaError) {
            // If dbo schema fails, try without schema prefix
            console.log('[WHATSAPP-LOGIN] Trying without dbo schema prefix');
            result = await pool.request()
                .input('username', sql.NVarChar(255), trimmedUsername)
                .execute('comm_get_user_credentials');
        }

        console.log('[WHATSAPP-LOGIN] Stored procedure executed', {
            username: trimmedUsername,
            database: selectedDatabase,
            rowCount: result.recordset?.length || 0
        });

        // Check if procedure returned any rows (success)
        if (result.recordset && result.recordset.length > 0) {
            console.log('[WHATSAPP-LOGIN] Login successful', {
                username: trimmedUsername,
                returnedData: result.recordset[0]
            });

            // Calculate dates for last 2 weeks (from 2 weeks ago to today)
            const today = new Date();
            const twoWeeksAgo = new Date();
            twoWeeksAgo.setDate(today.getDate() - 14); // 14 days ago

            // Format dates as YYYY-MM-DD
            const endDate = today.toISOString().split('T')[0];
            const startDate = twoWeeksAgo.toISOString().split('T')[0];

            console.log('[WHATSAPP-LOGIN] Fetching pending first intimation data', {
                startDate,
                endDate
            });

            // Call comm_pending_first_intimation procedure
            // The procedure expects positional date parameters (not named parameters)
            let pendingData;
            try {
                // Use raw query with positional parameters (as shown in user's example)
                const query = `EXEC dbo.comm_pending_first_intimation '${startDate}', '${endDate}'`;
                pendingData = await pool.request().query(query);
                console.log('[WHATSAPP-LOGIN] Procedure executed successfully with dbo schema');
            } catch (procedureError) {
                // If dbo schema fails, try without schema prefix
                console.log('[WHATSAPP-LOGIN] dbo schema failed, trying without schema prefix', procedureError.message);
                try {
                    const query = `EXEC comm_pending_first_intimation '${startDate}', '${endDate}'`;
                    pendingData = await pool.request().query(query);
                    console.log('[WHATSAPP-LOGIN] Procedure executed successfully without schema prefix');
                } catch (altError) {
                    console.error('[WHATSAPP-LOGIN] Failed to execute comm_pending_first_intimation', altError);
                    // Return empty array if procedure fails, but still allow login
                    pendingData = { recordset: [] };
                }
            }

            console.log('[WHATSAPP-LOGIN] Pending first intimation data fetched', {
                recordCount: pendingData.recordset?.length || 0,
                hasRecordset: !!pendingData.recordset,
                sampleRecord: pendingData.recordset?.[0] || null
            });
            
            return res.json({
                status: true,
                message: 'Login successful',
                username: trimmedUsername,
                pendingData: pendingData.recordset || [],
                dateRange: {
                    startDate,
                    endDate
                }
            });
        } else {
            console.warn('[WHATSAPP-LOGIN] Login failed - no rows returned', {
                username: trimmedUsername,
                database: selectedDatabase
            });
            
            return res.status(401).json({
                status: false,
                error: 'Invalid credentials'
            });
        }
    } catch (error) {
        console.error('[WHATSAPP-LOGIN] Error:', error);
        return res.status(500).json({
            status: false,
            error: error.message || 'Login failed'
        });
    }
});

// Second intimation endpoint for WhatsApp Web UI
router.post('/whatsapp/second-intimation', async (req, res) => {
    try {
        const { username, startDate, endDate } = req.body;

        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Username is required'
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({
                status: false,
                error: 'Start date and end date are required'
            });
        }

        const today = new Date();
            const fourmonthsago = new Date();
            fourmonthsago.setDate(today.getDate() - 120); // 14 days ago

            // Format dates as YYYY-MM-DD
            //endDate = today.toISOString().split('T')[0];
            const startDate2 = fourmonthsago.toISOString().split('T')[0];

        const trimmedUsername = username.trim();
        const selectedDatabase = 'KOL';
        
        console.log(`[WHATSAPP-2ND-INTIMATION] Fetching data for user: ${trimmedUsername}, Database: ${selectedDatabase}, Date range: ${startDate} to ${endDate}`);

        const pool = await getPool(selectedDatabase);

        // Call comm_pending_delivery_followup procedure
        let pendingData;
        try {
            // Use raw query with positional parameters
            const query = `EXEC dbo.comm_pending_delivery_followup '${startDate2}', '${endDate}'`;
            pendingData = await pool.request().query(query);
            console.log('[WHATSAPP-2ND-INTIMATION] Procedure executed successfully with dbo schema');
        } catch (procedureError) {
            // If dbo schema fails, try without schema prefix
            console.log('[WHATSAPP-2ND-INTIMATION] dbo schema failed, trying without schema prefix', procedureError.message);
            try {
                const query = `EXEC comm_pending_delivery_followup '${startDate}', '${endDate}'`;
                pendingData = await pool.request().query(query);
                console.log('[WHATSAPP-2ND-INTIMATION] Procedure executed successfully without schema prefix');
            } catch (altError) {
                console.error('[WHATSAPP-2ND-INTIMATION] Failed to execute comm_pending_delivery_followup', altError);
                return res.status(500).json({
                    status: false,
                    error: 'Failed to fetch second intimation data: ' + altError.message
                });
            }
        }

        console.log('[WHATSAPP-2ND-INTIMATION] Pending delivery followup data fetched', {
            recordCount: pendingData.recordset?.length || 0,
            hasRecordset: !!pendingData.recordset,
            sampleRecord: pendingData.recordset?.[0] || null
        });
        
        return res.json({
            status: true,
            message: 'Second intimation data fetched successfully',
            username: trimmedUsername,
            pendingData: pendingData.recordset || [],
            dateRange: {
                startDate,
                endDate
            }
        });
    } catch (error) {
        console.error('[WHATSAPP-2ND-INTIMATION] Error:', error);
        return res.status(500).json({
            status: false,
            error: error.message || 'Failed to fetch second intimation data'
        });
    }
});

// Send WhatsApp message endpoint
router.post('/whatsapp/send-message', async (req, res) => {
    try {
        const { username, phoneNumber, message } = req.body;

        // Validation
        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Username is required'
            });
        }

        if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Phone number is required'
            });
        }

        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Message is required'
            });
        }

        // Format phone number (remove spaces, ensure it starts with +)
        let formattedPhone = phoneNumber.trim().replace(/\s+/g, '');
        if (!formattedPhone.startsWith('+')) {
            // If no country code, assume default (you can customize this)
            formattedPhone = '+91' + formattedPhone; // Default to India (+91)
        }

        // TODO: Integrate with WhatsApp API (e.g., whatsapp-web.js, Twilio, etc.)
        // For now, just log and return success
        console.log(`[WHATSAPP-SEND] User: ${username}, Phone: ${formattedPhone}, Message: ${message}`);

        // Simulate API call delay
        await new Promise(resolve => setTimeout(resolve, 500));

        return res.json({
            status: true,
            message: 'Message sent successfully',
            data: {
                phoneNumber: formattedPhone,
                message: message.trim(),
                sentAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('[WHATSAPP-SEND] Error:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to send message'
        });
    }
});

// Update expected delivery date endpoint
router.post('/whatsapp/update-delivery-date', async (req, res) => {
    try {
        const { username, orderBookingDetailsID, newExpectedDeliveryDate } = req.body;

        // Validation
        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Username is required'
            });
        }

        if (!orderBookingDetailsID || typeof orderBookingDetailsID !== 'number') {
            return res.status(400).json({
                status: false,
                error: 'OrderBookingDetailsID is required and must be a number'
            });
        }

        if (!newExpectedDeliveryDate || typeof newExpectedDeliveryDate !== 'string') {
            return res.status(400).json({
                status: false,
                error: 'NewExpectedDeliveryDate is required'
            });
        }

        // Validate date format (YYYY-MM-DD)
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(newExpectedDeliveryDate)) {
            return res.status(400).json({
                status: false,
                error: 'Invalid date format. Expected YYYY-MM-DD'
            });
        }

        // WhatsApp app uses Kolkata (KOL) database only
        const selectedDatabase = 'KOL';
        
        console.log('[WHATSAPP-UPDATE-DATE] Updating delivery date', {
            username,
            orderBookingDetailsID,
            newExpectedDeliveryDate,
            database: selectedDatabase
        });

        const pool = await getPool(selectedDatabase);

        // Call the stored procedure
        let result;
        try {
            const query = `EXEC dbo.comm_update_expected_delivery_date @OrderBookingDetailsID = ${orderBookingDetailsID}, @NewExpectedDeliveryDate = '${newExpectedDeliveryDate}'`;
            result = await pool.request().query(query);
            console.log('[WHATSAPP-UPDATE-DATE] Procedure executed successfully');
        } catch (procedureError) {
            // If dbo schema fails, try without schema prefix
            console.log('[WHATSAPP-UPDATE-DATE] Trying without dbo schema prefix');
            const query = `EXEC comm_update_expected_delivery_date @OrderBookingDetailsID = ${orderBookingDetailsID}, @NewExpectedDeliveryDate = '${newExpectedDeliveryDate}'`;
            result = await pool.request().query(query);
        }

        console.log('[WHATSAPP-UPDATE-DATE] Delivery date updated successfully');

        return res.json({
            status: true,
            message: 'Delivery date updated successfully',
            data: {
                orderBookingDetailsID,
                newExpectedDeliveryDate
            }
        });
    } catch (error) {
        console.error('[WHATSAPP-UPDATE-DATE] Error:', error);
        return res.status(500).json({
            status: false,
            error: error.message || 'Failed to update delivery date'
        });
    }
});

// Update delivery dates and send WhatsApp message (2nd intimation - delivery date update)
router.post('/whatsapp/update-delivery-dates-and-send', async (req, res) => {
    try {
        const { username, items } = req.body || {};

        // Validation
        if (!username || typeof username !== 'string' || username.trim() === '') {
            return res.status(400).json({
                status: false,
                error: 'Username is required'
            });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                status: false,
                error: 'Items array is required and must not be empty'
            });
        }

        // Validate each item
        for (const item of items) {
            if (!item.orderBookingDetailsID || typeof item.orderBookingDetailsID !== 'number') {
                return res.status(400).json({
                    status: false,
                    error: 'Each item must have orderBookingDetailsID (number)'
                });
            }
            if (!item.newExpectedDeliveryDate || typeof item.newExpectedDeliveryDate !== 'string') {
                return res.status(400).json({
                    status: false,
                    error: 'Each item must have newExpectedDeliveryDate (string)'
                });
            }
            // Validate date format (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(item.newExpectedDeliveryDate)) {
                return res.status(400).json({
                    status: false,
                    error: 'Invalid date format. Expected YYYY-MM-DD'
                });
            }
        }

        const pool = await getPool('KOL');

        // 1) Get credentials
        const credReq = pool.request();
        credReq.input("Username", sql.NVarChar(100), username);
        const credRes = await credReq.execute("dbo.comm_get_user_credentials");

        const creds = credRes.recordset?.[0];
        if (!creds) {
            return res.status(400).json({
                status: false,
                error: 'Credentials not found'
            });
        }

        const senderName = username;
        const senderPhone = creds.ContactNo || "";

        // 2) Create map of new delivery dates by orderBookingDetailsID
        const dateUpdatesMap = new Map();
        items.forEach(item => {
            dateUpdatesMap.set(Number(item.orderBookingDetailsID), item.newExpectedDeliveryDate);
        });

        // 3) First, update all delivery dates using the stored procedure
        for (const item of items) {
            try {
                const query = `EXEC dbo.comm_update_expected_delivery_date @OrderBookingDetailsID = ${item.orderBookingDetailsID}, @NewExpectedDeliveryDate = '${item.newExpectedDeliveryDate}'`;
                await pool.request().query(query);
            } catch (procedureError) {
                // If dbo schema fails, try without schema prefix
                try {
                    const query = `EXEC comm_update_expected_delivery_date @OrderBookingDetailsID = ${item.orderBookingDetailsID}, @NewExpectedDeliveryDate = '${item.newExpectedDeliveryDate}'`;
                    await pool.request().query(query);
                } catch (altError) {
                    console.error(`[WHATSAPP-UPDATE-DATES-SEND] Failed to update date for OrderBookingDetailsID ${item.orderBookingDetailsID}:`, altError);
                    // Continue with other items even if one fails
                }
            }
        }

        // 4) Fetch order details using the procedure for 2nd intimation (same as material-readiness endpoint)
        const tvp = new sql.Table("dbo.IdList");
        tvp.columns.add("Id", sql.Int, { nullable: false });
        items.forEach(item => {
            const id = Number(item.orderBookingDetailsID);
            if (id) tvp.rows.add(id);
        });

        const detReq = pool.request();
        detReq.input("Ids", tvp);
        const detRes = await detReq.execute("dbo.comm_pending_delivery_followup_by_ids");

        const rows = detRes.recordset || [];
        if (!rows.length) {
            return res.status(400).json({
                status: false,
                error: 'No order details found for the selected items'
            });
        }

        // 5) Update the Final Delivery Date in rows with the new dates
        rows.forEach(row => {
            const newDate = dateUpdatesMap.get(Number(row.OrderBookingDetailsID));
            if (newDate) {
                row["Final Delivery Date"] = newDate;
                row.FinalDeliveryDate = newDate;
            }
        });

        // 6) Group by client
        const byClient = new Map();
        for (const r of rows) {
            if (!byClient.has(r.ClientLedgerID)) byClient.set(r.ClientLedgerID, []);
            byClient.get(r.ClientLedgerID).push(r);
        }

        const results = [];

        // Helper function to build order lines with updated delivery dates
        // Access columns by their position: 3rd column = Job Number, 5th column = Job Name
        function buildOrderLinesWithUpdatedDates(rows) {
            if (rows.length === 0) return "";
            
            // Get column names in order from the first row
            const firstRow = rows[0];
            const columnNames = Object.keys(firstRow);
            
            // 3rd column (index 2) = Job Number, 5th column (index 4) = Job Name
            const jobNumberColumnIndex = 2; // 3rd column (0-based index)
            const jobNameColumnIndex = 4;   // 5th column (0-based index)
            
            // Find Order Qty column (try to find it by name since position may vary)
            let orderQtyColumnName = null;
            for (const key of columnNames) {
                const keyLower = key.toLowerCase();
                if ((keyLower.includes('order') && keyLower.includes('qty')) ||
                    key === 'Order Qty' || key === 'OrderQty') {
                    orderQtyColumnName = key;
                    break;
                }
            }
            
            return rows.map(r => {
                // Use the updated date from our map
                const updatedDate = dateUpdatesMap.get(Number(r.OrderBookingDetailsID)) || r["Committed Delivery Date"] || r["CommittedDeliveryDate"] || r["Final Delivery Date"] || r.FinalDeliveryDate;
                
                // Access by column position (3rd and 5th columns)
                const jobNumber = (columnNames[jobNumberColumnIndex] && r[columnNames[jobNumberColumnIndex]]) ? String(r[columnNames[jobNumberColumnIndex]]) : "";
                const jobName = (columnNames[jobNameColumnIndex] && r[columnNames[jobNameColumnIndex]]) ? String(r[columnNames[jobNameColumnIndex]]) : "";
                const orderQty = orderQtyColumnName ? (r[orderQtyColumnName] ? String(r[orderQtyColumnName]) : "") : "";
                
                return [
                    `• Item: ${jobName}`,
                    `  Qty: ${orderQty}`,
                    `  Job No: ${jobNumber}`,
                    `  Updated Committed Delivery: ${fmtDate(updatedDate)}`
                ].join("\n");
            }).join("\n\n");
        }

        // 7) Send messages for each client
        for (const [ledgerId, clientRows] of byClient.entries()) {
            // Use field names from comm_pending_delivery_followup_by_ids (same as material-readiness endpoint)
            const clientName = clientRows[0]["Client Name"] || clientRows[0]["ClientName"] || "";
            const contactPerson = clientRows[0]["Contact Person"] || clientRows[0]["ContactPerson"] || "";
            const contactName = (contactPerson.split(",")[0] || clientName).trim();

            const orderLines = buildOrderLinesWithUpdatedDates(clientRows);

            let whatsappText = `Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

We regret to inform you that due to unforeseen circumstances, we will not be able to deliver the below jobs within the committed timeframe. Please find the updated committed delivery dates below:

  ${orderLines}

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailSubject = `Updated Delivery Schedule | ${clientName}`;
            let emailBody = `Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd.

We regret to inform you that due to unforeseen circumstances, we will not be able to deliver the below jobs within the committed timeframe. Please find the updated committed delivery dates below:

  ${orderLines}

Regards,
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            // For 2nd intimation (comm_pending_delivery_followup_by_ids), use "Contact Email" and "Contact phone" like material-readiness endpoint
            const emailList = splitCsv(clientRows[0]["Contact Email"] || clientRows[0]["ContactEmail"] || clientRows[0]["Concern Email"] || clientRows[0]["ConcernEmail"] || "");
            const mobileList = splitCsv(clientRows[0]["Contact phone"] || clientRows[0]["Contactphone"] || clientRows[0]["Concern Mobile No"] || clientRows[0]["ConcernMobileNo"] || "")
                .map(normalizeINPhone)
                .filter(Boolean);

            // Append "Track your orders online" portal block (Scenario 1/2/3)
            const portalAppend = await buildPortalAppend({
                pool,
                customerEmail: emailList[0] || null
            });
            whatsappText += portalAppend;
            emailBody += portalAppend;

            let sentEmail = false;
            let sentWhatsapp = false;

            // Send WhatsApp messages
            if (mobileList.length && creds.ProductID && creds.ApiKey && creds.PhoneID) {
                for (const to of mobileList) {
                    try {
                        await sendWhatsAppMaytapi({
                            productId: creds.ProductID,
                            phoneId: creds.PhoneID,
                            apiKey: creds.ApiKey,
                            toNumber: to,
                            text: whatsappText
                        });
                        sentWhatsapp = true;
                    } catch (waErr) {
                        console.error('[WHATSAPP ERROR]', waErr.message);
                        throw waErr;
                    }
                }
            }

            // Send Email
            if (emailList.length && creds.SMTPServer && creds.SMTPUserName && creds.SMTPUserPassword) {
                try {
                    await sendEmailSMTP({
                        creds,
                        to: emailList.join(","),
                        subject: emailSubject,
                        text: emailBody
                    });
                    sentEmail = true;
                } catch (emailErr) {
                    console.error('[EMAIL ERROR]', emailErr.message);
                    throw emailErr;
                }
            }

            // Add per-job details to results
            // Get column names in order from the first row
            const firstRow = clientRows[0];
            const columnNames = Object.keys(firstRow);
            const jobNumberColumnIndex = 2; // 3rd column (0-based index)
            const jobNameColumnIndex = 4;    // 5th column (0-based index)
            
            // Find Order Qty column
            let orderQtyColumnName = null;
            for (const key of columnNames) {
                const keyLower = key.toLowerCase();
                if ((keyLower.includes('order') && keyLower.includes('qty')) ||
                    key === 'Order Qty' || key === 'OrderQty') {
                    orderQtyColumnName = key;
                    break;
                }
            }
            
            clientRows.forEach(row => {
                const updatedDate = dateUpdatesMap.get(Number(row.OrderBookingDetailsID)) || row["Committed Delivery Date"] || row["CommittedDeliveryDate"] || row["Final Delivery Date"] || row.FinalDeliveryDate;
                
                // Access by column position (3rd and 5th columns)
                const jobNumber = (columnNames[jobNumberColumnIndex] && row[columnNames[jobNumberColumnIndex]]) ? String(row[columnNames[jobNumberColumnIndex]]) : "";
                const jobName = (columnNames[jobNameColumnIndex] && row[columnNames[jobNameColumnIndex]]) ? String(row[columnNames[jobNameColumnIndex]]) : "";
                const orderQty = orderQtyColumnName ? (row[orderQtyColumnName] ? String(row[orderQtyColumnName]) : "") : "";
                
                results.push({
                    orderBookingDetailsID: row.OrderBookingDetailsID,
                    jobCardNo: jobNumber,
                    orderQty: orderQty,
                    clientName: row["Client Name"] || row["ClientName"] || clientName,
                    jobName: jobName,
                    finalDeliveryDate: updatedDate || '',
                    contactPerson: row["Contact Person"] || row["ContactPerson"] || '',
                    mailSent: sentEmail ? 'Yes' : 'No',
                    whatsappSent: sentWhatsapp ? 'Yes' : 'No'
                });
            });
        }

        return res.json({
            status: true,
            message: 'Delivery dates updated and messages sent successfully',
            results: results
        });
    } catch (error) {
        console.error('[WHATSAPP-UPDATE-DATES-SEND] Error:', error);
        return res.status(500).json({
            status: false,
            error: error.message || 'Failed to update delivery dates and send messages'
        });
    }
});

// ============================================
// Contractor PO System Routes (COMMENTED OUT - using subfolder backend instead)
// ============================================

// Helper function to get MSSQL connection for contractor PO routes.
//
// Contractor PO MUST ALWAYS use Kolkata (IndusEnterprise). To prevent the
// database from being silently switched by other callers we:
//   1. Hardcode database to 'IndusEnterprise' — no env fallback.
//   2. Use `new sql.ConnectionPool()` so this pool is isolated from the
//      mssql global singleton pool (which is shared by `sql.connect()` and
//      `getPool('AHM')` callers, and can be overwritten).
//   3. Verify DB_NAME() on every reuse; if drifted, run USE [IndusEnterprise]
//      and recreate the pool if the switch fails.
const CONTRACTOR_PO_DATABASE = 'IndusEnterprise';
let contractorPool = null;
let contractorConnectionPromise = null;

async function buildContractorPool() {
  const serverEnv = process.env.DB_SERVER || 'cdcindas.24mycloud.com';
  let serverHost = serverEnv;
  let serverPort = Number(process.env.DB_PORT) || 51175;
  if (serverEnv.includes(',')) {
    const parts = serverEnv.split(',');
    serverHost = parts[0];
    const parsed = parseInt(parts[1], 10);
    if (!Number.isNaN(parsed)) serverPort = parsed;
  }
  const config = {
    server: serverHost,
    port: serverPort,
    // Hardcoded: contractor PO must always run against IndusEnterprise (Kolkata).
    database: CONTRACTOR_PO_DATABASE,
    user: process.env.DB_USER || 'indus',
    password: process.env.DB_PASSWORD || 'Param@99811',
    connectionTimeout: 10000,
    requestTimeout: 30000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
  };

  console.log('🔌 [MSSQL] Establishing isolated Contractor-PO pool...');
  const startTime = Date.now();
  // Isolated pool — does NOT touch the mssql global singleton.
  const newPool = new sql.ConnectionPool(config);
  await newPool.connect();

  // Belt-and-suspenders: enforce DB context.
  await newPool.request().query(`USE [${CONTRACTOR_PO_DATABASE}]`);
  const verify = await newPool.request().query('SELECT DB_NAME() AS currentDb');
  const actualDb = verify.recordset?.[0]?.currentDb;
  if (actualDb !== CONTRACTOR_PO_DATABASE) {
    await newPool.close().catch(() => {});
    throw new Error(`Contractor PO pool ended up on ${actualDb}, expected ${CONTRACTOR_PO_DATABASE}`);
  }
  console.log(`✅ [MSSQL] Contractor-PO connected to ${CONTRACTOR_PO_DATABASE} in ${Date.now() - startTime}ms`);

  newPool.on('error', (err) => {
    console.error('❌ [MSSQL] Contractor-PO pool error:', err);
    contractorPool = null;
    contractorConnectionPromise = null;
  });

  return newPool;
}

async function getConnection() {
  try {
    // Reuse existing healthy pool — but verify it's still on IndusEnterprise.
    if (contractorPool && contractorPool.connected) {
      try {
        const dbCheck = await contractorPool.request().query('SELECT DB_NAME() AS currentDb');
        const actualDb = dbCheck.recordset?.[0]?.currentDb;
        if (actualDb === CONTRACTOR_PO_DATABASE) {
          return contractorPool;
        }
        // Drifted (extremely unlikely for an isolated pool, but recover anyway).
        console.warn(`⚠️ [MSSQL] Contractor-PO pool drifted to ${actualDb}. Switching back to ${CONTRACTOR_PO_DATABASE}.`);
        await contractorPool.request().query(`USE [${CONTRACTOR_PO_DATABASE}]`);
        const reverify = await contractorPool.request().query('SELECT DB_NAME() AS currentDb');
        if (reverify.recordset?.[0]?.currentDb === CONTRACTOR_PO_DATABASE) {
          return contractorPool;
        }
        // Could not switch — recreate.
        console.warn('⚠️ [MSSQL] Could not switch contractor pool back; recreating.');
        await contractorPool.close().catch(() => {});
        contractorPool = null;
      } catch (verifyErr) {
        console.warn('⚠️ [MSSQL] Contractor-PO pool verification failed; recreating.', verifyErr.message);
        await contractorPool.close().catch(() => {});
        contractorPool = null;
      }
    }

    if (contractorConnectionPromise) {
      console.log('⏳ [MSSQL] Contractor-PO connection already in progress, waiting...');
      return await contractorConnectionPromise;
    }

    contractorConnectionPromise = buildContractorPool();
    contractorPool = await contractorConnectionPromise;
    contractorConnectionPromise = null;
    return contractorPool;
  } catch (error) {
    console.error('❌ [MSSQL] Contractor-PO connection error:', error);
    contractorPool = null;
    contractorConnectionPromise = null;
    throw error;
  }
}

// Contractor_WD savedInBill helpers.
// Legacy opsDone rows may not have savedInBill. Treat missing/empty as billed ('Yes').
// Only explicit savedInBill === 'No' is unsaved work pending bill submission.
function isOpsDoneUnsaved(od) {
  return String(od?.savedInBill ?? '').trim() === 'No';
}

function isOpsDoneBilled(od) {
  return !isOpsDoneUnsaved(od);
}

// Packaging jobs may record up to this much of the job quantity beyond an
// operation's total. work-done.html caps entry at the same figure
// (packagingTotalQty * 0.05 + pending), and the bill delete reversal uses it
// too, so the server has to allow exactly as much as the client does.
const PACKAGING_ALLOWANCE_PCT = 5;
const QTY_TOL = 0.5;

function packagingAllowanceFor(jobOpsMaster) {
  if (!jobOpsMaster) return 0;
  if (String(jobOpsMaster.segmentName || '').trim() !== 'Packaging') return 0;
  const basis = Number(jobOpsMaster.totalQty || 0);
  return basis > 0 ? Math.round(basis * PACKAGING_ALLOWANCE_PCT / 100) : 0;
}

// How much of each operation is already covered by live (non-deleted) bills.
// Bills identify an operation by name and rate, not by opId, so that is the
// key used here. Pass excludeBillNumber to leave one bill out — needed when
// re-checking a bill that is itself being edited.
async function getLiveBilledQtyByOp(jobNumbers, excludeBillNumber) {
  const list = Array.isArray(jobNumbers) ? jobNumbers.filter(Boolean) : [];
  if (list.length === 0) return {};

  const query = {
    'jobs.jobNumber': { $in: list },
    $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }]
  };
  if (excludeBillNumber) query.billNumber = { $ne: excludeBillNumber };

  const bills = await Bill.find(query).lean();
  const billed = {};
  bills.forEach(b => {
    (b.jobs || []).forEach(j => {
      if (j.isAdhoc) return;
      const jn = String(j.jobNumber || '').trim();
      if (!list.includes(jn)) return;
      (j.ops || []).forEach(op => {
        const key = [jn, String(op.opsName || '').trim(), parseFloat(Number(op.rate || 0).toFixed(2))].join('|');
        billed[key] = (billed[key] || 0) + Number(op.qtyCompleted || 0);
      });
    });
  });
  return billed;
}

// Flip the Contractor_WD opsDone entries covered by a bill to savedInBill:'Yes'.
// Shared by POST /bills and POST /work/mark-billed: creating a bill and marking
// its work as billed used to be two separate round trips, so a failure of the
// second left the bill in place with its work still looking pending — it would
// then reload into Bill Details on the next search and could be billed twice.
// Returns how many entries were marked.
async function markContractorWDEntriesBilled(contractorId, items) {
  const jobGroups = {};
  const adhocGroups = {};

  for (const item of (items || [])) {
    if (item && item.isAdhoc && item.adhocOrderId) {
      if (!adhocGroups[item.adhocOrderId]) adhocGroups[item.adhocOrderId] = [];
      adhocGroups[item.adhocOrderId].push(item);
    } else if (item && item.jobNumber) {
      if (!jobGroups[item.jobNumber]) jobGroups[item.jobNumber] = [];
      jobGroups[item.jobNumber].push(item);
    }
  }

  const applyToDoc = (contractorWD, opsToMark) => {
    let marked = 0;
    for (const markItem of opsToMark) {
      const vpb = parseFloat(Number(markItem.valuePerBook || 0).toFixed(2));
      const opsId = String(markItem.opsId || '');
      for (const od of contractorWD.opsDone) {
        if (isOpsDoneBilled(od)) continue;
        const odVpb = parseFloat(Number(od.valuePerBook || 0).toFixed(2));
        const idMatch = opsId && String(od.opsId) === opsId;
        const nameMatch = od.opsName === markItem.opsName && odVpb === vpb;
        if (idMatch || nameMatch) {
          od.savedInBill = 'Yes';
          marked++;
        }
      }
    }
    return marked;
  };

  let totalMarked = 0;

  for (const jobNumber of Object.keys(jobGroups)) {
    const contractorWD = await ContractorWD.findOne({ contractorId, jobId: jobNumber, isAdhoc: { $ne: true } });
    if (!contractorWD) continue;
    const marked = applyToDoc(contractorWD, jobGroups[jobNumber]);
    if (marked > 0) {
      contractorWD.markModified('opsDone');
      await contractorWD.save();
      totalMarked += marked;
    }
  }

  for (const adhocOrderId of Object.keys(adhocGroups)) {
    const contractorWD = await ContractorWD.findOne({ contractorId, isAdhoc: true, adhocOrderId });
    if (!contractorWD) continue;
    const marked = applyToDoc(contractorWD, adhocGroups[adhocOrderId]);
    if (marked > 0) {
      contractorWD.markModified('opsDone');
      await contractorWD.save();
      totalMarked += marked;
    }
  }

  return totalMarked;
}

/*

async function getContractorConnection() {
  try {
    const expectedDb = 'IndusEnterprise'; // Always use IndusEnterprise for contractor PO system
    
    if (contractorPool && contractorPool.connected) {
      // Verify we're still on the correct database before returning
      try {
        const dbCheck = await contractorPool.request().query('SELECT DB_NAME() AS currentDb');
        const currentDb = dbCheck.recordset[0]?.currentDb;
        
        if (currentDb !== expectedDb) {
          console.warn(`⚠️ [CONTRACTOR-MSSQL] Database context mismatch. Expected: ${expectedDb}, Current: ${currentDb}. Reconnecting...`);
          contractorPool = null;
          // Fall through to create new connection
        } else {
          return contractorPool;
        }
      } catch (checkErr) {
        console.warn('⚠️ [CONTRACTOR-MSSQL] Database check failed, reconnecting...', checkErr);
        contractorPool = null;
        // Fall through to create new connection
      }
    }

    if (contractorConnectionPromise) {
      console.log('⏳ [CONTRACTOR-MSSQL] Connection already in progress, waiting...');
      return await contractorConnectionPromise;
    }

    console.log('🔌 [CONTRACTOR-MSSQL] Establishing connection to IndusEnterprise...');
    const startTime = Date.now();
    
    const serverEnv = process.env.DB_SERVER || 'cdcindas.24mycloud.com';
    let serverHost = serverEnv;
    let serverPort = Number(process.env.DB_PORT || 51175);

    if (!serverPort && serverEnv.includes(',')) {
      const parts = serverEnv.split(',');
      serverHost = parts[0];
      const parsed = parseInt(parts[1], 10);
      if (!Number.isNaN(parsed)) {
        serverPort = parsed;
      }
    }

    const config = {
      server: serverHost,
      port: serverPort,
      database: expectedDb, // Always use IndusEnterprise - no environment variable override
      user: process.env.DB_USER || 'indus',
      password: process.env.DB_PASSWORD || 'Param@99811',
      connectionTimeout: 10000,
      requestTimeout: 30000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      },
      options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true
      }
    };

    contractorConnectionPromise = sql.connect(config);
    contractorPool = await contractorConnectionPromise;
    
    const connectionTime = Date.now() - startTime;
    console.log(`✅ [CONTRACTOR-MSSQL] Connected in ${connectionTime}ms`);
    
    // CRITICAL: Explicitly switch to IndusEnterprise database using USE statement
    // This ensures we're using the right DB even if user's default DB is different
    try {
      await contractorPool.request().query(`USE [${expectedDb}]`);
      console.log(`✅ [CONTRACTOR-MSSQL] Explicitly switched to database [${expectedDb}]`);
      
      // Verify we're on the correct database
      const verifyDb = await contractorPool.request().query('SELECT DB_NAME() AS currentDb');
      const actualDb = verifyDb.recordset[0]?.currentDb;
      if (actualDb !== expectedDb) {
        throw new Error(`Failed to switch to database ${expectedDb}. Currently on: ${actualDb}`);
      }
      console.log(`✅ [CONTRACTOR-MSSQL] Verified connection to correct database`, { expected: expectedDb, actual: actualDb });
    } catch (useErr) {
      console.error(`❌ [CONTRACTOR-MSSQL] Failed to switch to database ${expectedDb}:`, useErr);
      contractorPool = null;
      contractorConnectionPromise = null;
      throw useErr;
    }
    
    contractorConnectionPromise = null;
    
    contractorPool.on('error', (err) => {
      console.error('❌ [CONTRACTOR-MSSQL] Connection pool error:', err);
      contractorPool = null;
      contractorConnectionPromise = null;
    });

    return contractorPool;
  } catch (error) {
    console.error('❌ [CONTRACTOR-MSSQL] Connection error:', error);
    contractorPool = null;
    contractorConnectionPromise = null;
    throw error;
  }
}

// ============================================
// Contractor PO Routes (using MongoDB) - COMMENTED OUT TO AVOID CONFLICTS
// These routes conflict with the main app routes
// ============================================

/*
// Auth routes
router.post('/auth/login', async (req, res) => {
  try {
    const { userId, passkey } = req.body;

    if (!userId || !passkey) {
      return res.status(400).json({ error: 'User ID and passkey are required' });
    }

    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = passkey === user.passkey || await bcrypt.compare(passkey, user.passkey);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.userId, id: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        userId: user.userId,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

router.post('/auth/register', async (req, res) => {
  try {
    const { userId, passkey, name, role } = req.body;

    if (!userId || !passkey) {
      return res.status(400).json({ error: 'User ID and passkey are required' });
    }

    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPasskey = await bcrypt.hash(passkey, 10);

    const user = new User({
      userId,
      passkey: hashedPasskey,
      name: name || userId,
      role: role || 'user'
    });

    await user.save();

    res.status(201).json({ message: 'User created successfully', userId: user.userId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});
*/

// Jobs routes
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 });
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Error fetching jobs' });
  }
});

router.get('/jobs/search/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber }).lean();

    let previousOps = null;

    if (jobOpsMaster && jobOpsMaster.ops && jobOpsMaster.ops.length > 0) {
      try {
        // Get all opIds from JobopsMaster
        const opIds = jobOpsMaster.ops.map(op => op.opId);

        // Get operation names from Operation collection
        const opsDocs = await Operation.find(
          { _id: { $in: opIds } },
          { _id: 1, opsName: 1 }
        ).lean();

        const opsNameById = {};
        opsDocs.forEach(op => {
          opsNameById[op._id.toString()] = op.opsName;
        });

        // Check Contractor_WD for completed work (jobId is job number string)
        const contractorWDDocs = await ContractorWD.find({
          jobId: jobNumber
        }).lean();

        // Collect unique contractor IDs
        const contractorIds = [
          ...new Set(contractorWDDocs.map(doc => doc.contractorId))
        ];

        // Get contractor names
        const contractors = await Contractor.find({
          contractorId: { $in: contractorIds }
        }).lean();

        const contractorNameById = {};
        contractors.forEach(c => {
          contractorNameById[c.contractorId] = c.name;
        });

        // Aggregate completed quantities by operation and contractor
        // Use opsName + valuePerBook (rounded to 2 decimals) as key for matching
        const quantitiesByOpAndContractor = {};

        const totalCompletedByOp = {}; // Track total completed across all contractors (key: opsName_valuePerBook)

        contractorWDDocs.forEach(doc => {
          const contractorId = doc.contractorId;
          (doc.opsDone || []).forEach(od => {
            if (!od.opsId || !od.opsName || od.opsDoneQty == null || od.valuePerBook == null) {
              return;
            }

            // Round valuePerBook to 2 decimal places for matching
            const odValuePerBook = parseFloat(Number(od.valuePerBook).toFixed(2));
            const odOpsName = od.opsName.trim();
            
            // Create composite key: opsName_valuePerBook
            const opKey = `${odOpsName}_${odValuePerBook}`;

            // Only count if this opId exists in JobopsMaster (preliminary check)
            if (opIds.includes(od.opsId)) {
              if (!quantitiesByOpAndContractor[opKey]) {
                quantitiesByOpAndContractor[opKey] = {};
              }
              if (!quantitiesByOpAndContractor[opKey][contractorId]) {
                quantitiesByOpAndContractor[opKey][contractorId] = 0;
              }
              quantitiesByOpAndContractor[opKey][contractorId] += od.opsDoneQty;

              // Track total completed for this operation
              if (!totalCompletedByOp[opKey]) {
                totalCompletedByOp[opKey] = 0;
              }
              totalCompletedByOp[opKey] += od.opsDoneQty;
            }
          });
        });

        // Build previousOps from JobopsMaster.ops
        // Match using opsName + valuePerBook (rounded to 2 decimals)
        previousOps = {
          contractors: contractorIds.map(id => ({
            contractorId: id,
            name: contractorNameById[id] || id
          })),
          operations: jobOpsMaster.ops.map(op => {
            const totalOpsQty = op.totalOpsQty || 0;
            
            // Get opsName and valuePerBook for this operation
            const opOpsName = opsNameById[op.opId] || 'Unknown';
            const opValuePerBook = parseFloat(Number(op.valuePerBook || 0).toFixed(2));
            
            // Create composite key: opsName_valuePerBook for matching
            const opKey = `${opOpsName}_${opValuePerBook}`;

            const totalCompleted = totalCompletedByOp[opKey] || 0;

            const pending = Math.max(0, totalOpsQty - totalCompleted);

            return {
              opsId: op.opId,
              opsName: opOpsName,
              totalOpsQty,
              totalCompleted,
              pending,
              quantitiesByContractor:
                quantitiesByOpAndContractor[opKey] || {}
            };
          })
        };
      } catch (aggError) {
        console.error('Error building previous ops summary:', aggError);
      }
    }

    res.json({
      job: null,
      operations: [],
      previousOps
    });
  } catch (error) {
    console.error('Error searching job:', error);
    res.status(500).json({ error: 'Error searching job' });
  }
});

// IMPORTANT: Specific routes must come before the general /jobs/:id route
// Search job numbers from MSSQL (when 4+ digits entered)
// This route MUST come before /jobs/:id to avoid route matching conflicts
router.get('/jobs/search-numbers/:jobNumberPart', async (req, res) => {
  console.log('✅ [ROUTE] /jobs/search-numbers/:jobNumberPart route hit!');
  console.log('✅ [ROUTE] Request params:', req.params);
  console.log('✅ [ROUTE] Request URL:', req.url);
  console.log('✅ [ROUTE] Request path:', req.path);
  try {
    const { jobNumberPart } = req.params;
    console.log('🔍 [BACKEND] /jobs/search-numbers called with jobNumberPart:', jobNumberPart);

    if (!jobNumberPart || jobNumberPart.length < 4) {
      return res.status(400).json({ error: 'Job number part must be at least 4 characters' });
    }

    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    request.input('JobNumberPart', sql.NVarChar(255), String(jobNumberPart));

    console.log('🔍 [MSSQL] Calling dbo.contractor_search_jobnumbers with @JobNumberPart =', jobNumberPart);

    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_search_jobnumbers');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    console.log('🔍 [MSSQL] Raw result.recordset:', JSON.stringify(result.recordset, null, 2));
    console.log('🔍 [MSSQL] result.recordset.length:', result.recordset.length);

    const jobNumbers = result.recordset.map((row, index) => {
      console.log(`🔍 [MSSQL] Row ${index}:`, JSON.stringify(row, null, 2));
      const jobNum = row.JobNumber || row.Job_Number || row.jobNumber || row.job_number || 
             row.JobNo || row.Job_NO || Object.values(row)[0];
      console.log(`🔍 [MSSQL] Row ${index} extracted jobNumber:`, jobNum);
      return jobNum;
    }).filter(Boolean);

    console.log('🔍 [BACKEND] Final jobNumbers array:', jobNumbers);
    res.json(jobNumbers);
  } catch (error) {
    console.error('❌ [BACKEND] Error searching job numbers:', error);
    console.error('❌ [BACKEND] Error stack:', error.stack);
    res.status(500).json({ error: 'Error searching job numbers: ' + error.message });
  }
});

// IMPORTANT: Specific routes like /jobs/items-for-color must come BEFORE /jobs/:id
// Otherwise Express will match "items-for-color" as an :id parameter

// Get items for color dropdown (must be before /jobs/:id)
router.get('/jobs/items-for-color', async (req, res) => {
  try {
    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    // Verify database context before executing query
    const expectedDb = 'IndusEnterprise';
    try {
      const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
      const currentDb = dbCheck.recordset[0]?.currentDb;
      if (currentDb !== expectedDb) {
        console.warn(`⚠️ [MSSQL] Database context mismatch. Switching to ${expectedDb}...`);
        await pool.request().query(`USE [${expectedDb}]`);
      }
    } catch (dbErr) {
      console.error('❌ [MSSQL] Database context verification failed:', dbErr);
      return res.status(500).json({ error: 'Database connection error. Please try again.' });
    }

    const request = pool.request();
    
    // Query to get items from itemmaster
    const query = `
      SELECT itemid, itemname, InkColour, PantoneCode 
      FROM itemmaster 
      WHERE itemgroupid=3 
        AND isitemactive=1 
        AND isdeleted=0 
        AND isblocked=0 
        AND IsDeletedTransaction=0
      ORDER BY itemname
    `;

    console.log('🔍 [MSSQL] Executing query to get items for color dropdown');
    const queryStartTime = Date.now();
    const result = await request.query(query);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Query executed in ${queryTime}ms`);

    const items = result.recordset.map(row => ({
      itemId: row.itemid || row.itemId || null,
      itemName: row.itemname || row.itemName || '',
      inkColour: row.InkColour || row.inkColour || null,
      pantoneCode: row.PantoneCode || row.pantoneCode || null
    }));

    res.json({
      items: items
    });
  } catch (error) {
    console.error('Error fetching items for color:', error);
    res.status(500).json({ error: 'Error fetching items: ' + error.message });
  }
});

// Restrict :id to valid Mongo ObjectId strings to prevent route conflicts
// with other /jobs/* endpoints (e.g. /jobs/possible-completed-jobs).
router.get('/jobs/:id', async (req, res, next) => {
  try {
    // Avoid route conflict: allow later route `/jobs/possible-completed-jobs`
    // to handle this request instead of attempting `Job.findById()`.
    const { id } = req.params || {};
    if (id === 'possible-completed-jobs') {
      return next();
    }

    // Prevent Mongoose CastError for non-ObjectId values.
    // (Only our /jobs/:id routes are Mongo-backed.)
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = await Job.findById(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const operations = await JobOperation.find({ job: job._id })
      .populate('operation', 'opsName type');

    res.json({
      job,
      operations
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ error: 'Error fetching job' });
  }
});

router.post('/jobs', async (req, res) => {
  try {
    const { jobNumber, clientName, jobTitle, qty, productCat, unitPrice } = req.body;

    if (!jobNumber || !clientName || !jobTitle || !qty) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existingJob = await Job.findOne({ jobNumber });
    if (existingJob) {
      return res.status(400).json({ error: 'Job number already exists' });
    }

    const job = new Job({
      jobNumber,
      clientName,
      jobTitle,
      qty,
      productCat: productCat || '',
      unitPrice: unitPrice || 0
    });

    await job.save();
    res.status(201).json(job);
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Error creating job' });
  }
});

router.post('/jobs/:jobId/operations', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { operations } = req.body;

    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const createdOperations = [];

    for (const op of operations) {
      const { operationId, qtyPerBook, rate, ratePerBook } = op;

      if (!operationId || qtyPerBook === undefined || rate === undefined || ratePerBook === undefined) {
        continue;
      }

      const jobOperation = new JobOperation({
        job: jobId,
        operation: operationId,
        qtyPerBook,
        rate,
        ratePerBook,
        contractorWork: []
      });

      await jobOperation.save();
      createdOperations.push(jobOperation);
    }

    res.status(201).json(createdOperations);
  } catch (error) {
    console.error('Error adding operations to job:', error);
    res.status(500).json({ error: 'Error adding operations to job' });
  }
});

router.post('/jobs/jobopsmaster', async (req, res) => {
  try {
    const {
      jobNumber,
      operations,
      qty,
      clientName,
      jobTitle,
      productCat,
      segmentName,
      unitPrice
    } = req.body;

    if (!jobNumber || !operations || !Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ error: 'Job number and at least one operation are required' });
    }

    // totalQty in JobopsMaster should be the qty from UI
    const totalQty = Number(qty || 0);
    const parsedUnitPrice = Number(unitPrice || 0);
    // Fetch all operations to get their types and names for calculation
    const operationIds = operations.map(op => op.operationId).filter(Boolean);
    const operationDocs = await Operation.find({ _id: { $in: operationIds } });
    const operationTypeMap = {};
    const operationNameMap = {};
    operationDocs.forEach(op => {
      // Normalize ID to string for consistent lookup
      const idStr = op._id.toString();
      operationTypeMap[idStr] = op.type;
      operationNameMap[idStr] = op.opsName;
    });
    
    console.log('Operation Type Map:', JSON.stringify(operationTypeMap, null, 2));

    // Match previous backend: 1/x save qtyPerBook as 1/x; totalOpsQty/pendingOpsQty by operation type
    const ops = operations
      .map(op => {
        const { operationId, qtyPerBook, ratePerBook } = op;
        if (!operationId || qtyPerBook === undefined || ratePerBook === undefined) {
          return null;
        }

        const qtyPerBookNum = Number(qtyPerBook);
        const valuePerBookNum = parseFloat(Number(ratePerBook).toFixed(14));

        if (isNaN(qtyPerBookNum) || qtyPerBookNum < 0 || isNaN(valuePerBookNum) || valuePerBookNum < 0) {
          return null;
        }
        const opIdStr = String(operationId);
        const operationType = operationTypeMap[opIdStr];
        const opsName = operationNameMap[opIdStr] || 'Unknown';

        // For 1/x: save qtyPerBook as 1/qtyPerBook; totalOpsQty = totalQty
        // For 1*x: save qtyPerBook as is; totalOpsQty = totalQty
        // For 1:1: save qtyPerBook as is; totalOpsQty = qtyPerBook * totalQty
        let savedQtyPerBook;
        let totalOpsQty;
        if (operationType === '1/x') {
          savedQtyPerBook = qtyPerBookNum > 0 ? parseFloat((1 / qtyPerBookNum).toFixed(14)) : 0;
          totalOpsQty = totalQty;
          console.log(`[1/x] Operation ${opIdStr}: totalQty=${totalQty}, user qtyPerBook=${qtyPerBookNum}, saved qtyPerBook=${savedQtyPerBook}, totalOpsQty=${totalOpsQty}`);
        } else if (operationType === '1*x') {
          savedQtyPerBook = qtyPerBookNum;
          totalOpsQty = totalQty;
          console.log(`[1*x] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty}`);
        } else {
          savedQtyPerBook = qtyPerBookNum;
          totalOpsQty = qtyPerBookNum * totalQty;
          if (operationType) {
            console.log(`[${operationType}] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty}`);
          } else {
            console.log(`[WARNING: Operation type not found] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty} (using default multiplication)`);
          }
        }

        return {
          opId: opIdStr,
          qtyPerBook: savedQtyPerBook,
          totalOpsQty,
          pendingOpsQty: totalOpsQty,
          valuePerBook: valuePerBookNum
        };
      })
      .filter(Boolean);

    if (ops.length === 0) {
      return res.status(400).json({ error: 'No valid operations to save' });
    }

    let jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber });

    if (!jobOpsMaster) {
      jobOpsMaster = new JobOpsMaster({
        jobId: jobNumber,
        totalQty,
        clientName: clientName || '',
        jobTitle: jobTitle || '',
        productCategory: productCat || '',
        segmentName: segmentName || '',
        unitPrice: Number.isFinite(parsedUnitPrice) && parsedUnitPrice >= 0 ? parsedUnitPrice : 0,
        ops
      });
    } else {
      // Changing the job quantity leaves every existing operation's
      // totalOpsQty at the figure derived from the old quantity, so the job
      // silently ends up describing two different quantities. Refuse once work
      // has been recorded; before that, recompute the existing operations.
      const previousTotalQty = Number(jobOpsMaster.totalQty || 0);
      if (totalQty !== previousTotalQty && (jobOpsMaster.ops || []).length > 0) {
        const workedOps = (jobOpsMaster.ops || []).filter(
          o => Number(o.pendingOpsQty || 0) < Number(o.totalOpsQty || 0) - 0.5
        );
        if (workedOps.length > 0) {
          return res.status(400).json({
            error:
              `Job quantity cannot be changed from ${previousTotalQty} to ${totalQty}: work has ` +
              `already been recorded against ${workedOps.length} operation(s) of this job, and ` +
              `their quantities were derived from ${previousTotalQty}.`
          });
        }
        // No work recorded yet — rescale the existing operations to match.
        const existingOpDocs = await Operation.find({
          _id: {
            $in: (jobOpsMaster.ops || []).map(o => {
              try { return new mongoose.Types.ObjectId(o.opId); } catch { return null; }
            }).filter(Boolean)
          }
        }).lean();
        const existingTypeMap = {};
        existingOpDocs.forEach(o => { existingTypeMap[o._id.toString()] = o.type; });

        jobOpsMaster.ops.forEach(o => {
          const type = existingTypeMap[String(o.opId)];
          const newTotalOpsQty = (type === '1/x' || type === '1*x')
            ? totalQty
            : Number(o.qtyPerBook || 0) * totalQty;
          o.totalOpsQty = newTotalOpsQty;
          o.pendingOpsQty = newTotalOpsQty;
          o.lastUpdatedDate = new Date();
        });
        jobOpsMaster.markModified('ops');
      }

      jobOpsMaster.totalQty = totalQty;
      if (clientName !== undefined) {
        jobOpsMaster.clientName = clientName || '';
      }
      if (jobTitle !== undefined) {
        jobOpsMaster.jobTitle = jobTitle || '';
      }
      if (productCat !== undefined) {
        jobOpsMaster.productCategory = productCat || '';
      }
      if (segmentName !== undefined) {
        jobOpsMaster.segmentName = segmentName || '';
      }
      if (unitPrice !== undefined) {
        jobOpsMaster.unitPrice = Number.isFinite(parsedUnitPrice) && parsedUnitPrice >= 0 ? parsedUnitPrice : 0;
      }

      // Fetch operation names for existing operations in JobOpsMaster
      const existingOpIds = jobOpsMaster.ops.map(existingOp => existingOp.opId).filter(Boolean);
      const allOpIds = [...new Set([...operationIds, ...existingOpIds])];
      const allOperationDocs = await Operation.find({ _id: { $in: allOpIds } });
      const allOperationNameMap = {};
      allOperationDocs.forEach(op => {
        const idStr = op._id.toString();
        allOperationNameMap[idStr] = op.opsName;
      });

      // Process each new operation: duplicate by opId only (match previous backend)
      for (const newOp of ops) {
        const opIdStr = String(newOp.opId);
        const opsName = allOperationNameMap[opIdStr] || 'Unknown';
        const existingOpIndex = jobOpsMaster.ops.findIndex(existingOp => String(existingOp.opId) === opIdStr);
        if (existingOpIndex !== -1) {
          return res.status(400).json({
            error: `Operation "${opsName}" is already added to this job. Duplicate operations are not allowed.`
          });
        }
        jobOpsMaster.ops.push(newOp);
      }
    }

    await jobOpsMaster.save();

    res.status(201).json(jobOpsMaster);
  } catch (error) {
    console.error('Error saving job operations to JobopsMaster:', error);
    res.status(500).json({ error: 'Error saving job operations' });
  }
});

function getGPPct(totalPrice, totalCost) {
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return null;
  return ((totalPrice - totalCost) / totalPrice) * 100;
}

function getPeriodLabel(dateObj, granularity) {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');

  if (granularity === 'date') return `${year}-${month}-${day}`;
  if (granularity === 'month') return `${year}-${month}`;
  if (granularity === 'year') return String(year);
  if (granularity === 'quarter') return `${year}-Q${Math.floor(dateObj.getUTCMonth() / 3) + 1}`;

  // ISO week
  const temp = new Date(Date.UTC(year, dateObj.getUTCMonth(), dateObj.getUTCDate()));
  const dayNum = temp.getUTCDay() || 7;
  temp.setUTCDate(temp.getUTCDate() + 4 - dayNum);
  const weekYear = temp.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNo = Math.ceil((((temp - yearStart) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNo).padStart(2, '0')}`;
}

// Summary routes
router.get('/summary', async (req, res) => {
  try {
    const deletedBillJobRows = await Bill.aggregate([
      { $match: { isDeleted: 1 } },
      { $unwind: '$jobs' },
      { $group: { _id: '$jobs.jobNumber' } },
    ]);
    const deletedBillJobIdSet = new Set(
      deletedBillJobRows.map(row => String(row._id || '').trim()).filter(Boolean)
    );

    const contractorJobIds = await ContractorWD.distinct('jobId');
    const uniqueJobIds = [...new Set((contractorJobIds || []).map(j => String(j).trim()).filter(Boolean))]
      .filter(jobId => !deletedBillJobIdSet.has(jobId));

    const jobOpsDocs = uniqueJobIds.length > 0
      ? await JobOpsMaster.find({ jobId: { $in: uniqueJobIds } }, { jobId: 1, totalQty: 1, unitPrice: 1 }).lean()
      : [];

    const priceByJobId = {};
    let totalPrice = 0;
    jobOpsDocs.forEach(doc => {
      const jobId = String(doc.jobId || '').trim();
      const jobPrice = Number(doc.unitPrice || 0) * Number(doc.totalQty || 0);
      const safeJobPrice = Number.isFinite(jobPrice) ? jobPrice : 0;
      priceByJobId[jobId] = safeJobPrice;
      totalPrice += safeJobPrice;
    });

    const billRows = await Bill.aggregate([
      { $match: { $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }] } },
      { $unwind: '$jobs' },
      { $unwind: '$jobs.ops' },
      {
        $group: {
          _id: '$jobs.jobNumber',
          totalCost: { $sum: { $ifNull: ['$jobs.ops.totalValue', 0] } },
        },
      },
    ]);

    const costByJobId = {};
    let totalCost = 0;
    billRows.forEach(row => {
      const jobId = String(row._id || '').trim();
      if (!jobId || deletedBillJobIdSet.has(jobId)) return;
      const cost = Number(row.totalCost || 0);
      costByJobId[jobId] = cost;
      totalCost += cost;
    });

    const allJobIds = [...new Set([...Object.keys(priceByJobId), ...Object.keys(costByJobId)])];
    const jobWiseData = allJobIds.map(jobId => {
      const jobTotalPrice = Number(priceByJobId[jobId] || 0);
      const jobTotalCost = Number(costByJobId[jobId] || 0);
      return {
        jobId,
        totalPrice: jobTotalPrice,
        totalCost: jobTotalCost,
        gpPercent: getGPPct(jobTotalPrice, jobTotalCost),
      };
    });

    res.json({
      totalPrice,
      totalCost,
      gpPercent: getGPPct(totalPrice, totalCost),
      jobWiseData,
    });
  } catch (error) {
    console.error('Error building summary:', error);
    res.status(500).json({ error: 'Error building summary' });
  }
});

router.get('/summary/chart', async (req, res) => {
  try {
    const filterType = String(req.query.filterType || 'year').toLowerCase();
    const allowed = new Set(['month', 'quarter', 'year']);
    if (!allowed.has(filterType)) {
      return res.status(400).json({ error: 'Invalid filterType. Use month, quarter, or year.' });
    }

    const now = new Date();
    const selectedYear = Number(req.query.year || now.getUTCFullYear());
    const selectedMonth = Number(req.query.month || (now.getUTCMonth() + 1));
    const selectedQuarter = Number(req.query.quarter || (Math.floor(now.getUTCMonth() / 3) + 1));

    const start = new Date(Date.UTC(selectedYear, 0, 1));
    const end = new Date(Date.UTC(selectedYear + 1, 0, 1));
    if (filterType === 'month') {
      const safeMonth = Math.min(12, Math.max(1, selectedMonth));
      start.setUTCMonth(safeMonth - 1, 1);
      end.setUTCFullYear(selectedYear, safeMonth, 1);
    } else if (filterType === 'quarter') {
      const safeQuarter = Math.min(4, Math.max(1, selectedQuarter));
      const startMonth = (safeQuarter - 1) * 3;
      start.setUTCMonth(startMonth, 1);
      end.setUTCFullYear(selectedYear, startMonth + 3, 1);
    }

    const contractorRows = await Bill.aggregate([
      {
        $match: {
          $and: [
            { $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }] },
            { createdAt: { $gte: start, $lt: end } },
          ],
        },
      },
      { $unwind: '$jobs' },
      { $unwind: '$jobs.ops' },
      {
        $group: {
          _id: '$contractorName',
          totalValue: { $sum: { $ifNull: ['$jobs.ops.totalValue', 0] } },
          billNumbers: { $addToSet: '$billNumber' },
        },
      },
      {
        $project: {
          _id: 1,
          totalValue: 1,
          billCount: { $size: '$billNumbers' },
        },
      },
      { $sort: { totalValue: -1 } },
    ]);

    const labels = contractorRows.map(row => String(row._id || 'Unknown'));
    const totalValues = contractorRows.map(row => Number(row.totalValue || 0));
    const billCounts = contractorRows.map(row => Number(row.billCount || 0));

    res.json({
      labels,
      totalValues,
      billCounts,
      filterType,
      year: selectedYear,
      month: selectedMonth,
      quarter: selectedQuarter,
    });
  } catch (error) {
    console.error('Error building summary chart:', error);
    res.status(500).json({ error: 'Error building summary chart' });
  }
});

function parseYmdExportDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function formatYmdExportDate(dateObj) {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getExportDateRange(query) {
  const now = new Date();
  const defaultEndExclusive = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));

  const endParsed = parseYmdExportDate(query.endDate);
  const endExclusive = endParsed
    ? new Date(endParsed.getTime() + 86400000)
    : defaultEndExclusive;

  let start = parseYmdExportDate(query.startDate);
  if (!start) {
    start = new Date(endExclusive);
    start.setUTCMonth(start.getUTCMonth() - 1);
  }

  if (start >= endExclusive) {
    const err = new Error('startDate must be before endDate');
    err.statusCode = 400;
    throw err;
  }

  const endInclusive = new Date(endExclusive.getTime() - 1);
  return {
    start,
    endExclusive,
    startLabel: formatYmdExportDate(start),
    endLabel: formatYmdExportDate(endInclusive),
  };
}

function getContractorCostPct(totalJobValue, contractorAmount) {
  const price = Number(totalJobValue || 0);
  const cost = Number(contractorAmount || 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  return (cost / price) * 100;
}

function formatOpsProcessed(opsByName) {
  return Object.values(opsByName || {})
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
    .map((info) => `${info.name}: ${Number(info.qty || 0)}`)
    .join('; ');
}

function getCompletedQtyFromOps(opsByName, orderQty) {
  // Each entry's qty is already the TOTAL completed quantity for that
  // operation, summed across every contractor and completion record in
  // the selected period (see rollupContractorWorkRows). An operation is
  // only considered "processed" for the job's completed-qty calculation
  // when its completed qty is more than 30% of the job's order qty (when
  // an order qty is known); operations with zero completed qty are
  // always excluded so they don't drag the job's completed qty down to 0.
  const safeOrderQty = Number(orderQty || 0);
  const eligibleQtys = Object.values(opsByName || {})
    .map((info) => Number(info?.qty || 0))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .filter((qty) => {
      if (!(safeOrderQty > 0)) return true;
      return (qty / safeOrderQty) > 0.30;
    });

  if (!eligibleQtys.length) return 0;
  return Math.min(...eligibleQtys);
}

// ---------------------------------------------------------------------------
// Contractor billing anomaly flagging.
// Judges each JOB only by its realised per-piece rate and % of job value vs
// comparable jobs (same product category, segment fallback). It never reads
// the operation-level columns, which are contractor/accounts-entered and
// therefore manipulable. See the flagging-logic specification.
// ---------------------------------------------------------------------------
const FLAG_PARAMS = {
  Z_THRESHOLD: 3.0,      // robust-sigmas above median that counts as a breach
  MIN_COHORT: 8,         // min jobs in a cohort before its baseline is trusted
  MIN_REL_SPREAD: 0.15,  // spread floor: sigma >= 15% of the median
  DOUBLE_LO: 1.8,        // ratio window that reads as "qty billed twice"
  DOUBLE_HI: 2.2,
  QTY_MISMATCH_PCT: 0.25,// processed-vs-order gap beyond this is notable
  PCT_SANITY_MAX: 100,   // cost > this % of job value => job value is bad data
  SCALE: 1.4826,         // MAD -> sigma constant
  Z90: 1.2816,           // z-value at the 90th percentile
};

const FLAG_WEIGHTS = {
  OVERCHARGE_SUSPECT: 4,
  DOUBLE_QTY_SUSPECT: 4,
  OVERCHARGE_SUSPECT_RATE_ONLY: 3,
  DUPLICATE_SUSPECT: 3,
  QTY_MISMATCH: 1,
  QTY_PROCESSED_MISSING: 1,
  FLAT_OR_MINIMUM: 1,
  JOB_VALUE_SUSPECT: 1,
  REVIEW_RATE_ONLY: 1,
  REVIEW_PCT_ONLY: 1,
  UNDERCHARGE: 1,
  INSUFFICIENT_BASELINE: 0,
};

const FLAG_HIGH_SEVERITY = new Set([
  'OVERCHARGE_SUSPECT',
  'OVERCHARGE_SUSPECT_RATE_ONLY',
  'DOUBLE_QTY_SUSPECT',
]);

// Normalise category/segment names so typos don't split one cohort into two
// undersized ones (e.g. "Corrugarted" vs "Corrugated").
function canonicalizeCohortName(raw) {
  let s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  s = s.replace(/corrugarted/gi, 'Corrugated');
  return s;
}

// Linear-interpolated percentile (matches SQL PERCENTILE_CONT). Input sorted asc.
function percentileCont(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

// Robust baseline for one metric within a cohort.
function computeMetricBaseline(values, cohortCount, params) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const med = percentileCont(arr, 0.5);
  const absDev = arr.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const madSigma = params.SCALE * percentileCont(absDev, 0.5);
  const p90 = percentileCont(arr, 0.90);
  const tailSigma = Math.max((p90 - med) / params.Z90, 0);
  let sigma = Math.max(madSigma, tailSigma);
  sigma = Math.max(sigma, Math.abs(med) * params.MIN_REL_SPREAD);
  return { med, sigma, n: cohortCount };
}

function metricZScore(value, baseline) {
  if (!baseline || !Number.isFinite(value)) return null;
  if (!(baseline.sigma > 0)) return 0;
  return (value - baseline.med) / baseline.sigma;
}

// Builds the "Anomalies" rows from the already-computed JOB summary rows.
// Returns only rows with severity !== 'OK', sorted HIGH -> LOW.
function buildAnomalyRows(jobRows, params = FLAG_PARAMS) {
  // 1. Per-row derived fields (§3).
  const derived = jobRows.map((row) => {
    const orderQty = Number(row['Order Qty'] || 0);
    const qtyProcessed = Number(row['Qty Processed'] || 0);
    const amount = Number(row['Total Contractor Amount'] || 0);
    const jobValueRaw = row['Total Job Value'];
    const jobValue = (jobValueRaw === '' || jobValueRaw == null) ? null : Number(jobValueRaw);
    const pctRaw = row['% Contractor Cost of Job Value'];
    const pct = (pctRaw === '' || pctRaw == null) ? null : Number(pctRaw);

    const billingQty = qtyProcessed > 0 ? qtyProcessed : orderQty;
    const billingBasis = qtyProcessed > 0 ? 'processed' : 'order';
    const ratePerPc = billingQty > 0 ? amount / billingQty : null;
    const pctValid = jobValue != null && Number.isFinite(jobValue) && jobValue > 0
      && pct != null && Number.isFinite(pct) && pct <= params.PCT_SANITY_MAX;

    const categoryDisplay = canonicalizeCohortName(row['Product Category']);
    const segmentDisplay = canonicalizeCohortName(row['Segment Name']);

    return {
      row, orderQty, qtyProcessed, amount, jobValue, pct,
      billingQty, billingBasis, ratePerPc, pctValid,
      categoryDisplay, segmentDisplay,
      categoryKey: categoryDisplay.toLowerCase(),
      segmentKey: segmentDisplay.toLowerCase(),
      clientName: String(row['Client Name'] || '').trim(),
      jobTitle: String(row['Job Title'] || '').trim(),
      contractors: String(row['Contractors Worked'] || '').trim(),
    };
  });

  const groupBy = (items, keyFn) => {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return m;
  };

  // 2. Cohort baselines (§4) for category and segment fallback.
  const baselineFor = (group) => ({
    count: group.length,
    rate: computeMetricBaseline(group.map((d) => d.ratePerPc), group.length, params),
    pct: computeMetricBaseline(group.filter((d) => d.pctValid).map((d) => d.pct), group.length, params),
  });

  const catBaselines = new Map();
  for (const [k, g] of groupBy(derived, (d) => d.categoryKey)) catBaselines.set(k, baselineFor(g));
  const segBaselines = new Map();
  for (const [k, g] of groupBy(derived, (d) => d.segmentKey)) segBaselines.set(k, baselineFor(g));

  // 3. Structural group aggregates (§6b).
  // FLAT_OR_MINIMUM: same (Contractors + Category) group, identical positive
  // Amount across >=2 rows that have different billing_qty.
  const flatFlagged = new Set();
  for (const [, g] of groupBy(derived, (d) => `${d.contractors}||${d.categoryKey}`)) {
    const byAmount = new Map();
    for (const d of g) {
      if (!(d.amount > 0)) continue;
      if (!byAmount.has(d.amount)) byAmount.set(d.amount, []);
      byAmount.get(d.amount).push(d);
    }
    for (const [, sameAmt] of byAmount) {
      if (sameAmt.length >= 2 && new Set(sameAmt.map((d) => d.billingQty)).size >= 2) {
        sameAmt.forEach((d) => flatFlagged.add(d));
      }
    }
  }

  // DUPLICATE_SUSPECT: same (Client, Job Title, Amount, billing_qty) more than once.
  const dupFlagged = new Set();
  for (const [, g] of groupBy(derived, (d) => (
    d.clientName && d.jobTitle ? `${d.clientName}||${d.jobTitle}||${d.amount}||${d.billingQty}` : ''
  ))) {
    if (g.length > 1) g.forEach((d) => dupFlagged.add(d));
  }

  // 4. Per-row scores, flags, severity (§5-7).
  const results = derived.map((d) => {
    const flags = [];

    const catB = catBaselines.get(d.categoryKey);
    const segB = segBaselines.get(d.segmentKey);
    let source = 'none';
    let base = null;
    if (catB && catB.count >= params.MIN_COHORT) { base = catB; source = 'category'; }
    else if (segB && segB.count >= params.MIN_COHORT) { base = segB; source = 'segment'; }

    const rateBase = base ? base.rate : null;
    const pctBase = base ? base.pct : null;
    const rateZ = rateBase ? metricZScore(d.ratePerPc, rateBase) : null;
    const pctZ = (pctBase && d.pctValid) ? metricZScore(d.pct, pctBase) : null;

    const rateHi = rateZ != null && rateZ >= params.Z_THRESHOLD;
    const pctHi = d.pctValid && pctZ != null && pctZ >= params.Z_THRESHOLD;
    const rateLo = rateZ != null && rateZ <= -params.Z_THRESHOLD;
    const pctLo = d.pctValid && pctZ != null && pctZ <= -params.Z_THRESHOLD;

    // 6a benchmark flags — only when a cohort is trusted.
    if (!base) {
      flags.push('INSUFFICIENT_BASELINE');
    } else if (d.pctValid) {
      if (rateHi && pctHi) {
        const rateRatio = rateBase && rateBase.med !== 0 ? d.ratePerPc / rateBase.med : null;
        const pctRatio = pctBase && pctBase.med !== 0 ? d.pct / pctBase.med : null;
        const inDouble = (r) => r != null && r >= params.DOUBLE_LO && r <= params.DOUBLE_HI;
        flags.push(inDouble(rateRatio) && inDouble(pctRatio) ? 'DOUBLE_QTY_SUSPECT' : 'OVERCHARGE_SUSPECT');
      } else if (rateHi) {
        flags.push('REVIEW_RATE_ONLY');
      } else if (pctHi) {
        flags.push('REVIEW_PCT_ONLY');
      }
      if (rateLo && pctLo) flags.push('UNDERCHARGE');
    } else {
      flags.push('JOB_VALUE_SUSPECT');
      if (rateHi) flags.push('OVERCHARGE_SUSPECT_RATE_ONLY');
      else if (rateLo) flags.push('UNDERCHARGE');
    }

    // 6b structural flags — always evaluated.
    if (d.qtyProcessed === 0 && d.amount > 0) {
      flags.push('QTY_PROCESSED_MISSING');
    } else if (d.orderQty > 0 && Math.abs(d.qtyProcessed - d.orderQty) / d.orderQty > params.QTY_MISMATCH_PCT) {
      flags.push('QTY_MISMATCH');
    }
    if (flatFlagged.has(d)) flags.push('FLAT_OR_MINIMUM');
    if (dupFlagged.has(d)) flags.push('DUPLICATE_SUSPECT');

    const uniqueFlags = [...new Set(flags)];
    const riskScore = uniqueFlags.reduce((s, f) => s + (FLAG_WEIGHTS[f] || 0), 0);
    let severity;
    if (uniqueFlags.some((f) => FLAG_HIGH_SEVERITY.has(f))) severity = 'HIGH';
    else if (riskScore >= 3) severity = 'MEDIUM';
    else if (riskScore >= 1) severity = 'LOW';
    else severity = 'OK';

    return { d, source, rateBase, pctBase, rateZ, pctZ, uniqueFlags, riskScore, severity };
  });

  // 5. Keep only flagged rows, sort HIGH -> LOW.
  const sevRank = { HIGH: 0, MEDIUM: 1, LOW: 2, OK: 3 };
  const round = (v, dp) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : '');

  return results
    .filter((r) => r.severity !== 'OK')
    .sort((a, b) => (
      sevRank[a.severity] - sevRank[b.severity]
      || b.riskScore - a.riskScore
      || (b.rateZ || 0) - (a.rateZ || 0)
    ))
    .map((r) => {
      const d = r.d;
      return {
        'Job Number': d.row['Job Number'],
        Severity: r.severity,
        'Risk Score': r.riskScore,
        Flags: r.uniqueFlags.join(', '),
        'Product Category': d.categoryDisplay,
        'Segment Name': d.segmentDisplay,
        'Client Name': d.clientName,
        'Job Title': d.jobTitle,
        'Contractors Worked': d.contractors,
        'Order Qty': d.orderQty,
        'Qty Processed': d.qtyProcessed,
        'Billing Qty': d.billingQty,
        'Billing Basis': d.billingBasis,
        'Total Contractor Amount': round(d.amount, 2),
        'Total Job Value': d.jobValue == null ? '' : round(d.jobValue, 2),
        'Rate / pc': d.ratePerPc == null ? '' : round(d.ratePerPc, 4),
        'Cohort Rate Median': r.rateBase ? round(r.rateBase.med, 4) : '',
        'Rate z': r.rateZ == null ? '' : round(r.rateZ, 2),
        '% Cost of Job Value': d.pct == null ? '' : round(d.pct, 2),
        'Cohort % Median': r.pctBase ? round(r.pctBase.med, 2) : '',
        '% z': r.pctZ == null ? '' : round(r.pctZ, 2),
        'Baseline Source': r.source,
        'Cohort n': base_n(r),
      };
    });
}

function base_n(r) {
  if (r.source === 'category' || r.source === 'segment') {
    return (r.rateBase && r.rateBase.n) || (r.pctBase && r.pctBase.n) || '';
  }
  return '';
}

async function buildContractorNameMap(contractorIds) {
  const ids = [...new Set((contractorIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();

  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const query = {
    isdeleted: { $ne: 1 },
    $or: [{ contractorId: { $in: ids } }],
  };
  if (objectIds.length) {
    query.$or.push({ _id: { $in: objectIds } });
  }

  const contractors = await Contractor.find(query).lean();
  const map = new Map();
  contractors.forEach((contractor) => {
    const name = String(contractor.name || '').trim() || 'Unknown';
    if (contractor.contractorId) map.set(String(contractor.contractorId), name);
    map.set(String(contractor._id), name);
  });
  return map;
}

async function fetchErpJobDetailsByNumbers(jobNumbers) {
  const unique = [...new Set((jobNumbers || []).map((j) => String(j || '').trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  try {
    const pool = await getConnection();
    const request = pool.request();
    const placeholders = unique.map((jobNo, index) => {
      const param = `jobNo${index}`;
      request.input(param, sql.NVarChar(255), jobNo);
      return `@${param}`;
    }).join(', ');

    const query = `
      SELECT
        JB.JobBookingNo,
        ISNULL(JB.ClientName, LM.LedgerName) AS ClientName,
        JB.JobName,
        JB.OrderQuantity,
        CM.CategoryName,
        SM.SegmentName
      FROM JobBookingJobCard JB
      LEFT JOIN LedgerMaster LM ON LM.LedgerID = JB.LedgerID
      LEFT JOIN CategoryMaster CM ON CM.CategoryID = JB.CategoryID
      LEFT JOIN SegmentMaster SM ON SM.SegmentID = CM.SegmentID
      WHERE JB.JobBookingNo IN (${placeholders})
    `;

    const result = await request.query(query);
    const map = new Map();
    (result.recordset || []).forEach((row) => {
      const jobNo = String(row.JobBookingNo || '').trim();
      if (!jobNo) return;
      map.set(jobNo, {
        clientName: row.ClientName || '',
        jobTitle: row.JobName || '',
        orderQty: Number(row.OrderQuantity || 0),
        productCategory: row.CategoryName || '',
        segmentName: row.SegmentName || '',
      });
    });
    return map;
  } catch (error) {
    console.error('Error fetching ERP job details for summary export:', error);
    return new Map();
  }
}

function rollupContractorWorkRows(rows, { idKey, type }) {
  const grouped = new Map();

  rows.forEach((row) => {
    const groupId = String(row._id[idKey] || '').trim();
    const contractorId = String(row._id.contractorId || '').trim();
    if (!groupId) return;

    if (!grouped.has(groupId)) {
      grouped.set(groupId, {
        rowKey: groupId,
        type,
        adhocLabel: type === 'Adhoc' ? String(row._id.adhocLabel || groupId).trim() : '',
        contractorIds: new Set(),
        contractorAmount: 0,
        qtyDone: 0,
        opsByName: {},
      });
    }

    const entry = grouped.get(groupId);
    if (contractorId) entry.contractorIds.add(contractorId);
    entry.contractorAmount += Number(row.contractorAmount || 0);
    entry.qtyDone += Number(row.qtyDone || 0);

    (row.ops || []).forEach((op) => {
      const displayName = String(op.opsName || 'Unknown').trim() || 'Unknown';
      // Group by opsId (stable identifier) rather than the raw name text so
      // multiple completion records for the same operation are always
      // summed together, even if the recorded name text ever differs in
      // case/whitespace across contractors or completion entries.
      const opKey = String(op.opsId || '').trim() || displayName.toLowerCase();
      if (!entry.opsByName[opKey]) {
        entry.opsByName[opKey] = { name: displayName, qty: 0, value: 0 };
      }
      entry.opsByName[opKey].qty += Number(op.qty || 0);
      entry.opsByName[opKey].value += Number(op.value || 0);
    });
  });

  return grouped;
}

router.get('/summary/export.xlsx', async (req, res) => {
  try {
    const { start, endExclusive, startLabel, endLabel } = getExportDateRange(req.query);
    const completionDateMatch = { 'opsDone.completionDate': { $gte: start, $lt: endExclusive } };
    const opValueExpr = {
      $multiply: [
        { $ifNull: ['$opsDone.opsDoneQty', 0] },
        { $ifNull: ['$opsDone.valuePerBook', 0] },
      ],
    };
    const opsPushExpr = {
      opsId: '$opsDone.opsId',
      opsName: '$opsDone.opsName',
      qty: '$opsDone.opsDoneQty',
      value: opValueExpr,
      savedInBill: '$opsDone.savedInBill',
    };

    // Step 1: the date range ONLY decides which jobs/adhoc orders are
    // included in the report (i.e. jobs that had contractor work completed
    // in that window). All other figures for a selected job (qty processed,
    // operations, contractors worked, contractor amount, bills) reflect the
    // job's ENTIRE history, not just the selected period.
    const [periodJobIdRows, periodAdhocRows] = await Promise.all([
      ContractorWD.aggregate([
        { $match: { isAdhoc: { $ne: true }, jobId: { $exists: true, $ne: '' } } },
        { $unwind: '$opsDone' },
        { $match: completionDateMatch },
        { $group: { _id: '$jobId' } },
      ]),
      ContractorWD.aggregate([
        { $match: { isAdhoc: true } },
        { $unwind: '$opsDone' },
        { $match: completionDateMatch },
        { $group: { _id: { adhocOrderId: '$adhocOrderId', adhocLabel: '$adhocLabel' } } },
      ]),
    ]);

    const jobIds = [...new Set(periodJobIdRows.map((row) => String(row._id || '').trim()).filter(Boolean))];
    const adhocOrderIds = [...new Set(
      periodAdhocRows.map((row) => String(row._id.adhocOrderId || '').trim()).filter(Boolean),
    )];

    // Step 2: pull the FULL history for exactly those jobs/adhoc orders.
    const [jobContractorRows, adhocContractorRows, billsAllRows] = await Promise.all([
      jobIds.length
        ? ContractorWD.aggregate([
            { $match: { isAdhoc: { $ne: true }, jobId: { $in: jobIds } } },
            { $unwind: '$opsDone' },
            {
              $group: {
                _id: { jobId: '$jobId', contractorId: '$contractorId' },
                contractorAmount: { $sum: opValueExpr },
                qtyDone: { $sum: { $ifNull: ['$opsDone.opsDoneQty', 0] } },
                ops: { $push: opsPushExpr },
              },
            },
          ])
        : Promise.resolve([]),
      adhocOrderIds.length
        ? ContractorWD.aggregate([
            { $match: { isAdhoc: true, adhocOrderId: { $in: adhocOrderIds } } },
            { $unwind: '$opsDone' },
            {
              $group: {
                _id: {
                  adhocOrderId: '$adhocOrderId',
                  adhocLabel: '$adhocLabel',
                  contractorId: '$contractorId',
                },
                contractorAmount: { $sum: opValueExpr },
                qtyDone: { $sum: { $ifNull: ['$opsDone.opsDoneQty', 0] } },
                ops: { $push: opsPushExpr },
              },
            },
          ])
        : Promise.resolve([]),
      jobIds.length
        ? Bill.aggregate([
            {
              $match: {
                $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }],
                'jobs.jobNumber': { $in: jobIds },
              },
            },
            { $unwind: '$jobs' },
            { $match: { 'jobs.jobNumber': { $in: jobIds } } },
            {
              $group: {
                _id: '$jobs.jobNumber',
                billNumbers: { $addToSet: '$billNumber' },
                lastBillDate: { $max: '$createdAt' },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    const jobRollup = rollupContractorWorkRows(jobContractorRows, { idKey: 'jobId', type: 'Job' });
    const adhocRollup = rollupContractorWorkRows(adhocContractorRows, { idKey: 'adhocOrderId', type: 'Adhoc' });

    const allContractorIds = [
      ...jobContractorRows.map((row) => String(row._id.contractorId || '').trim()),
      ...adhocContractorRows.map((row) => String(row._id.contractorId || '').trim()),
    ];

    const billsByJobId = {};
    const billDateByJobId = {};
    const formatBillDate = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    };
    billsAllRows.forEach((row) => {
      const jobId = String(row._id || '').trim();
      if (!jobId) return;
      billsByJobId[jobId] = (row.billNumbers || []).map((billNo) => String(billNo || '').trim()).filter(Boolean);
      billDateByJobId[jobId] = formatBillDate(row.lastBillDate);
    });

    const [contractorNameMap, jobOpsDocs, erpDetailsMap] = await Promise.all([
      buildContractorNameMap(allContractorIds),
      jobIds.length
        ? JobOpsMaster.find({ jobId: { $in: jobIds } }).lean()
        : Promise.resolve([]),
      fetchErpJobDetailsByNumbers(jobIds),
    ]);

    const jobOpsById = {};
    jobOpsDocs.forEach((doc) => {
      const jobId = String(doc.jobId || '').trim();
      if (jobId) jobOpsById[jobId] = doc;
    });

    const resolveContractorNames = (contractorIds) => [...contractorIds]
      .map((id) => contractorNameMap.get(String(id)) || String(id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');

    const jobRows = jobIds.map((jobId) => {
      const rollup = jobRollup.get(jobId);
      if (!rollup) return null;
      const jobOps = jobOpsById[jobId] || {};
      const erp = erpDetailsMap.get(jobId) || {};
      const totalJobValue = Number(jobOps.unitPrice || 0) * Number(jobOps.totalQty || 0);
      const contractorAmount = Number(rollup.contractorAmount || 0);
      const orderQty = Number(erp.orderQty || jobOps.totalQty || 0);
      const completedQty = getCompletedQtyFromOps(rollup.opsByName, orderQty);
      const billsGenerated = billsByJobId[jobId] || [];

      return {
        'Job Number': jobId,
        'Bill Date': billDateByJobId[jobId] || '',
        Type: 'Job',
        'Client Name': erp.clientName || jobOps.clientName || '',
        'Job Title': erp.jobTitle || jobOps.jobTitle || '',
        'Product Category': erp.productCategory || jobOps.productCategory || '',
        'Segment Name': erp.segmentName || jobOps.segmentName || '',
        'Order Qty': orderQty,
        'Qty Processed': completedQty,
        'Total Job Value': Number.isFinite(totalJobValue) ? totalJobValue : 0,
        'Total Contractor Amount': contractorAmount,
        '% Contractor Cost of Job Value': getContractorCostPct(totalJobValue, contractorAmount),
        'Contractors Worked': resolveContractorNames(rollup.contractorIds),
        'Operations Processed': formatOpsProcessed(rollup.opsByName),
        'Bills Generated': billsGenerated.join(', '),
      };
    }).filter(Boolean);

    const adhocRows = [...adhocRollup.values()].map((rollup) => {
      const jobNumber = rollup.adhocLabel || rollup.rowKey;
      const contractorAmount = Number(rollup.contractorAmount || 0);
      const completedQty = getCompletedQtyFromOps(rollup.opsByName);

      return {
        'Job Number': jobNumber,
        'Bill Date': '',
        Type: 'Adhoc',
        'Client Name': '',
        'Job Title': rollup.adhocLabel || '',
        'Product Category': '',
        'Segment Name': '',
        'Order Qty': '',
        'Qty Processed': completedQty,
        'Total Job Value': '',
        'Total Contractor Amount': contractorAmount,
        '% Contractor Cost of Job Value': '',
        'Contractors Worked': resolveContractorNames(rollup.contractorIds),
        'Operations Processed': formatOpsProcessed(rollup.opsByName),
        'Bills Generated': '',
      };
    });

    const sheetRows = [...jobRows, ...adhocRows]
      .sort((a, b) => String(a['Job Number'] || '').localeCompare(String(b['Job Number'] || '')))
      .map((row) => ({
        ...row,
        '% Contractor Cost of Job Value': row['% Contractor Cost of Job Value'] == null
          ? ''
          : Number(row['% Contractor Cost of Job Value']).toFixed(2),
      }));

    const ws = XLSX.utils.json_to_sheet(sheetRows);
    ws['!cols'] = [
      { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 28 }, { wch: 30 }, { wch: 20 }, { wch: 16 },
      { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 22 },
      { wch: 32 }, { wch: 40 }, { wch: 24 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Job Summary');

    // Anomalies tab: flag suspect JOB rows for manual review (never reads
    // operation-level columns). Only rows with severity != OK are listed.
    const anomalyRows = buildAnomalyRows(jobRows);
    const wsFlags = anomalyRows.length > 0
      ? XLSX.utils.json_to_sheet(anomalyRows)
      : XLSX.utils.json_to_sheet([{ Note: 'No anomalies flagged for the selected period.' }]);
    if (anomalyRows.length > 0) {
      wsFlags['!cols'] = [
        { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 40 }, { wch: 24 }, { wch: 16 },
        { wch: 28 }, { wch: 30 }, { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
        { wch: 13 }, { wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 9 },
        { wch: 18 }, { wch: 16 }, { wch: 9 }, { wch: 16 }, { wch: 9 },
      ];
    }
    XLSX.utils.book_append_sheet(wb, wsFlags, 'Anomalies');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Contractor-Job-Summary-${startLabel}_to_${endLabel}.xlsx"`,
    );
    return res.send(buf);
  } catch (error) {
    console.error('Error exporting summary:', error);
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || 'Error exporting summary' });
  }
});

router.get('/jobs/jobopsmaster/jobnumbers', async (req, res) => {
  try {
    const jobOpsMasters = await JobOpsMaster.find({}, 'jobId').sort({ jobId: 1 }).lean();
    const jobNumbers = jobOpsMasters.map(job => job.jobId);
    res.json(jobNumbers);
  } catch (error) {
    console.error('Error fetching job numbers:', error);
    res.status(500).json({ error: 'Error fetching job numbers' });
  }
});

router.get('/jobs/details/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Calling dbo.contractor_get_job_details2 with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_get_job_details2');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobDetails = result.recordset[0];

    res.json({
      clientName: jobDetails['Client Name'] || jobDetails.ClientName || jobDetails.clientName || '',
      jobTitle: jobDetails['Job Title'] || jobDetails.JobTitle || jobDetails.jobTitle || '',
      qty: jobDetails.OrderQty || jobDetails.orderQty || jobDetails.Qty || jobDetails.qty || 0,
      productCat: jobDetails.ProductCategory || jobDetails.productCategory || jobDetails.ProductCat || jobDetails.productCat || '',
      unitPrice: jobDetails.UnitPrice || jobDetails.unitPrice || jobDetails.unit_price || 0,
      segmentName: jobDetails.SegmentName || jobDetails.segmentName || ''
    });
  } catch (error) {
    console.error('Error fetching job details:', error);
    res.status(500).json({ error: 'Error fetching job details: ' + error.message });
  }
});

function getCompletionSelectedDatabase(req, { allowBody = false } = {}) {
  const rawValue = allowBody
    ? (req.body?.database ?? req.query?.database)
    : req.query?.database;

  const selectedDatabase = String(rawValue || 'KOL').trim().toUpperCase();
  if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
    return null;
  }
  return selectedDatabase;
}

// Get job details for completion app (with isclose and jobcloseddate)
// Uses direct SQL query instead of stored procedure
router.get('/jobs/details-completion/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req);

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    
    // Direct SQL query for job completion app
    const query = `
      select
        lm.LedgerName as ClientName,
        j.JobName,
        j.OrderQuantity,
        j.isclose,
        j.jobcloseddate
      from jobbookingjobcard
      j inner join LedgerMaster lm on lm.ledgerid=j.LedgerID
      where j.jobbookingno = @JobBookingNo
    `;
    
    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Executing direct query for job completion with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(query);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Query executed in ${queryTime}ms`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobDetails = result.recordset[0];

    res.json({
      clientName: jobDetails.ClientName || jobDetails.clientName || '',
      qty: jobDetails.OrderQuantity || jobDetails.orderQuantity || 0,
      isclose: jobDetails.isclose !== undefined ? jobDetails.isclose : 0,
      jobcloseddate: jobDetails.jobcloseddate || null
    });
  } catch (error) {
    console.error('Error fetching job details for completion:', error);
    res.status(500).json({ error: 'Error fetching job details: ' + error.message });
  }
});

// Possible completed jobs - used by Job Completion UI table
router.get('/jobs/possible-completed-jobs', async (req, res) => {
  try {
    const selectedDatabase = getCompletionSelectedDatabase(req);
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }
    const pool = await getPool(selectedDatabase);

    const query = `
      ;WITH GPNAgg AS
      (
          SELECT
              fgd.JobBookingID,
              SUM(ISNULL(fgd.outercarton,0)
                  * ISNULL(fgd.innercarton,0)
                  * ISNULL(fgd.quantityperpack,0)
              ) AS GpnUnits
          FROM FinishGoodsTransactionMain fgm
          JOIN FinishGoodsTransactionDetail fgd
              ON fgd.FGTransactionID = fgm.FGtransactionID
          WHERE
              fgm.voucherid = -50
              AND ISNULL(fgm.IsDeletedTransaction,0)=0
              AND ISNULL(fgd.IsDeletedTransaction,0)=0
          GROUP BY fgd.JobBookingID
      ),

      DispatchAgg AS
      (
          SELECT
              fgd.JobBookingID,
              SUM(ISNULL(fgd.innercarton,0)
                  * ISNULL(fgd.quantityperpack,0)
              ) AS DispatchQty
          FROM FinishGoodsTransactionMain fgm
          JOIN FinishGoodsTransactionDetail fgd
              ON fgd.FGTransactionID = fgm.FGtransactionID
          WHERE
              fgm.voucherid = -51
              AND ISNULL(fgm.IsDeletedTransaction,0)=0
              AND ISNULL(fgd.IsDeletedTransaction,0)=0
          GROUP BY fgd.JobBookingID
      )

      SELECT DISTINCT
          JEJ.JobBookingID,
          JEJ.JobBookingNo,
          JEJ.OrderQuantity,
          ISNULL(GPN.GpnUnits,0) AS GpnQty,
          ISNULL(DSP.DispatchQty,0) AS DispatchQty,
          (JEJ.OrderQuantity * 0.8) AS ThresholdQty,
          CASE
              WHEN ISNULL(GPN.GpnUnits,0) < (JEJ.OrderQuantity * 0.8)
                   AND ISNULL(DSP.DispatchQty,0) < (JEJ.OrderQuantity * 0.8)
              THEN 'PENDING'
              ELSE 'COMPLETED'
          END AS Status

      FROM JobScheduleRelease JSR

      INNER JOIN JobBookingJobCardContents JEJC
          ON JEJC.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID

      INNER JOIN JobBookingJobCard JEJ
          ON JEJ.JobBookingID = JEJC.JobBookingID

      LEFT JOIN GPNAgg GPN
          ON GPN.JobBookingID = JEJ.JobBookingID

      LEFT JOIN DispatchAgg DSP
          ON DSP.JobBookingID = JEJ.JobBookingID

      WHERE
          JSR.ProcessID in (279,10773)
          AND ISNULL(JSR.IsOnlineProcess, 0) = 0
          AND JSR.Status IN ('In Queue', 'Part Complete', 'Running')
          AND ISNULL(JSR.IsDeletedTransaction,0)=0
          AND ISNULL(JEJ.IsCancel,0)=0
          AND ISNULL(JEJ.IsClose,0)=0

      ORDER BY JEJ.JobBookingNo;
    `;

    const result = await pool.request().query(query);
    return res.json({
      status: true,
      rows: result.recordset || []
    });
  } catch (error) {
    console.error('Error fetching possible completed jobs:', error);
    return res.status(500).json({ error: 'Error fetching possible completed jobs: ' + error.message });
  }
});

// Search job numbers for completion app (uses same stored procedure as Contractor PO System)
router.get('/jobs/search-numbers-completion/:jobNumberPart', async (req, res) => {
  try {
    const { jobNumberPart } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req);
    console.log('🔍 [BACKEND] /jobs/search-numbers-completion called with jobNumberPart:', jobNumberPart);

    if (!jobNumberPart || jobNumberPart.length < 4) {
      return res.status(400).json({ error: 'Job number part must be at least 4 characters' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    request.input('JobNumberPart', sql.NVarChar(255), String(jobNumberPart));

    console.log('🔍 [MSSQL] Calling dbo.contractor_search_jobnumbers with @JobNumberPart =', jobNumberPart);

    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_search_jobnumbers');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    console.log('🔍 [MSSQL] Raw result.recordset:', JSON.stringify(result.recordset, null, 2));
    console.log('🔍 [MSSQL] result.recordset.length:', result.recordset.length);

    const jobNumbers = result.recordset.map((row, index) => {
      console.log(`🔍 [MSSQL] Row ${index}:`, JSON.stringify(row, null, 2));
      const jobNum = row.JobNumber || row.Job_Number || row.jobNumber || row.job_number || 
             row.JobNo || row.Job_NO || Object.values(row)[0];
      console.log(`🔍 [MSSQL] Row ${index} extracted jobNumber:`, jobNum);
      return jobNum;
    }).filter(Boolean);

    console.log('🔍 [BACKEND] Final jobNumbers array:', jobNumbers);
    res.json(jobNumbers);
  } catch (error) {
    console.error('❌ [BACKEND] Error searching job numbers for completion:', error);
    console.error('❌ [BACKEND] Error stack:', error.stack);
    res.status(500).json({ error: 'Error searching job numbers: ' + error.message });
  }
});

// Complete job - close job in jobbookingjobcard table
router.post('/jobs/complete/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req, { allowBody: true });

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();

    // Execute UPDATE statement to close the job
    const updateQuery = `
      UPDATE jobbookingjobcard 
      SET isclose = 1, 
          jobclosedby = 2, 
          jobcloseddate = GETDATE(), 
          jobcloseremark = 'Closed - Manu' 
      WHERE jobbookingno = @JobBookingNo
    `;

    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('✅ [MSSQL] Executing job completion update for:', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(updateQuery);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Update executed in ${queryTime}ms`);
    console.log(`✅ [MSSQL] Rows affected: ${result.rowsAffected[0]}`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Job not found or already closed' });
    }

    res.json({
      success: true,
      message: 'Job completed successfully',
      jobNumber: jobNumber,
      rowsAffected: result.rowsAffected[0]
    });
  } catch (error) {
    console.error('Error completing job:', error);
    res.status(500).json({ error: 'Error completing job: ' + error.message });
  }
});

// Reopen job - set isclose = 0 and clear close fields in jobbookingjobcard table
router.post('/jobs/reopen/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req, { allowBody: true });

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();

    const updateQuery = `
      UPDATE jobbookingjobcard
      SET isclose = 0,
          jobclosedby = 2,
          jobcloseddate = NULL,
          jobcloseremark = ''
      WHERE jobbookingno = @JobBookingNo
    `;

    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('✅ [MSSQL] Executing job reopen update for:', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(updateQuery);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Reopen update executed in ${queryTime}ms`);
    console.log(`✅ [MSSQL] Rows affected: ${result.rowsAffected[0]}`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Job not found or already open' });
    }

    res.json({
      success: true,
      message: 'Job reopened successfully',
      jobNumber: jobNumber,
      rowsAffected: result.rowsAffected[0]
    });
  } catch (error) {
    console.error('Error reopening job:', error);
    res.status(500).json({ error: 'Error reopening job: ' + error.message });
  }
});

// Operations routes
router.get('/operations/categories', async (req, res) => {
  try {
    const pool = await getPool('KOL');
    const result = await pool.request().query('SELECT DISTINCT categoryname FROM categorymaster ORDER BY categoryname');
    const rows = result.recordset || [];
    const nameKey = rows[0] ? Object.keys(rows[0]).find(k => k.toLowerCase() === 'categoryname') : 'categoryname';
    const list = rows.map(r => (r[nameKey] != null ? String(r[nameKey]).trim() : '')).filter(Boolean);
    res.json(list);
  } catch (error) {
    console.error('Error fetching categories from categorymaster:', error);
    res.status(500).json({ error: 'Error fetching categories' });
  }
});

router.get('/operations', async (req, res) => {
  try {
    const { search, category } = req.query;
    let query = { isdeleted: 0 };

    if (search) {
      query.opsName = { $regex: search, $options: 'i' };
    }
    if (category != null && String(category).trim() !== '') {
      query.categories = String(category).trim();
    }

    const operations = await Operation.find(query).sort({ opsName: 1 });
    res.json(operations);
  } catch (error) {
    console.error('Error fetching operations:', error);
    res.status(500).json({ error: 'Error fetching operations' });
  }
});

router.get('/operations/:id', async (req, res) => {
  try {
    const operation = await Operation.findById(req.params.id);
    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }
    res.json(operation);
  } catch (error) {
    console.error('Error fetching operation:', error);
    res.status(500).json({ error: 'Error fetching operation' });
  }
});

router.post('/operations', async (req, res) => {
  try {
    const { opsName, type, ratePerUnit, categories: categoriesBody, isAdhocOp, link } = req.body;
    const normalizedIsAdhocOp = !!isAdhocOp;
    const finalType = normalizedIsAdhocOp ? '1:1' : type;

    if (!opsName || !finalType) {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    if (ratePerUnit === undefined || ratePerUnit === null || ratePerUnit === '') {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    const ratePerUnitNum = parseFloat(Number(ratePerUnit).toFixed(4));
    if (isNaN(ratePerUnitNum) || ratePerUnitNum < 0) {
      return res.status(400).json({ error: 'Rate/unit must be a valid number greater than or equal to 0' });
    }

    const existingOp = await Operation.findOne({ opsName, isdeleted: 0 });
    if (existingOp) {
      return res.status(400).json({ error: 'Operation already exists' });
    }

    const categories = Array.isArray(categoriesBody)
      ? categoriesBody.map(c => String(c).trim()).filter(Boolean)
      : categoriesBody != null && categoriesBody !== ''
        ? [String(categoriesBody).trim()]
        : [];

    const operation = new Operation({
      opsName,
      type: finalType,
      ratePerUnit: ratePerUnitNum,
      isAdhocOp: normalizedIsAdhocOp,
      categories,
      link: link != null ? String(link).trim() : '',
      isdeleted: 0
    });

    await operation.save();
    res.status(201).json(operation);
  } catch (error) {
    console.error('Error creating operation:', error);
    res.status(500).json({ error: 'Error creating operation' });
  }
});

router.put('/operations/:id', async (req, res) => {
  try {
    const { opsName, type, ratePerUnit, categories: categoriesBody, isAdhocOp, link } = req.body;
    const normalizedIsAdhocOp = !!isAdhocOp;
    const finalType = normalizedIsAdhocOp ? '1:1' : type;
    
    if (!opsName || !finalType) {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    if (ratePerUnit === undefined || ratePerUnit === null || ratePerUnit === '') {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    const ratePerUnitNum = parseFloat(Number(ratePerUnit).toFixed(4));
    if (isNaN(ratePerUnitNum) || ratePerUnitNum < 0) {
      return res.status(400).json({ error: 'Rate/unit must be a valid number greater than or equal to 0' });
    }

    const updateFields = { opsName, type: finalType, ratePerUnit: ratePerUnitNum };
    if (isAdhocOp !== undefined) {
      updateFields.isAdhocOp = normalizedIsAdhocOp;
    }
    if (link !== undefined) {
      updateFields.link = link != null ? String(link).trim() : '';
    }
    if (categoriesBody !== undefined) {
      updateFields.categories = Array.isArray(categoriesBody)
        ? categoriesBody.map(c => String(c).trim()).filter(Boolean)
        : categoriesBody != null && categoriesBody !== ''
          ? [String(categoriesBody).trim()]
          : [];
    }
    
    const operation = await Operation.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    );

    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }

    res.json(operation);
  } catch (error) {
    console.error('Error updating operation:', error);
    res.status(500).json({ error: 'Error updating operation' });
  }
});

router.delete('/operations/:id', async (req, res) => {
  try {
    const operation = await Operation.findByIdAndUpdate(
      req.params.id,
      { isdeleted: 1 },
      { new: true }
    );
    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }
    res.json({ message: 'Operation deleted successfully' });
  } catch (error) {
    console.error('Error deleting operation:', error);
    res.status(500).json({ error: 'Error deleting operation' });
  }
});

// Ad-hoc work order routes
function formatAdhocDatePart(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

async function generateNextAdhocId() {
  const datePart = formatAdhocDatePart(new Date());
  const prefix = `adhoc_${datePart}_`;
  const regex = new RegExp(`^${prefix}\\d{3}$`);
  const existing = await AdhocWorkOrder.find({ adhocId: { $regex: regex } }).select('adhocId').lean();

  let maxSeq = 0;
  existing.forEach((doc) => {
    const id = String(doc.adhocId || '');
    const seqStr = id.slice(-3);
    const seq = Number(seqStr);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  });

  const nextSeq = String(maxSeq + 1).padStart(3, '0');
  return `${prefix}${nextSeq}`;
}

router.get('/adhoc-orders', async (req, res) => {
  try {
    const orders = await AdhocWorkOrder.find().sort({ createdAt: -1 }).lean();

    // Attach hasCompletedWork flag: true if any Contractor_WD entry exists with opsDoneQty > 0
    const orderIds = orders.map(o => String(o._id));
    const wdDocs = await ContractorWD.find({
      isAdhoc: true,
      adhocOrderId: { $in: orderIds }
    }).lean();
    const completedSet = new Set();
    wdDocs.forEach(doc => {
      const hasWork = (doc.opsDone || []).some(od => Number(od.opsDoneQty || 0) > 0);
      if (hasWork) completedSet.add(String(doc.adhocOrderId));
    });

    const enriched = orders.map(o => ({
      ...o,
      hasCompletedWork: completedSet.has(String(o._id))
    }));

    res.json(enriched);
  } catch (error) {
    console.error('Error fetching ad-hoc orders:', error);
    res.status(500).json({ error: 'Error fetching ad-hoc orders' });
  }
});

router.post('/adhoc-orders', async (req, res) => {
  try {
    const { description, ops } = req.body;
    if (!Array.isArray(ops) || ops.length === 0) {
      return res.status(400).json({ error: 'At least one operation is required' });
    }

    const normalizedOps = ops.map((op) => ({
      opId: String(op.opId || '').trim(),
      opsName: String(op.opsName || '').trim(),
      totalOpsQty: Number(op.totalOpsQty),
      pendingOpsQty: Number(op.pendingOpsQty),
      rate: Number(op.rate),
      creationDate: op.creationDate ? new Date(op.creationDate) : new Date(),
      lastUpdatedDate: op.lastUpdatedDate ? new Date(op.lastUpdatedDate) : new Date(),
    }));

    for (const op of normalizedOps) {
      if (!op.opId || !op.opsName) {
        return res.status(400).json({ error: 'Each operation must include opId and opsName' });
      }
      if (
        Number.isNaN(op.totalOpsQty) || Number.isNaN(op.pendingOpsQty) || Number.isNaN(op.rate) ||
        op.totalOpsQty < 0 || op.pendingOpsQty < 0 || op.rate < 0
      ) {
        return res.status(400).json({ error: 'Invalid operation values' });
      }
    }

    const adhocId = await generateNextAdhocId();
    const order = new AdhocWorkOrder({
      adhocId,
      description: description != null ? String(description).trim() : '',
      ops: normalizedOps,
    });

    await order.save();
    res.status(201).json(order);
  } catch (error) {
    console.error('Error creating ad-hoc order:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Ad-hoc ID generation conflict. Please retry.' });
    }
    res.status(500).json({ error: 'Error creating ad-hoc order' });
  }
});

// GET /adhoc-orders/:id/status
// Returns per-operation completion status grouped by contractor.
router.get('/adhoc-orders/:id/status', async (req, res) => {
  try {
    const order = await AdhocWorkOrder.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: 'Ad-hoc order not found' });

    // All Contractor_WD docs for this adhoc order
    const wdDocs = await ContractorWD.find({ isAdhoc: true, adhocOrderId: String(order._id) }).lean();

    // Build a contractor name lookup
    const contractorIds = [...new Set(wdDocs.map(d => d.contractorId))];
    const contractorDocs = await Contractor.find({ contractorId: { $in: contractorIds } }).lean();
    const contractorNameMap = {};
    contractorDocs.forEach(c => { contractorNameMap[c.contractorId] = c.name; });

    const ops = (order.ops || []).map(op => {
      // Sum completed qty per contractor for this opId
      const contractorBreakdown = [];
      let totalCompleted = 0;

      wdDocs.forEach(doc => {
        const matchingOps = (doc.opsDone || []).filter(od => {
          return String(od.opsId) === String(op.opId) ||
                 (od.opsName === op.opsName && Math.abs(Number(od.valuePerBook || 0) - Number(op.rate || 0)) < 0.0001);
        });
        const completedByThisContractor = matchingOps.reduce((s, od) => s + Number(od.opsDoneQty || 0), 0);
        if (completedByThisContractor > 0) {
          contractorBreakdown.push({
            contractorId: doc.contractorId,
            contractorName: contractorNameMap[doc.contractorId] || doc.contractorId,
            completedQty: completedByThisContractor
          });
          totalCompleted += completedByThisContractor;
        }
      });

      return {
        opId: String(op.opId),
        opsName: op.opsName,
        totalOpsQty: Number(op.totalOpsQty || 0),
        pendingOpsQty: Number(op.pendingOpsQty || 0),
        completedQty: totalCompleted,
        contractors: contractorBreakdown
      };
    });

    res.json({ adhocId: order.adhocId, description: order.description || '', ops });
  } catch (error) {
    console.error('Error fetching ad-hoc order status:', error);
    res.status(500).json({ error: 'Error fetching status', details: error.message });
  }
});

router.get('/adhoc-orders/:id', async (req, res) => {
  try {
    const order = await AdhocWorkOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Ad-hoc order not found' });
    }
    res.json(order);
  } catch (error) {
    console.error('Error fetching ad-hoc order:', error);
    res.status(500).json({ error: 'Error fetching ad-hoc order' });
  }
});

router.put('/adhoc-orders/:id', async (req, res) => {
  try {
    const { description, ops } = req.body;
    const order = await AdhocWorkOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Ad-hoc order not found' });
    }

    if (description !== undefined) {
      order.description = description != null ? String(description).trim() : '';
    }
    if (ops !== undefined) {
      if (!Array.isArray(ops) || ops.length === 0) {
        return res.status(400).json({ error: 'At least one operation is required' });
      }
      order.ops = ops.map((op) => ({
        opId: String(op.opId || '').trim(),
        opsName: String(op.opsName || '').trim(),
        totalOpsQty: Number(op.totalOpsQty),
        pendingOpsQty: Number(op.pendingOpsQty),
        rate: Number(op.rate),
        creationDate: op.creationDate ? new Date(op.creationDate) : new Date(),
        lastUpdatedDate: new Date(),
      }));
    }

    await order.save();
    res.json(order);
  } catch (error) {
    console.error('Error updating ad-hoc order:', error);
    res.status(500).json({ error: 'Error updating ad-hoc order' });
  }
});

router.delete('/adhoc-orders/:id', async (req, res) => {
  try {
    const order = await AdhocWorkOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Ad-hoc order not found' });
    }

    await AdhocWorkOrder.findByIdAndDelete(req.params.id);
    res.json({ message: 'Ad-hoc order deleted successfully' });
  } catch (error) {
    console.error('Error deleting ad-hoc order:', error);
    res.status(500).json({ error: 'Error deleting ad-hoc order' });
  }
});

// Work routes
router.get('/work/pending/jobopsmaster/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    // Find job in JobOpsMaster
    const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber }).lean();
    
    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobOpsMaster' });
    }

    // Work already recorded per operation, across every contractor. The save
    // cap is measured against this, so returning it lets the entry screen show
    // the same limit instead of accepting a number the server will reject.
    const wdDocsForJob = await ContractorWD.find({ jobId: jobNumber, isAdhoc: { $ne: true } }).lean();
    const recordedByOp = {};
    (wdDocsForJob || []).forEach(doc => {
      (doc.opsDone || []).forEach(od => {
        if (od.opsId == null) return;
        const k = String(od.opsId);
        recordedByOp[k] = (recordedByOp[k] || 0) + Number(od.opsDoneQty || 0);
      });
    });

    const allowance = packagingAllowanceFor(jobOpsMaster);

    // pendingOpsQty reaching 0 means the job's own quantity is covered, which
    // is the end of the road for an ordinary job. A Packaging job may
    // legitimately run past it by the allowance — spoilage and re-packing are
    // real work — and the save cap already accepts that quantity, so an
    // operation still holding allowance has to stay on the screen or there is
    // no way to enter it. Its pending reads 0, and allowanceRoom carries what
    // is left so the entry screen can say why the row is there.
    const pendingOps = (jobOpsMaster.ops || []).filter(op => {
      if (Number(op.pendingOpsQty || 0) > 0) return true;
      if (allowance <= 0) return false;
      const recorded = recordedByOp[String(op.opId)] || 0;
      return Number(op.totalOpsQty || 0) + allowance - recorded > QTY_TOL;
    });

    if (pendingOps.length === 0) {
      return res.json({
        jobNumber,
        clientName: jobOpsMaster.clientName || '',
        jobTitle: jobOpsMaster.jobTitle || '',
        segmentName: jobOpsMaster.segmentName || '',
        totalQty: Number(jobOpsMaster.totalQty || 0),
        packagingAllowance: allowance,
        operations: []
      });
    }

    // Get all unique opIds and convert to ObjectIds
    const opIds = pendingOps.map(op => {
      try {
        return new mongoose.Types.ObjectId(op.opId);
      } catch (error) {
        return null;
      }
    }).filter(Boolean);

    // Fetch operation details from Operation collection
    // opId in JobOpsMaster is stored as String (ObjectId string), so we convert to ObjectId for query
    const operations = await Operation.find({
      _id: { $in: opIds }
    }).lean();

    // Create a map of opId to operation details (name and ratePerUnit)
    const opsMap = {};
    operations.forEach(op => {
      opsMap[op._id.toString()] = {
        opsName: op.opsName,
        ratePerUnit: op.ratePerUnit || 0
      };
    });

    // Build response with operation name, totalOpsQty, pendingOpsQty, qtyPerBook, rate, and valuePerBook
    const operationsWithNames = pendingOps.map(op => {
      // Get rate from Operation collection by mapping opId
      const operationData = opsMap[op.opId] || {};
      const rate = operationData.ratePerUnit || 0;
      const recordedOpsQty = recordedByOp[String(op.opId)] || 0;

      return {
        opId: op.opId,
        opsName: operationData.opsName || 'Unknown',
        totalOpsQty: op.totalOpsQty,
        pendingOpsQty: op.pendingOpsQty,
        recordedOpsQty,
        // What the allowance still holds once the job's own quantity is spent.
        // 0 on every non-Packaging job, and on a Packaging operation that has
        // used the allowance up.
        allowanceRoom: allowance > 0
          ? Math.max(0, Number(op.totalOpsQty || 0) + allowance - recordedOpsQty - Math.max(0, Number(op.pendingOpsQty || 0)))
          : 0,
        qtyPerBook: op.qtyPerBook,
        rate: rate,
        valuePerBook: op.valuePerBook || 0
      };
    });

    res.json({
      jobNumber,
      clientName: jobOpsMaster.clientName || '',
      jobTitle: jobOpsMaster.jobTitle || '',
      // Returned so the client can apply the packaging cap from this one call
      // and stays in step with the limit the server enforces on save.
      segmentName: jobOpsMaster.segmentName || '',
      totalQty: Number(jobOpsMaster.totalQty || 0),
      packagingAllowance: allowance,
      operations: operationsWithNames
    });
  } catch (error) {
    console.error('Error fetching pending operations from JobOpsMaster:', error);
    res.status(500).json({ error: 'Error fetching pending operations' });
  }
});

router.get('/work/pending/adhoc/:id', async (req, res) => {
  try {
    const order = await AdhocWorkOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ error: 'Ad-hoc order not found' });
    }

    const pendingOps = Array.isArray(order.ops)
      ? order.ops.filter(op => Number(op.pendingOpsQty || 0) > 0)
      : [];

    res.json({
      adhocOrderId: order._id.toString(),
      adhocId: order.adhocId || '',
      description: order.description || '',
      operations: pendingOps.map(op => ({
        opId: op.opId,
        opsName: op.opsName,
        totalOpsQty: Number(op.totalOpsQty || 0),
        pendingOpsQty: Number(op.pendingOpsQty || 0),
        qtyPerBook: 1,
        rate: Number(op.rate || 0),
        valuePerBook: Number(op.rate || 0),
      })),
    });
  } catch (error) {
    console.error('Error fetching pending ad-hoc operations:', error);
    res.status(500).json({ error: 'Error fetching pending ad-hoc operations' });
  }
});

router.get('/work/pending/:contractor/:jobNumber', async (req, res) => {
  try {
    const { contractor, jobNumber } = req.params;

    const job = await Job.findOne({ jobNumber });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobOperations = await JobOperation.find({ job: job._id })
      .populate('operation', 'opsName type');

    const pendingOps = jobOperations.map(jobOp => {
      const contractorWork = jobOp.contractorWork.find(cw => cw.contractor === contractor);
      const completedQty = contractorWork ? contractorWork.completedQty : 0;
      const pendingQty = jobOp.qtyPerBook - completedQty;

      return {
        _id: jobOp._id,
        operation: jobOp.operation,
        qtyPerBook: jobOp.qtyPerBook,
        pendingQty: Math.max(0, pendingQty),
        completedQty
      };
    });

    res.json({
      job,
      operations: pendingOps
    });
  } catch (error) {
    console.error('Error fetching pending work:', error);
    res.status(500).json({ error: 'Error fetching pending work' });
  }
});

// Retired. This wrote Contractor_WD without the savedInBill discipline the
// current flow depends on, and nothing calls it any more. Kept as an explicit
// error so an old client fails loudly instead of writing inconsistent data.
router.post('/work/update/jobopsmaster', async (req, res) => {
  res.status(410).json({
    error: 'This endpoint has been retired. Use POST /work/save/jobopsmaster instead.'
  });
});

// Retired. This wrote Contractor_WD without the savedInBill discipline the
// current flow depends on, and nothing calls it any more. Kept as an explicit
// error so an old client fails loudly instead of writing inconsistent data.
router.post('/work/update/adhoc', async (req, res) => {
  res.status(410).json({
    error: 'This endpoint has been retired. Use POST /work/save/adhoc instead.'
  });
});

// ---------------------------------------------------------------------------
// POST /work/unsave
// Reverses a saved-but-not-billed Contractor_WD entry:
//   • Restores pendingOpsQty in JobOpsMaster / AdhocWorkOrder
//   • Reduces / removes the matching opsDone entry (savedInBill:'No') in Contractor_WD
// Body: { contractorId, items: [{ jobNumber?, isAdhoc?, adhocOrderId?, opsId, opsName, valuePerBook, qtyToRestore }] }
// ---------------------------------------------------------------------------
router.post('/work/unsave', async (req, res) => {
  try {
    const { contractorId, items } = req.body;
    if (!contractorId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'contractorId and items array are required' });
    }

    // Per-item outcome so the caller can tell a real reversal from a no-op.
    // IMPORTANT: the Contractor_WD entry is removed FIRST and pending is only
    // restored when that actually happened. Restoring pending for an entry we
    // could not find would inflate pending while leaving the row in place, and
    // the row would then reappear in Bill Details on the next search.
    const results = [];

    for (const item of items) {
      const { isAdhoc, jobNumber, adhocOrderId, opsId, opsName, valuePerBook, qtyToRestore } = item;
      const qty = Number(qtyToRestore || 0);
      const outcome = {
        jobNumber: jobNumber || '',
        adhocOrderId: adhocOrderId || '',
        opsId: opsId || '',
        opsName: opsName || '',
        removed: false,
        restored: false,
        error: ''
      };

      if (qty <= 0) {
        outcome.error = 'qtyToRestore must be greater than 0';
        results.push(outcome);
        continue;
      }

      const vpb = parseFloat(Number(valuePerBook || 0).toFixed(2));
      const matchesWdOp = od => {
        if (isOpsDoneBilled(od)) return false;
        return (opsId && String(od.opsId) === String(opsId)) ||
               (od.opsName === opsName && parseFloat(Number(od.valuePerBook || 0).toFixed(2)) === vpb);
      };

      try {
        if (isAdhoc && adhocOrderId) {
          // 1. Remove / reduce the unsaved Contractor_WD entry
          const cwdAdhoc = await ContractorWD.findOne({ contractorId, isAdhoc: true, adhocOrderId: String(adhocOrderId) });
          const wdOp = cwdAdhoc ? cwdAdhoc.opsDone.find(matchesWdOp) : null;
          if (!wdOp) {
            outcome.error = 'No unsaved Contractor_WD entry found for this ad-hoc operation';
            results.push(outcome);
            continue;
          }
          wdOp.opsDoneQty = Math.max(0, Number(wdOp.opsDoneQty || 0) - qty);
          if (wdOp.opsDoneQty <= 0) cwdAdhoc.opsDone = cwdAdhoc.opsDone.filter(od => od !== wdOp);
          cwdAdhoc.markModified('opsDone');
          if (cwdAdhoc.opsDone.length > 0) await cwdAdhoc.save();
          else await ContractorWD.deleteOne({ _id: cwdAdhoc._id });
          outcome.removed = true;

          // 2. Only now restore pending in AdhocWorkOrder
          const order = await AdhocWorkOrder.findById(adhocOrderId);
          if (order) {
            const orderOp = order.ops.find(o => String(o.opId) === String(opsId));
            if (orderOp) {
              orderOp.pendingOpsQty = Math.min(Number(orderOp.totalOpsQty || 0), Number(orderOp.pendingOpsQty || 0) + qty);
              orderOp.lastUpdatedDate = new Date();
              order.markModified('ops');
              await order.save();
              outcome.restored = true;
            }
          }
        } else if (jobNumber) {
          // 1. Remove / reduce the unsaved Contractor_WD entry
          const cwdJob = await ContractorWD.findOne({ contractorId, jobId: jobNumber, isAdhoc: { $ne: true } });
          const wdOp = cwdJob ? cwdJob.opsDone.find(matchesWdOp) : null;
          if (!wdOp) {
            outcome.error = 'No unsaved Contractor_WD entry found for this operation';
            results.push(outcome);
            continue;
          }
          wdOp.opsDoneQty = Math.max(0, Number(wdOp.opsDoneQty || 0) - qty);
          if (wdOp.opsDoneQty <= 0) cwdJob.opsDone = cwdJob.opsDone.filter(od => od !== wdOp);
          cwdJob.markModified('opsDone');
          if (cwdJob.opsDone.length > 0) await cwdJob.save();
          else await ContractorWD.deleteOne({ _id: cwdJob._id });
          outcome.removed = true;

          // 2. Only now restore pending in JobOpsMaster
          const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber });
          if (jobOpsMaster) {
            let jobOp = opsId ? jobOpsMaster.ops.find(jop => String(jop.opId) === String(opsId)) : null;
            if (!jobOp && opsName) {
              const opObjectIds = jobOpsMaster.ops.map(jop => {
                try { return new mongoose.Types.ObjectId(jop.opId); } catch { return null; }
              }).filter(Boolean);
              const opDocs = await Operation.find({ _id: { $in: opObjectIds } }).lean();
              const nameMap = {};
              opDocs.forEach(op => { nameMap[op._id.toString()] = op.opsName; });
              jobOp = jobOpsMaster.ops.find(jop =>
                nameMap[String(jop.opId)] === opsName && parseFloat(Number(jop.valuePerBook || 0).toFixed(2)) === vpb
              );
            }
            if (jobOp) {
              // unsave: pending is recomputed from the work still recorded for
              // this operation, not by adding the quantity back to whatever
              // pending holds. A Packaging save may run past the job quantity by
              // the 5% allowance, and pending floors at 0 while it does, so
              // adding back handed the overshoot out as fresh pending — an
              // operation with 100000 left, saved at 106000, came back as
              // 106000. The Contractor_WD row was already removed above, so this
              // read is the state after the reversal.
              const wdDocsAfterUnsave = await ContractorWD.find({ jobId: jobNumber, isAdhoc: { $ne: true } }).lean();
              const unsaveOpKey = String(jobOp.opId);
              let recordedAfterUnsave = 0;
              (wdDocsAfterUnsave || []).forEach(doc => {
                (doc.opsDone || []).forEach(od => {
                  if (od.opsId == null || String(od.opsId) !== unsaveOpKey) return;
                  recordedAfterUnsave += Number(od.opsDoneQty || 0);
                });
              });
              const totalOpsQtyForUnsave = Number(jobOp.totalOpsQty || 0);
              jobOp.pendingOpsQty = Math.min(totalOpsQtyForUnsave, Math.max(0, totalOpsQtyForUnsave - recordedAfterUnsave));
              jobOp.lastUpdatedDate = new Date();
              jobOpsMaster.markModified('ops');
              await jobOpsMaster.save();
              outcome.restored = true;
            }
          }
        } else {
          outcome.error = 'Either jobNumber or adhocOrderId is required';
        }
      } catch (itemErr) {
        console.error('Error unsaving item:', item, itemErr);
        outcome.error = itemErr.message || 'Error unsaving item';
      }

      results.push(outcome);
    }

    const failed = results.filter(r => !r.removed);
    res.json({
      message: failed.length ? 'Unsave completed with errors' : 'Unsave completed',
      removed: results.length - failed.length,
      failed: failed.length,
      results
    });
  } catch (error) {
    console.error('Error unsaving work:', error);
    res.status(500).json({ error: 'Error unsaving work', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /work/save/jobopsmaster
// Reduces pendingOpsQty in JobOpsMaster AND saves to Contractor_WD with
// savedInBill: 'No'.  The bill is NOT created here – that happens on Submit.
// ---------------------------------------------------------------------------
router.post('/work/save/jobopsmaster', async (req, res) => {
  try {
    const { contractorId, jobNumber, operations } = req.body;

    if (!contractorId || !jobNumber || !operations || !Array.isArray(operations)) {
      return res.status(400).json({ error: 'Missing required fields: contractorId, jobNumber, and operations are required' });
    }

    const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber });
    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobOpsMaster' });
    }

    const allOpIds = [...new Set([
      ...jobOpsMaster.ops.map(jop => jop.opId),
      ...operations.map(op => op.opId).filter(Boolean)
    ])];
    const opObjectIds = allOpIds.map(id => {
      try { return new mongoose.Types.ObjectId(id); } catch { return null; }
    }).filter(Boolean);
    const operationDocs = await Operation.find({ _id: { $in: opObjectIds } });
    const operationNameMap = {};
    operationDocs.forEach(op => { operationNameMap[op._id.toString()] = op.opsName; });

    const updates = [];
    const contractorWDOps = [];
    // Cap each operation so the recorded work cannot pass what the job holds.
    // Without this the browser is the only thing enforcing the limit:
    // pendingOpsQty just floors at 0 while Contractor_WD records whatever was
    // posted, so the recorded work silently exceeds the job.
    //
    // The cap is measured against work already recorded, not against
    // pendingOpsQty. Once pending floors at 0 it stops tracking the overshoot,
    // so "pending + allowance" hands out the full allowance again on every
    // later save — two contractors on one operation could take it repeatedly.
    // Recorded work also stays right when pendingOpsQty has drifted.
    const allowance = packagingAllowanceFor(jobOpsMaster);
    const rejected = [];

    const wdDocsForJob = await ContractorWD.find({ jobId: jobNumber, isAdhoc: { $ne: true } }).lean();
    const recordedByOp = {};
    (wdDocsForJob || []).forEach(doc => {
      (doc.opsDone || []).forEach(od => {
        if (od.opsId == null) return;
        const k = String(od.opsId);
        recordedByOp[k] = (recordedByOp[k] || 0) + Number(od.opsDoneQty || 0);
      });
    });
    // Several operations can arrive in one request, so count what this request
    // has already claimed for an operation as well.
    const claimedByOp = {};

    for (const op of operations) {
      const { opId, opsName, valuePerBook, qtyToAdd } = op;
      if (!opId || !opsName || opsName.trim() === '' ||
          valuePerBook == null || isNaN(Number(valuePerBook)) ||
          qtyToAdd == null || isNaN(Number(qtyToAdd)) || Number(qtyToAdd) <= 0) {
        continue;
      }
      const normalizedOpsName = opsName.trim();
      const normalizedVPB = parseFloat(Number(valuePerBook).toFixed(2));
      if (isNaN(normalizedVPB)) continue;

      // Match on opId first — it is unique and the client always sends it.
      // Only fall back to opsName + rate for legacy callers that omit opId,
      // because operation names are NOT unique (duplicates exist in the
      // operations collection) and name matching hits the wrong row.
      let jobOp = jobOpsMaster.ops.find(jop => String(jop.opId) === String(opId));
      if (!jobOp) {
        jobOp = jobOpsMaster.ops.find(jop => {
          const jopName = operationNameMap[String(jop.opId)] || 'Unknown';
          return jopName === normalizedOpsName && parseFloat(Number(jop.valuePerBook).toFixed(2)) === normalizedVPB;
        });
      }
      if (!jobOp) continue;

      const qtyToDeduct = Number(qtyToAdd);
      if (isNaN(qtyToDeduct) || qtyToDeduct <= 0) continue;

      const opKey = String(jobOp.opId);
      const alreadyRecorded = (recordedByOp[opKey] || 0) + (claimedByOp[opKey] || 0);
      const maxAllowed = Math.max(0, Number(jobOp.totalOpsQty || 0) + allowance - alreadyRecorded);
      if (qtyToDeduct > maxAllowed + QTY_TOL) {
        rejected.push({
          opId: opKey,
          opsName: normalizedOpsName,
          qtyToAdd: qtyToDeduct,
          totalOpsQty: Number(jobOp.totalOpsQty || 0),
          alreadyRecorded,
          packagingAllowance: allowance,
          maxAllowed
        });
        continue;
      }
      claimedByOp[opKey] = (claimedByOp[opKey] || 0) + qtyToDeduct;

      jobOp.pendingOpsQty = Math.max(0, jobOp.pendingOpsQty - qtyToDeduct);
      jobOp.lastUpdatedDate = new Date();
      updates.push({ opId: jobOp.opId, opsName: normalizedOpsName, valuePerBook: jobOp.valuePerBook, pendingOpsQty: jobOp.pendingOpsQty });

      const wdOp = {
        opsId: String(jobOp.opId).trim(),
        opsName: normalizedOpsName,
        valuePerBook: Number(jobOp.valuePerBook),
        opsDoneQty: qtyToDeduct,
        savedInBill: 'No',
        completionDate: new Date()
      };
      if (!wdOp.opsId || !wdOp.opsName || isNaN(wdOp.valuePerBook) || isNaN(wdOp.opsDoneQty) || wdOp.opsDoneQty <= 0) continue;
      contractorWDOps.push(wdOp);
    }

    // Nothing is written when any operation is over the cap, so a partly
    // accepted save can never leave the job half-updated.
    if (rejected.length > 0) {
      const first = rejected[0];
      return res.status(400).json({
        error:
          `Quantity too large for ${rejected.length} operation(s). ` +
          `"${first.opsName}": job holds ${first.totalOpsQty}` +
          (first.packagingAllowance ? ` (+${first.packagingAllowance} packaging allowance)` : '') +
          `, ${first.alreadyRecorded} already recorded, so at most ${first.maxAllowed} can be added — ` +
          `${first.qtyToAdd} was sent.`,
        rejected
      });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid operations to save' });
    }

    await jobOpsMaster.save();

    let contractorWD = await ContractorWD.findOne({ contractorId, jobId: jobNumber });
    if (contractorWD) {
      for (const newOp of contractorWDOps) {
        const existing = contractorWD.opsDone.find(od => {
          if (isOpsDoneBilled(od)) return false;
          const nvpb = parseFloat(Number(newOp.valuePerBook).toFixed(2));
          const odVpb = parseFloat(Number(od.valuePerBook).toFixed(2));
          const idMatch = newOp.opsId && String(od.opsId) === String(newOp.opsId);
          return idMatch || (od.opsName === newOp.opsName && odVpb === nvpb);
        });
        if (existing) {
          existing.opsDoneQty += newOp.opsDoneQty;
          existing.completionDate = new Date();
        } else {
          contractorWD.opsDone.push(newOp);
        }
      }
    } else {
      contractorWD = new ContractorWD({ contractorId, jobId: jobNumber, opsDone: contractorWDOps });
    }
    await contractorWD.save();

    res.json({ message: 'Work saved successfully', updates, jobNumber, contractorId });
  } catch (error) {
    console.error('Error saving work to Contractor_WD:', error);
    res.status(500).json({ error: 'Error saving work', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /work/save/adhoc
// Reduces pendingOpsQty in AdhocWorkOrder AND saves to Contractor_WD with
// savedInBill: 'No'.  The bill is NOT created here.
// ---------------------------------------------------------------------------
router.post('/work/save/adhoc', async (req, res) => {
  try {
    const { adhocOrderId, contractorId, operations } = req.body;
    if (!adhocOrderId || !contractorId || !Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: adhocOrderId, contractorId, operations' });
    }

    const order = await AdhocWorkOrder.findById(adhocOrderId);
    if (!order) return res.status(404).json({ error: 'Ad-hoc order not found' });

    const updates = [];
    const contractorWDOps = [];

    for (const op of operations) {
      const opId = String(op.opId || '').trim();
      const qtyToAdd = Number(op.qtyToAdd);
      const incomingOpsName = String(op.opsName || '').trim();
      if (!opId || isNaN(qtyToAdd) || qtyToAdd <= 0) continue;

      const orderOp = order.ops.find(o => String(o.opId) === opId);
      if (!orderOp) continue;

      const deduct = Math.min(Number(orderOp.pendingOpsQty || 0), qtyToAdd);
      if (deduct <= 0) continue;

      orderOp.pendingOpsQty = Math.max(0, Number(orderOp.pendingOpsQty || 0) - deduct);
      orderOp.lastUpdatedDate = new Date();

      const opsName = incomingOpsName || orderOp.opsName || 'Unknown';
      const valuePerBook = Number(orderOp.rate || 0);

      updates.push({ opId: String(orderOp.opId), opsName, valuePerBook, pendingOpsQty: Number(orderOp.pendingOpsQty || 0) });
      contractorWDOps.push({ opsId: String(orderOp.opId), opsName, valuePerBook, opsDoneQty: deduct, savedInBill: 'No', completionDate: new Date() });
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid operations to save' });

    await order.save();

    let contractorWD = await ContractorWD.findOne({ contractorId, isAdhoc: true, adhocOrderId: String(order._id) });
    if (contractorWD) {
      contractorWD.adhocLabel = order.adhocId || contractorWD.adhocLabel || '';
      for (const newOp of contractorWDOps) {
        const existing = contractorWD.opsDone.find(od =>
          String(od.opsId) === String(newOp.opsId) &&
          od.opsName === newOp.opsName &&
          Number(od.valuePerBook) === Number(newOp.valuePerBook) &&
          isOpsDoneUnsaved(od)
        );
        if (existing) {
          existing.opsDoneQty += newOp.opsDoneQty;
          existing.completionDate = new Date();
        } else {
          contractorWD.opsDone.push(newOp);
        }
      }
    } else {
      contractorWD = new ContractorWD({
        contractorId, jobId: '', isAdhoc: true, adhocOrderId: String(order._id),
        adhocLabel: order.adhocId || '', opsDone: contractorWDOps
      });
    }
    await contractorWD.save();

    res.json({ message: 'Ad-hoc work saved successfully', updates, adhocOrderId: String(order._id), contractorId });
  } catch (error) {
    console.error('Error saving ad-hoc work:', error);
    res.status(500).json({ error: 'Error saving ad-hoc work', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /work/unsaved/:contractorId/:jobNumber
// Returns Contractor_WD entries with savedInBill = 'No' for a job.
// Used to auto-populate the Bill Details section when a job is searched.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /work/unsaved/all/:contractorId
// Returns ALL unsaved Contractor_WD entries (job-based + ad-hoc) for a contractor.
// ---------------------------------------------------------------------------
router.get('/work/unsaved/all/:contractorId', async (req, res) => {
  try {
    const { contractorId } = req.params;
    // Only documents that actually hold unsaved work — a contractor can have
    // hundreds of Contractor_WD documents and most are fully billed.
    // The pattern tolerates surrounding whitespace so this matches exactly what
    // isOpsDoneUnsaved accepts; savedInBill has no trim in the schema, and a
    // value written outside mongoose could carry spaces.
    const wdDocs = await ContractorWD.find({
      contractorId,
      'opsDone.savedInBill': { $regex: /^\s*No\s*$/ }
    }).lean();

    const docsWithUnsaved = wdDocs
      .map(doc => ({ doc, unsavedOps: (doc.opsDone || []).filter(isOpsDoneUnsaved) }))
      .filter(x => x.unsavedOps.length > 0);

    // Fetch the referenced jobs and ad-hoc orders in one query each. This used
    // to be a findOne per document, run sequentially, which on a contractor
    // with a long history made the call slow enough to time out — and the
    // client swallowed that, so Bill Details silently stayed empty until a job
    // search loaded the same rows through the per-job endpoint.
    const jobIds = [...new Set(docsWithUnsaved.filter(x => !x.doc.isAdhoc && x.doc.jobId).map(x => x.doc.jobId))];
    const adhocIds = [...new Set(docsWithUnsaved.filter(x => x.doc.isAdhoc && x.doc.adhocOrderId).map(x => String(x.doc.adhocOrderId)))];

    const masterByJob = {};
    if (jobIds.length > 0) {
      const masters = await JobOpsMaster.find({ jobId: { $in: jobIds } }).lean();
      masters.forEach(m => { masterByJob[String(m.jobId)] = m; });
    }

    const orderById = {};
    if (adhocIds.length > 0) {
      const validIds = adhocIds
        .map(id => { try { return new mongoose.Types.ObjectId(id); } catch { return null; } })
        .filter(Boolean);
      if (validIds.length > 0) {
        const orders = await AdhocWorkOrder.find({ _id: { $in: validIds } }).lean();
        orders.forEach(o => { orderById[String(o._id)] = o; });
      }
    }

    const result = [];

    for (const { doc, unsavedOps } of docsWithUnsaved) {
      if (doc.isAdhoc && doc.adhocOrderId) {
        const order = orderById[String(doc.adhocOrderId)] || null;
        const adhocLabel = doc.adhocLabel || (order ? order.adhocId : '') || String(doc.adhocOrderId);

        result.push({
          isAdhoc: true,
          adhocOrderId: String(doc.adhocOrderId),
          adhocLabel,
          jobNumber: '',
          clientName: '',
          jobTitle: '',
          items: unsavedOps.map(od => ({
            opsId: String(od.opsId),
            opsName: od.opsName,
            valuePerBook: Number(od.valuePerBook || 0),
            qtyCompleted: Number(od.opsDoneQty || 0),
            totalValue: Number(od.opsDoneQty || 0) * Number(od.valuePerBook || 0),
            qtyBook: 1,
            completionDate: od.completionDate || null
          }))
        });
      } else if (doc.jobId) {
        const jobOpsMaster = masterByJob[String(doc.jobId)] || null;
        const clientName = jobOpsMaster ? (jobOpsMaster.clientName || '') : '';
        const jobTitle  = jobOpsMaster ? (jobOpsMaster.jobTitle  || '') : '';

        result.push({
          isAdhoc: false,
          adhocOrderId: '',
          adhocLabel: '',
          jobNumber: doc.jobId,
          clientName,
          jobTitle,
          items: unsavedOps.map(od => {
            let qtyBook = 0;
            if (jobOpsMaster) {
              const jop = (jobOpsMaster.ops || []).find(o => String(o.opId) === String(od.opsId));
              if (jop) qtyBook = Number(jop.qtyPerBook || 0);
            }
            return {
              opsId: String(od.opsId),
              opsName: od.opsName,
              valuePerBook: Number(od.valuePerBook || 0),
              qtyCompleted: Number(od.opsDoneQty || 0),
              totalValue: Number(od.opsDoneQty || 0) * Number(od.valuePerBook || 0),
              qtyBook,
              completionDate: od.completionDate || null
            };
          })
        });
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching all unsaved work:', error);
    res.status(500).json({ error: 'Error fetching all unsaved work', details: error.message });
  }
});

router.get('/work/unsaved/:contractorId/:jobNumber', async (req, res) => {
  try {
    const { contractorId, jobNumber } = req.params;

    const contractorWD = await ContractorWD.findOne({
      contractorId,
      jobId: jobNumber,
      isAdhoc: { $ne: true }
    }).lean();

    if (!contractorWD) return res.json({ jobNumber, clientName: '', jobTitle: '', items: [] });

    const unsavedOps = (contractorWD.opsDone || []).filter(isOpsDoneUnsaved);
    if (unsavedOps.length === 0) return res.json({ jobNumber, clientName: '', jobTitle: '', items: [] });

    // Look up qtyPerBook and clientName/jobTitle from JobOpsMaster
    const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber }).lean();
    const clientName = jobOpsMaster ? (jobOpsMaster.clientName || '') : '';
    const jobTitle = jobOpsMaster ? (jobOpsMaster.jobTitle || '') : '';

    const items = unsavedOps.map(od => {
      let qtyBook = 0;
      if (jobOpsMaster) {
        const jop = (jobOpsMaster.ops || []).find(o => String(o.opId) === String(od.opsId));
        if (jop) qtyBook = Number(jop.qtyPerBook || 0);
      }
      return {
        opsId: String(od.opsId),
        opsName: od.opsName,
        valuePerBook: Number(od.valuePerBook || 0),
        qtyCompleted: Number(od.opsDoneQty || 0),
        totalValue: Number(od.opsDoneQty || 0) * Number(od.valuePerBook || 0),
        qtyBook,
        savedInBill: 'No',
        completionDate: od.completionDate || null
      };
    });

    res.json({ jobNumber, clientName, jobTitle, items });
  } catch (error) {
    console.error('Error fetching unsaved work:', error);
    res.status(500).json({ error: 'Error fetching unsaved work', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /work/unsaved/adhoc/:contractorId/:adhocOrderId
// Returns Contractor_WD entries with savedInBill = 'No' for an ad-hoc order.
// ---------------------------------------------------------------------------
router.get('/work/unsaved/adhoc/:contractorId/:adhocOrderId', async (req, res) => {
  try {
    const { contractorId, adhocOrderId } = req.params;

    const contractorWD = await ContractorWD.findOne({
      contractorId,
      isAdhoc: true,
      adhocOrderId
    }).lean();

    if (!contractorWD) return res.json({ adhocOrderId, adhocLabel: '', items: [] });

    const unsavedOps = (contractorWD.opsDone || []).filter(isOpsDoneUnsaved);
    if (unsavedOps.length === 0) return res.json({ adhocOrderId, adhocLabel: contractorWD.adhocLabel || '', items: [] });

    // Look up rate (valuePerBook) from AdhocWorkOrder if needed
    const order = await AdhocWorkOrder.findById(adhocOrderId).lean();
    const adhocLabel = contractorWD.adhocLabel || (order ? order.adhocId : '') || adhocOrderId;

    const items = unsavedOps.map(od => {
      let qtyBook = 1;
      if (order) {
        const orderOp = (order.ops || []).find(o => String(o.opId) === String(od.opsId));
        if (orderOp) qtyBook = Number(orderOp.qtyPerBook || 1);
      }
      return {
        opsId: String(od.opsId),
        opsName: od.opsName,
        valuePerBook: Number(od.valuePerBook || 0),
        qtyCompleted: Number(od.opsDoneQty || 0),
        totalValue: Number(od.opsDoneQty || 0) * Number(od.valuePerBook || 0),
        qtyBook,
        savedInBill: 'No',
        completionDate: od.completionDate || null
      };
    });

    res.json({ adhocOrderId, adhocLabel, items });
  } catch (error) {
    console.error('Error fetching unsaved ad-hoc work:', error);
    res.status(500).json({ error: 'Error fetching unsaved ad-hoc work', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /work/mark-billed
// After a bill is submitted, marks the relevant Contractor_WD opsDone entries
// as savedInBill: 'Yes'.
// Body: { contractorId, items: [{ jobNumber?, isAdhoc?, adhocOrderId?, opsId, opsName, valuePerBook }] }
// ---------------------------------------------------------------------------
router.post('/work/mark-billed', async (req, res) => {
  try {
    const { contractorId, items } = req.body;
    if (!contractorId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'contractorId and items array are required' });
    }

    // POST /bills already marks these entries, so on the normal path this call
    // finds nothing left to do and marks 0 — that is success, not a failure.
    const marked = await markContractorWDEntriesBilled(contractorId, items);

    res.json({ message: 'Entries marked as billed successfully', marked });
  } catch (error) {
    console.error('Error marking entries as billed:', error);
    res.status(500).json({ error: 'Error marking entries as billed', details: error.message });
  }
});

// Retired. This wrote Contractor_WD without the savedInBill discipline the
// current flow depends on, and nothing calls it any more. Kept as an explicit
// error so an old client fails loudly instead of writing inconsistent data.
router.post('/work/update', async (req, res) => {
  res.status(410).json({
    error: 'This endpoint has been retired. Use POST /work/save/jobopsmaster instead.'
  });
});

// Contractors routes
router.get('/contractors', async (req, res) => {
  try {
    const contractors = await Contractor.find({ isdeleted: 0 }).sort({ creationDate: -1 });
    res.json(contractors);
  } catch (error) {
    console.error('Error fetching contractors:', error);
    res.status(500).json({ error: 'Error fetching contractors' });
  }
});

async function findActiveContractorByName(name, excludeId = null) {
  const trimmed = name.trim();
  const query = {
    isdeleted: 0,
    name: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  return Contractor.findOne(query);
}

/** Next free 3-digit ID in 1–999 (includes soft-deleted so IDs are not reused). */
async function allocateNextShortId() {
  const used = await Contractor.find({ shortId: { $ne: null } }).select('shortId').lean();
  const usedSet = new Set(used.map((c) => Number(c.shortId)).filter((n) => Number.isFinite(n)));
  for (let i = 1; i <= 999; i++) {
    if (!usedSet.has(i)) return i;
  }
  throw new Error('No available 3-digit contractor IDs (001–999 are all used)');
}

router.post('/contractors', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    const duplicate = await findActiveContractorByName(name);
    if (duplicate) {
      return res.status(400).json({ error: 'A contractor with this name already exists' });
    }

    let contractorId;
    let existingContractor;
    do {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
      contractorId = `CTR${timestamp}${randomStr}`;
      existingContractor = await Contractor.findOne({ contractorId });
    } while (existingContractor);

    let shortId;
    try {
      shortId = await allocateNextShortId();
    } catch (allocErr) {
      return res.status(400).json({ error: allocErr.message });
    }

    const contractor = new Contractor({
      contractorId,
      shortId,
      name: name.trim(),
      creationDate: new Date(),
      isdeleted: 0
    });

    await contractor.save();
    res.status(201).json(contractor);
  } catch (error) {
    console.error('Error creating contractor:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Contractor ID already exists' });
    }
    res.status(500).json({ error: 'Error creating contractor' });
  }
});

router.put('/contractors/:id', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    const duplicate = await findActiveContractorByName(name, req.params.id);
    if (duplicate) {
      return res.status(400).json({ error: 'A contractor with this name already exists' });
    }

    const contractor = await Contractor.findByIdAndUpdate(
      req.params.id,
      { name: name.trim() },
      { new: true, runValidators: true }
    );

    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json(contractor);
  } catch (error) {
    console.error('Error updating contractor:', error);
    res.status(500).json({ error: 'Error updating contractor' });
  }
});

router.delete('/contractors/:id', async (req, res) => {
  try {
    const contractor = await Contractor.findByIdAndUpdate(
      req.params.id,
      { isdeleted: 1 },
      { new: true }
    );

    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json({ message: 'Contractor deleted successfully' });
  } catch (error) {
    console.error('Error deleting contractor:', error);
    res.status(500).json({ error: 'Error deleting contractor' });
  }
});

// Bills routes
async function generateNextBillNumber() {
  try {
    const lastBill = await Bill.findOne().sort({ billNumber: -1 });
    
    if (!lastBill) {
      return '00000001';
    }
    
    const lastNumber = parseInt(lastBill.billNumber, 10);
    const nextNumber = lastNumber + 1;
    
    return nextNumber.toString().padStart(8, '0');
  } catch (error) {
    console.error('Error generating bill number:', error);
    throw error;
  }
}

/** Compose contractor bill ref: mm_yy_<shortId>_<enteredNo> using Asia/Kolkata payment date. */
function buildContractorBillNo(paymentDate, shortId, enteredNo) {
  const d = paymentDate instanceof Date ? paymentDate : new Date(paymentDate);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(d);
  const mm = parts.find((p) => p.type === 'month')?.value;
  const yy = parts.find((p) => p.type === 'year')?.value;
  const id = Number(shortId);
  const no = String(enteredNo || '').trim();
  if (!mm || !yy || !Number.isFinite(id) || id < 1 || !no) {
    throw new Error('Invalid contractor bill number inputs');
  }
  return `${mm}_${yy}_${id}_${no}`;
}

router.get('/bills', async (req, res) => {
  try {
    const bills = await Bill.find({
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ]
    }).sort({ billNumber: -1 });
    res.json(bills);
  } catch (error) {
    console.error('Error fetching bills:', error);
    res.status(500).json({ error: 'Error fetching bills' });
  }
});

router.get('/bills/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const bill = await Bill.findOne({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    res.json(bill);
  } catch (error) {
    console.error('Error fetching bill:', error);
    res.status(500).json({ error: 'Error fetching bill' });
  }
});

router.post('/bills', async (req, res) => {
  try {
    const { contractorName, jobs } = req.body;

    if (!contractorName || !contractorName.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'At least one job is required' });
    }

    for (const job of jobs) {
      const isAdhoc = !!job.isAdhoc;
      if (!isAdhoc && (!job.jobNumber || !job.jobNumber.trim())) {
        return res.status(400).json({ error: 'Each non-ad-hoc entry must have a job number' });
      }
      if (isAdhoc && (!job.adhocOrderId || !String(job.adhocOrderId).trim())) {
        return res.status(400).json({ error: 'Each ad-hoc entry must have adhocOrderId' });
      }
      if (!job.ops || !Array.isArray(job.ops) || job.ops.length === 0) {
        return res.status(400).json({ error: 'Each job must have at least one operation' });
      }

      for (const op of job.ops) {
        if (!op.opsName || !op.opsName.trim()) {
          return res.status(400).json({ 
            error: 'Each operation must have an operation name (opsName)' 
          });
        }
        if (
          op.qtyBook === undefined || 
          op.rate === undefined || 
          op.qtyCompleted === undefined || 
          op.totalValue === undefined
        ) {
          return res.status(400).json({ 
            error: 'Each operation must have qtyBook, rate, qtyCompleted, and totalValue' 
          });
        }

        if (
          isNaN(Number(op.qtyBook)) || 
          isNaN(Number(op.rate)) || 
          isNaN(Number(op.qtyCompleted)) || 
          isNaN(Number(op.totalValue))
        ) {
          return res.status(400).json({ 
            error: 'All operation fields must be valid numbers' 
          });
        }

        if (
          Number(op.qtyBook) < 0 ||
          Number(op.rate) < 0 ||
          Number(op.qtyCompleted) < 0 ||
          Number(op.totalValue) < 0
        ) {
          return res.status(400).json({
            error: 'All operation values must be non-negative'
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Refuse to bill more of an operation than the job holds.
    // Nothing else stops the same work being billed twice: pendingOpsQty is
    // the only guard on re-recording, and when it drifts the work looks
    // outstanding again and gets billed a second time. Set allowOverBilling
    // to override deliberately.
    // -----------------------------------------------------------------------
    if (req.body?.allowOverBilling !== true) {
      const jobNumbers = [...new Set(
        jobs.filter(j => !j.isAdhoc && j.jobNumber).map(j => String(j.jobNumber).trim())
      )];

      if (jobNumbers.length > 0) {
        const alreadyBilled = await getLiveBilledQtyByOp(jobNumbers);
        const masters = await JobOpsMaster.find({ jobId: { $in: jobNumbers } }).lean();
        const masterByJob = {};
        masters.forEach(m => { masterByJob[String(m.jobId).trim()] = m; });

        // Operation names, so a jobOp can be matched when opId is absent
        const masterOpIds = [];
        masters.forEach(m => (m.ops || []).forEach(o => { if (o.opId) masterOpIds.push(o.opId); }));
        const masterOpDocs = await Operation.find({
          _id: { $in: masterOpIds.map(id => { try { return new mongoose.Types.ObjectId(id); } catch { return null; } }).filter(Boolean) }
        }).lean();
        const masterOpName = {};
        masterOpDocs.forEach(o => { masterOpName[o._id.toString()] = String(o.opsName || '').trim(); });

        const violations = [];
        for (const job of jobs) {
          if (job.isAdhoc || !job.jobNumber) continue;
          const jn = String(job.jobNumber).trim();
          const master = masterByJob[jn];
          if (!master) continue;                       // no master: nothing to compare against
          const allowance = packagingAllowanceFor(master);

          for (const op of (job.ops || [])) {
            const opsName = String(op.opsName || '').trim();
            const rate = parseFloat(Number(op.rate || 0).toFixed(2));

            let jobOp = op.opId
              ? (master.ops || []).find(jop => String(jop.opId) === String(op.opId))
              : null;
            if (!jobOp) {
              jobOp = (master.ops || []).find(jop =>
                masterOpName[String(jop.opId)] === opsName &&
                parseFloat(Number(jop.valuePerBook || 0).toFixed(2)) === rate
              );
            }
            if (!jobOp) continue;

            const allowedMax = Number(jobOp.totalOpsQty || 0) + allowance;
            const prior = alreadyBilled[[jn, opsName, rate].join('|')] || 0;
            const after = prior + Number(op.qtyCompleted || 0);

            if (after > allowedMax + QTY_TOL) {
              violations.push({
                jobNumber: jn,
                opsName,
                rate,
                totalOpsQty: Number(jobOp.totalOpsQty || 0),
                packagingAllowance: allowance,
                alreadyBilled: prior,
                thisBill: Number(op.qtyCompleted || 0),
                wouldBeBilled: after,
                excess: parseFloat((after - allowedMax).toFixed(2))
              });
            }
          }
        }

        if (violations.length > 0) {
          const first = violations[0];
          return res.status(400).json({
            error:
              `This bill would charge more than the job allows for ${violations.length} operation(s). ` +
              `For example job ${first.jobNumber}, "${first.opsName}": total ${first.totalOpsQty}` +
              (first.packagingAllowance ? ` (+${first.packagingAllowance} packaging allowance)` : '') +
              `, already billed ${first.alreadyBilled}, this bill adds ${first.thisBill} — ` +
              `${first.excess} too many. This work has most likely been billed already.`,
            overBilling: violations
          });
        }
      }
    }

    // Generate bill number
    const billNumber = await generateNextBillNumber();

    // Collect all unique opIds from all jobs
    const allOpIds = [];
    jobs.forEach(job => {
      job.ops.forEach(op => {
        if (op.opId) {
          allOpIds.push(op.opId);
        }
      });
    });

    // Fetch operation types for all operations
    const operationTypeMap = {};
    if (allOpIds.length > 0) {
      const opObjectIds = allOpIds.map(opId => {
        try {
          return new mongoose.Types.ObjectId(opId);
        } catch (error) {
          return null;
        }
      }).filter(Boolean);

      if (opObjectIds.length > 0) {
        const operationDocs = await Operation.find({ _id: { $in: opObjectIds } }).lean();
        operationDocs.forEach(op => {
          const idStr = op._id.toString();
          operationTypeMap[idStr] = op.type;
        });
      }
    }

    // Fallback lookup for missing clientName/jobTitle from JobOpsMaster
    const nonAdhocJobNumbers = [...new Set(
      jobs
        .filter(j => !j.isAdhoc && j.jobNumber != null && String(j.jobNumber).trim())
        .map(j => String(j.jobNumber).trim())
    )];
    const jobDetailsFallbackMap = {};
    if (nonAdhocJobNumbers.length > 0) {
      const jobDocs = await JobOpsMaster.find({ jobId: { $in: nonAdhocJobNumbers } }).lean();
      jobDocs.forEach(doc => {
        const key = String(doc.jobId || '').trim();
        if (key) {
          jobDetailsFallbackMap[key] = {
            clientName: String(doc.clientName || '').trim(),
            jobTitle: String(doc.jobTitle || '').trim()
          };
        }
      });
    }

    // Create bill (include clientName and jobTitle per job for display/print)
    // Resolve the contractor up front so the bill carries a stable id, not just
    // a name that can be duplicated or renamed later.
    let billContractorId = '';
    try {
      const matches = await Contractor.find({
        name: contractorName.trim(),
        $or: [{ isdeleted: 0 }, { isdeleted: { $exists: false } }]
      }).select('contractorId').lean();
      if (matches.length === 1) billContractorId = String(matches[0].contractorId || '');
    } catch (_) { /* fall back to name-only, as before */ }

    const bill = new Bill({
      billNumber,
      contractorName: contractorName.trim(),
      contractorId: billContractorId,
      jobs: jobs.map(job => {
        const isAdhoc = !!job.isAdhoc;
        const normalizedJobNumber = (job.jobNumber != null && String(job.jobNumber).trim()) ? String(job.jobNumber).trim() : '';
        const fallback = (!isAdhoc && normalizedJobNumber) ? (jobDetailsFallbackMap[normalizedJobNumber] || {}) : {};
        const clientName = (job.clientName != null && String(job.clientName).trim())
          ? String(job.clientName).trim()
          : String(fallback.clientName || '');
        const jobTitle = (job.jobTitle != null && String(job.jobTitle).trim())
          ? String(job.jobTitle).trim()
          : String(fallback.jobTitle || '');

        return {
        jobNumber: normalizedJobNumber,
        clientName,
        jobTitle,
        isAdhoc,
        adhocOrderId: (job.adhocOrderId != null && String(job.adhocOrderId).trim()) ? String(job.adhocOrderId).trim() : '',
        adhocLabel: (job.adhocLabel != null && String(job.adhocLabel).trim()) ? String(job.adhocLabel).trim() : '',
        ops: job.ops.map(op => {
          // Get operation type
          const opIdStr = String(op.opId || '');
          const operationType = operationTypeMap[opIdStr];
          const actualQtyBook = Number(op.qtyBook);
          
          // For 1/x type operations, save qtyBook as 1/actual qtyBook
          let qtyBookToSave = actualQtyBook;
          if (operationType === '1/x' && actualQtyBook > 0) {
            qtyBookToSave = 1 / actualQtyBook;
          }
          
          return {
            opId: (op.opId != null && String(op.opId).trim()) ? String(op.opId).trim() : '',
            opsName: op.opsName.trim(),
            qtyBook: qtyBookToSave,
            rate: Number(op.rate),
            qtyCompleted: Number(op.qtyCompleted),
            totalValue: Number(op.totalValue)
          };
        })
      };
      })
    });

    await bill.save();

    // Mark the underlying Contractor_WD work as billed in the same request.
    // The client also calls /work/mark-billed afterwards, but that is a second
    // round trip that can fail on its own; doing it here means a saved bill
    // never leaves its work looking like pending work in Work Done.
    let wdMarked = 0;
    let wdMarkError = '';
    try {
      const contractor = await Contractor.findOne({
        name: bill.contractorName.trim(),
        $or: [ { isdeleted: 0 }, { isdeleted: { $exists: false } } ]
      });
      if (contractor) {
        const markItems = [];
        bill.jobs.forEach(job => {
          (job.ops || []).forEach(op => {
            markItems.push({
              jobNumber: job.jobNumber || '',
              isAdhoc: !!job.isAdhoc,
              adhocOrderId: job.adhocOrderId || '',
              opsId: op.opId || '',
              opsName: op.opsName || '',
              valuePerBook: Number(op.rate || 0)
            });
          });
        });
        wdMarked = await markContractorWDEntriesBilled(contractor.contractorId, markItems);
      } else {
        wdMarkError = `Contractor not found for name: ${bill.contractorName}`;
      }
    } catch (markErr) {
      // The bill itself is saved, so do not fail the request — report it instead.
      console.error('Bill saved but marking Contractor_WD as billed failed:', markErr);
      wdMarkError = markErr.message || 'Error marking work as billed';
    }

    res.status(201).json({ ...bill.toObject(), wdMarked, wdMarkError });
  } catch (error) {
    console.error('Error creating bill:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Bill number already exists' });
    }
    res.status(500).json({ error: 'Error creating bill' });
  }
});

// Generic bill update. This route does NOT touch JobopsMaster or
// Contractor_WD, so rewriting the billed operations through it would leave the
// recorded work and pending quantities describing a bill that no longer
// exists. Only the contractor name can be changed here; quantities go through
// PUT /bills/:billNumber/edit-qty, which adjusts both collections.
router.put('/bills/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const { contractorName, jobs } = req.body;

    if (jobs !== undefined) {
      return res.status(400).json({
        error:
          'Billed operations cannot be changed through this endpoint, because it does not ' +
          'adjust JobopsMaster pending quantities or Contractor_WD. ' +
          'Use PUT /bills/:billNumber/edit-qty to change quantities.'
      });
    }

    const bill = await Bill.findOne({ billNumber });
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (contractorName !== undefined) {
      if (!contractorName || !contractorName.trim()) {
        return res.status(400).json({ error: 'Contractor name cannot be empty' });
      }
      bill.contractorName = contractorName.trim();
    }


    await bill.save();
    res.json(bill);
  } catch (error) {
    console.error('Error updating bill:', error);
    res.status(500).json({ error: 'Error updating bill' });
  }
});

// Edit unpaid bill: allow only qtyCompleted changes and row/job deletion.
// This endpoint also keeps JobopsMaster.pendingOpsQty and Contractor_WD.opsDone in sync.
router.put('/bills/:billNumber/edit-qty', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { billNumber } = req.params;
    const { contractorId, changes } = req.body;

    if (!contractorId || !String(contractorId).trim()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'contractorId is required' });
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'At least one change is required' });
    }

    // Load existing bill within the transaction
    const bill = await Bill.findOne({ billNumber }).session(session);
    if (!bill) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Do not allow editing paid bills
    if (bill.paymentStatus === 'Yes') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Paid bills cannot be edited' });
    }

    // Build quick lookup for existing operations in the bill
    // key: jobNumber|opsName|rateRounded
    function buildKey(jobNumber, opsName, rate) {
      const jn = String(jobNumber || '').trim();
      const name = String(opsName || '').trim();
      const r = Number(rate || 0);
      const roundedRate = Number.isFinite(r) ? r.toFixed(4) : '0.0000';
      return `${jn}|${name}|${roundedRate}`;
    }

    // A bill can list the same job, operation and rate more than once. Keeping
    // only the last match would edit one line and silently leave the others,
    // so ambiguous keys are rejected rather than half-applied.
    const billOpsMap = new Map();
    bill.jobs.forEach(job => {
      const jobNumber = job.jobNumber;
      (job.ops || []).forEach(op => {
        const key = buildKey(jobNumber, op.opsName, op.rate);
        if (!billOpsMap.has(key)) billOpsMap.set(key, []);
        billOpsMap.get(key).push({ job, op });
      });
    });

    // Collect deltas per job for JobopsMaster / Contractor_WD updates
    const deltasByJob = new Map(); // jobNumber -> [{ opsName, rate, deltaQty }]

    // Apply changes to bill in-memory
    for (const change of changes) {
      const { jobNumber, opsName, rate, newQtyCompleted } = change || {};

      if (!jobNumber || !String(jobNumber).trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have a jobNumber' });
      }
      if (!opsName || !String(opsName).trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have an opsName' });
      }
      if (newQtyCompleted === undefined || newQtyCompleted === null) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have newQtyCompleted' });
      }

      const key = buildKey(jobNumber, opsName, rate);
      const entries = billOpsMap.get(key);
      if (!entries || entries.length === 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: `Operation not found in bill for job ${jobNumber}, operation ${opsName}` });
      }
      if (entries.length > 1) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          error:
            `Job ${jobNumber} lists operation "${opsName}" at rate ${rate} ${entries.length} times in ` +
            `this bill, so it is not clear which line should change. Delete the bill and re-create it ` +
            `with the correct lines instead.`
        });
      }

      const { job, op } = entries[0];
      const oldQty = Number(op.qtyCompleted || 0);
      const newQty = Number(newQtyCompleted);

      if (!Number.isFinite(newQty) || newQty < 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'newQtyCompleted must be a non-negative number' });
      }

      const delta = newQty - oldQty;
      if (delta === 0) {
        continue; // nothing to do for this row
      }

      // Track delta for backend collections
      if (!deltasByJob.has(job.jobNumber)) {
        deltasByJob.set(job.jobNumber, []);
      }
      deltasByJob.get(job.jobNumber).push({
        // Carried through so the operation can be matched by id rather than by
        // name and rate, which are not a reliable key.
        opId: String(op.opId || '').trim(),
        opsName: String(op.opsName || '').trim(),
        rate: Number(op.rate || 0),
        deltaQty: delta
      });

      // Update bill op
      op.qtyCompleted = newQty;
      op.totalValue = Number(op.rate || 0) * newQty;
    }

    // If no effective changes, just return the existing bill
    if (deltasByJob.size === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.json(bill);
    }

    // Helper to round valuePerBook / rate consistently
    const round2 = (val) => parseFloat(Number(val || 0).toFixed(2));

    // For each job, update JobopsMaster and Contractor_WD using deltas
    for (const [jobNumber, deltas] of deltasByJob.entries()) {
      const jobOpsMaster = await JobOpsMaster.findOne({ jobId: jobNumber }).session(session);
      if (!jobOpsMaster) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: `JobOpsMaster not found for job ${jobNumber}` });
      }

      // Fetch operation names for this job's operations
      const opIds = jobOpsMaster.ops.map(op => op.opId).filter(Boolean);
      const opObjectIds = opIds.map(opId => {
        try {
          return new mongoose.Types.ObjectId(opId);
        } catch {
          return null;
        }
      }).filter(Boolean);

      const operationDocs = await Operation.find({ _id: { $in: opObjectIds } }).session(session);
      const operationNameMap = {};
      operationDocs.forEach(op => {
        operationNameMap[op._id.toString()] = op.opsName;
      });

      // Apply each delta to JobopsMaster.ops and prepare Contractor_WD adjustments
      const contractorWDAdjustments = []; // { opsName, valuePerBook, deltaQty }

      // Work already recorded per operation, across every contractor, before
      // this edit. pendingOpsQty clamps at 0, so once an operation has run past
      // its total the overshoot is no longer visible there — moving pending by
      // the delta then carries that gap forward. Deriving it from the recorded
      // work instead keeps the figure right, the same way the delete reversal
      // now does.
      const wdDocsForEdit = await ContractorWD.find({
        jobId: jobNumber,
        isAdhoc: { $ne: true }
      }).session(session).lean();
      const recordedByOpForEdit = {};
      (wdDocsForEdit || []).forEach(doc => {
        (doc.opsDone || []).forEach(od => {
          if (od.opsId == null) return;
          const k = String(od.opsId);
          recordedByOpForEdit[k] = (recordedByOpForEdit[k] || 0) + Number(od.opsDoneQty || 0);
        });
      });
      // Several changes can land on one operation, so the deltas accumulate.
      const appliedDeltaByOp = {};
      // The operations this edit touches, so pending can be set for them once
      // the Contractor_WD adjustment below has actually gone in.
      const touchedJobOps = new Map();

      for (const { opId, opsName, rate, deltaQty } of deltas) {
        const normalizedName = String(opsName || '').trim();
        const normalizedRate = round2(rate);
        const normalizedOpId = String(opId || '').trim();

        // opId first; name and rate only for bills saved before opId was stored.
        let jobOp = normalizedOpId
          ? jobOpsMaster.ops.find(jop => String(jop.opId) === normalizedOpId)
          : null;
        if (!jobOp) {
          jobOp = jobOpsMaster.ops.find(jop => {
            const jopName = operationNameMap[String(jop.opId)] || 'Unknown';
            const jopValue = round2(jop.valuePerBook);
            return jopName === normalizedName && jopValue === normalizedRate;
          });
        }

        if (!jobOp) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ error: `Operation ${normalizedName} (rate ${normalizedRate}) not found in JobopsMaster for job ${jobNumber}` });
        }

        const totalOpsQty = Number(jobOp.totalOpsQty || 0);
        const opKey = String(jobOp.opId);

        // Where the recorded work lands once this change is applied.
        const recordedBefore = (recordedByOpForEdit[opKey] || 0) + (appliedDeltaByOp[opKey] || 0);
        const recordedAfter = Math.max(0, recordedBefore + deltaQty);

        // Packaging jobs may run past the total by the usual allowance, so the
        // same headroom the entry screen grants applies here.
        const editAllowance = packagingAllowanceFor(jobOpsMaster);
        if (recordedAfter > totalOpsQty + editAllowance + 1e-6) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            error:
              `Insufficient pending quantity for job ${jobNumber}, operation ${normalizedName} ` +
              `to increase completed quantity by ${deltaQty}: the job holds ${totalOpsQty}` +
              (editAllowance ? ` (+${editAllowance} packaging allowance)` : '') +
              ` and ${recordedBefore} is already recorded.`
          });
        }
        appliedDeltaByOp[opKey] = (appliedDeltaByOp[opKey] || 0) + deltaQty;
        touchedJobOps.set(opKey, jobOp);

        contractorWDAdjustments.push({
          opId: String(jobOp.opId || '').trim(),
          opsName: normalizedName,
          valuePerBook: jobOp.valuePerBook,
          deltaQty
        });
      }

      // Apply adjustments to Contractor_WD
      let contractorWD = await ContractorWD.findOne({
        contractorId: contractorId,
        jobId: jobNumber
      }).session(session);

      if (!contractorWD) {
        contractorWD = new ContractorWD({
          contractorId: contractorId,
          jobId: jobNumber,
          opsDone: []
        });
      }

      for (const adj of contractorWDAdjustments) {
        const { opId, opsName, valuePerBook, deltaQty } = adj;
        const adjName = String(opsName || '').trim();
        const adjValue = round2(valuePerBook);
        const adjOpId = String(opId || '').trim();

        // Only ever touch entries that are already part of a bill. An entry
        // with savedInBill:'No' is work that has been saved but not yet
        // submitted — folding a bill edit into it would both inflate that
        // pending row and bill the same quantity twice.
        const existingOp = contractorWD.opsDone.find(od => {
          if (isOpsDoneUnsaved(od)) return false;
          if (adjOpId && String(od.opsId || '').trim() === adjOpId) return true;
          const odName = String(od.opsName || '').trim();
          const odVal = round2(od.valuePerBook);
          return odName === adjName && odVal === adjValue;
        });

        if (deltaQty > 0) {
          // Increase completed quantity
          if (existingOp) {
            existingOp.opsDoneQty += deltaQty;
            existingOp.completionDate = new Date();
          } else {
            // This quantity is going straight onto an existing bill, so the
            // entry must be created as already billed. Leaving savedInBill
            // unset would fall back to the schema default of 'No' and make it
            // show up as pending work in Work Done.
            contractorWD.opsDone.push({
              opsId: adjOpId,
              opsName: adjName,
              valuePerBook: adjValue,
              opsDoneQty: deltaQty,
              savedInBill: 'Yes',
              completionDate: new Date()
            });
          }
        } else if (deltaQty < 0 && existingOp) {
          // Decrease completed quantity
          const newDone = Number(existingOp.opsDoneQty || 0) + deltaQty; // deltaQty is negative
          if (newDone <= 0) {
            // Remove entry if fully reversed
            contractorWD.opsDone = contractorWD.opsDone.filter(od => od !== existingOp);
          } else {
            existingOp.opsDoneQty = newDone;
            existingOp.completionDate = new Date();
          }
        }
      }

      await contractorWD.save({ session });

      // Pending is set from the Contractor_WD state the adjustment above left
      // behind, not from the delta this request asked for. A decrease can only
      // come out of a billed row that exists: where none matched, or it held
      // less than the bill claimed, Contractor_WD keeps the quantity while a
      // delta-based pending would hand it back as work to do. The save cap
      // measures against Contractor_WD, so that pending was unusable anyway.
      const wdDocsAfterEdit = await ContractorWD.find({
        jobId: jobNumber,
        isAdhoc: { $ne: true }
      }).session(session).lean();
      const recordedAfterByOpForEdit = {};
      (wdDocsAfterEdit || []).forEach(doc => {
        (doc.opsDone || []).forEach(od => {
          if (od.opsId == null) return;
          const k = String(od.opsId);
          recordedAfterByOpForEdit[k] = (recordedAfterByOpForEdit[k] || 0) + Number(od.opsDoneQty || 0);
        });
      });

      for (const [opKey, jobOp] of touchedJobOps.entries()) {
        const totalOpsQty = Number(jobOp.totalOpsQty || 0);
        const recordedAfter = Math.max(0, recordedAfterByOpForEdit[opKey] || 0);
        jobOp.pendingOpsQty = Math.max(0, Math.min(totalOpsQty, totalOpsQty - recordedAfter));
        jobOp.lastUpdatedDate = new Date();
      }
      jobOpsMaster.markModified('ops');
      await jobOpsMaster.save({ session });
    }

    // After adjustments, clean up bill jobs:
    // - Remove operations with qtyCompleted === 0
    // - Remove jobs with no operations
    // Mutate in place so clientName, jobTitle, isAdhoc, etc. are preserved.
    for (const job of bill.jobs) {
      job.ops = (job.ops || []).filter(op => Number(op.qtyCompleted || 0) > 0);
    }
    bill.jobs = bill.jobs.filter(job => (job.ops || []).length > 0);

    await bill.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json(bill);
  } catch (error) {
    console.error('Error editing bill quantities:', error);
    try {
      await session.abortTransaction();
    } catch (_) {}
    session.endSession();
    res.status(500).json({ error: 'Error editing bill quantities' });
  }
});

router.patch('/bills/:billNumber/pay', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const { roomRent, contractorBillNumber } = req.body;

    const enteredNo = String(contractorBillNumber || '').trim();
    if (!enteredNo) {
      return res.status(400).json({ error: 'Contractor Bill Number is required' });
    }

    const bill = await Bill.findOne({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const contractor = await Contractor.findOne({
      name: bill.contractorName.trim(),
      isdeleted: 0,
      shortId: { $ne: null },
    }).select('shortId name').lean();

    if (!contractor || !Number.isFinite(Number(contractor.shortId))) {
      return res.status(400).json({
        error: 'Contractor short ID not found. Please ensure this contractor has a 3-digit ID.',
      });
    }

    const paymentDate = new Date();
    const composedBillNo = buildContractorBillNo(paymentDate, contractor.shortId, enteredNo);
    
    bill.paymentStatus = 'Yes';
    bill.paymentDate = paymentDate;
    bill.contractorBillNo = composedBillNo;

    if (roomRent !== undefined && roomRent !== null) {
      const rentValue = Number(roomRent);
      if (isNaN(rentValue) || rentValue < 0) {
        return res.status(400).json({ error: 'roomRent must be a non-negative number' });
      }
      bill.roomRent = rentValue;
    } else {
      bill.roomRent = 0;
    }
    
    await bill.save();
    res.json(bill);
  } catch (error) {
    console.error('Error marking bill as paid:', error);
    res.status(500).json({ error: error.message || 'Error marking bill as paid' });
  }
});

/**
 * Edit/add contractorBillNo on a paid bill.
 * If the bill already shares a contractorBillNo with other paid bills for the
 * same contractor, all of those shared bills get the new value too.
 */
router.patch('/bills/:billNumber/contractor-bill-no', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const enteredNo = String(req.body?.contractorBillNumber || '').trim();
    if (!enteredNo) {
      return res.status(400).json({ error: 'Contractor Bill Number is required' });
    }

    const bill = await Bill.findOne({
      billNumber,
      $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }],
    });
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    if (bill.paymentStatus !== 'Yes') {
      return res.status(400).json({ error: 'Only paid bills can have contractor bill number edited' });
    }
    if (!bill.paymentDate) {
      return res.status(400).json({ error: 'Bill has no payment date' });
    }

    const contractor = await Contractor.findOne({
      name: bill.contractorName.trim(),
      isdeleted: 0,
      shortId: { $ne: null },
    }).select('shortId name').lean();

    if (!contractor || !Number.isFinite(Number(contractor.shortId))) {
      return res.status(400).json({
        error: 'Contractor short ID not found. Please ensure this contractor has a 3-digit ID.',
      });
    }

    const oldValue = String(bill.contractorBillNo || '').trim();
    // Keep existing mm_yy_shortId prefix when editing; only the last segment is user-editable.
    // When adding (no existing value / invalid format), generate prefix from payment date + shortId.
    const oldParts = oldValue.split('_');
    const hasLockedPrefix = oldParts.length >= 4;
    const composedBillNo = hasLockedPrefix
      ? `${oldParts.slice(0, 3).join('_')}_${enteredNo}`
      : buildContractorBillNo(bill.paymentDate, contractor.shortId, enteredNo);

    // Default true: update all paid bills sharing the old contractorBillNo.
    // When false, only this bill is updated.
    const updateShared = req.body?.updateShared !== false && req.body?.updateShared !== 'false';

    let updatedCount = 0;
    if (oldValue && updateShared) {
      const result = await Bill.updateMany(
        {
          contractorName: bill.contractorName,
          contractorBillNo: oldValue,
          paymentStatus: 'Yes',
          $or: [{ isDeleted: { $ne: 1 } }, { isDeleted: { $exists: false } }],
        },
        { $set: { contractorBillNo: composedBillNo } },
      );
      updatedCount = result.modifiedCount || 0;
    } else {
      bill.contractorBillNo = composedBillNo;
      await bill.save();
      updatedCount = 1;
    }

    const updatedBill = await Bill.findOne({ billNumber }).lean();
    res.json({
      bill: updatedBill,
      contractorBillNo: composedBillNo,
      updatedCount,
      sharedUpdate: Boolean(oldValue) && updateShared && updatedCount > 1,
    });
  } catch (error) {
    console.error('Error updating contractor bill number:', error);
    res.status(500).json({ error: error.message || 'Error updating contractor bill number' });
  }
});

router.delete('/bills/:billNumber', async (req, res) => {
  // The reversal touches JobopsMaster, Contractor_WD and the bill itself. Run
  // it in one transaction: a partial reversal leaves the bill undeleted, and
  // deleting again would reverse the same work a second time.
  const session = await mongoose.startSession();
  session.startTransaction();
  const abort = async () => { try { await session.abortTransaction(); } catch (_) {} session.endSession(); };

  try {
    const { billNumber } = req.params;
    const bill = await Bill.findOne({
      billNumber,
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ]
    }).session(session);

    if (!bill) {
      await abort();
      return res.status(404).json({ error: 'Bill not found or already deleted' });
    }

    // A paid bill has money against it, so deleting one has to be deliberate.
    // Pass force=true (query or body) to go ahead anyway.
    const forceDelete = req.query?.force === 'true' || req.query?.force === true ||
                        req.body?.force === true || req.body?.force === 'true';
    if (bill.paymentStatus === 'Yes' && !forceDelete) {
      await abort();
      return res.status(400).json({
        error:
          `Bill ${billNumber} is marked PAID. Deleting it reverses the recorded work and ` +
          `restores pending quantities, but does not undo the payment. ` +
          `Re-send with force=true if that is intended.`,
        requiresForce: true
      });
    }

    // Prefer the contractorId stored on the bill. Resolving by name picks an
    // arbitrary contractor when two share a name, and then the reversal writes
    // to the wrong Contractor_WD document while pending is still restored.
    let contractorId = String(bill.contractorId || '').trim();
    if (!contractorId) {
      const contractorName = bill.contractorName.trim();
      const matches = await Contractor.find({
        name: contractorName,
        $or: [ { isdeleted: 0 }, { isdeleted: { $exists: false } } ]
      }).session(session);

      if (matches.length === 0) {
        await abort();
        return res.status(404).json({ error: `Contractor not found for name: ${bill.contractorName}` });
      }
      if (matches.length > 1) {
        await abort();
        return res.status(409).json({
          error:
            `${matches.length} contractors are named "${contractorName}", so this bill cannot be ` +
            `matched to one of them. Give them distinct names before deleting this bill.`,
          contractorIds: matches.map(c => c.contractorId)
        });
      }
      contractorId = matches[0].contractorId;
    }

    // Reverse all work from this bill: restore JobopsMaster pending and reduce Contractor_WD opsDone
    for (const job of bill.jobs) {
      // Ad-hoc reversal path
      if (job.isAdhoc && job.adhocOrderId) {
        const adhocOrder = await AdhocWorkOrder.findById(job.adhocOrderId).session(session);

        if (adhocOrder) {
          for (const op of (job.ops || [])) {
            const qtyCompleted = Number(op.qtyCompleted || 0);
            if (qtyCompleted <= 0) continue;

            const opIdFromBill = String(op.opId || '').trim();
            const opNameFromBill = String(op.opsName || '').trim();
            const opRateFromBill = Number(op.rate || 0);

            let orderOp = null;
            if (opIdFromBill) {
              orderOp = adhocOrder.ops.find(o => String(o.opId) === opIdFromBill);
            }
            if (!orderOp) {
              orderOp = adhocOrder.ops.find(o =>
                String(o.opsName || '').trim() === opNameFromBill &&
                Number(o.rate || 0) === opRateFromBill
              );
            }
            if (!orderOp) continue;

            const totalOpsQty = Number(orderOp.totalOpsQty || 0);
            const restored = Number(orderOp.pendingOpsQty || 0) + qtyCompleted;
            orderOp.pendingOpsQty = Math.min(totalOpsQty, Math.max(0, restored));
            orderOp.lastUpdatedDate = new Date();
          }
          adhocOrder.markModified('ops');
          await adhocOrder.save({ session });
        }

        const adhocContractorWD = await ContractorWD.findOne({
          contractorId: contractorId,
          isAdhoc: true,
          adhocOrderId: String(job.adhocOrderId),
        }).session(session);

        if (adhocContractorWD) {
          for (const op of (job.ops || [])) {
            const qtyCompleted = Number(op.qtyCompleted || 0);
            if (qtyCompleted <= 0) continue;

            const opIdFromBill = String(op.opId || '').trim();
            const opNameFromBill = String(op.opsName || '').trim();
            const opRateFromBill = Number(op.rate || 0);

            // Only billed entries belong to this bill. An entry with
            // savedInBill:'No' is newer work that was saved after the bill and
            // must not be touched by the reversal.
            let wdOp = null;
            if (opIdFromBill) {
              wdOp = adhocContractorWD.opsDone.find(od =>
                isOpsDoneBilled(od) && String(od.opsId) === opIdFromBill
              );
            }
            if (!wdOp) {
              wdOp = adhocContractorWD.opsDone.find(od =>
                isOpsDoneBilled(od) &&
                String(od.opsName || '').trim() === opNameFromBill &&
                Number(od.valuePerBook || 0) === opRateFromBill
              );
            }
            if (!wdOp) continue;

            // Remove only this entry. Whatever quantity is left over belongs to
            // other bills, so it stays billed — flipping it back to 'No' would
            // make it reappear in Work Done as pending work.
            wdOp.opsDoneQty = Math.max(0, Number(wdOp.opsDoneQty || 0) - qtyCompleted);
            if (wdOp.opsDoneQty <= 0) {
              adhocContractorWD.opsDone = adhocContractorWD.opsDone.filter(od => od !== wdOp);
            }
          }
          adhocContractorWD.markModified('opsDone');
          if (adhocContractorWD.opsDone.length > 0) {
            await adhocContractorWD.save({ session });
          } else {
            await ContractorWD.deleteOne({ _id: adhocContractorWD._id }).session(session);
          }
        }
        continue;
      }

      // Sum this bill's quantity per operation first, so a bill that lists the
      // same operation on more than one line is reversed once. The opId stored
      // on the bill is preferred — resolving by name alone picks an arbitrary
      // operation whenever two share a name, and then the wrong row is reversed.
      const billQtyByOp = {};
      for (const op of job.ops) {
        let opIdStr = String(op.opId || '').trim();
        if (!opIdStr) {
          const operation = await Operation.findOne({ opsName: op.opsName.trim() }).session(session);
          opIdStr = operation ? operation._id.toString() : '';
        }
        if (!opIdStr) continue;
        billQtyByOp[opIdStr] = (billQtyByOp[opIdStr] || 0) + Number(op.qtyCompleted || 0);
      }

      // Reverse Contractor_WD first, then read pending off what the reversal
      // actually left behind. Subtracting the bill's quantity from the earlier
      // total assumes the reversal removed all of it, and it often cannot: the
      // row may hold less than the bill claims, carry savedInBill:'No', or sit
      // under a different contractor, and each subtraction floors at 0. Pending
      // then reads lower than the work Contractor_WD still holds, while the save
      // cap measures against Contractor_WD — so Work Done showed pending the
      // entry screen would not let anyone use.
      const contractorWD = await ContractorWD.findOne({
        contractorId: contractorId,
        jobId: job.jobNumber,
        isAdhoc: { $ne: true }
      }).session(session);

      if (contractorWD) {
        for (const opIdStr of Object.keys(billQtyByOp)) {
          // Only billed entries belong to this bill — an entry with
          // savedInBill:'No' is newer work saved after the bill was created.
          const wdOp = contractorWD.opsDone.find(od => isOpsDoneBilled(od) && String(od.opsId) === opIdStr);
          if (!wdOp) continue;
          wdOp.opsDoneQty = Math.max(0, Number(wdOp.opsDoneQty || 0) - billQtyByOp[opIdStr]);
          // Remove only this entry, and leave any remaining quantity marked
          // as billed: it belongs to another bill, not to pending work.
          if (wdOp.opsDoneQty <= 0) {
            contractorWD.opsDone = contractorWD.opsDone.filter(od => od !== wdOp);
          }
        }
        contractorWD.markModified('opsDone');
        if (contractorWD.opsDone.length > 0) {
          await contractorWD.save({ session });
        } else {
          await ContractorWD.deleteOne({ _id: contractorWD._id }).session(session);
        }
      }

      const jobOpsMaster = await JobOpsMaster.findOne({ jobId: job.jobNumber }).session(session);

      if (jobOpsMaster) {
        // The work still recorded against this job now that the reversal is
        // saved, across every contractor. Same query the pending endpoint and
        // the save cap use, so the three cannot disagree.
        const wdDocsAfterDelete = await ContractorWD.find({
          jobId: job.jobNumber,
          isAdhoc: { $ne: true }
        }).session(session).lean();
        const recordedAfterByOp = {};
        (wdDocsAfterDelete || []).forEach(doc => {
          (doc.opsDone || []).forEach(od => {
            if (od.opsId == null) return;
            const opKey = String(od.opsId);
            recordedAfterByOp[opKey] = (recordedAfterByOp[opKey] || 0) + Number(od.opsDoneQty || 0);
          });
        });

        // Pending is recomputed rather than having the quantity added back:
        // adding back drifts whenever pending is already wrong, and the previous
        // packaging branch withheld a flat 5% of the job quantity regardless of
        // how far the operation had actually overshot, so a delete left pending
        // short by the difference. Clamping to [0, totalOpsQty] covers the
        // overshoot case on its own, so no packaging branch is needed here.
        for (const opIdStr of Object.keys(billQtyByOp)) {
          const jobOp = jobOpsMaster.ops.find(jop => String(jop.opId) === opIdStr);
          if (!jobOp) continue;
          const totalOpsQty = Number(jobOp.totalOpsQty) || 0;
          const recordedAfter = Math.max(0, recordedAfterByOp[opIdStr] || 0);
          jobOp.pendingOpsQty = Math.min(totalOpsQty, Math.max(0, totalOpsQty - recordedAfter));
          jobOp.lastUpdatedDate = new Date();
        }
        jobOpsMaster.markModified('ops');
        await jobOpsMaster.save({ session });
      }
    }

    // Soft delete the bill
    bill.isDeleted = 1;
    await bill.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({ message: 'Bill deleted successfully' });
  } catch (error) {
    console.error('Error deleting bill:', error);
    await abort();
    res.status(500).json({ error: 'Error deleting bill', details: error.message });
  }
});

// Series routes
// Create a new series (save job numbers)
router.post('/series', async (req, res) => {
  try {
    const { jobNumbers } = req.body;

    if (!jobNumbers || !Array.isArray(jobNumbers) || jobNumbers.length === 0) {
      return res.status(400).json({ error: 'Job numbers array is required and must not be empty' });
    }

    // Validate that all job numbers are strings
    const validJobNumbers = jobNumbers.filter(jn => typeof jn === 'string' && jn.trim() !== '').sort();
    
    if (validJobNumbers.length === 0) {
      return res.status(400).json({ error: 'At least one valid job number is required' });
    }

    // Check if a series with the exact same job numbers already exists
    // First, find series with the same count (optimization)
    const sortedValidJobNumbers = [...validJobNumbers].sort();
    const existingSeries = await Series.find({
      $expr: { $eq: [{ $size: "$jobNumbers" }, validJobNumbers.length] }
    });
    
    // Verify exact match (order-independent) by comparing sorted arrays
    for (const series of existingSeries) {
      const existingJobNumbers = [...series.jobNumbers].sort();
      
      if (existingJobNumbers.length === sortedValidJobNumbers.length &&
          existingJobNumbers.every((val, idx) => val === sortedValidJobNumbers[idx])) {
        // Series with same job numbers already exists
        return res.status(200).json({
          message: 'Series already exists',
          series: {
            _id: series._id,
            jobNumbers: series.jobNumbers,
            savedAt: series.savedAt
          }
        });
      }
    }

    // Create new series entry only if it doesn't exist
    const series = new Series({
      jobNumbers: validJobNumbers
    });

    await series.save();

    res.status(201).json({
      message: 'Series saved successfully',
      series: {
        _id: series._id,
        jobNumbers: series.jobNumbers,
        savedAt: series.savedAt
      }
    });
  } catch (error) {
    console.error('Error saving series:', error);
    res.status(500).json({ error: 'Error saving series' });
  }
});

// Get all series
router.get('/series', async (req, res) => {
  try {
    const series = await Series.find().sort({ createdAt: -1 });
    res.json(series);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Error fetching series' });
  }
});

// Search series by job number
router.get('/series/search/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    
    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    // Find all series that contain this job number
    const series = await Series.find({
      jobNumbers: jobNumber
    }).sort({ createdAt: -1 });

    // If found, return the first one (most recent) with all its job numbers and ID
    if (series.length > 0) {
      return res.json({
        found: true,
        seriesId: series[0]._id.toString(),
        jobNumbers: series[0].jobNumbers
      });
    }

    // Not found
    res.json({
      found: false,
      seriesId: null,
      jobNumbers: []
    });
  } catch (error) {
    console.error('Error searching series:', error);
    res.status(500).json({ error: 'Error searching series' });
  }
});

// Get a specific series by ID
router.get('/series/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(series);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Error fetching series' });
  }
});

// ============================================
// Job Completion Routes (for Update Job Card and Job Completion UIs)
// ============================================

// Get job color details for update job card app (returns PlanContName list)
router.get('/jobs/color-details/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    // Verify database context before executing query
    const expectedDb = 'IndusEnterprise';
    try {
      const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
      const currentDb = dbCheck.recordset[0]?.currentDb;
      if (currentDb !== expectedDb) {
        console.warn(`⚠️ [MSSQL] Database context mismatch. Switching to ${expectedDb}...`);
        await pool.request().query(`USE [${expectedDb}]`);
      }
    } catch (dbErr) {
      console.error('❌ [MSSQL] Database context verification failed:', dbErr);
      return res.status(500).json({ error: 'Database connection error. Please try again.' });
    }

    const request = pool.request();
    request.input('JobNumber', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Calling usp_GetJobColorDetails_JSON with @JobNumber =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.execute('usp_GetJobColorDetails_JSON');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    console.log('🔍 [MSSQL] Raw result.recordset:', JSON.stringify(result.recordset, null, 2));
    console.log('🔍 [MSSQL] result.recordset.length:', result.recordset.length);

    // The stored procedure returns JSON, so we need to parse it
    let jsonData = null;
    if (result.recordset && result.recordset.length > 0) {
      // The JSON might be in the first column of the first row
      const firstRow = result.recordset[0];
      const firstKey = Object.keys(firstRow)[0];
      const jsonString = firstRow[firstKey];
      
      console.log('🔍 [MSSQL] First row key:', firstKey);
      console.log('🔍 [MSSQL] JSON string type:', typeof jsonString);
      console.log('🔍 [MSSQL] JSON string preview:', jsonString ? jsonString.substring(0, 200) : 'null');
      
      try {
        if (typeof jsonString === 'string') {
          jsonData = JSON.parse(jsonString);
        } else if (typeof jsonString === 'object') {
          // If it's already parsed, use it directly
          jsonData = jsonString;
        } else {
          // Try to parse the entire recordset as JSON
          jsonData = JSON.parse(JSON.stringify(result.recordset[0]));
        }
      } catch (parseErr) {
        console.error('❌ [MSSQL] JSON parse error:', parseErr);
        // If parsing fails, try to use the recordset directly
        jsonData = result.recordset[0];
      }
    }

    console.log('🔍 [BACKEND] Parsed jsonData:', JSON.stringify(jsonData, null, 2));

    if (!jsonData || !jsonData.Contents || !Array.isArray(jsonData.Contents)) {
      console.log('⚠️ [BACKEND] No Contents array found in response');
      return res.json({
        jobNumber: jobNumber,
        planContNames: []
      });
    }

    // Extract all PlanContName values from Contents array
    const planContNames = jsonData.Contents
      .map(content => content.PlanContName)
      .filter(name => name != null && name !== '');

    console.log('🔍 [BACKEND] Extracted planContNames:', planContNames);

    res.json({
      jobNumber: jsonData.JobNumber || jobNumber,
      jobBookingID: jsonData.JobBookingID || null,
      planContNames: planContNames,
      fullData: jsonData // Include full data in case needed later
    });
  } catch (error) {
    console.error('Error fetching job color details:', error);
    res.status(500).json({ error: 'Error fetching job color details: ' + error.message });
  }
});

// Get items from itemmaster for color dropdown
// Save color changes for update job card app
router.post('/jobs/save-color-changes', async (req, res) => {
  console.log('\n🔔 [BACKEND] ========================================');
  console.log('🔔 [BACKEND] POST /jobs/save-color-changes - REQUEST RECEIVED');
  console.log('🔔 [BACKEND] ========================================');
  console.log('🔔 [BACKEND] Timestamp:', new Date().toISOString());
  console.log('🔔 [BACKEND] Request headers:', JSON.stringify(req.headers, null, 2));
  console.log('🔔 [BACKEND] Request body type:', typeof req.body);
  console.log('🔔 [BACKEND] Request body:', req.body);
  console.log('🔔 [BACKEND] Request body keys:', Object.keys(req.body || {}));
  
  try {
    const colorData = req.body;
    
    console.log('🔔 [BACKEND] Parsed colorData:', colorData);

    if (!colorData || !colorData.Contents || !Array.isArray(colorData.Contents) || colorData.Contents.length === 0) {
      console.error('❌ [BACKEND] Invalid color data format');
      console.error('❌ [BACKEND] colorData:', colorData);
      console.error('❌ [BACKEND] Contents:', colorData?.Contents);
      return res.status(400).json({ error: 'Invalid color data format' });
    }

    // Log the received JSON object with clear formatting
    console.log('\n========================================');
    console.log('💾 [BACKEND] SAVE COLOR CHANGES REQUEST');
    console.log('========================================');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Job Number:', colorData.JobNumber);
    console.log('Job Booking ID:', colorData.JobBookingID);
    console.log('\n📋 Full JSON Object:');
    console.log(JSON.stringify(colorData, null, 2));
    console.log('\n📊 Summary:');
    console.log(`  - Contents Count: ${colorData.Contents.length}`);
    colorData.Contents.forEach((content, index) => {
      console.log(`  - Content ${index + 1}: ${content.PlanContName}`);
      console.log(`    - Colors Count: ${content.Colors ? content.Colors.length : 0}`);
      if (content.Colors && content.Colors.length > 0) {
        content.Colors.forEach((color, colorIndex) => {
          console.log(`      ${colorIndex + 1}. ${color.ColorSpecification}: ${color.ItemName} (ItemID: ${color.ItemID})`);
        });
      }
    });
    console.log('========================================\n');

    // Get database connection (default to KOL, can be made configurable)
    const pool = await getPool('KOL');
    
    // Process only the selected/updated content (should be only one in the array)
    if (colorData.Contents.length !== 1) {
      console.warn('⚠️ [BACKEND] Expected exactly one content, but received:', colorData.Contents.length);
    }
    
    const selectedContent = colorData.Contents[0];
    
    // Convert content to JSON string (format matches the procedure's expected input)
    const contentJson = JSON.stringify(selectedContent);
    
    console.log(`\n🔄 [BACKEND] Processing selected content: ${selectedContent.PlanContName}`);
    console.log(`📋 [BACKEND] Content JSON:`, contentJson);
    
    try {
      const request = pool.request();
      
      // Call the stored procedure with the selected content JSON
      const result = await request
        .input('Json', sql.NVarChar(sql.MAX), contentJson)
        .input('CompanyID', sql.Int, 2)
        .input('UserID', sql.Int, 0)
        .execute('dbo.usp_ReplaceJobCardColorDetails_ByContents_JSON');
      
      console.log(`✅ [BACKEND] Stored procedure executed successfully for: ${selectedContent.PlanContName}`);
      
      res.json({ 
        success: true, 
        message: 'Color changes saved successfully',
        content: selectedContent.PlanContName
      });
    } catch (spError) {
      console.error(`❌ [BACKEND] Error executing stored procedure for ${selectedContent.PlanContName}:`, spError);
      console.error(`❌ [BACKEND] Error details:`, spError.message);
      console.error(`❌ [BACKEND] Error stack:`, spError.stack);
      
      res.status(500).json({ 
        success: false,
        error: 'Failed to save color changes: ' + spError.message,
        content: selectedContent.PlanContName
      });
    }
  } catch (error) {
    console.error('\n❌ [ERROR] Error saving color changes:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Error saving color changes: ' + error.message });
  }
});

// Get job details for update job card app (with ClientName, JobName, OrderQuantity, PODate)
router.get('/jobs/details-update/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    // Verify database context before executing query
    const expectedDb = 'IndusEnterprise';
    try {
      const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
      const currentDb = dbCheck.recordset[0]?.currentDb;
      if (currentDb !== expectedDb) {
        console.warn(`⚠️ [MSSQL] Database context mismatch. Switching to ${expectedDb}...`);
        await pool.request().query(`USE [${expectedDb}]`);
      }
    } catch (dbErr) {
      console.error('❌ [MSSQL] Database context verification failed:', dbErr);
      return res.status(500).json({ error: 'Database connection error. Please try again.' });
    }

    const request = pool.request();
    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Calling find_similar_jobs_batch_get_job_details_1hr with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.execute('find_similar_jobs_batch_get_job_details_1hr');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);
    console.log(`📊 [MSSQL] Returned ${result.recordset.length} job(s)`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Map all jobs from the batch result
    const jobs = result.recordset.map(job => {
      // Format JobCreatedOn to show only date (no time)
      let jobCreatedOnFormatted = null;
      if (job.JobCreatedOn) {
        const createdDate = new Date(job.JobCreatedOn);
        if (!isNaN(createdDate.getTime())) {
          // Format as YYYY-MM-DD
          const year = createdDate.getFullYear();
          const month = String(createdDate.getMonth() + 1).padStart(2, '0');
          const day = String(createdDate.getDate()).padStart(2, '0');
          jobCreatedOnFormatted = `${year}-${month}-${day}`;
        }
      }

      return {
        clientName: job.ClientName || '',
        jobNumber: job.JobBookingNo || '',
        jobTitle: job.JobTitle || '',
        orderQuantity: job.OrderQty || 0,
        productCategory: job.ProductCategory || '',
        unitPrice: job.UnitPrice || 0,
        jobCreatedOn: jobCreatedOnFormatted || 'N/A'
      };
    });

    res.json({
      jobs: jobs,
      count: jobs.length
    });
  } catch (error) {
    console.error('Error fetching job details for update:', error);
    res.status(500).json({ error: 'Error fetching job details: ' + error.message });
  }
});

// Get job details for completion app (with isclose and jobcloseddate)
// Uses direct SQL query instead of stored procedure
router.get('/jobs/details-completion/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req);

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    
    // Direct SQL query for job completion app
    const query = `
      SELECT ClientName, JobName, OrderQuantity, isclose, jobcloseddate 
      FROM jobbookingjobcard 
      WHERE jobbookingno = @JobBookingNo
    `;
    
    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Executing direct query for job completion with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(query);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Query executed in ${queryTime}ms`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobDetails = result.recordset[0];

    res.json({
      clientName: jobDetails.ClientName || jobDetails.clientName || '',
      qty: jobDetails.OrderQuantity || jobDetails.orderQuantity || 0,
      isclose: jobDetails.isclose !== undefined ? jobDetails.isclose : 0,
      jobcloseddate: jobDetails.jobcloseddate || null
    });
  } catch (error) {
    console.error('Error fetching job details for completion:', error);
    res.status(500).json({ error: 'Error fetching job details: ' + error.message });
  }
});

// Search job numbers for completion app (uses same stored procedure as Contractor PO System)
router.get('/jobs/search-numbers-completion/:jobNumberPart', async (req, res) => {
  try {
    const { jobNumberPart } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req);
    console.log('🔍 [BACKEND] /jobs/search-numbers-completion called with jobNumberPart:', jobNumberPart);

    if (!jobNumberPart || jobNumberPart.length < 4) {
      return res.status(400).json({ error: 'Job number part must be at least 4 characters' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    request.input('JobNumberPart', sql.NVarChar(255), String(jobNumberPart));

    console.log('🔍 [MSSQL] Calling dbo.contractor_search_jobnumbers with @JobNumberPart =', jobNumberPart);

    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_search_jobnumbers');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    console.log('🔍 [MSSQL] Raw result.recordset:', JSON.stringify(result.recordset, null, 2));
    console.log('🔍 [MSSQL] result.recordset.length:', result.recordset.length);

    const jobNumbers = result.recordset.map((row, index) => {
      console.log(`🔍 [MSSQL] Row ${index}:`, JSON.stringify(row, null, 2));
      const jobNum = row.JobNumber || row.Job_Number || row.jobNumber || row.job_number || 
             row.JobNo || row.Job_NO || Object.values(row)[0];
      console.log(`🔍 [MSSQL] Row ${index} extracted jobNumber:`, jobNum);
      return jobNum;
    }).filter(Boolean);

    console.log('🔍 [BACKEND] Final jobNumbers array:', jobNumbers);
    res.json(jobNumbers);
  } catch (error) {
    console.error('❌ [BACKEND] Error searching job numbers for completion:', error);
    console.error('❌ [BACKEND] Error stack:', error.stack);
    res.status(500).json({ error: 'Error searching job numbers: ' + error.message });
  }
});

// Complete job - close job in jobbookingjobcard table
router.post('/jobs/complete/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    const selectedDatabase = getCompletionSelectedDatabase(req, { allowBody: true });

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    if (!selectedDatabase) {
      return res.status(400).json({ error: 'Invalid or missing database (must be KOL or AHM)' });
    }

    const connectionStartTime = Date.now();
    const pool = await getPool(selectedDatabase);
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();

    // Execute UPDATE statement to close the job
    const updateQuery = `
      UPDATE jobbookingjobcard 
      SET isclose = 1, 
          jobclosedby = 2, 
          jobcloseddate = GETDATE(), 
          jobcloseremark = 'Closed - Manu' 
      WHERE jobbookingno = @JobBookingNo
    `;

    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('✅ [MSSQL] Executing job completion update for:', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(updateQuery);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Update executed in ${queryTime}ms`);
    console.log(`✅ [MSSQL] Rows affected: ${result.rowsAffected[0]}`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Job not found or already closed' });
    }

    res.json({
      success: true,
      message: 'Job completed successfully',
      jobNumber: jobNumber,
      rowsAffected: result.rowsAffected[0]
    });
  } catch (error) {
    console.error('Error completing job:', error);
    res.status(500).json({ error: 'Error completing job: ' + error.message });
  }
});

// ============================================
// Voice Notes Routes (Legacy - for text notes)
// ============================================

// Create a new voice note
router.post('/voice-notes', async (req, res) => {
	try {
		const { jobNumber, toDepartment, voiceNote, audioBlob, audioMimeType, createdBy } = req.body;

		if (!jobNumber || !toDepartment || !createdBy) {
			return res.status(400).json({ error: 'Missing required fields (jobNumber, toDepartment, createdBy)' });
		}

		const VoiceNote = await getVoiceNoteModel();
		const newVoiceNote = new VoiceNote({
			jobNumber,
			toDepartment,
			voiceNote: voiceNote || '',
			audioBlob: audioBlob ? Buffer.from(audioBlob, 'base64') : undefined,
			audioMimeType,
			createdBy
		});

		await newVoiceNote.save();
		res.status(201).json(newVoiceNote);
	} catch (error) {
		console.error('Error creating voice note:', error);
		res.status(500).json({ error: 'Error creating voice note' });
	}
});

// Get all voice notes
router.get('/voice-notes', async (req, res) => {
	try {
		const VoiceNote = await getVoiceNoteModel();
		const voiceNotes = await VoiceNote.find().sort({ createdAt: -1 });
		res.json(voiceNotes);
	} catch (error) {
		console.error('Error fetching voice notes:', error);
		res.status(500).json({ error: 'Error fetching voice notes' });
	}
});

// Get voice notes by job number
router.get('/voice-notes/job/:jobNumber', async (req, res) => {
	try {
		const { jobNumber } = req.params;
		const VoiceNote = await getVoiceNoteModel();
		const voiceNotes = await VoiceNote.find({ jobNumber }).sort({ createdAt: -1 });
		res.json(voiceNotes);
	} catch (error) {
		console.error('Error fetching voice notes by job number:', error);
		res.status(500).json({ error: 'Error fetching voice notes' });
	}
});

// Get voice notes by department
router.get('/voice-notes/department/:department', async (req, res) => {
	try {
		const { department } = req.params;
		const VoiceNote = await getVoiceNoteModel();
		const voiceNotes = await VoiceNote.find({ toDepartment: department }).sort({ createdAt: -1 });
		res.json(voiceNotes);
	} catch (error) {
		console.error('Error fetching voice notes by department:', error);
		res.status(500).json({ error: 'Error fetching voice notes' });
	}
});

// ============================================
// Voice Note Tool API (Separate API for audio collection)
// ============================================

// Save audio to audio collection
router.post('/voice-note-tool/audio', async (req, res) => {
	try {
		const { jobNumber, toDepartment, audioBlob, audioMimeType, createdBy, summary, userId, audioId } = req.body;

		if (!jobNumber || !toDepartment || !audioBlob || !audioMimeType || !createdBy) {
			return res.status(400).json({ error: 'Missing required fields (jobNumber, toDepartment, audioBlob, audioMimeType, createdBy)' });
		}

		const Audio = await getAudioModel();

		// Find existing document for this user and job number (using userId if provided, otherwise username)
		let audioDoc = null;
		if (userId) {
			audioDoc = await Audio.findOne({ jobNumber, userId });
		} else {
			// Fallback to username for backward compatibility
			audioDoc = await Audio.findOne({ jobNumber, createdBy: createdBy.toLowerCase().trim() });
		}

		// Upload audio to Cloudinary
		let cloudinaryUrl = '';
		let cloudinaryPublicId = '';
		
		// With the gate on, audio is served from the Mongo blob below and the
		// Cloudinary copy is skipped entirely. The blob is saved either way, so
		// nothing depends on this succeeding.
		if (isR2Enabled()) {
			console.log('🎵 [AUDIO] USE_R2 on — serving audio from MongoDB; skipping Cloudinary upload.');
		} else if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
			try {
				console.log('📤 [CLOUDINARY] Starting upload to Cloudinary...');
				
				// Convert base64 to buffer
				const audioBuffer = Buffer.from(audioBlob, 'base64');
				console.log('📤 [CLOUDINARY] Audio buffer size:', audioBuffer.length, 'bytes');
				
				// Determine file format from mime type
				let format = 'mp3';
				if (audioMimeType.includes('webm')) format = 'webm';
				else if (audioMimeType.includes('wav')) format = 'wav';
				else if (audioMimeType.includes('m4a')) format = 'm4a';
				else if (audioMimeType.includes('ogg')) format = 'ogg';
				
				console.log('📤 [CLOUDINARY] Format:', format);
				
				// Create unique public_id with job number and timestamp
				const sanitizedJobNumber = jobNumber.replace(/[^a-zA-Z0-9]/g, '-');
				const timestamp = Date.now();
				const publicId = `voice-notes/job-${sanitizedJobNumber}-${timestamp}`;
				
				console.log('📤 [CLOUDINARY] Public ID:', publicId);
				
				// Upload to Cloudinary using upload_stream
				const uploadResult = await new Promise((resolve, reject) => {
					const uploadStream = cloudinary.uploader.upload_stream(
						{
							resource_type: 'video', // Cloudinary treats audio as video
							folder: 'voice-notes',
							public_id: publicId,
							format: format,
						},
						(error, result) => {
							if (error) {
								console.error('❌ [CLOUDINARY] Upload error:', error);
								reject(error);
							} else {
								console.log('✅ [CLOUDINARY] Upload result:', result);
								resolve(result);
							}
						}
					);
					
					uploadStream.end(audioBuffer);
				});

				cloudinaryUrl = uploadResult.secure_url;
				cloudinaryPublicId = uploadResult.public_id;
				console.log('✅ [CLOUDINARY] Audio uploaded successfully. URL:', cloudinaryUrl);
			} catch (cloudinaryError) {
				console.error('⚠️ [CLOUDINARY] Error uploading to Cloudinary:', cloudinaryError);
				console.error('⚠️ [CLOUDINARY] Error details:', cloudinaryError.message);
				// Continue without Cloudinary URL if upload fails (audio blob will still be saved)
			}
		} else {
			console.warn('⚠️ [CLOUDINARY] Cloudinary credentials not configured. Skipping upload.');
		}

		// Generate audioId if not provided (for backward compatibility)
		const finalAudioId = audioId || `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		console.log('🎵 [BACKEND] Using audioId:', finalAudioId, '(provided:', !!audioId, ')');
		
		const newRecording = {
			audioId: finalAudioId,
			audioBlob: Buffer.from(audioBlob, 'base64'),
			audioMimeType,
			cloudinaryUrl,
			cloudinaryPublicId,
			toDepartment,
			summary: summary || '',
			createdAt: new Date()
		};

		if (audioDoc) {
			// Add recording to existing document
			// Update userId if it's missing and we have userId
			if (userId && !audioDoc.userId) {
				audioDoc.userId = userId;
			}
			// Normalize username if different
			if (audioDoc.createdBy.toLowerCase() !== createdBy.toLowerCase().trim()) {
				audioDoc.createdBy = createdBy.toLowerCase().trim();
			}
			audioDoc.recordings.push(newRecording);
			await audioDoc.save();
		} else {
			// Create new document
			const newDocData = {
				jobNumber,
				createdBy: createdBy.toLowerCase().trim(), // Store username in lowercase for consistency
				recordings: [newRecording]
			};
			// Only add userId if provided
			if (userId) {
				newDocData.userId = userId;
			}
			audioDoc = new Audio(newDocData);
			await audioDoc.save();
		}

		// Return the last recording info
		const lastRecording = audioDoc.recordings[audioDoc.recordings.length - 1];
		res.status(201).json({
			_id: lastRecording._id,
			jobNumber: audioDoc.jobNumber,
			toDepartment: lastRecording.toDepartment,
			audioMimeType: lastRecording.audioMimeType,
			cloudinaryUrl: lastRecording.cloudinaryUrl || '',
			audioUrl: resolveAudioUrl(lastRecording),
			createdBy: audioDoc.createdBy,
			createdAt: lastRecording.createdAt
		});
	} catch (error) {
		console.error('Error saving audio:', error);
		res.status(500).json({ error: 'Error saving audio: ' + error.message });
	}
});

// Get all audio files for a job number
router.get('/voice-note-tool/audio/job/:jobNumber', async (req, res) => {
	try {
		const { jobNumber } = req.params;
		const { userId, username } = req.query; // userId is primary, username is fallback
		
		const Audio = await getAudioModel();
		let audioDoc = null;

		// 1) First priority: search by userId (most reliable)
		if (userId) {
			audioDoc = await Audio.findOne({ jobNumber, userId })
				.select('jobNumber createdBy userId recordings')
				.lean();

			// 2) If no document found for this userId, fallback to username with case-insensitive match
			if ((!audioDoc || !audioDoc.recordings || audioDoc.recordings.length === 0)) {
				// Determine username to use for fallback
				let fallbackUsername = username;

				// If username wasn't provided in query, try to resolve it from VoiceNoteUser using userId
				if (!fallbackUsername) {
					try {
						const VoiceNoteUser = await getVoiceNoteUserModel();
						const userDoc = await VoiceNoteUser.findById(userId).select('username').lean();
						if (userDoc && userDoc.username) {
							fallbackUsername = userDoc.username;
						}
					} catch (resolveErr) {
						console.error('Error resolving username from userId for audio lookup:', resolveErr);
					}
				}

				if (fallbackUsername) {
					const safeUsername = fallbackUsername.trim();
					audioDoc = await Audio.findOne({
						jobNumber,
						createdBy: {
							$regex: new RegExp(
								`^${safeUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
								'i'
							)
						}
					})
						.select('jobNumber createdBy userId recordings')
						.lean();
				}
			}
		} else if (username) {
			// 3) No userId, but username given – use case-insensitive match on createdBy
			const safeUsername = username.trim();
			audioDoc = await Audio.findOne({
				jobNumber,
				createdBy: {
					$regex: new RegExp(
						`^${safeUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
						'i'
					)
				}
			})
				.select('jobNumber createdBy userId recordings')
				.lean();
		} else {
			// 4) Neither userId nor username provided – no user-specific filter
			audioDoc = await Audio.findOne({ jobNumber })
				.select('jobNumber createdBy userId recordings')
				.lean();
		}

		if (!audioDoc || !audioDoc.recordings || audioDoc.recordings.length === 0) {
			return res.json([]);
		}

		// Transform recordings into individual audio file objects
		const audioFiles = audioDoc.recordings
			.map(recording => ({
				_id: recording._id,
				audioId: recording.audioId,
				jobNumber: audioDoc.jobNumber,
				toDepartment: recording.toDepartment,
				audioMimeType: recording.audioMimeType,
				cloudinaryUrl: recording.cloudinaryUrl || '',
				audioUrl: resolveAudioUrl(recording),
				summary: recording.summary || '',
				createdBy: audioDoc.createdBy,
				createdAt: recording.createdAt
			}))
			.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Sort by newest first

		res.json(audioFiles);
	} catch (error) {
		console.error('Error fetching audio files:', error);
		res.status(500).json({ error: 'Error fetching audio files: ' + error.message });
	}
});

// Get all audio files for a job number (all users, with full details including summary)
// Using regex pattern to handle job numbers with slashes (e.g., "J02011/25-26")
router.get(/^\/voice-note-tool\/audio\/job\/(.+)\/all$/, async (req, res) => {
	try {
		// Extract job number from the path (handles slashes, underscores, hyphens like "J02011/25-26_ABC")
		// The regex captures everything between /job/ and /all
		const match = req.path.match(/^\/voice-note-tool\/audio\/job\/(.+)\/all$/);
		let jobNumber = match ? match[1] : null;
		
		if (!jobNumber) {
			return res.status(400).json({ error: 'Job number is required' });
		}
		
		// Decode URL encoding in case job number was encoded (handles %2F for /, %5F for _, etc.)
		jobNumber = decodeURIComponent(jobNumber);
		
		console.log('📋 [API] Fetching all recordings for job number:', jobNumber);
		
		const Audio = await getAudioModel();
		
		// Find all documents for this job number (all users)
		// Include audioBlob in the query to return audio data
		const audioDocs = await Audio.find({ jobNumber })
			.select('jobNumber createdBy recordings')
			.lean();
		
		if (!audioDocs || audioDocs.length === 0) {
			return res.json([]);
		}
		
		// Aggregate all recordings from all documents
		const allRecordings = [];
		audioDocs.forEach(audioDoc => {
			if (audioDoc.recordings && audioDoc.recordings.length > 0) {
				audioDoc.recordings.forEach(recording => {
					// Convert audio buffer to base64 for API response
					const base64Audio = recording.audioBlob ? recording.audioBlob.toString('base64') : '';
					
					allRecordings.push({
						_id: recording._id,
						audioId: recording.audioId,
						jobNumber: audioDoc.jobNumber,
						toDepartment: recording.toDepartment,
						department: recording.toDepartment, // Alias for clarity
						audioMimeType: recording.audioMimeType,
						audioBlob: base64Audio, // Include audio data as base64
						cloudinaryUrl: recording.cloudinaryUrl || '',
				audioUrl: resolveAudioUrl(recording),
						summary: recording.summary || '',
						createdBy: audioDoc.createdBy,
						createdAt: recording.createdAt
					});
				});
			}
		});
		
		// Sort by newest first
		allRecordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
		
		res.json(allRecordings);
	} catch (error) {
		console.error('Error fetching all audio files for job:', error);
		res.status(500).json({ error: 'Error fetching all audio files: ' + error.message });
	}
});

// Get audio files with summaries for multiple job numbers
router.post('/voice-note-tool/audio/jobs/batch', async (req, res) => {
	try {
		const { jobNumbers } = req.body;

		if (!jobNumbers || !Array.isArray(jobNumbers)) {
			return res.status(400).json({ error: 'jobNumbers must be an array' });
		}

		if (jobNumbers.length === 0) {
			return res.json([]);
		}

		// Trim and filter out empty strings
		const validJobNumbers = jobNumbers
			.map(jn => typeof jn === 'string' ? jn.trim() : String(jn).trim())
			.filter(jn => jn.length > 0);

		if (validJobNumbers.length === 0) {
			return res.json([]);
		}

		console.log('📋 [API] Fetching audio files for job numbers:', validJobNumbers);

		const Audio = await getAudioModel();

		// Find all documents matching any of the job numbers using $in operator
		const audioDocs = await Audio.find({
			jobNumber: { $in: validJobNumbers }
		})
			.select('jobNumber createdBy userId recordings')
			.lean();

		if (!audioDocs || audioDocs.length === 0) {
			console.log('ℹ️ [API] No audio files found for the provided job numbers');
			return res.json([]);
		}

		console.log(`✅ [API] Found ${audioDocs.length} audio document(s) for ${validJobNumbers.length} job number(s)`);

		// Aggregate all recordings from all matching documents
		const allRecordings = [];
		audioDocs.forEach(audioDoc => {
			if (audioDoc.recordings && audioDoc.recordings.length > 0) {
				audioDoc.recordings.forEach(recording => {
					allRecordings.push({
						_id: recording._id,
						audioId: recording.audioId,
						jobNumber: audioDoc.jobNumber,
						toDepartment: recording.toDepartment,
						department: recording.toDepartment, // Alias for clarity
						audioMimeType: recording.audioMimeType,
						audioUrl: resolveAudioUrl(recording), // Mongo stream when USE_R2 is on, else Cloudinary
						summary: recording.summary || '',
						createdBy: audioDoc.createdBy,
						userId: audioDoc.userId ? audioDoc.userId.toString() : null,
						createdAt: recording.createdAt
					});
				});
			}
		});

		// Sort by job number, then by creation date (newest first)
		allRecordings.sort((a, b) => {
			// First sort by job number
			if (a.jobNumber !== b.jobNumber) {
				return a.jobNumber.localeCompare(b.jobNumber);
			}
			// Then by creation date (newest first)
			return new Date(b.createdAt) - new Date(a.createdAt);
		});

		console.log(`✅ [API] Returning ${allRecordings.length} recording(s) for ${validJobNumbers.length} job number(s)`);

		res.json({
			count: allRecordings.length,
			jobNumbers: validJobNumbers,
			recordings: allRecordings
		});
	} catch (error) {
		console.error('❌ [API] Error fetching audio files for multiple job numbers:', error);
		res.status(500).json({ error: 'Error fetching audio files: ' + error.message });
	}
});

// Get a specific audio file (with blob)
router.get('/voice-note-tool/audio/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const Audio = await getAudioModel();
		
		// Find document containing the recording with this ID
		const audioDoc = await Audio.findOne({ 'recordings._id': id });

		if (!audioDoc) {
			return res.status(404).json({ error: 'Audio not found' });
		}

		// Find the specific recording
		const recording = audioDoc.recordings.id(id);
		
		if (!recording) {
			return res.status(404).json({ error: 'Audio recording not found' });
		}

		// Convert buffer to base64
		const base64Audio = recording.audioBlob.toString('base64');

		res.json({
			_id: recording._id,
			audioId: recording.audioId,
			jobNumber: audioDoc.jobNumber,
			toDepartment: recording.toDepartment,
			audioBlob: base64Audio,
			audioMimeType: recording.audioMimeType,
			cloudinaryUrl: recording.cloudinaryUrl || '',
				audioUrl: resolveAudioUrl(recording),
			summary: recording.summary || '',
			createdBy: audioDoc.createdBy,
			createdAt: recording.createdAt
		});
	} catch (error) {
		console.error('Error fetching audio file:', error);
		res.status(500).json({ error: 'Error fetching audio file: ' + error.message });
	}
});

// Delete a specific audio recording
router.delete('/voice-note-tool/audio/:recordingId', async (req, res) => {
	try {
		const { recordingId } = req.params;
		const Audio = await getAudioModel();
		
		// Find document containing the recording
		const audioDoc = await Audio.findOne({ 'recordings._id': recordingId });

		if (!audioDoc) {
			return res.status(404).json({ error: 'Audio not found' });
		}

		// Remove the recording from the array
		audioDoc.recordings.pull(recordingId);
		
		// If no recordings left, delete the entire document
		if (audioDoc.recordings.length === 0) {
			await Audio.findByIdAndDelete(audioDoc._id);
		} else {
			await audioDoc.save();
		}

		res.json({ message: 'Audio deleted successfully' });
	} catch (error) {
		console.error('Error deleting audio:', error);
		res.status(500).json({ error: 'Error deleting audio: ' + error.message });
	}
});

// Analyze audio with OpenAI (transcription + summary)
router.post('/voice-note-tool/analyze-audio', async (req, res) => {
	try {
		const { audioBlob, audioMimeType, toDepartment } = req.body;

		if (!audioBlob || !audioMimeType || !toDepartment) {
			return res.status(400).json({ error: 'Missing required fields (audioBlob, audioMimeType, toDepartment)' });
		}

		// Convert base64 to buffer
		const audioBuffer = Buffer.from(audioBlob, 'base64');

		// Determine file extension from mime type
		let extension = 'webm';
		if (audioMimeType.includes('wav')) extension = 'wav';
		else if (audioMimeType.includes('mp3')) extension = 'mp3';
		else if (audioMimeType.includes('m4a')) extension = 'm4a';
		else if (audioMimeType.includes('ogg')) extension = 'ogg';

		// Create a temporary file for OpenAI (Whisper API requires file upload)
		const tempFilePath = path.join(process.cwd(), `temp_audio_${Date.now()}.${extension}`);
		fs.writeFileSync(tempFilePath, audioBuffer);

		try {
			// Step 1: Transcribe audio using gpt-4o-mini-transcribe
			console.log('🎙️ Transcribing audio with gpt-4o-mini-transcribe...');
			const transcription = await openai.audio.transcriptions.create({
				file: fs.createReadStream(tempFilePath),
				model: 'gpt-4o-mini-transcribe'
				// Language auto-detection - model will detect Bengali automatically
			});

			console.log('📝 Transcription:', transcription.text);

			// Step 2: Analyze with GPT-4 for summary and department alignment
			console.log('🤖 Analyzing with GPT-4...');
			const completion = await openai.chat.completions.create({
				model: 'gpt-4',
				messages: [
					{
						role: 'system',
						content: `You are an assistant that analyzes voice notes for a manufacturing company.

Your task:
1. Detect the language of the transcription
2. Summarize the instruction/voice note in bullet points (3-5 points)
3. Extract actionable items from the voice note as bullet points (2-4 actionable tasks)
4. Respond in the SAME language as the transcription, BUT write it using English alphabets (Romanized form)

IMPORTANT: 
- If the transcription is in Bengali, respond in Romanized Bengali (Banglish)
- If the transcription is in Hindi, respond in Romanized Hindi (Hinglish)
- If the transcription is in English, respond in English (no Romanization needed)
- If the transcription is in any other language, respond in Romanized form of that language
- Always match the language of the original transcription

Examples of Romanized forms(strictly follow this format):
Romanized Bengali (Banglish):
- "ami vat khabo" (I will eat rice)
- "ei kaj ta korte hobe" (This work needs to be done)
- "printing quality ta valo hoyni" (The printing quality was not good)

Romanized Hindi (Hinglish):
- "mujhe yeh kaam karna hai" (I need to do this work)
- "machine ko clean karna padega" (The machine needs to be cleaned)
- "quality check karna zaroori hai" (Quality check is necessary)

Department descriptions:
- prepress: Design, layout, color separation, plate making, pre-printing work
- postpress: Cutting, binding, folding, finishing work after printing
- printing: Actual printing process, press operation, ink management

Output format:
Summary:
• [bullet point 1 in Romanized form of detected language]
• [bullet point 2 in Romanized form of detected language]
• [bullet point 3 in Romanized form of detected language]

Actionable Items:
• [actionable task 1 in Romanized form of detected language]
• [actionable task 2 in Romanized form of detected language]
• [actionable task 3 in Romanized form of detected language]`
					},
					{
						role: 'user',
						content: `The transcription of the voice note is: "${transcription.text}"

The selected department is: ${toDepartment}

Please analyze this transcription, detect its language, and provide the summary and actionable items in the Romanized form of the detected language (if the language uses a non-Latin script, write it using English alphabets).`
					}
				],
				temperature: 0.7
			});

			const analysis = completion.choices[0].message.content;
			console.log('✅ Analysis complete:', analysis);

			// Clean up temp file
			fs.unlinkSync(tempFilePath);

			res.json({
				transcription: transcription.text,
				analysis: analysis,
				success: true
			});

		} catch (openaiError) {
			// Clean up temp file even if error occurs
			if (fs.existsSync(tempFilePath)) {
				fs.unlinkSync(tempFilePath);
			}
			throw openaiError;
		}

	} catch (error) {
		console.error('Error analyzing audio:', error);
		res.status(500).json({ error: 'Error analyzing audio: ' + error.message });
	}
});

// ============================================
// Prepress FMS Routes
// ============================================

// Create new prepress FMS entry
router.post('/prepress-fms', async (req, res) => {
	try {
		const {
			type,
			// Shared fields (same names for both packaging and commercial)
			clientName,
			executive,
			category,
			remarks,
			newRevised,
			prepressPerson,
			softcopyRequired,
			hardcopyRequired,
			// Type-specific fields
			itemName, // packaging only
			fileDetails, // commercial only
			createdBy
		} = req.body;

		if (!type || !['packaging', 'commercial'].includes(type)) {
			return res.status(400).json({ error: 'Type is required and must be "packaging" or "commercial"' });
		}

		// Validate shared required fields
		if (!clientName || !clientName.trim()) {
			return res.status(400).json({ error: 'Client name is required' });
		}
		if (!executive || !executive.trim()) {
			return res.status(400).json({ error: 'Executive is required' });
		}
		if (!category || !category.trim()) {
			return res.status(400).json({ error: 'Category is required' });
		}
		if (!newRevised || !['new', 'revised'].includes(newRevised)) {
			return res.status(400).json({ error: 'New/Revised is required and must be "new" or "revised"' });
		}
		if (!prepressPerson || !prepressPerson.trim()) {
			return res.status(400).json({ error: 'Prepress person is required' });
		}

		// Validate type-specific fields
		if (type === 'packaging') {
			if (!itemName || !itemName.trim()) {
				return res.status(400).json({ error: 'Item name is required for packaging type' });
			}
		} else if (type === 'commercial') {
			if (!fileDetails || !fileDetails.trim()) {
				return res.status(400).json({ error: 'File Details is required for commercial type' });
			}
		}

		const PrepressFMS = await getPrepressFMSModel();

		// Build entry data - shared fields use same names
		const entryData = {
			type,
			clientName: clientName?.trim() || '',
			executive: executive?.trim() || '',
			category: category?.trim() || '',
			remarks: remarks?.trim() || '',
			newRevised: newRevised || '',
			prepressPerson: prepressPerson?.trim() || '',
			softcopyRequired: softcopyRequired === true || softcopyRequired === 'true',
			hardcopyRequired: hardcopyRequired === true || hardcopyRequired === 'true',
			createdBy: createdBy?.trim() || 'admin',
		};

		// Add type-specific fields
		if (type === 'packaging') {
			entryData.itemName = itemName?.trim() || '';
		} else if (type === 'commercial') {
			entryData.fileDetails = fileDetails?.trim() || '';
		}

		const prepressEntry = new PrepressFMS(entryData);

		await prepressEntry.save();

		res.status(201).json({
			message: 'Prepress FMS entry created successfully',
			id: prepressEntry._id,
			type: prepressEntry.type,
			createdAt: prepressEntry.createdAt
		});
	} catch (error) {
		console.error('Error creating prepress FMS entry:', error);
		res.status(500).json({ error: 'Error creating prepress FMS entry: ' + error.message });
	}
});

// Get all prepress FMS entries (with optional filters)
router.get('/prepress-fms', async (req, res) => {
	try {
		const { type, clientName, client, prepressPerson, startDate, endDate } = req.query;

		const PrepressFMS = await getPrepressFMSModel();
		const query = {};

		if (type && ['packaging', 'commercial'].includes(type)) {
			query.type = type;
		}

		// Filter by client name (shared field name)
		if (clientName) {
			query.clientName = { $regex: clientName, $options: 'i' };
		}

		if (prepressPerson) {
			query.prepressPerson = { $regex: prepressPerson, $options: 'i' };
		}

		if (startDate || endDate) {
			query.createdAt = {};
			if (startDate) {
				query.createdAt.$gte = new Date(startDate);
			}
			if (endDate) {
				query.createdAt.$lte = new Date(endDate);
			}
		}

		const entries = await PrepressFMS.find(query)
			.sort({ createdAt: -1 })
			.limit(1000); // Limit to prevent large responses

		res.json({
			count: entries.length,
			entries
		});
	} catch (error) {
		console.error('Error fetching prepress FMS entries:', error);
		res.status(500).json({ error: 'Error fetching prepress FMS entries: ' + error.message });
	}
});

// Get single prepress FMS entry by ID
router.get('/prepress-fms/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const PrepressFMS = await getPrepressFMSModel();
		const entry = await PrepressFMS.findById(id);

		if (!entry) {
			return res.status(404).json({ error: 'Prepress FMS entry not found' });
		}

		res.json(entry);
	} catch (error) {
		console.error('Error fetching prepress FMS entry:', error);
		res.status(500).json({ error: 'Error fetching prepress FMS entry: ' + error.message });
	}
});

// Update prepress FMS entry
router.put('/prepress-fms/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const updateData = req.body;

		const PrepressFMS = await getPrepressFMSModel();
		const entry = await PrepressFMS.findById(id);

		if (!entry) {
			return res.status(404).json({ error: 'Prepress FMS entry not found' });
		}

		// Update allowed fields (shared fields use same names)
		if (updateData.clientName !== undefined) entry.clientName = updateData.clientName?.trim() || '';
		if (updateData.executive !== undefined) entry.executive = updateData.executive?.trim() || '';
		if (updateData.category !== undefined) entry.category = updateData.category?.trim() || '';
		if (updateData.remarks !== undefined) entry.remarks = updateData.remarks?.trim() || '';
		if (updateData.newRevised !== undefined) entry.newRevised = updateData.newRevised;
		if (updateData.prepressPerson !== undefined) entry.prepressPerson = updateData.prepressPerson?.trim() || '';
		if (updateData.softcopyRequired !== undefined) entry.softcopyRequired = updateData.softcopyRequired === true || updateData.softcopyRequired === 'true';
		if (updateData.hardcopyRequired !== undefined) entry.hardcopyRequired = updateData.hardcopyRequired === true || updateData.hardcopyRequired === 'true';
		
		// Update type-specific fields
		if (updateData.itemName !== undefined) entry.itemName = updateData.itemName?.trim() || '';
		if (updateData.fileDetails !== undefined) entry.fileDetails = updateData.fileDetails?.trim() || '';

		await entry.save();

		res.json({
			message: 'Prepress FMS entry updated successfully',
			entry
		});
	} catch (error) {
		console.error('Error updating prepress FMS entry:', error);
		res.status(500).json({ error: 'Error updating prepress FMS entry: ' + error.message });
	}
});

// Delete prepress FMS entry
router.delete('/prepress-fms/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const PrepressFMS = await getPrepressFMSModel();
		const entry = await PrepressFMS.findByIdAndDelete(id);

		if (!entry) {
			return res.status(404).json({ error: 'Prepress FMS entry not found' });
		}

		res.json({
			message: 'Prepress FMS entry deleted successfully'
		});
	} catch (error) {
		console.error('Error deleting prepress FMS entry:', error);
		res.status(500).json({ error: 'Error deleting prepress FMS entry: ' + error.message });
	}
});

export default router;


