import { Router } from 'express';
import { getPool, sql } from './db.js';
import { MongoClient, ObjectId } from 'mongodb';

// Update API for combined pending grid
// Exposed as: POST /api/artwork/pending/update
//
// ENV USED (matches existing backend .env):
//   DB_SERVER             - MSSQL server host (for both KOL and AHM)
//   DB_PORT               - MSSQL port (optional)
//   DB_NAME_KOL           - Kolkata DB name
//   DB_NAME_AHM           - Ahmedabad DB name
//   DB_USER               - MSSQL user
//   DB_PASSWORD           - MSSQL password
//
//   MONGODB_URI_Approval  - Mongo URI for artwork portal DB
//   MONGO_DB              - Mongo DB name (default: artwork_portal)

const router = Router();

// ---------- Mongo config ----------
// Prefer the dedicated approval URI, fall back to generic ones if present
const MONGO_URI =
  process.env.MONGODB_URI_Approval ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  '';
const MONGO_DB = process.env.MONGO_DB || 'artwork_portal';

let mongoClientPromise = null;

async function getMongoDb() {
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI_Approval (or MONGO_URI) is not configured');
  }
  if (!mongoClientPromise) {
    mongoClientPromise = MongoClient.connect(MONGO_URI, {
      maxPoolSize: 10,
    });
  }
  const client = await mongoClientPromise;
  return client.db(MONGO_DB);
}

// ---------- constants ----------
const APPROVAL_STATUSES = new Set(['Pending', 'Sent', 'Approved', 'Rejected', 'Redo']);
const FILE_STATUSES = new Set(['Pending', 'Received', 'Old']);

// ---------- helpers ----------
function normStr(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return String(v);
}

function normFileStatus(v) {
  const s = normStr(v);
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (t === 'received') return 'Received';
  if (t === 'old') return 'Old';
  return 'Pending';
}

function normApprovalStatus(v) {
  const s = normStr(v);
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return APPROVAL_STATUSES.has(cap) ? cap : 'Pending';
}

function normYesNo(v) {
  const s = normStr(v);
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (t === 'yes' || t === 'y' || t === '1' || t === 'true') return 'Yes';
  if (t === 'no' || t === 'n' || t === '0' || t === 'false') return 'No';
  return undefined;
}

function toDateOrNull(v) {
  if (v === undefined) return undefined; // means "no change"
  if (v === null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 24 * 3600 * 1000);
}

// Reads mapping from Mongo `user` collection.
// For MSSQL update: userKey => erp.<site>.ledgerId (number)
// Helper: Look up user by displayName and return userKey (_id) for MongoDB
async function displayNameToUserKey(db, displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  
  const user = await db
    .collection('user')
    .findOne(
      { active: true, displayName: { $regex: new RegExp(`^${displayName.trim()}$`, 'i') } },
      { projection: { _id: 1 } }
    );
  
  return user ? String(user._id).toLowerCase() : null;
}

// Helper: Look up user by displayName and return ledgerId from erp object for SQL
async function displayNameToLedgerId(db, site, displayName) {
  if (!displayName || typeof displayName !== 'string') return null;

  console.log('displayNameToLedgerId####################################################', displayName, site);
  
  const siteUpper = String(site).toUpperCase(); // KOLKATA or AHMEDABAD
  const erpPath = `erp.${siteUpper}.ledgerId`;
  
  const user = await db
    .collection('user')
    .findOne(
      { active: true, displayName: { $regex: new RegExp(`^${displayName.trim()}$`, 'i') } },
      { projection: { _id: 1, erp: 1 } }
    );
  
  if (!user || !user.erp) return null;
  
  const ledgerId = user.erp?.[siteUpper]?.ledgerId;
  return ledgerId != null ? Number(ledgerId) : null;
}

async function userKeyToLedgerId(db, site, userKey) {
  if (!userKey) return null;
  const key = String(userKey).toLowerCase();
  const path = `erp.${site}.ledgerId`;
  const u = await db.collection('user').findOne(
    { _id: key, active: true },
    { projection: { _id: 1, erp: 1 } }
  );
  const lid = u?.erp?.[site]?.ledgerId;
  if (lid === null || lid === undefined) return null;
  const n = Number(lid);
  return Number.isFinite(n) ? n : null;
}

