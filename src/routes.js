import { Router } from 'express';
import axios from "axios";
import nodemailer from "nodemailer";
import { getPool, sql, clearPoolCache } from './db.js';
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
import User from './models/User.js';
import Operation from './models/Operation.js';
import Job from './models/Job.js';
import JobOperation from './models/JobOperation.js';


const router = Router();

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

function ensureLogsDir() {
	try {
		if (!fs.existsSync(logsDir)) {
			fs.mkdirSync(logsDir, { recursive: true });
		}
	} catch (e) {
		// Best effort; don't crash the app on logging failure
		console.error('Failed to create logs directory:', e);
	}
}

function logQr(message, extra = {}) {
	try {
		ensureLogsDir();
		const timestamp = new Date().toISOString();
		const entry = {
			ts: timestamp,
			message,
			...extra,
		};
		fs.appendFileSync(qrLogFile, JSON.stringify(entry) + '\n');
	} catch (e) {
		console.error('Failed to write QR log entry:', e);
	}
}

function logProcessStart(message, extra = {}) {
    try {
        ensureLogsDir();
        const timestamp = new Date().toISOString();
        const entry = {
            ts: timestamp,
            message,
            ...extra,
        };
        fs.appendFileSync(processStartLogFile, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error('Failed to write process-start log entry:', e);
    }
}

function logAuth(message, extra = {}) {
    try {
        ensureLogsDir();
        const timestamp = new Date().toISOString();
        const entry = {
            ts: timestamp,
            message,
            ...extra,
        };
        fs.appendFileSync(authLogFile, JSON.stringify(entry) + '\n');
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
  
        const whatsappText =
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
        const emailBody =
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
  
        let sentEmail = false;
        let sentWhatsapp = false;
  
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
              console.error('[WHATSAPP ERROR]', waErr.message);
              throw waErr;
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
            throw emailErr;
          }
        }
  
        if (sentEmail || sentWhatsapp) {
          const tvpClient = new sql.Table("dbo.IdList");
          tvpClient.columns.add("Id", sql.Int, { nullable: false });
          clientRows.forEach(r => tvpClient.rows.add(r.OrderBookingDetailsID));
  
          const markReq = pool.request();
          markReq.input("OrderBookingDetailsIds", tvpClient);
          markReq.input("SentEmail", sql.Bit, sentEmail ? 1 : 0);
          markReq.input("SentWhatsapp", sql.Bit, sentWhatsapp ? 1 : 0);
          markReq.input("SentByUser", sql.NVarChar(100), username);
          await markReq.execute("dbo.comm_mark_first_intimation_sent");
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
            mailSent: sentEmail ? 'Yes' : 'No',
            whatsappSent: sentWhatsapp ? 'Yes' : 'No'
          });
        });
      }
  
      res.json({ ok: true, results });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
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

      const whatsappMessage =
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
      const emailBody =
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