// ---------- derive rules (server-side equivalent of your grid rules) ----------
function applyRules(current, incoming) {
  // current: existing row state (from DB)
  // incoming: update payload (may include only allowed fields)
  // returns: merged object with derived fields updated

  const now = new Date();
  const row = { ...current, ...incoming };

  // 1) FileStatus -> FileReceivedDate
  const fileStatus = normFileStatus(row.FileStatus ?? row.FileName); // SQL alias safety
  if (fileStatus) row.FileStatus = fileStatus;

  if (row.FileStatus === 'Received' || row.FileStatus === 'Old') {
    if (!row.FileReceivedDate) row.FileReceivedDate = now;
  } else if (row.FileStatus === 'Pending') {
    row.FileReceivedDate = null;
  }

  // 2) FileReceivedDate drives plan dates
  const frd = row.FileReceivedDate ? new Date(row.FileReceivedDate) : null;
  if (frd && !isNaN(frd.getTime())) {
    if (row.SoftApprovalReqd === 'Yes' && !row.SoftApprovalSentPlanDate)
      row.SoftApprovalSentPlanDate = addDays(frd, 2);
    if (row.HardApprovalReqd === 'Yes' && !row.HardApprovalSentPlanDate)
      row.HardApprovalSentPlanDate = addDays(frd, 4);
    if (row.MProofApprovalReqd === 'Yes' && !row.MProofApprovalSentPlanDate)
      row.MProofApprovalSentPlanDate = addDays(frd, 4);
  }

  // 3) Approval status logic
  // IMPORTANT: If required field is blank/null/undefined, keep status as blank/null
  // Only auto-set status when required is explicitly "Yes" or "No"
  // Only apply rules if SoftApprovalReqd is explicitly in the incoming update
  if ('SoftApprovalReqd' in incoming) {
    const currentSoftReqd = current.SoftApprovalReqd;
    const newSoftReqd = row.SoftApprovalReqd;
    
    // Handle transition: No -> Yes (change status from Approved to Pending)
    if (currentSoftReqd === 'No' && newSoftReqd === 'Yes') {
      // If changing from No to Yes, and status is Approved, change to Pending
      if (row.SoftApprovalStatus === 'Approved') {
        row.SoftApprovalStatus = 'Pending';
      }
    }
    
    if (row.SoftApprovalReqd === 'No') {
      row.SoftApprovalStatus = 'Approved';
      if (!row.SoftApprovalSentActdate) row.SoftApprovalSentActdate = now;
      if (!row.SoftApprovalSentPlanDate) row.SoftApprovalSentPlanDate = now;
    } else if (row.SoftApprovalReqd === 'Yes') {
      // If status is not set, default to Pending
      // But if it was just changed from No->Yes and was Approved, we already set it above
      if (row.SoftApprovalStatus === undefined || row.SoftApprovalStatus === null || row.SoftApprovalStatus === '') {
        row.SoftApprovalStatus = 'Pending';
      }
      // If status is Sent => stamp actual
      if (row.SoftApprovalStatus === 'Sent' && !row.SoftApprovalSentActdate)
        row.SoftApprovalSentActdate = now;
      if (row.SoftApprovalStatus === 'Redo') row.SoftApprovalSentActdate = null;
    } else if (row.SoftApprovalReqd === null || row.SoftApprovalReqd === undefined || row.SoftApprovalReqd === '') {
      // If required is blank, keep status as blank (don't auto-set)
      // BUT: only clear status if it's not being explicitly set in the incoming update
      if ('SoftApprovalStatus' in incoming) {
        // Status is being explicitly updated, preserve it even if required is blank
        // Don't clear the status
      } else if (row.SoftApprovalStatus === undefined) {
        row.SoftApprovalStatus = null;
      }
    }
  } else if ('SoftApprovalStatus' in incoming) {
    // SoftApprovalReqd is not in incoming update, but SoftApprovalStatus is
    // Only apply status-specific rules (like Sent date stamping) without touching required logic
    if (row.SoftApprovalStatus === 'Sent' && !row.SoftApprovalSentActdate)
      row.SoftApprovalSentActdate = now;
    if (row.SoftApprovalStatus === 'Redo') row.SoftApprovalSentActdate = null;
  }
  // If SoftApprovalReqd is undefined (not in incoming update), preserve existing status

  // Only apply rules if HardApprovalReqd is explicitly in the incoming update
  if ('HardApprovalReqd' in incoming) {
    const currentHardReqd = current.HardApprovalReqd;
    const newHardReqd = row.HardApprovalReqd;
    
    // Handle transition: No -> Yes (change status from Approved to Pending)
    if (currentHardReqd === 'No' && newHardReqd === 'Yes') {
      // If changing from No to Yes, and status is Approved, change to Pending
      if (row.HardApprovalStatus === 'Approved') {
        row.HardApprovalStatus = 'Pending';
      }
    }
    
    if (row.HardApprovalReqd === 'No') {
      row.HardApprovalStatus = 'Approved';
      if (!row.HardApprovalSentActdate) row.HardApprovalSentActdate = now;
      if (!row.HardApprovalSentPlanDate) row.HardApprovalSentPlanDate = now;
    } else if (row.HardApprovalReqd === 'Yes') {
      // If status is not set, default to Pending
      // But if it was just changed from No->Yes and was Approved, we already set it above
      if (row.HardApprovalStatus === undefined || row.HardApprovalStatus === null || row.HardApprovalStatus === '') {
        row.HardApprovalStatus = 'Pending';
      }
      if (row.HardApprovalStatus === 'Sent' && !row.HardApprovalSentActdate)
        row.HardApprovalSentActdate = now;
      if (row.HardApprovalStatus === 'Redo') row.HardApprovalSentActdate = null;
    } else if (row.HardApprovalReqd === null || row.HardApprovalReqd === undefined || row.HardApprovalReqd === '') {
      // If required is blank, keep status as blank (don't auto-set)
      // BUT: only clear status if it's not being explicitly set in the incoming update
      if ('HardApprovalStatus' in incoming) {
        // Status is being explicitly updated, preserve it even if required is blank
        // Don't clear the status
      } else if (row.HardApprovalStatus === undefined) {
        row.HardApprovalStatus = null;
      }
    }
  } else if ('HardApprovalStatus' in incoming) {
    // HardApprovalReqd is not in incoming update, but HardApprovalStatus is
    // Only apply status-specific rules (like Sent date stamping) without touching required logic
    if (row.HardApprovalStatus === 'Sent' && !row.HardApprovalSentActdate)
      row.HardApprovalSentActdate = now;
    if (row.HardApprovalStatus === 'Redo') row.HardApprovalSentActdate = null;
  }
  // If HardApprovalReqd is undefined (not in incoming update), preserve existing status

  // Only apply rules if MProofApprovalReqd is explicitly in the incoming update
  if ('MProofApprovalReqd' in incoming) {
    const currentMProofReqd = current.MProofApprovalReqd;
    const newMProofReqd = row.MProofApprovalReqd;
    
    // Handle transition: No -> Yes (change status from Approved to Pending)
    if (currentMProofReqd === 'No' && newMProofReqd === 'Yes') {
      // If changing from No to Yes, and status is Approved, change to Pending
      if (row.MProofApprovalStatus === 'Approved') {
        row.MProofApprovalStatus = 'Pending';
      }
    }
    
    if (row.MProofApprovalReqd === 'No') {
      row.MProofApprovalStatus = 'Approved';
      if (!row.MProofApprovalSentActdate) row.MProofApprovalSentActdate = now;
      if (!row.MProofApprovalSentPlanDate) row.MProofApprovalSentPlanDate = now;
    } else if (row.MProofApprovalReqd === 'Yes') {
      // If status is not set, default to Pending
      // But if it was just changed from No->Yes and was Approved, we already set it above
      if (row.MProofApprovalStatus === undefined || row.MProofApprovalStatus === null || row.MProofApprovalStatus === '') {
        row.MProofApprovalStatus = 'Pending';
      }
      if (row.MProofApprovalStatus === 'Sent' && !row.MProofApprovalSentActdate)
        row.MProofApprovalSentActdate = now;
      if (row.MProofApprovalStatus === 'Redo') row.MProofApprovalSentActdate = null;
    } else if (row.MProofApprovalReqd === null || row.MProofApprovalReqd === undefined || row.MProofApprovalReqd === '') {
      // If required is blank, keep status as blank (don't auto-set)
      // BUT: only clear status if it's not being explicitly set in the incoming update
      if ('MProofApprovalStatus' in incoming) {
        // Status is being explicitly updated, preserve it even if required is blank
        // Don't clear the status
      } else if (row.MProofApprovalStatus === undefined) {
        row.MProofApprovalStatus = null;
      }
    }
  } else if ('MProofApprovalStatus' in incoming) {
    // MProofApprovalReqd is not in incoming update, but MProofApprovalStatus is
    // Only apply status-specific rules (like Sent date stamping) without touching required logic
    if (row.MProofApprovalStatus === 'Sent' && !row.MProofApprovalSentActdate)
      row.MProofApprovalSentActdate = now;
    if (row.MProofApprovalStatus === 'Redo') row.MProofApprovalSentActdate = null;
  }
  // If MProofApprovalReqd is undefined (not in incoming update), preserve existing status

  // 4) FinallyApproved
  const finalYes =
    row.SoftApprovalStatus === 'Approved' &&
    row.HardApprovalStatus === 'Approved' &&
    row.MProofApprovalStatus === 'Approved';

  row.FinallyApproved = finalYes ? 'Yes' : 'No';
  if (finalYes) {
    if (!row.FinallyApprovedDate) {
      row.FinallyApprovedDate = now;
      // your rule: ToolingBlanketPlan = FinallyApprovedDate
      if (!row.ToolingBlanketPlan) row.ToolingBlanketPlan = row.FinallyApprovedDate;
    }
  } else {
    row.FinallyApprovedDate = null;
  }

  // 5) Plate dates (do NOT override once set)
  if (row.PlateOutput) {
    const po = String(row.PlateOutput).trim().toLowerCase();

    if (po === 'pending') {
      if (!row.PlatePlan) {
        if (row.FinallyApprovedDate) {
          const d = new Date(row.FinallyApprovedDate);
          row.PlatePlan = isNaN(d.getTime()) ? null : addDays(d, 1);
        } else {
          row.PlatePlan = null;
        }
      }
    }

    if (po === 'done') {
      if (!row.PlateActual) row.PlateActual = now; // ✅ only stamp once
    }
  }

  // 6) ToolingBlanketActual when ready
  if (row.ToolingDie === 'Ready' && row.Blanket === 'Ready' && row.ToolingBlock !== 'Required') {
    if (!row.ToolingBlanketActual) row.ToolingBlanketActual = now;
  }

  return row;
}

// ---------- MSSQL: read current row (minimal) ----------
async function fetchSqlCurrentRow(databaseKey, orderBookingDetailsId) {
  const pool = await getPool(databaseKey);
  // We fetch current row so we can apply rules safely (because payload doesn't contain everything)
  // Using direct select is easiest; adjust schema/table name if different.
  const q = `
    SELECT TOP 1
      OrderBookingDetailsID,
      CategoryID, OrderBookingID, JobBookingID,
      EmployeeID, ToolingPersonID, PlatePersonID,
      FileName, FileReceivedDate,
      SoftApprovalReqd, SoftApprovalStatus, SoftApprovalSentPlanDate, SoftApprovalSentActdate, LinkofSoftApprovalfile,
      HardApprovalReqd, HardApprovalStatus, HardApprovalSentPlanDate, HardApprovalSentActdate,
      MProofApprovalReqd, MProofApprovalStatus, MProofApprovalSentPlanDate, MProofApprovalSentActdate,
      FinallyApproved, FinallyApprovedDate,
      ToolingDie, ToolingBlock, Blanket, ToolingBlanketPlan, ToolingBlanketActual,
      PlateOutput, PlatePlan, PlateActual,
      PlateRemark, ToolingRemark, ArtworkRemark
    FROM dbo.ArtworkProcessApproval WITH (NOLOCK)
    WHERE OrderBookingDetailsID = @obd;
  `;
  
  console.log('\n' + '='.repeat(80));
  console.log('🔍 [FETCH CURRENT ROW] Fetching current row from database');
  console.log('='.repeat(80));
  console.log('📊 [FETCH] Database:', databaseKey);
  console.log('📊 [FETCH] OrderBookingDetailsID:', orderBookingDetailsId);
  
  const r = await pool
    .request()
    .input('obd', sql.Int, orderBookingDetailsId)
    .query(q);
  
  const currentRow = r.recordset?.[0] || null;
  
  if (currentRow) {
    console.log('✅ [FETCH] Current row found:');
    console.log('   OrderBookingDetailsID:', currentRow.OrderBookingDetailsID ?? 'NULL');
    console.log('   CategoryID:', currentRow.CategoryID ?? 'NULL');
    console.log('   OrderBookingID:', currentRow.OrderBookingID ?? 'NULL');
    console.log('   JobBookingID:', currentRow.JobBookingID ?? 'NULL');
    console.log('   EmployeeID:', currentRow.EmployeeID ?? 'NULL');
    console.log('   ToolingPersonID:', currentRow.ToolingPersonID ?? 'NULL');
    console.log('   PlatePersonID:', currentRow.PlatePersonID ?? 'NULL');
    console.log('   FileName:', currentRow.FileName ?? 'NULL');
    console.log('   FileReceivedDate:', currentRow.FileReceivedDate ? new Date(currentRow.FileReceivedDate).toISOString() : 'NULL');
    console.log('   SoftApprovalReqd:', currentRow.SoftApprovalReqd ?? 'NULL');
    console.log('   SoftApprovalStatus:', currentRow.SoftApprovalStatus ?? 'NULL');
    console.log('   HardApprovalReqd:', currentRow.HardApprovalReqd ?? 'NULL');
    console.log('   HardApprovalStatus:', currentRow.HardApprovalStatus ?? 'NULL');
    console.log('   MProofApprovalReqd:', currentRow.MProofApprovalReqd ?? 'NULL');
    console.log('   MProofApprovalStatus:', currentRow.MProofApprovalStatus ?? 'NULL');
    console.log('   FinallyApproved:', currentRow.FinallyApproved ?? 'NULL');
    console.log('   ToolingDie:', currentRow.ToolingDie ?? 'NULL');
    console.log('   ToolingBlock:', currentRow.ToolingBlock ?? 'NULL');
    console.log('   Blanket:', currentRow.Blanket ?? 'NULL');
    console.log('   PlateOutput:', currentRow.PlateOutput ?? 'NULL');
    console.log('   ArtworkRemark:', currentRow.ArtworkRemark ?? 'NULL');
    console.log('   ToolingRemark:', currentRow.ToolingRemark ?? 'NULL');
    console.log('   PlateRemark:', currentRow.PlateRemark ?? 'NULL');
  } else {
    console.log('⚠️  [FETCH] No current row found - this will be an INSERT operation');
  }
  console.log('='.repeat(80) + '\n');
  
  return currentRow;
}