// Logout endpoint to clear session/cookies AND database pool cache
router.post('/auth/logout', async (req, res) => {
	try {
		logAuth('Logout request received', { route: '/auth/logout', ip: req.ip });
		
		// CRITICAL: Clear database pool cache to prevent wrong DB reuse
		clearPoolCache();
		console.log('[AUTH] Database pool cache cleared on logout');
		
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
        logProcessStart('Start process called', { route: '/processes/start', ip: req.ip, body: req.body });

        const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, database } = req.body || {};

        const userIdNum = Number(UserID);
        const employeeIdNum = Number(EmployeeID);
        const processIdNum = Number(ProcessID);
        const jobBookingIdNum = Number(JobBookingJobCardContentsID);
        const machineIdNum = Number(MachineID);
        const jobCardFormNoStr = (JobCardFormNo || '').toString().trim();
        const selectedDatabase = database || 'KOL'; // Default to KOL

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

        // Log normalized parameters after basic coercion
        logProcessStart('Normalized start params', {
            route: '/processes/start',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        const pool = await getPool(selectedDatabase);
        
        // Log query execution details
        logProcessStart('Executing Production_Start_Manu_v2 stored procedure', {
            route: '/processes/start',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Start_Manu_v2',
            parameters: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        console.log(`\n${'='.repeat(80)}`);
        console.log(`[SYNC START] CALLING START PROCEDURE`);
        console.log(`Procedure: dbo.Production_Start_Manu_v2`);
        console.log(`Parameters:`);
        console.log(`  - UserID: ${userIdNum} (${typeof userIdNum})`);
        console.log(`  - EmployeeID: ${employeeIdNum} (${typeof employeeIdNum})`);
        console.log(`  - ProcessID: ${processIdNum} (${typeof processIdNum})`);
        console.log(`  - JobBookingJobCardContentsID: ${jobBookingIdNum} (${typeof jobBookingIdNum})`);
        console.log(`  - MachineID: ${machineIdNum} (${typeof machineIdNum})`);
        console.log(`  - JobCardFormNo: ${jobCardFormNoStr} (${typeof jobCardFormNoStr})`);
        console.log(`Database: ${selectedDatabase}`);
        console.log(`${'='.repeat(80)}\n`);

        const request = pool.request();
        request.timeout = 180000; // Set timeout to 3 minutes (180 seconds) for start operations
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('EmployeeID', sql.Int, employeeIdNum)
            .input('ProcessID', sql.Int, processIdNum)
            .input('JobBookingJobCardContentsID', sql.Int, jobBookingIdNum)
            .input('MachineID', sql.Int, machineIdNum)
            .input('JobCardFormNo', sql.NVarChar(255), jobCardFormNoStr)
            .execute('dbo.Production_Start_Manu_v2');

        // Extract ProductionID from result
        let productionId = null;
        if (result.recordset && result.recordset.length > 0 && result.recordset[0].ProductionID) {
            productionId = result.recordset[0].ProductionID;
            console.log(`[SYNC START] ✅ ProductionID returned: ${productionId}`);
        }

        // Log detailed query results
        logProcessStart('Start process query completed', {
            route: '/processes/start',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Start_Manu_v2',
            productionId: productionId,
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in start process', {
                route: '/processes/start',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_Start_Manu_v2'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                productionId: productionId,
                statusWarning: statusWarning
            });
        }
        
        return res.json({ 
            status: true, 
            result: result.recordset || [],
            productionId: productionId
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
        logProcessStart('Complete process called', { route: '/processes/complete', ip: req.ip, body: req.body });

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

        logProcessStart('Normalized complete params', {
            route: '/processes/complete',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                ProductionID: productionIdNum,
                ProductionQty: productionQtyNum,
                WastageQty: wastageQtyNum
            }
        });

        const pool = await getPool(selectedDatabase);

        // Diagnostics: verify actual DB context and SP existence
        try {
            const dbInfo = await pool.request().query("SELECT DB_NAME() AS currentDb");
            const currentDb = dbInfo?.recordset?.[0]?.currentDb || null;
            const spCheck = await pool.request().query("SELECT OBJECT_ID('dbo.Production_End_Manu_v2') AS spId");
            const spId = spCheck?.recordset?.[0]?.spId || null;
            logProcessStart('Diagnostics - DB and SP availability (complete)', { selectedDatabase, currentDb, productionEndManuExists: !!spId, spId });
        } catch (diagErr) {
            logProcessStart('Diagnostics failed (complete)', { selectedDatabase, error: String(diagErr) });
        }
        
        // Log query execution details
        logProcessStart('Executing Production_End_Manu_v2 stored procedure', {
            route: '/processes/complete',
            ip: req.ip,
            storedProcedure: 'dbo.Production_End_Manu_v2',
            parameters: {
                UserID: userIdNum,
                ProductionID: productionIdNum,
                ProductionQty: productionQtyNum,
                WastageQty: wastageQtyNum
            }
        });

        console.log(`\n${'='.repeat(80)}`);
        console.log(`[SYNC COMPLETE] CALLING COMPLETE PROCEDURE`);
        console.log(`Procedure: dbo.Production_End_Manu_v2`);
        console.log(`Parameters:`);
        console.log(`  - UserID: ${userIdNum} (${typeof userIdNum})`);
        console.log(`  - ProductionID: ${productionIdNum} (${typeof productionIdNum})`);
        console.log(`  - ProductionQty: ${productionQtyNum} (${typeof productionQtyNum})`);
        console.log(`  - WastageQty: ${wastageQtyNum} (${typeof wastageQtyNum})`);
        console.log(`Database: ${selectedDatabase}`);
        console.log(`${'='.repeat(80)}\n`);

        const request = pool.request();
        request.timeout = 180000; // Set timeout to 3 minutes (180 seconds) for complete operations
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('ProductionID', sql.Int, productionIdNum)
            .input('ProductionQty', sql.Int, productionQtyNum)
            .input('WastageQty', sql.Int, wastageQtyNum)
            .execute('dbo.Production_End_Manu_v2');
        
        console.log(`[SYNC COMPLETE] ✅ Complete operation finished successfully`);

        // Log detailed query results
        logProcessStart('Complete process query completed', {
            route: '/processes/complete',
            ip: req.ip,
            storedProcedure: 'dbo.Production_End_Manu_v2',
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in complete process', {
                route: '/processes/complete',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_End_Manu_v2'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                statusWarning: statusWarning
            });
        }
        
        return res.json({ status: true, result: result.recordset || [] });
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
        logProcessStart('Cancel process called', { route: '/processes/cancel', ip: req.ip, body: req.body });

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

        logProcessStart('Normalized cancel params', {
            route: '/processes/cancel',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                ProductionID: productionIdNum
            }
        });

        const pool = await getPool(selectedDatabase);
        
        // Log query execution details
        logProcessStart('Executing Production_Cancel_Manu_v2 stored procedure', {
            route: '/processes/cancel',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Cancel_Manu_v2',
            parameters: {
                UserID: userIdNum,
                ProductionID: productionIdNum
            }
        });

        console.log(`\n${'='.repeat(80)}`);
        console.log(`[SYNC CANCEL] CALLING CANCEL PROCEDURE`);
        console.log(`Procedure: dbo.Production_Cancel_Manu_v2`);
        console.log(`Parameters:`);
        console.log(`  - UserID: ${userIdNum} (${typeof userIdNum})`);
        console.log(`  - ProductionID: ${productionIdNum} (${typeof productionIdNum})`);
        console.log(`Database: ${selectedDatabase}`);
        console.log(`${'='.repeat(80)}\n`);

        const request = pool.request();
        request.timeout = 180000; // Set timeout to 3 minutes (180 seconds) for cancel operations
        const result = await request
            .input('UserID', sql.Int, userIdNum)
            .input('ProductionID', sql.Int, productionIdNum)
            .execute('dbo.Production_Cancel_Manu_v2');
        
        console.log(`[SYNC CANCEL] ✅ Cancel operation finished successfully`);

        // Log detailed query results
        logProcessStart('Cancel process query completed', {
            route: '/processes/cancel',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Cancel_Manu_v2',
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in cancel process', {
                route: '/processes/cancel',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_Cancel_Manu_v2'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                statusWarning: statusWarning
            });
        }
        
        return res.json({ status: true, result: result.recordset || [] });
    } catch (err) {
        console.error('Cancel process error:', err);
        logProcessStart('Cancel process failed', { route: '/processes/cancel', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
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
            cartonCount: first.CartonCt || first.cartonct || null
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
            cartonCount: first.CartonCt || first.cartonct || null
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
            return res.json({
                status: false,
                error: `No floor screen data returned for MachineID ${machineIdNum}`
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
        
        console.log('[QC-SAVE] Inspection saved successfully');
        
        return res.json({
            status: true,
            message: 'Inspection saved successfully',
            result: result.recordset || []
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

// ============================================
// WhatsApp Messaging Routes
// ============================================

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

            const whatsappText = `Dear ${contactName},

Warm greetings from CDC Printers Pvt Ltd 😊

We regret to inform you that due to unforeseen circumstances, we will not be able to deliver the below jobs within the committed timeframe. Please find the updated committed delivery dates below:

  ${orderLines}

—
${senderName}
Customer Relationship Manager
CDC Printers Pvt Ltd
${senderPhone}`;

            const emailSubject = `Updated Delivery Schedule | ${clientName}`;
            const emailBody = `Dear ${contactName},

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

export default router;