// ---------- MSSQL: call UpsertArtworkProcessApproval ----------
async function upsertSqlRow(databaseKey, mergedRow, ledgerIds) {
  const pool = await getPool(databaseKey);

  const req = pool.request();

  req.input('EmployeeID', sql.Int, ledgerIds.EmployeeID);
  req.input('CategoryID', sql.Int, mergedRow.CategoryID ?? null);
  req.input('OrderBookingID', sql.Int, mergedRow.OrderBookingID ?? null);
  req.input('OrderBookingDetailsID', sql.Int, mergedRow.OrderBookingDetailsID); // required
  req.input('JobBookingID', sql.Int, mergedRow.JobBookingID ?? null);

  // IMPORTANT: your SQL uses FileName column but it is being used as FileStatus.
  // Keep sending FileName = FileStatus.
  req.input('FileName', sql.NVarChar(200), mergedRow.FileStatus ?? mergedRow.FileName ?? null);
  req.input(
    'FileReceivedDate',
    sql.DateTime2(0),
    mergedRow.FileReceivedDate ? new Date(mergedRow.FileReceivedDate) : null
  );

  req.input('SoftApprovalReqd', sql.NVarChar(20), mergedRow.SoftApprovalReqd ?? null);
  req.input('SoftApprovalStatus', sql.NVarChar(50), mergedRow.SoftApprovalStatus ?? null);
  req.input(
    'SoftApprovalSentPlanDate',
    sql.Date,
    mergedRow.SoftApprovalSentPlanDate ? new Date(mergedRow.SoftApprovalSentPlanDate) : null
  );
  req.input(
    'SoftApprovalSentActdate',
    sql.DateTime2(0),
    mergedRow.SoftApprovalSentActdate ? new Date(mergedRow.SoftApprovalSentActdate) : null
  );
  req.input('LinkofSoftApprovalfile', sql.NVarChar(500), mergedRow.LinkofSoftApprovalfile ?? null);

  req.input('HardApprovalReqd', sql.NVarChar(20), mergedRow.HardApprovalReqd ?? null);
  req.input('HardApprovalStatus', sql.NVarChar(50), mergedRow.HardApprovalStatus ?? null);
  req.input(
    'HardApprovalSentPlanDate',
    sql.Date,
    mergedRow.HardApprovalSentPlanDate ? new Date(mergedRow.HardApprovalSentPlanDate) : null
  );
  req.input(
    'HardApprovalSentActdate',
    sql.DateTime2(0),
    mergedRow.HardApprovalSentActdate ? new Date(mergedRow.HardApprovalSentActdate) : null
  );

  req.input('MProofApprovalReqd', sql.NVarChar(20), mergedRow.MProofApprovalReqd ?? null);
  req.input('MProofApprovalStatus', sql.NVarChar(50), mergedRow.MProofApprovalStatus ?? null);
  req.input(
    'MProofApprovalSentPlanDate',
    sql.Date,
    mergedRow.MProofApprovalSentPlanDate ? new Date(mergedRow.MProofApprovalSentPlanDate) : null
  );
  req.input(
    'MProofApprovalSentActdate',
    sql.DateTime2(0),
    mergedRow.MProofApprovalSentActdate ? new Date(mergedRow.MProofApprovalSentActdate) : null
  );

  req.input('FinallyApproved', sql.NVarChar(20), mergedRow.FinallyApproved ?? null);
  req.input(
    'FinallyApprovedDate',
    sql.Date,
    mergedRow.FinallyApprovedDate ? new Date(mergedRow.FinallyApprovedDate) : null
  );

  req.input('ToolingPersonID', sql.Int, ledgerIds.ToolingPersonID);
  req.input('ToolingDie', sql.NVarChar(100), mergedRow.ToolingDie ?? null);
  req.input('ToolingBlock', sql.NVarChar(100), mergedRow.ToolingBlock ?? null);
  req.input('Blanket', sql.NVarChar(100), mergedRow.Blanket ?? null);
  req.input(
    'ToolingBlanketPlan',
    sql.Date,
    mergedRow.ToolingBlanketPlan ? new Date(mergedRow.ToolingBlanketPlan) : null
  );
  req.input(
    'ToolingBlanketActual',
    sql.Date,
    mergedRow.ToolingBlanketActual ? new Date(mergedRow.ToolingBlanketActual) : null
  );

  req.input('PlatePersonID', sql.Int, ledgerIds.PlatePersonID);
  req.input('PlateOutput', sql.NVarChar(50), mergedRow.PlateOutput ?? null);
  req.input('PlatePlan', sql.Date, mergedRow.PlatePlan ? new Date(mergedRow.PlatePlan) : null);
  req.input(
    'PlateActual',
    sql.DateTime2(0),
    mergedRow.PlateActual ? new Date(mergedRow.PlateActual) : null
  );

  req.input('PlateRemark', sql.NVarChar(500), mergedRow.PlateRemark ?? null);
  req.input('ToolingRemark', sql.NVarChar(500), mergedRow.ToolingRemark ?? null);
  req.input('ArtworkRemark', sql.NVarChar(500), mergedRow.ArtworkRemark ?? null);

  // OUTPUT
  req.output('ArtworkProcessApprovalID', sql.Int);

  // ========== LOG SQL PROCEDURE CALL WITH ALL PARAMETERS ==========
  console.log('\n' + '='.repeat(80));
  console.log('📋 [SQL PROCEDURE] Executing: dbo.UpsertArtworkProcessApproval');
  console.log('='.repeat(80));
  console.log('📊 [SQL PROCEDURE] Database:', databaseKey);
  console.log('📊 [SQL PROCEDURE] Parameters:');
  console.log('   @EmployeeID                 =', ledgerIds.EmployeeID ?? 'NULL');
  console.log('   @CategoryID                 =', mergedRow.CategoryID ?? 'NULL');
  console.log('   @OrderBookingID             =', mergedRow.OrderBookingID ?? 'NULL');
  console.log('   @OrderBookingDetailsID      =', mergedRow.OrderBookingDetailsID, '(REQUIRED)');
  console.log('   @JobBookingID               =', mergedRow.JobBookingID ?? 'NULL');
  console.log('   @FileName                   =', (mergedRow.FileStatus ?? mergedRow.FileName ?? null) ? `'${mergedRow.FileStatus ?? mergedRow.FileName}'` : 'NULL');
  console.log('   @FileReceivedDate           =', mergedRow.FileReceivedDate ? `'${new Date(mergedRow.FileReceivedDate).toISOString()}'` : 'NULL');
  console.log('   @SoftApprovalReqd           =', mergedRow.SoftApprovalReqd ? `'${mergedRow.SoftApprovalReqd}'` : 'NULL');
  console.log('   @SoftApprovalStatus         =', mergedRow.SoftApprovalStatus ? `'${mergedRow.SoftApprovalStatus}'` : 'NULL');
  console.log('   @SoftApprovalSentPlanDate   =', mergedRow.SoftApprovalSentPlanDate ? `'${new Date(mergedRow.SoftApprovalSentPlanDate).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @SoftApprovalSentActdate    =', mergedRow.SoftApprovalSentActdate ? `'${new Date(mergedRow.SoftApprovalSentActdate).toISOString()}'` : 'NULL');
  console.log('   @LinkofSoftApprovalfile     =', mergedRow.LinkofSoftApprovalfile ? `'${mergedRow.LinkofSoftApprovalfile}'` : 'NULL');
  console.log('   @HardApprovalReqd           =', mergedRow.HardApprovalReqd ? `'${mergedRow.HardApprovalReqd}'` : 'NULL');
  console.log('   @HardApprovalStatus         =', mergedRow.HardApprovalStatus ? `'${mergedRow.HardApprovalStatus}'` : 'NULL');
  console.log('   @HardApprovalSentPlanDate   =', mergedRow.HardApprovalSentPlanDate ? `'${new Date(mergedRow.HardApprovalSentPlanDate).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @HardApprovalSentActdate    =', mergedRow.HardApprovalSentActdate ? `'${new Date(mergedRow.HardApprovalSentActdate).toISOString()}'` : 'NULL');
  console.log('   @MProofApprovalReqd         =', mergedRow.MProofApprovalReqd ? `'${mergedRow.MProofApprovalReqd}'` : 'NULL');
  console.log('   @MProofApprovalStatus       =', mergedRow.MProofApprovalStatus ? `'${mergedRow.MProofApprovalStatus}'` : 'NULL');
  console.log('   @MProofApprovalSentPlanDate =', mergedRow.MProofApprovalSentPlanDate ? `'${new Date(mergedRow.MProofApprovalSentPlanDate).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @MProofApprovalSentActdate  =', mergedRow.MProofApprovalSentActdate ? `'${new Date(mergedRow.MProofApprovalSentActdate).toISOString()}'` : 'NULL');
  console.log('   @FinallyApproved            =', mergedRow.FinallyApproved ? `'${mergedRow.FinallyApproved}'` : 'NULL');
  console.log('   @FinallyApprovedDate        =', mergedRow.FinallyApprovedDate ? `'${new Date(mergedRow.FinallyApprovedDate).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @ToolingPersonID            =', ledgerIds.ToolingPersonID ?? 'NULL');
  console.log('   @ToolingDie                 =', mergedRow.ToolingDie ? `'${mergedRow.ToolingDie}'` : 'NULL');
  console.log('   @ToolingBlock               =', mergedRow.ToolingBlock ? `'${mergedRow.ToolingBlock}'` : 'NULL');
  console.log('   @Blanket                    =', mergedRow.Blanket ? `'${mergedRow.Blanket}'` : 'NULL');
  console.log('   @ToolingBlanketPlan         =', mergedRow.ToolingBlanketPlan ? `'${new Date(mergedRow.ToolingBlanketPlan).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @ToolingBlanketActual       =', mergedRow.ToolingBlanketActual ? `'${new Date(mergedRow.ToolingBlanketActual).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @PlatePersonID              =', ledgerIds.PlatePersonID ?? 'NULL');
  console.log('   @PlateOutput                =', mergedRow.PlateOutput ? `'${mergedRow.PlateOutput}'` : 'NULL');
  console.log('   @PlatePlan                  =', mergedRow.PlatePlan ? `'${new Date(mergedRow.PlatePlan).toISOString().split('T')[0]}'` : 'NULL');
  console.log('   @PlateActual                =', mergedRow.PlateActual ? `'${new Date(mergedRow.PlateActual).toISOString()}'` : 'NULL');
  console.log('   @PlateRemark                =', mergedRow.PlateRemark ? `'${mergedRow.PlateRemark}'` : 'NULL');
  console.log('   @ToolingRemark              =', mergedRow.ToolingRemark ? `'${mergedRow.ToolingRemark}'` : 'NULL');
  console.log('   @ArtworkRemark              =', mergedRow.ArtworkRemark ? `'${mergedRow.ArtworkRemark}'` : 'NULL');
  console.log('   @ArtworkProcessApprovalID   = OUTPUT');
  
  // Build and log the equivalent SQL EXEC statement with SQL Server-compatible date formats
  const formatSqlValue = (val, isDate = false, isDateTime = false) => {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (isDate) {
      // Format as 'YYYY-MM-DD' for DATE type
      const d = new Date(val);
      return `'${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}'`;
    }
    if (isDateTime) {
      // Format as 'YYYY-MM-DD HH:MM:SS' for DATETIME2(0)
      const d = new Date(val);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      return `'${dateStr} ${timeStr}'`;
    }
    return String(val);
  };
  
  console.log('\n📝 [SQL STATEMENT] Equivalent EXEC statement (SQL Server compatible format):');
  console.log('DECLARE @ArtworkProcessApprovalID INT;');
  console.log('EXEC dbo.UpsertArtworkProcessApproval');
  console.log(`    @EmployeeID = ${ledgerIds.EmployeeID ?? 'NULL'},`);
  console.log(`    @CategoryID = ${mergedRow.CategoryID ?? 'NULL'},`);
  console.log(`    @OrderBookingID = ${mergedRow.OrderBookingID ?? 'NULL'},`);
  console.log(`    @OrderBookingDetailsID = ${mergedRow.OrderBookingDetailsID},`);
  console.log(`    @JobBookingID = ${mergedRow.JobBookingID ?? 'NULL'},`);
  console.log(`    @FileName = ${formatSqlValue(mergedRow.FileStatus ?? mergedRow.FileName)},`);
  console.log(`    @FileReceivedDate = ${formatSqlValue(mergedRow.FileReceivedDate, false, true)},`);
  console.log(`    @SoftApprovalReqd = ${formatSqlValue(mergedRow.SoftApprovalReqd)},`);
  console.log(`    @SoftApprovalStatus = ${formatSqlValue(mergedRow.SoftApprovalStatus)},`);
  console.log(`    @SoftApprovalSentPlanDate = ${formatSqlValue(mergedRow.SoftApprovalSentPlanDate, true)},`);
  console.log(`    @SoftApprovalSentActdate = ${formatSqlValue(mergedRow.SoftApprovalSentActdate, false, true)},`);
  console.log(`    @LinkofSoftApprovalfile = ${formatSqlValue(mergedRow.LinkofSoftApprovalfile)},`);
  console.log(`    @HardApprovalReqd = ${formatSqlValue(mergedRow.HardApprovalReqd)},`);
  console.log(`    @HardApprovalStatus = ${formatSqlValue(mergedRow.HardApprovalStatus)},`);
  console.log(`    @HardApprovalSentPlanDate = ${formatSqlValue(mergedRow.HardApprovalSentPlanDate, true)},`);
  console.log(`    @HardApprovalSentActdate = ${formatSqlValue(mergedRow.HardApprovalSentActdate, false, true)},`);
  console.log(`    @MProofApprovalReqd = ${formatSqlValue(mergedRow.MProofApprovalReqd)},`);
  console.log(`    @MProofApprovalStatus = ${formatSqlValue(mergedRow.MProofApprovalStatus)},`);
  console.log(`    @MProofApprovalSentPlanDate = ${formatSqlValue(mergedRow.MProofApprovalSentPlanDate, true)},`);
  console.log(`    @MProofApprovalSentActdate = ${formatSqlValue(mergedRow.MProofApprovalSentActdate, false, true)},`);
  console.log(`    @FinallyApproved = ${formatSqlValue(mergedRow.FinallyApproved)},`);
  console.log(`    @FinallyApprovedDate = ${formatSqlValue(mergedRow.FinallyApprovedDate, true)},`);
  console.log(`    @ToolingPersonID = ${ledgerIds.ToolingPersonID ?? 'NULL'},`);
  console.log(`    @ToolingDie = ${formatSqlValue(mergedRow.ToolingDie)},`);
  console.log(`    @ToolingBlock = ${formatSqlValue(mergedRow.ToolingBlock)},`);
  console.log(`    @Blanket = ${formatSqlValue(mergedRow.Blanket)},`);
  console.log(`    @ToolingBlanketPlan = ${formatSqlValue(mergedRow.ToolingBlanketPlan, true)},`);
  console.log(`    @ToolingBlanketActual = ${formatSqlValue(mergedRow.ToolingBlanketActual, true)},`);
  console.log(`    @PlatePersonID = ${ledgerIds.PlatePersonID ?? 'NULL'},`);
  console.log(`    @PlateOutput = ${formatSqlValue(mergedRow.PlateOutput)},`);
  console.log(`    @PlatePlan = ${formatSqlValue(mergedRow.PlatePlan, true)},`);
  console.log(`    @PlateActual = ${formatSqlValue(mergedRow.PlateActual, false, true)},`);
  console.log(`    @PlateRemark = ${formatSqlValue(mergedRow.PlateRemark)},`);
  console.log(`    @ToolingRemark = ${formatSqlValue(mergedRow.ToolingRemark)},`);
  console.log(`    @ArtworkRemark = ${formatSqlValue(mergedRow.ArtworkRemark)},`);
  console.log(`    @ArtworkProcessApprovalID = @ArtworkProcessApprovalID OUTPUT;`);
  console.log('SELECT @ArtworkProcessApprovalID AS ArtworkProcessApprovalID;');
  console.log('='.repeat(80) + '\n');

  const r = await req.execute('UpsertArtworkProcessApproval');
  const outId = r.output?.ArtworkProcessApprovalID || r.recordset?.[0]?.ArtworkProcessApprovalID || null;

  // Log procedure result
  console.log('✅ [SQL PROCEDURE] Execution completed successfully');
  console.log('📊 [SQL PROCEDURE] Returned ArtworkProcessApprovalID:', outId);
  console.log('='.repeat(80) + '\n');

  return outId;
}

// ---------- Mongo update ----------
async function updateMongoRow(db, mongoId, mergedRow, updatedBy) {
  const _id = new ObjectId(mongoId);
  const now = new Date();

  // Map mergedRow (grid-ish fields) back to document fields
  // Only include fields that are explicitly defined in mergedRow (not undefined)
  // This prevents clearing fields that weren't part of the update
  const set = {
    updatedAt: now,
    'status.updatedAt': now,
    'status.updatedBy': updatedBy || 'Coordinator',
  };

  // Only set fields that are explicitly defined in mergedRow
  // This preserves existing values for fields that weren't updated
  if (mergedRow.FileStatus !== undefined) {
    set['artwork.fileStatus'] = (mergedRow.FileStatus || 'Pending').toString().toUpperCase();
  }
  if (mergedRow.FileReceivedDate !== undefined) {
    set['artwork.fileReceivedDate'] = mergedRow.FileReceivedDate ? new Date(mergedRow.FileReceivedDate) : null;
  }

  if (mergedRow.EmployeeUserKey !== undefined) {
    set['assignedTo.prepressUserKey'] = mergedRow.EmployeeUserKey
      ? String(mergedRow.EmployeeUserKey).toLowerCase()
      : null;
  }
  if (mergedRow.ToolingUserKey !== undefined) {
    set['assignedTo.toolingUserKey'] = mergedRow.ToolingUserKey
      ? String(mergedRow.ToolingUserKey).toLowerCase()
      : null;
  }
  if (mergedRow.PlateUserKey !== undefined) {
    set['assignedTo.plateUserKey'] = mergedRow.PlateUserKey
      ? String(mergedRow.PlateUserKey).toLowerCase()
      : null;
  }

  if (mergedRow.SoftApprovalReqd !== undefined) {
    set['approvals.soft.required'] = mergedRow.SoftApprovalReqd === null || mergedRow.SoftApprovalReqd === ''
      ? null
      : mergedRow.SoftApprovalReqd === 'Yes';
  }
  if (mergedRow.SoftApprovalStatus !== undefined) {
    set['approvals.soft.status'] = mergedRow.SoftApprovalStatus || null;
  }
  if (mergedRow.SoftApprovalSentPlanDate !== undefined) {
    set['approvals.soft.planDate'] = mergedRow.SoftApprovalSentPlanDate
      ? new Date(mergedRow.SoftApprovalSentPlanDate)
      : null;
  }
  if (mergedRow.SoftApprovalSentActdate !== undefined) {
    set['approvals.soft.actualDate'] = mergedRow.SoftApprovalSentActdate
      ? new Date(mergedRow.SoftApprovalSentActdate)
      : null;
  }

  if (mergedRow.HardApprovalReqd !== undefined) {
    set['approvals.hard.required'] = mergedRow.HardApprovalReqd === null || mergedRow.HardApprovalReqd === ''
      ? null
      : mergedRow.HardApprovalReqd === 'Yes';
  }
  if (mergedRow.HardApprovalStatus !== undefined) {
    set['approvals.hard.status'] = mergedRow.HardApprovalStatus || null;
  }
  if (mergedRow.HardApprovalSentPlanDate !== undefined) {
    set['approvals.hard.planDate'] = mergedRow.HardApprovalSentPlanDate
      ? new Date(mergedRow.HardApprovalSentPlanDate)
      : null;
  }
  if (mergedRow.HardApprovalSentActdate !== undefined) {
    set['approvals.hard.actualDate'] = mergedRow.HardApprovalSentActdate
      ? new Date(mergedRow.HardApprovalSentActdate)
      : null;
  }

  if (mergedRow.MProofApprovalReqd !== undefined) {
    set['approvals.machineProof.required'] = mergedRow.MProofApprovalReqd === null || mergedRow.MProofApprovalReqd === ''
      ? null
      : mergedRow.MProofApprovalReqd === 'Yes';
  }
  if (mergedRow.MProofApprovalStatus !== undefined) {
    set['approvals.machineProof.status'] = mergedRow.MProofApprovalStatus || null;
  }
  if (mergedRow.MProofApprovalSentPlanDate !== undefined) {
    set['approvals.machineProof.planDate'] = mergedRow.MProofApprovalSentPlanDate
      ? new Date(mergedRow.MProofApprovalSentPlanDate)
      : null;
  }
  if (mergedRow.MProofApprovalSentActdate !== undefined) {
    set['approvals.machineProof.actualDate'] = mergedRow.MProofApprovalSentActdate
      ? new Date(mergedRow.MProofApprovalSentActdate)
      : null;
  }

  if (mergedRow.FinallyApproved !== undefined) {
    set['finalApproval.approved'] = mergedRow.FinallyApproved === 'Yes';
  }
  if (mergedRow.FinallyApprovedDate !== undefined) {
    set['finalApproval.approvedDate'] = mergedRow.FinallyApprovedDate
      ? new Date(mergedRow.FinallyApprovedDate)
      : null;
  }

  if (mergedRow.ToolingDie !== undefined) {
    set['tooling.die'] = mergedRow.ToolingDie ?? null;
  }
  if (mergedRow.ToolingBlock !== undefined) {
    set['tooling.block'] = mergedRow.ToolingBlock ?? null;
  }
  if (mergedRow.Blanket !== undefined) {
    set['tooling.blanket'] = mergedRow.Blanket ?? null;
  }
  if (mergedRow.ToolingBlanketPlan !== undefined) {
    set['tooling.planDate'] = mergedRow.ToolingBlanketPlan ? new Date(mergedRow.ToolingBlanketPlan) : null;
  }
  if (mergedRow.ToolingBlanketActual !== undefined) {
    set['tooling.actualDate'] = mergedRow.ToolingBlanketActual ? new Date(mergedRow.ToolingBlanketActual) : null;
  }
  if (mergedRow.ToolingRemark !== undefined) {
    set['tooling.remark'] = mergedRow.ToolingRemark ?? null;
  }

  if (mergedRow.PlateOutput !== undefined) {
    set['plate.output'] = mergedRow.PlateOutput ?? null;
  }
  if (mergedRow.PlatePlan !== undefined) {
    set['plate.planDate'] = mergedRow.PlatePlan ? new Date(mergedRow.PlatePlan) : null;
  }
  if (mergedRow.PlateActual !== undefined) {
    set['plate.actualDate'] = mergedRow.PlateActual ? new Date(mergedRow.PlateActual) : null;
  }
  if (mergedRow.PlateRemark !== undefined) {
    set['plate.remark'] = mergedRow.PlateRemark ?? null;
  }

  if (mergedRow.ArtworkRemark !== undefined) {
    set['remarks.artwork'] = mergedRow.ArtworkRemark ?? null;
  }

  // Allow updating client name for Mongo rows
  if (mergedRow.ClientName !== undefined) {
    set['client.name'] = mergedRow.ClientName ?? null;
  }

  if (mergedRow.RefPCC !== undefined) {
    set.reference = mergedRow.RefPCC ?? null;
  }

  // Also handle SoftApprovalLink if provided
  if (mergedRow.LinkofSoftApprovalfile !== undefined || mergedRow.SoftApprovalLink !== undefined) {
    const link = mergedRow.LinkofSoftApprovalfile || mergedRow.SoftApprovalLink;
    set['approvals.soft.link'] = link ?? null;
  }

  const r = await db.collection('ArtworkUnordered').updateOne(
    { _id, 'status.isDeleted': { $ne: true } },
    { $set: set }
  );

  return r.modifiedCount;
}

// ---------- endpoint ----------
router.post('/artwork/pending/update', async (req, res) => {
  try {
    const payload = req.body || {};
    const sourceDb = String(payload.__SourceDB || '').trim();
    const update = payload.update || {};
    const updatedBy = payload.updatedBy || payload.createdBy || 'Coordinator';

    // Log incoming API request
    console.log('\n' + '='.repeat(80));
    console.log('📥 [API REQUEST] POST /api/artwork/pending/update');
    console.log('='.repeat(80));
    console.log('📋 [API] Incoming payload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log('='.repeat(80) + '\n');

    if (!sourceDb) throw new Error('__SourceDB is required in payload');

    const db = await getMongoDb();

    // Normalize incoming allowed fields - ONLY include fields that are actually in update
    // This prevents the 'in' operator from returning true for fields that weren't updated
    const incoming = {};
    
    // Only add fields that are explicitly present in update
    if ('FileStatus' in update) incoming.FileStatus = normFileStatus(update.FileStatus);
    if ('FileReceivedDate' in update) incoming.FileReceivedDate = toDateOrNull(update.FileReceivedDate);
    if ('SoftApprovalReqd' in update) incoming.SoftApprovalReqd = normYesNo(update.SoftApprovalReqd);
    if ('SoftApprovalStatus' in update) incoming.SoftApprovalStatus = normApprovalStatus(update.SoftApprovalStatus);
    if ('HardApprovalReqd' in update) incoming.HardApprovalReqd = normYesNo(update.HardApprovalReqd);
    if ('HardApprovalStatus' in update) incoming.HardApprovalStatus = normApprovalStatus(update.HardApprovalStatus);
    if ('MProofApprovalReqd' in update) incoming.MProofApprovalReqd = normYesNo(update.MProofApprovalReqd);
    if ('MProofApprovalStatus' in update) incoming.MProofApprovalStatus = normApprovalStatus(update.MProofApprovalStatus);
    
    if ('ToolingDie' in update) incoming.ToolingDie = update.ToolingDie ?? null;
    if ('ToolingBlock' in update) incoming.ToolingBlock = update.ToolingBlock ?? null;
    if ('Blanket' in update) incoming.Blanket = update.Blanket ?? null;
    if ('PlateOutput' in update) incoming.PlateOutput = update.PlateOutput ?? null;
    
    if ('PlateRemark' in update) incoming.PlateRemark = update.PlateRemark ?? null;
    if ('ToolingRemark' in update) incoming.ToolingRemark = update.ToolingRemark ?? null;
    if ('ArtworkRemark' in update) incoming.ArtworkRemark = update.ArtworkRemark ?? null;
    if ('RefPCC' in update) incoming.RefPCC = update.RefPCC ?? null;
    if ('ClientName' in update) incoming.ClientName = update.ClientName ?? null;
    
    // user keys (for Mongo OR for mapping to SQL ledger IDs)
    if ('EmployeeUserKey' in update) incoming.EmployeeUserKey = update.EmployeeUserKey ? String(update.EmployeeUserKey) : null;
    if ('ToolingUserKey' in update) incoming.ToolingUserKey = update.ToolingUserKey ? String(update.ToolingUserKey) : null;
    if ('PlateUserKey' in update) incoming.PlateUserKey = update.PlateUserKey ? String(update.PlateUserKey) : null;
    
    // Person display names (for SQL updates - will be converted to ledgerIds)
    if ('PrepressPerson' in update) incoming.PrepressPerson = update.PrepressPerson ? String(update.PrepressPerson) : null;
    if ('ToolingPerson' in update) incoming.ToolingPerson = update.ToolingPerson ? String(update.ToolingPerson) : null;
    if ('PlatePerson' in update) incoming.PlatePerson = update.PlatePerson ? String(update.PlatePerson) : null;
    
    // Link of Soft Approval file
    if ('LinkofSoftApprovalfile' in update || 'SoftApprovalLink' in update) {
      incoming.LinkofSoftApprovalfile = update.LinkofSoftApprovalfile ?? update.SoftApprovalLink ?? null;
    }

    // ----- MONGO_UNORDERED -----
    if (sourceDb === 'MONGO_UNORDERED') {
      const mongoId = payload.__MongoId || payload.__MongoID || payload.mongoId;
      if (!mongoId) throw new Error('__MongoId is required for MONGO_UNORDERED');

      // Convert displayNames to userKeys for MongoDB updates
      // Always look up displayName in user collection to get the corresponding _id
      if (incoming.EmployeeUserKey) {
        const userKey = await displayNameToUserKey(db, incoming.EmployeeUserKey);
        if (userKey) {
          console.log(`✅ [MONGO] Converted displayName "${incoming.EmployeeUserKey}" to userKey: ${userKey}`);
          incoming.EmployeeUserKey = userKey;
        } else {
          console.warn(`⚠️  [MONGO] Could not find userKey for displayName: "${incoming.EmployeeUserKey}". Treating as userKey and lowercasing.`);
          // Fallback: if lookup fails, assume it's already a userKey and lowercase it
          incoming.EmployeeUserKey = String(incoming.EmployeeUserKey).toLowerCase();
        }
      }
      
      if (incoming.ToolingUserKey) {
        const userKey = await displayNameToUserKey(db, incoming.ToolingUserKey);
        if (userKey) {
          console.log(`✅ [MONGO] Converted displayName "${incoming.ToolingUserKey}" to userKey: ${userKey}`);
          incoming.ToolingUserKey = userKey;
        } else {
          console.warn(`⚠️  [MONGO] Could not find userKey for displayName: "${incoming.ToolingUserKey}". Treating as userKey and lowercasing.`);
          // Fallback: if lookup fails, assume it's already a userKey and lowercase it
          incoming.ToolingUserKey = String(incoming.ToolingUserKey).toLowerCase();
        }
      }
      
      if (incoming.PlateUserKey) {
        const userKey = await displayNameToUserKey(db, incoming.PlateUserKey);
        if (userKey) {
          console.log(`✅ [MONGO] Converted displayName "${incoming.PlateUserKey}" to userKey: ${userKey}`);
          incoming.PlateUserKey = userKey;
        } else {
          console.warn(`⚠️  [MONGO] Could not find userKey for displayName: "${incoming.PlateUserKey}". Treating as userKey and lowercasing.`);
          // Fallback: if lookup fails, assume it's already a userKey and lowercase it
          incoming.PlateUserKey = String(incoming.PlateUserKey).toLowerCase();
        }
      }

      // Load current doc to merge and apply rules
      const cur = await db.collection('ArtworkUnordered').findOne(
        { _id: new ObjectId(mongoId), 'status.isDeleted': { $ne: true } },
        {
          projection: {
            site: 1,
            artwork: 1,
            approvals: 1,
            tooling: 1,
            plate: 1,
            assignedTo: 1,
            finalApproval: 1,
            remarks: 1,
            client: 1, // include client to preserve ClientName when not updating
          },
        }
      );
      if (!cur) throw new Error('Mongo record not found');

      // Convert current doc to grid-ish current row so rules can apply uniformly
      const currentRow = {
        FileStatus:
          (cur.artwork?.fileStatus || 'PENDING').toString().toUpperCase() === 'RECEIVED'
            ? 'Received'
            : (cur.artwork?.fileStatus || '').toString().toUpperCase() === 'OLD'
              ? 'Old'
              : 'Pending',
        FileReceivedDate: cur.artwork?.fileReceivedDate ?? null,

        SoftApprovalReqd: cur.approvals?.soft?.required === null || cur.approvals?.soft?.required === undefined
          ? null
          : cur.approvals?.soft?.required ? 'Yes' : 'No',
        SoftApprovalStatus: cur.approvals?.soft?.status ?? null,
        SoftApprovalSentPlanDate: cur.approvals?.soft?.planDate ?? null,
        SoftApprovalSentActdate: cur.approvals?.soft?.actualDate ?? null,

        HardApprovalReqd: cur.approvals?.hard?.required === null || cur.approvals?.hard?.required === undefined
          ? null
          : cur.approvals?.hard?.required ? 'Yes' : 'No',
        HardApprovalStatus: cur.approvals?.hard?.status ?? null,
        HardApprovalSentPlanDate: cur.approvals?.hard?.planDate ?? null,
        HardApprovalSentActdate: cur.approvals?.hard?.actualDate ?? null,

        MProofApprovalReqd: cur.approvals?.machineProof?.required === null || cur.approvals?.machineProof?.required === undefined
          ? null
          : cur.approvals?.machineProof?.required ? 'Yes' : 'No',
        MProofApprovalStatus: cur.approvals?.machineProof?.status ?? null,
        MProofApprovalSentPlanDate: cur.approvals?.machineProof?.planDate ?? null,
        MProofApprovalSentActdate: cur.approvals?.machineProof?.actualDate ?? null,

        FinallyApproved: cur.finalApproval?.approved ? 'Yes' : 'No',
        FinallyApprovedDate: cur.finalApproval?.approvedDate ?? null,

        ToolingDie: cur.tooling?.die ?? null,
        ToolingBlock: cur.tooling?.block ?? null,
        Blanket: cur.tooling?.blanket ?? null,
        ToolingBlanketPlan: cur.tooling?.planDate ?? null,
        ToolingBlanketActual: cur.tooling?.actualDate ?? null,

        PlateOutput: cur.plate?.output ?? null,
        PlatePlan: cur.plate?.planDate ?? null,
        PlateActual: cur.plate?.actualDate ?? null,

        PlateRemark: cur.plate?.remark ?? null,
        ToolingRemark: cur.tooling?.remark ?? null,
        ArtworkRemark: cur.remarks?.artwork ?? null,

        // Client
        ClientName: cur.client?.name ?? null,

        EmployeeUserKey: cur.assignedTo?.prepressUserKey ?? null,
        ToolingUserKey: cur.assignedTo?.toolingUserKey ?? null,
        PlateUserKey: cur.assignedTo?.plateUserKey ?? null,
      };

      const merged = applyRules(currentRow, incoming);
      await updateMongoRow(db, mongoId, merged, updatedBy);

      return res.json({ ok: true, updated: 1, source: 'MONGO_UNORDERED', reload: true });
    }

    // ----- MSSQL (KOL_SQL / AMD_SQL) -----
    if (sourceDb !== 'KOL_SQL' && sourceDb !== 'AMD_SQL') {
      throw new Error(`Unsupported __SourceDB: ${sourceDb}`);
    }

    const orderBookingDetailsId = Number(payload.OrderBookingDetailsID);
    if (!Number.isFinite(orderBookingDetailsId) || orderBookingDetailsId <= 0) {
      throw new Error('OrderBookingDetailsID is required for MSSQL update');
    }

    const databaseKey = sourceDb === 'KOL_SQL' ? 'KOL' : 'AHM';
    const site = sourceDb === 'KOL_SQL' ? 'KOLKATA' : 'AHMEDABAD';

    // Fetch current SQL row (so we can apply rules without needing full payload)
    const current = await fetchSqlCurrentRow(databaseKey, orderBookingDetailsId);

    const currentRow = current
      ? {
          ...current,
          OrderBookingDetailsID: orderBookingDetailsId,
          FileStatus: current.FileName, // alias
        }
      : {
          OrderBookingDetailsID: orderBookingDetailsId,
        };

    // Extract root-level fields if provided (these are not part of update object but should be preserved)
    // These fields can be passed at root level to override/preserve values
    if (payload.CategoryID !== undefined) {
      currentRow.CategoryID = Number(payload.CategoryID) || null;
      console.log('📋 [API] CategoryID from root payload:', currentRow.CategoryID);
    }
    if (payload.OrderBookingID !== undefined) {
      currentRow.OrderBookingID = Number(payload.OrderBookingID) || null;
      console.log('📋 [API] OrderBookingID from root payload:', currentRow.OrderBookingID);
    }
    if (payload.JobBookingID !== undefined) {
      currentRow.JobBookingID = Number(payload.JobBookingID) || null;
      console.log('📋 [API] JobBookingID from root payload:', currentRow.JobBookingID);
    }
    // Note: EmployeeID is handled separately via EmployeeUserKey mapping

    // Merge + rules
    const merged = applyRules(currentRow, incoming);

    // Log what's being saved for debugging
    console.log('[UPDATE] Saving SQL row:', {
      OrderBookingDetailsID: orderBookingDetailsId,
      MProofApprovalReqd: merged.MProofApprovalReqd,
      incoming_MProofApprovalReqd: incoming.MProofApprovalReqd,
      current_MProofApprovalReqd: current?.MProofApprovalReqd,
    });

    // Map displayNames/userKeys -> ledgerIds for SQL updates
    // Priority: 1. Root payload EmployeeID, 2. PrepressPerson displayName, 3. EmployeeUserKey, 4. Current value
    let EmployeeID;
    console.log('EmployeeID####################################################', payload.EmployeeID, incoming.PrepressPerson, incoming.EmployeeUserKey);
    if (payload.EmployeeID !== undefined) {
      EmployeeID = Number(payload.EmployeeID) || null;
      console.log('📋 [API] EmployeeID from root payload:', EmployeeID);
    } else if (incoming.PrepressPerson !== undefined) {
      // Look up displayName and get ledgerId
      EmployeeID = await displayNameToLedgerId(db, site, incoming.PrepressPerson);
      console.log('📋 [API] EmployeeID from PrepressPerson displayName lookup:', EmployeeID, `(displayName: ${incoming.PrepressPerson})`);
    } else if (incoming.EmployeeUserKey !== undefined) {
      EmployeeID = await userKeyToLedgerId(db, site, incoming.EmployeeUserKey);
      console.log('📋 [API] EmployeeID from EmployeeUserKey mapping:', EmployeeID);
    } else {
      EmployeeID = current?.EmployeeID ?? null;
      console.log('📋 [API] EmployeeID from current record:', EmployeeID);
    }

    let ToolingPersonID;
    if (incoming.ToolingPerson !== undefined) {
      // Look up displayName and get ledgerId
      ToolingPersonID = await displayNameToLedgerId(db, site, incoming.ToolingPerson);
      console.log('📋 [API] ToolingPersonID from ToolingPerson displayName lookup:', ToolingPersonID, `(displayName: ${incoming.ToolingPerson})`);
    } else if (incoming.ToolingUserKey !== undefined) {
      ToolingPersonID = await userKeyToLedgerId(db, site, incoming.ToolingUserKey);
      console.log('📋 [API] ToolingPersonID from ToolingUserKey mapping:', ToolingPersonID);
    } else {
      ToolingPersonID = current?.ToolingPersonID ?? null;
      console.log('📋 [API] ToolingPersonID from current record:', ToolingPersonID);
    }

    let PlatePersonID;
    if (incoming.PlatePerson !== undefined) {
      // Look up displayName and get ledgerId
      PlatePersonID = await displayNameToLedgerId(db, site, incoming.PlatePerson);
      console.log('📋 [API] PlatePersonID from PlatePerson displayName lookup:', PlatePersonID, `(displayName: ${incoming.PlatePerson})`);
    } else if (incoming.PlateUserKey !== undefined) {
      PlatePersonID = await userKeyToLedgerId(db, site, incoming.PlateUserKey);
      console.log('📋 [API] PlatePersonID from PlateUserKey mapping:', PlatePersonID);
    } else {
      PlatePersonID = current?.PlatePersonID ?? null;
      console.log('📋 [API] PlatePersonID from current record:', PlatePersonID);
    }

    // Log merged data before calling SQL procedure
    console.log('\n' + '='.repeat(80));
    console.log('📦 [API] Merged row data (after applying rules and merging with current):');
    console.log('='.repeat(80));
    console.log('   OrderBookingDetailsID:', merged.OrderBookingDetailsID);
    console.log('   EmployeeID:', EmployeeID, '(from userKey:', incoming.EmployeeUserKey || 'preserved from current)');
    console.log('   ToolingPersonID:', ToolingPersonID, '(from userKey:', incoming.ToolingUserKey || 'preserved from current)');
    console.log('   PlatePersonID:', PlatePersonID, '(from userKey:', incoming.PlateUserKey || 'preserved from current)');
    console.log('   CategoryID:', merged.CategoryID ?? 'NULL');
    console.log('   OrderBookingID:', merged.OrderBookingID ?? 'NULL');
    console.log('   JobBookingID:', merged.JobBookingID ?? 'NULL');
    console.log('   FileStatus:', merged.FileStatus ?? 'NULL');
    console.log('   FileReceivedDate:', merged.FileReceivedDate ?? 'NULL');
    console.log('   SoftApprovalReqd:', merged.SoftApprovalReqd ?? 'NULL');
    console.log('   SoftApprovalStatus:', merged.SoftApprovalStatus ?? 'NULL');
    console.log('   HardApprovalReqd:', merged.HardApprovalReqd ?? 'NULL');
    console.log('   HardApprovalStatus:', merged.HardApprovalStatus ?? 'NULL');
    console.log('   MProofApprovalReqd:', merged.MProofApprovalReqd ?? 'NULL');
    console.log('   MProofApprovalStatus:', merged.MProofApprovalStatus ?? 'NULL');
    console.log('   FinallyApproved:', merged.FinallyApproved ?? 'NULL');
    console.log('   ToolingDie:', merged.ToolingDie ?? 'NULL');
    console.log('   ToolingBlock:', merged.ToolingBlock ?? 'NULL');
    console.log('   Blanket:', merged.Blanket ?? 'NULL');
    console.log('   PlateOutput:', merged.PlateOutput ?? 'NULL');
    console.log('   ArtworkRemark:', merged.ArtworkRemark ?? 'NULL');
    console.log('   ToolingRemark:', merged.ToolingRemark ?? 'NULL');
    console.log('   PlateRemark:', merged.PlateRemark ?? 'NULL');
    console.log('='.repeat(80) + '\n');

    const outId = await upsertSqlRow(databaseKey, merged, {
      EmployeeID,
      ToolingPersonID,
      PlatePersonID,
    });

    // Verify the update was saved by querying directly
    const pool = await getPool(databaseKey);
    const verifyQuery = `
      SELECT MProofApprovalReqd 
      FROM dbo.ArtworkProcessApproval WITH (NOLOCK)
      WHERE OrderBookingDetailsID = @obd;
    `;
    const verifyResult = await pool
      .request()
      .input('obd', sql.Int, orderBookingDetailsId)
      .query(verifyQuery);
    const savedValue = verifyResult.recordset?.[0]?.MProofApprovalReqd;
    
    console.log('[UPDATE] Verified saved value:', {
      OrderBookingDetailsID: orderBookingDetailsId,
      saved_MProofApprovalReqd: savedValue,
      expected: merged.MProofApprovalReqd,
    });

    // Also fetch the full updated row to return in response
    const updatedRowQuery = `
      SELECT TOP 1
        OrderBookingDetailsID,
        MProofApprovalReqd, MProofApprovalStatus,
        SoftApprovalReqd, SoftApprovalStatus,
        HardApprovalReqd, HardApprovalStatus,
        FinallyApproved, FinallyApprovedDate
      FROM dbo.ArtworkProcessApproval WITH (NOLOCK)
      WHERE OrderBookingDetailsID = @obd;
    `;
    const updatedRowResult = await pool
      .request()
      .input('obd', sql.Int, orderBookingDetailsId)
      .query(updatedRowQuery);
    const updatedRow = updatedRowResult.recordset?.[0] || null;

    console.log('[UPDATE] Full updated row from DB:', updatedRow);

    res.json({
      ok: true,
      updated: 1,
      source: sourceDb,
      ArtworkProcessApprovalID: outId,
      reload: true,
      verified: {
        MProofApprovalReqd: savedValue,
        MProofApprovalStatus: updatedRow?.MProofApprovalStatus,
        FinallyApproved: updatedRow?.FinallyApproved,
      },
      updatedRow: updatedRow, // Return the full updated row
    });
  } catch (e) {
    console.error('Error in POST /api/artwork/pending/update:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
