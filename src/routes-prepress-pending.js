import { Router } from 'express';
import { getPool, sql } from './db.js';
import { MongoClient, ObjectId } from 'mongodb';

// User-wise pending data API for Prepress FMS Tool
// Exposed as: GET /api/prepress/pending?username=<username>
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

const PLATE_CLOSED_MONGO_VALUES = [
  'DONE',
  'Done',
  'done',
  'NOT REQUIRED',
  'Not Required',
  'not required',
];

function isPlateClosedValue(value) {
  const upper = String(value || '').trim().toUpperCase();
  return upper === 'DONE' || upper === 'NOT REQUIRED';
}

const TOOLING_CANONICAL = {
  NA: 'NA',
  'N/A': 'NA',
  'N.A.': 'NA',
  OLD: 'Old',
  ORDERED: 'Ordered',
  REQUIRED: 'Required',
  RECEIVED: 'Received',
};

function normalizeToolingStatus(value) {
  const t = (value ?? '').toString().trim();
  if (!t) return 'NA';
  return TOOLING_CANONICAL[t.toUpperCase()] || t;
}

function isToolingTypeOpen(value) {
  return normalizeToolingStatus(value).toUpperCase() === 'REQUIRED';
}

function computeToolingState(die, block, blanket) {
  const vals = [die, block, blanket].map(normalizeToolingStatus);
  if (vals.some((v) => v.toUpperCase() === 'REQUIRED')) return 'Open';
  if (vals.every((v) => v.toUpperCase() === 'NA')) return 'Not Applicable';
  return 'Closed';
}

function computeToolingSummary(die, block, blanket) {
  const d = normalizeToolingStatus(die);
  const b = normalizeToolingStatus(block);
  const bl = normalizeToolingStatus(blanket);
  if (d === 'NA' && b === 'NA' && bl === 'NA') return null;
  const parts = [];
  if (d !== 'NA') parts.push(`Die: ${d}`);
  if (b !== 'NA') parts.push(`Block: ${b}`);
  if (bl !== 'NA') parts.push(`Blanket: ${bl}`);
  return parts.length ? parts.join(', ') : null;
}

function attachToolingFields(row, source = {}) {
  const die = normalizeToolingStatus(source.ToolingDie ?? source.toolingDie ?? source.die);
  const block = normalizeToolingStatus(source.ToolingBlock ?? source.toolingBlock ?? source.block);
  const blanket = normalizeToolingStatus(source.Blanket ?? source.blanket);
  return {
    ...row,
    ToolingDie: die,
    ToolingBlock: block,
    Blanket: blanket,
    ToolingState: source.ToolingState || computeToolingState(die, block, blanket),
    ToolingSummary:
      source.ToolingSummary !== undefined
        ? source.ToolingSummary
        : computeToolingSummary(die, block, blanket),
    ToolingPerson: source.ToolingPerson ?? null,
    ToolingPlanDate: source.ToolingPlanDate ?? source.ToolingBlanketPlan ?? null,
    ToolingRemarkText:
      source.ToolingRemarkText ??
      source.toolingRemarkText ??
      source.ToolingRemark ??
      source.toolingRemark ??
      null,
  };
}

function isToolingProcessName(operation) {
  return /^TOOLING\s*-\s*(DIE|BLOCK|BLANKET)$/i.test(String(operation || '').trim());
}

// ---------- Mongo config ----------
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

// Helper: Convert username to userKey for MongoDB filtering
async function usernameToUserKey(db, username) {
  if (!username || typeof username !== 'string') return null;
  
  const user = await db
    .collection('user')
    .findOne(
      { active: true, displayName: { $regex: new RegExp(`^${username.trim()}$`, 'i') } },
      { projection: { _id: 1 } }
    );
  
  return user ? String(user._id).toLowerCase() : null;
}

// Helper: Look up user by displayName and return ledgerId from erp object for SQL
async function displayNameToLedgerId(db, site, displayName) {
  if (!displayName || typeof displayName !== 'string') return null;
  
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

// ---------- Fetch SQL pending data using GetPendingArtworkWorklist procedure ----------
async function fetchSqlPendingByUser(databaseKey, username, db) {
  const pool = await getPool(databaseKey); // 'KOL' or 'AHM'
  const site = databaseKey === 'KOL' ? 'KOLKATA' : 'AHMEDABAD';
  const expectedDb = databaseKey === 'KOL' ? process.env.DB_NAME_KOL : process.env.DB_NAME_AHM;
  
  // CRITICAL: Verify we're on the correct database before querying
  try {
    const dbVerify = await pool.request().query('SELECT DB_NAME() AS currentDb');
    const currentDb = dbVerify.recordset[0]?.currentDb;
    
    if (currentDb !== expectedDb) {
      console.error(`[FETCH] ${databaseKey} - CRITICAL: Wrong database! Expected: ${expectedDb}, Actual: ${currentDb}`);
      console.error(`[FETCH] ${databaseKey} - Attempting to switch database...`);
      
      // Try to switch database
      try {
        await pool.request().query(`USE [${expectedDb}]`);
        // Verify switch
        const dbVerify2 = await pool.request().query('SELECT DB_NAME() AS currentDb');
        const newDb = dbVerify2.recordset[0]?.currentDb;
        
        if (newDb !== expectedDb) {
          throw new Error(`Failed to switch to ${expectedDb}. Still on: ${newDb}`);
        }
        console.log(`[FETCH] ${databaseKey} - Successfully switched to ${expectedDb}`);
      } catch (switchErr) {
        console.error(`[FETCH] ${databaseKey} - Failed to switch database:`, switchErr.message);
        throw new Error(`Database connection error for ${databaseKey}: Connected to wrong database (${currentDb} instead of ${expectedDb})`);
      }
    } else {
      console.log(`[FETCH] ${databaseKey} - Database verified: ${currentDb}`);
    }
  } catch (verifyErr) {
    console.error(`[FETCH] ${databaseKey} - Error verifying database:`, verifyErr.message);
    throw verifyErr;
  }
  
  // Get ledgerId from MongoDB using displayName
  const ledgerId = await displayNameToLedgerId(db, site, username);

  console.log('ledgerId####################################################', ledgerId);
  console.log('site####################################################', site);
  
  if (!ledgerId) {
    console.log(`[FETCH] ${databaseKey} - No ledgerId found for username "${username}" in ${site}, skipping SQL filter`);
    // Still need to get total count even if we can't filter
    try {
      const result = await pool.request().query('EXEC GetPendingArtworkWorklist 0');
      const rs = result.recordset || [];
      console.log('********************rs', rs);
      // console.log(`[FETCH] ${databaseKey} - Total rows from stored procedure (ALL users, not filtered): ${rs.length}`);
      return {
        rows: [],
        totalCount: rs.length,
        databaseKey: databaseKey
      };
    } catch (err) {
      console.error(`[FETCH] ${databaseKey} - Error getting total count:`, err.message);
      return {
        rows: [],
        totalCount: 0,
        databaseKey: databaseKey
      };
    }
  }
  
  // Call the stored procedure: exec GetPendingArtworkWorklist 0
  // Using raw query since we don't know the parameter name, but value is 0
  const result = await pool.request().query('EXEC GetPendingArtworkWorklist 0');
  const rs = result.recordset || [];
  console.log('********************rs', rs);

  // Log total row count from stored procedure (ALL users, not filtered)
  // console.log(`[FETCH] ${databaseKey} - Database: ${expectedDb} (${site})`);
  // console.log(`[FETCH] ${databaseKey} - Total rows from stored procedure (ALL users, not filtered): ${rs.length}`);
  
  // Check if ledgerid column exists in the result (AHM might not have it yet)
  const hasLedgerIdColumn = rs.length > 0 && 'ledgerid' in rs[0];
  
  // if (!hasLedgerIdColumn && databaseKey === 'AHM') {
  //   console.log(`[FETCH] ${databaseKey} - ledgerid column not found in result. AHM database may not have this column yet.`);
  //   console.log(`[FETCH] ${databaseKey} - Available columns:`, rs.length > 0 ? Object.keys(rs[0]).join(', ') : 'no rows');
  //   // For AHM without ledgerid column, return empty array or all rows (depending on requirement)
  //   // Currently returning empty since we can't filter by user without ledgerid
  //   return [];
  // }
  
  // Filter by ledgerid matching the ledgerId from MongoDB
  const filtered = rs.filter((r) => {
    const rowLedgerId = r.ledgerid != null ? Number(r.ledgerid) : null;
    return rowLedgerId === ledgerId;
  });
  
  // Log detailed row count information for both KOL and AHM
  console.log(`[FETCH] ${databaseKey} - Row Count Summary:`);
  console.log(`  - Database: ${expectedDb} (${site})`);
  console.log(`  - Total rows from stored proc (ALL users): ${rs.length}`);
  console.log(`  - Filtered by ledgerId ${ledgerId} (${site} ledgerId for "${username}"): ${filtered.length}`);
  console.log(`  - Rows filtered out: ${rs.length - filtered.length}`);
  
  // Map filtered rows
  const mappedRows = filtered.map((r) => ({
    __SourceDB: databaseKey === 'KOL' ? 'KOL_SQL' : 'AMD_SQL',
    __Site: databaseKey === 'KOL' ? 'KOLKATA' : 'AHMEDABAD',
    

    
    // Map SQL columns to required output format
    PONumber: r.PONumber ?? null,
    PODate: r.PODate ?? null,
    Jobcardnumber: r.Jobcardnumber ?? null,
    ClientName: r.ClientName ?? null,
    RefMISCode: r.RefMISCode ?? null,
    JobName: r.JobName ?? null,
    Division: r.Division ?? null,
    FileReceivedDate: r.FileReceivedDate ?? null,
    Operation: r.Operation ?? null,
    Remarks: r.Remarks ?? null,
    PlanDate: r.PlanDate ?? null,
    Status: r.Status ?? null,
    SalesExec: r.SalesExec ??"NA", // Executive name from stored procedure (column is SalesExec for user-wise pending)
    
    // Keep original fields for reference
    ID: r.ID ?? null,
    EmployeeName: r.EmployeeName ?? null,
    FinalApprovalStatus: r.FinalApprovalStatus ?? null,
    FinalApprovalDate: r.FinalApprovalDate ?? null,
    ledgerid: r.ledgerid ?? null,
    Link: r.Link ?? null,
    SegmentName: r.SegmentName ?? r.Segment ?? null,
    CategoryName: r.CategoryName ?? r.Category ?? null,
  })).map((row, i) => attachToolingFields(row, filtered[i]));
  
  // Return object with both total count and filtered rows
  return {
    rows: mappedRows,
    totalCount: rs.length, // Total rows from database (all users)
    databaseKey: databaseKey
  };
}

function parseIsoDateOrNull(value) {
  if (!value || typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const dt = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isDateInRange(dateValue, fromDate, toDate) {
  if (!dateValue) return false;
  const dt = new Date(dateValue);
  if (Number.isNaN(dt.getTime())) return false;
  return dt >= fromDate && dt <= toDate;
}

async function fetchSqlCompletedByUser(databaseKey, username, fromDate, toDate, db) {
  const pool = await getPool(databaseKey);
  const site = databaseKey === 'KOL' ? 'KOLKATA' : 'AHMEDABAD';
  const ledgerId = await displayNameToLedgerId(db, site, username);

  if (!ledgerId) {
    return [];
  }

  const request = pool.request();
  request.input('ledgerid', sql.Int, Number(ledgerId));
  request.input('FromDate', sql.Date, fromDate);
  request.input('ToDate', sql.Date, toDate);

  const result = await request.execute('dbo.GetCompletedArtworkWorklist');
  const rs = result.recordset || [];

  return rs.map((r) => ({
    __SourceDB: databaseKey === 'KOL' ? 'KOL_SQL' : 'AMD_SQL',
    __Site: site,
    __MongoId: null,
    PONumber: r.PONumber ?? null,
    PODate: r.PODate ?? null,
    Jobcardnumber: r.Jobcardnumber ?? r.JobCardNumber ?? null,
    ClientName: r.ClientName ?? null,
    RefMISCode: r.RefMISCode ?? null,
    JobName: r.JobName ?? null,
    Executive: r.Executive ?? r.SalesExec ?? r.EmployeeName ?? null,
    Division: r.Division ?? site,
    FileReceivedDate: r.FileReceivedDate ?? null,
    Operation: r.Operation ?? null,
    Remarks: r.Remarks ?? r.Remark ?? null,
    PlanDate: r.PlanDate ?? null,
    ActualDate: r.CompletionDate ?? null,
    Status: r.Status ?? 'Completed',
    ID: r.ID ?? null,
    ledgerid: r.ledgerid ?? ledgerId,
    FinalApprovalStatus: r.FinalApprovalStatus ?? 'Yes',
    Link: r.Link ?? null,
    SegmentName: r.SegmentName ?? r.Segment ?? null,
    CategoryName: r.CategoryName ?? r.Category ?? null,
  })).map((row, i) => attachToolingFields(row, rs[i]));
}

function mapMongoCompletedOperations(doc, userKey, fromDate, toDate) {
  const rows = [];
  const isPrepress = doc.assignedTo?.prepressUserKey === userKey;
  const isPlate = doc.assignedTo?.plateUserKey === userKey;
  const isCancelled = Number(doc.iscancelled || 0) === 1;
  const baseFields = {
    __SourceDB: 'MONGO_UNORDERED',
    __Site: doc.site || 'COMMON',
    __MongoId: doc._id.toString(),
    PONumber: null,
    PODate: doc.createdAt ?? null,
    Jobcardnumber: doc.tokenNumber ?? null,
    ClientName: doc.client?.name ?? null,
    RefMISCode: doc.reference ?? null,
    JobName: doc.job?.jobName ?? null,
    Executive: doc.executive ?? null,
    Division: doc.job?.segment ?? null,
    SegmentName: doc.job?.segment ?? null,
    CategoryName: doc.job?.category ?? null,
    FileReceivedDate: doc.artwork?.fileReceivedDate ?? null,
    Remarks: doc.remarks?.artwork ?? null,
    ID: null,
    ledgerid: null,
    Link: doc.approvals?.soft?.link ?? null,
    ...attachToolingFields({}, {
      die: doc.tooling?.die,
      block: doc.tooling?.block,
      blanket: doc.tooling?.blanket,
      ToolingPlanDate: doc.tooling?.planDate,
      ToolingRemark: doc.tooling?.remark,
    }),
  };

  const approvalRows = [
    {
      op: 'Soft Copy Approval',
      required: Boolean(doc.approvals?.soft?.required),
      status: (doc.approvals?.soft?.status || '').toString().toLowerCase(),
      actualDate: doc.approvals?.soft?.actualDate ?? null,
    },
    {
      op: 'Hard Copy Approval',
      required: Boolean(doc.approvals?.hard?.required),
      status: (doc.approvals?.hard?.status || '').toString().toLowerCase(),
      actualDate: doc.approvals?.hard?.actualDate ?? null,
    },
    {
      op: 'Machine Proof Approval',
      required: Boolean(doc.approvals?.machineProof?.required),
      status: (doc.approvals?.machineProof?.status || '').toString().toLowerCase(),
      actualDate: doc.approvals?.machineProof?.actualDate ?? null,
    },
  ];

  if (isPrepress) {
    for (const item of approvalRows) {
      const isCompletedStatus = item.status === 'sent' || item.status === 'approved';
      if (!item.required || !isCompletedStatus || !isDateInRange(item.actualDate, fromDate, toDate)) {
        continue;
      }

      rows.push({
        ...baseFields,
        Operation: item.op,
        Status: item.status === 'approved' ? 'Approved' : 'Completed',
        PlanDate: item.actualDate,
        ActualDate: item.actualDate,
        FinalApprovalStatus: doc.finalApproval?.approved ? 'Yes' : 'No',
      });
    }
  }

  const isTooling = doc.assignedTo?.toolingUserKey === userKey;
  const toolingActualDate = doc.tooling?.actualDate ?? null;
  const toolingState = computeToolingState(doc.tooling?.die, doc.tooling?.block, doc.tooling?.blanket);
  if (isTooling && toolingState === 'Closed' && isDateInRange(toolingActualDate, fromDate, toDate)) {
    rows.push({
      ...baseFields,
      Operation: 'Tooling',
      Status: 'Completed',
      PlanDate: doc.tooling?.planDate ?? null,
      ActualDate: toolingActualDate,
      FinalApprovalStatus: doc.finalApproval?.approved ? 'Yes' : 'No',
    });
  }

  const plateOutputRaw = (doc.plate?.output || '').toString().trim();
  const plateOutputUpper = plateOutputRaw.toUpperCase();
  const plateDate = doc.plate?.actualDate ?? null;
  if (
    isPlate &&
    isPlateClosedValue(plateOutputRaw) &&
    isDateInRange(plateDate, fromDate, toDate)
  ) {
    rows.push({
      ...baseFields,
      Operation: 'Plate Output',
      Status: plateOutputUpper === 'NOT REQUIRED' ? 'Not Required' : 'Completed',
      PlanDate: plateDate,
      ActualDate: plateDate,
      FinalApprovalStatus: doc.finalApproval?.approved ? 'Yes' : 'No',
    });
  }

  const finalDate = doc.finalApproval?.approvedDate ?? null;
  if (isPrepress && doc.finalApproval?.approved && isDateInRange(finalDate, fromDate, toDate)) {
    rows.push({
      ...baseFields,
      Operation: 'Final Approval',
      Status: 'Approved',
      PlanDate: finalDate,
      ActualDate: finalDate,
      FinalApprovalStatus: 'Yes',
    });
  }

  const cancelDate = doc.status?.cancelledAt ?? null;
  if (isCancelled && (isPrepress || isPlate) && isDateInRange(cancelDate, fromDate, toDate)) {
    rows.push({
      ...baseFields,
      Operation: 'Cancelled',
      Status: 'Cancelled',
      PlanDate: cancelDate,
      ActualDate: cancelDate,
      FinalApprovalStatus: 'No',
    });
  }

  return rows;
}

async function fetchMongoCompletedByUser(db, username, fromDate, toDate) {
  const userKey = await usernameToUserKey(db, username);
  if (!userKey) return [];

  const docs = await db
    .collection('ArtworkUnordered')
    .find({
      'status.isDeleted': { $ne: true },
      $and: [
        {
          $or: [
            { iscancelled: 1 },
            { 'finalApproval.approved': true },
            { 'approvals.soft.status': { $in: ['Sent', 'sent', 'Approved', 'approved'] } },
            { 'approvals.hard.status': { $in: ['Sent', 'sent', 'Approved', 'approved'] } },
            { 'approvals.machineProof.status': { $in: ['Sent', 'sent', 'Approved', 'approved'] } },
            { 'plate.output': { $in: PLATE_CLOSED_MONGO_VALUES } },
            { 'tooling.actualDate': { $ne: null } },
          ],
        },
        {
          $or: [
            { 'assignedTo.prepressUserKey': userKey },
            { 'assignedTo.plateUserKey': userKey },
            { 'assignedTo.toolingUserKey': userKey },
          ],
        },
      ],
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  return docs.flatMap((d) => mapMongoCompletedOperations(d, userKey, fromDate, toDate));
}

// ---------- Fetch MongoDB pending data filtered by user ----------
async function fetchMongoPendingByUser(db, username) {
  // Filter by displayName field: Look up user by displayName to get userKey
  const userKey = await usernameToUserKey(db, username);
  
  if (!userKey) {
    console.log(`[FETCH] MONGO - No user found for displayName "${username}", skipping MongoDB filter`);
    return [];
  }
  
  // Mongo pending logic mirrors routes-pending.js:
  // - not finally approved OR tooling/blanket/plate pending
  // Filter by prepressUserKey, toolingUserKey, or plateUserKey (derived from displayName lookup)
  const query = {
    iscancelled: { $ne: 1 },
    'status.isDeleted': { $ne: true },
    $and: [
      {
        $or: [
          // not finally approved
          { 'finalApproval.approved': { $ne: true } },
          
          // tooling pending: only Required is open
          { 'tooling.die': { $in: ['REQUIRED', 'Required'] } },
          { 'tooling.block': { $in: ['REQUIRED', 'Required'] } },
          { 'tooling.blanket': { $in: ['REQUIRED', 'Required'] } },
          
          // plate pending — open unless Done or Not Required
          { 'plate.output': { $exists: true, $nin: [null, ...PLATE_CLOSED_MONGO_VALUES] } },
        ],
      },
      {
        // Filter by user assignments
        $or: [
          { 'assignedTo.prepressUserKey': userKey },
          { 'assignedTo.toolingUserKey': userKey },
          { 'assignedTo.plateUserKey': userKey },
        ],
      },
    ],
  };
  
  const docs = await db
    .collection('ArtworkUnordered')
    .find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();
  
  // Map MongoDB documents to required output format
  // Create multiple rows if multiple pending operations exist
  // Note: Most fields will be null as they don't exist in MongoDB
  return docs.flatMap((d) => {
    const pendingOperations = [];

    const isPrepress = d.assignedTo?.prepressUserKey === userKey;
    const isPlate = d.assignedTo?.plateUserKey === userKey;

    console.log('********************d', d);
    
    // Common fields for all rows from this document
    const baseFields = {
      __SourceDB: 'MONGO_UNORDERED',
      __Site: d.site || 'COMMON',
      __MongoId: d._id.toString(),
      
      // Map MongoDB fields for column mapping
      SODate: d.createdAt ?? null, // SO Date -> createdAt
      PWONO: d.tokenNumber ?? null, // PWO No -> tokenNumber (UN-XXXXX)
      RefPCC: d.reference ?? null, // Ref P.C.C... -> reference
      
      // Required output columns - most will be null for MongoDB
      PONumber: null,
      PODate: d.createdAt ?? null,
      Jobcardnumber: d.tokenNumber ?? null,
      ClientName: d.client?.name ?? null,
      RefMISCode: d.reference ?? null, // Map MongoDB reference field to Ref MIS Code
      JobName: d.job?.jobName ?? null,
      Division: d.job?.segment ?? null, // Map job.segment to Division
      FileReceivedDate: d.artwork?.fileReceivedDate ?? null,
      Remarks: d.remarks?.artwork ?? null,
      Status: d.finalApproval?.approved ? 'Approved' : 'Pending',
      Executive: d.executive ?? null, // Executive name from MongoDB
      SegmentName: d.job?.segment ?? null,
      CategoryName: d.job?.category ?? null,
    
      // Keep MongoDB-specific fields for reference
      EmployeeUserKey: d.assignedTo?.prepressUserKey ?? null,
      ToolingUserKey: d.assignedTo?.toolingUserKey ?? null,
      PlateUserKey: d.assignedTo?.plateUserKey ?? null,
      ...attachToolingFields({}, {
        die: d.tooling?.die,
        block: d.tooling?.block,
        blanket: d.tooling?.blanket,
        ToolingPlanDate: d.tooling?.planDate,
        ToolingRemark: d.tooling?.remark,
      }),
    };
    
    // Check for plate output pending (only for plate assignee; Done / Not Required are closed)
    const plateOutput = d.plate?.output;
    if (isPlate && plateOutput && !isPlateClosedValue(plateOutput)) {
      pendingOperations.push({
        ...baseFields,
        Operation: 'Plate Output',
        PlanDate: d.plate?.planDate ?? null,
      });
    }

    // Tooling does not get its own worklist rows — statuses ride on the existing operation row.
    
    // Approvals follow prepress assignment only (not tooling/plate-only users)
    // Exclude approvals that are 'Sent' or 'Approved' - they are no longer pending
    if (isPrepress && !d.finalApproval?.approved) {
      // Soft Copy Approval pending - exclude if status is 'Sent' or 'Approved'
      const softStatus = d.approvals?.soft?.status;
      const softIsPending = softStatus !== 'Approved' && softStatus !== 'Sent';
      if (d.approvals?.soft?.required && softIsPending) {
        pendingOperations.push({
          ...baseFields,
          Operation: 'Soft Copy Approval',
          PlanDate: d.approvals?.soft?.planDate ?? null,
        });
      }
      
      // Hard Copy Approval pending - exclude if status is 'Sent' or 'Approved'
      const hardStatus = d.approvals?.hard?.status;
      const hardIsPending = hardStatus !== 'Approved' && hardStatus !== 'Sent';
      if (d.approvals?.hard?.required && hardIsPending) {
        pendingOperations.push({
          ...baseFields,
          Operation: 'Hard Copy Approval',
          PlanDate: d.approvals?.hard?.planDate ?? null,
        });
      }
      
      // Machine Proof Approval pending - exclude if status is 'Sent' or 'Approved'
      const mpStatus = d.approvals?.machineProof?.status;
      const mpIsPending = mpStatus !== 'Approved' && mpStatus !== 'Sent';
      if (d.approvals?.machineProof?.required && mpIsPending) {
        pendingOperations.push({
          ...baseFields,
          Operation: 'Machine Proof Approval',
          PlanDate: d.approvals?.machineProof?.planDate ?? null,
        });
      }
    }
    
    // Only return pending operations if there are any
    // If all approvals are 'Sent'/'Approved' and plate is 'Done', 
    // then nothing is pending, so return empty array (document won't show up)
    return pendingOperations;
  });
}

// ---------- endpoint ----------
router.get('/prepress/pending', async (req, res) => {
  try {
    const username = req.query.username;
    
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ 
        ok: false, 
        error: 'username query parameter is required' 
      });
    }
    
    const trimmedUsername = username.trim();
    const db = await getMongoDb();
    
    // Fetch from sources sequentially to avoid connection pool race conditions
    // SQL databases are fetched one at a time to ensure proper database connection
    console.log('[FETCH] Starting sequential database queries to avoid connection pool issues...');
    
    // Step 1: Fetch from KOL database first
    console.log('[FETCH] Step 1/3: Fetching from KOL (Kolkata) database...');
    const kolRows = await fetchSqlPendingByUser('KOL', trimmedUsername, db);
    console.log('[FETCH] Step 1/3: KOL database query completed');
    
    // Step 2: Fetch from AHM database second
    console.log('[FETCH] Step 2/3: Fetching from AHM (Ahmedabad) database...');
    const ahmRows = await fetchSqlPendingByUser('AHM', trimmedUsername, db);
    console.log('[FETCH] Step 2/3: AHM database query completed');
    
    // Step 3: Fetch from MongoDB third
    console.log('[FETCH] Step 3/3: Fetching from MongoDB...');
    const mongoRows = await fetchMongoPendingByUser(db, trimmedUsername);
    // console.log('[FETCH] Step 3/3: MongoDB query completed');
    
    // console.log('[FETCH] All database queries completed sequentially');
    
    // Extract total counts and filtered rows
    const kolTotalCount = kolRows.totalCount || 0;
    const ahmTotalCount = ahmRows.totalCount || 0;
    const kolFilteredRows = kolRows.rows || [];
    const ahmFilteredRows = ahmRows.rows || [];
    
    // Log summary of TOTAL row counts from both databases (NOT filtered by user)
    // console.log(`[FETCH] ========== DATABASE ROW COUNT SUMMARY (ALL USERS, NOT FILTERED) ==========`);
    // console.log(`[FETCH] KOL (Kolkata) - Total rows in database: ${kolTotalCount}`);
    // console.log(`[FETCH] AHM (Ahmedabad) - Total rows in database: ${ahmTotalCount}`);
    // console.log(`[FETCH] Total across both databases: ${kolTotalCount + ahmTotalCount} rows`);
    // console.log(`[FETCH] ============================================================`);
    
    // // Log summary of filtered row counts for the searched user
    // console.log(`[FETCH] ========== FILTERED ROW COUNT SUMMARY for "${trimmedUsername}" ==========`);
    // console.log(`[FETCH] KOL (Kolkata) - Filtered rows: ${kolFilteredRows.length}`);
    // console.log(`[FETCH] AHM (Ahmedabad) - Filtered rows: ${ahmFilteredRows.length}`);
    // console.log(`[FETCH] MongoDB - Filtered rows: ${mongoRows.length}`);
    // console.log(`[FETCH] Total combined (filtered): ${kolFilteredRows.length + ahmFilteredRows.length + mongoRows.length} rows`);
    // console.log(`[FETCH] ============================================================`);
    
    // Combine all results
    const combined = [...kolFilteredRows, ...ahmFilteredRows, ...mongoRows];
    
    // Extract required output columns + metadata fields needed for updates
    const formattedData = combined.map((row) => ({
      // Visible columns for UI
      PONumber: row.PONumber,
      PODate: row.PODate,
      Jobcardnumber: row.Jobcardnumber,
      ClientName: row.ClientName,
      RefMISCode: row.RefMISCode,
      JobName: row.JobName,
      // Executive name:
      // - For SQL user-wise pending, comes from SalesExec
      // - For MongoDB user-wise pending, comes from Executive (mapped from d.executive)
      Executive: row.Executive ?? row.SalesExec ?? null,
      Division: row.Division,
      FileReceivedDate: row.FileReceivedDate,
      Operation: row.Operation,
      Remarks: row.Remarks,
      PlanDate: row.PlanDate,
      Status: row.Status,
      
      // Metadata fields needed for update operations
      __SourceDB: row.__SourceDB,      // 'KOL_SQL', 'AMD_SQL', or 'MONGO_UNORDERED'
      __MongoId: row.__MongoId,        // MongoDB ObjectId as string (for MongoDB items)
      ID: row.ID,                      // SQL ID or MongoDB ID fallback
      ledgerid: row.ledgerid,          // SQL ledger ID (for SQL items)
      FinalApprovalStatus: row.FinalApprovalStatus ?? null, // SQL-only; undefined for Mongo
      __Site: row.__Site,              // Site information (optional)
      
      // Additional fields for reference
      Link: row.Link || null,          // Link field if exists
      ToolingDie: row.ToolingDie ?? 'NA',
      ToolingBlock: row.ToolingBlock ?? 'NA',
      Blanket: row.Blanket ?? 'NA',
      ToolingState: row.ToolingState ?? null,
      ToolingSummary: row.ToolingSummary ?? null,
      ToolingPerson: row.ToolingPerson ?? null,
      ToolingPlanDate: row.ToolingPlanDate ?? null,
      ToolingRemarkText: row.ToolingRemarkText ?? null,
      SegmentName: row.SegmentName ?? null,
      CategoryName: row.CategoryName ?? null,
    }));
    
    // Log sample of formatted data to verify metadata fields are included
    if (formattedData.length > 0) {
      const sampleItem = formattedData[0];
      console.log('[FETCH] Sample formatted data item:', {
        __SourceDB: sampleItem.__SourceDB,
        __MongoId: sampleItem.__MongoId,
        ID: sampleItem.ID,
        ledgerid: sampleItem.ledgerid,
        Operation: sampleItem.Operation,
        ClientName: sampleItem.ClientName
      });
      
      // Log MongoDB items specifically
      const mongoItems = formattedData.filter(item => item.__SourceDB === 'MONGO_UNORDERED');
      if (mongoItems.length > 0) {
        console.log(`[FETCH] Found ${mongoItems.length} MongoDB items in formatted data`);
        console.log('[FETCH] Sample MongoDB item:', {
          __SourceDB: mongoItems[0].__SourceDB,
          __MongoId: mongoItems[0].__MongoId,
          ID: mongoItems[0].ID,
          Operation: mongoItems[0].Operation
        });
      }
    }
    
    res.json({
      ok: true,
      count: formattedData.length,
      data: formattedData,
      username: trimmedUsername,
    });
  } catch (e) {
    console.error('Error in /api/prepress/pending:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/prepress/completed', async (req, res) => {
  try {
    const username = (req.query.username || '').toString().trim();
    const fromDateRaw = (req.query.fromDate || '').toString().trim();
    const toDateRaw = (req.query.toDate || '').toString().trim();

    if (!username || !fromDateRaw || !toDateRaw) {
      return res.status(400).json({
        ok: false,
        error: 'username, fromDate and toDate query parameters are required',
      });
    }

    const fromDateStart = parseIsoDateOrNull(fromDateRaw);
    const toDateStart = parseIsoDateOrNull(toDateRaw);
    if (!fromDateStart || !toDateStart) {
      return res.status(400).json({
        ok: false,
        error: 'fromDate and toDate must be in YYYY-MM-DD format',
      });
    }

    const fromDate = new Date(fromDateStart);
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date(toDateStart);
    toDate.setHours(23, 59, 59, 999);

    if (fromDate > toDate) {
      return res.status(400).json({
        ok: false,
        error: 'fromDate cannot be greater than toDate',
      });
    }

    const db = await getMongoDb();
    const kolRows = await fetchSqlCompletedByUser('KOL', username, fromDateStart, toDateStart, db);
    const ahmRows = await fetchSqlCompletedByUser('AHM', username, fromDateStart, toDateStart, db);
    const mongoRows = await fetchMongoCompletedByUser(db, username, fromDate, toDate);

    const combined = [...kolRows, ...ahmRows, ...mongoRows];
    const formattedData = combined.map((row) => ({
      PONumber: row.PONumber ?? null,
      PODate: row.PODate ?? null,
      Jobcardnumber: row.Jobcardnumber ?? null,
      ClientName: row.ClientName ?? null,
      RefMISCode: row.RefMISCode ?? null,
      JobName: row.JobName ?? null,
      Executive: row.Executive ?? null,
      Division: row.Division ?? null,
      FileReceivedDate: row.FileReceivedDate ?? null,
      Operation: row.Operation ?? null,
      Remarks: row.Remarks ?? null,
      PlanDate: row.PlanDate ?? null,
      ActualDate: row.ActualDate ?? null,
      Status: row.Status ?? 'Completed',
      __SourceDB: row.__SourceDB ?? null,
      __MongoId: row.__MongoId ?? null,
      ID: row.ID ?? null,
      ledgerid: row.ledgerid ?? null,
      FinalApprovalStatus: row.FinalApprovalStatus ?? null,
      __Site: row.__Site ?? null,
      Link: row.Link ?? null,
      ToolingDie: row.ToolingDie ?? 'NA',
      ToolingBlock: row.ToolingBlock ?? 'NA',
      Blanket: row.Blanket ?? 'NA',
      ToolingState: row.ToolingState ?? null,
      ToolingSummary: row.ToolingSummary ?? null,
      SegmentName: row.SegmentName ?? null,
      CategoryName: row.CategoryName ?? null,
    }));

    res.json({
      ok: true,
      count: formattedData.length,
      data: formattedData,
      username,
      fromDate: fromDateRaw,
      toDate: toDateRaw,
    });
  } catch (e) {
    console.error('Error in /api/prepress/completed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Update MongoDB Artwork Process Status ----------
// Updates MongoDB document based on Operation, following SQL stored procedure logic
async function updateMongoArtworkProcessStatus(db, mongoId, operation, remark, link, toolingStatus, username) {
  const _id = new ObjectId(mongoId);
  const now = new Date();
  
  // Normalize operation to uppercase for comparison
  const proc = String(operation || '').toUpperCase().trim();
  let appliedStatus = null;
  
  // Fetch current document
  const doc = await db.collection('ArtworkUnordered').findOne({
    _id,
    'status.isDeleted': { $ne: true }
  });
  
  if (!doc) {
    throw new Error(`ArtworkUnordered document with ID ${mongoId} not found`);
  }
  
  const updateFields = {
    updatedAt: now,
    'status.updatedAt': now
  };
  
  // Update based on process type, following SQL stored procedure logic
  if (proc === 'SOFT COPY APPROVAL') {
    // Check if soft approval is required (condition from SQL: SoftApprovalReqd IN ('YES','Y','1','TRUE'))
    const softRequired = doc.approvals?.soft?.required;
    if (!softRequired) {
      throw new Error('Soft Copy Approval not required for this record.');
    }
    
    // Update soft approval status to 'Sent' and set actual date
    updateFields['approvals.soft.status'] = 'Sent';
    updateFields['approvals.soft.actualDate'] = now;
    
    // Update artwork remark if provided
    if (remark) {
      updateFields['remarks.artwork'] = remark;
    }
    
    // Update link if provided (only for Soft Copy Approval)
    if (link) {
      updateFields['approvals.soft.link'] = link;
    }
    
    appliedStatus = 'Sent';
    
  } else if (proc === 'HARD COPY APPROVAL') {
    // Check if hard approval is required (condition from SQL: HardApprovalReqd IN ('YES','Y','1','TRUE'))
    const hardRequired = doc.approvals?.hard?.required;
    if (!hardRequired) {
      throw new Error('Hard Copy Approval not required for this record.');
    }
    
    // Update hard approval status to 'Sent' and set actual date
    updateFields['approvals.hard.status'] = 'Sent';
    updateFields['approvals.hard.actualDate'] = now;
    
    // Update artwork remark if provided
    if (remark) {
      updateFields['remarks.artwork'] = remark;
    }
    
    appliedStatus = 'Sent';
    
  } else if (proc === 'MACHINE PROOF' || proc === 'MACHINE PROOF APPROVAL') {
    // Check if machine proof is required (condition from SQL: MProofApprovalReqd IN ('YES','Y','1','TRUE'))
    const mpRequired = doc.approvals?.machineProof?.required;
    if (!mpRequired) {
      throw new Error('Machine Proof not required for this record.');
    }
    
    // Update machine proof status to 'Sent' and set actual date
    updateFields['approvals.machineProof.status'] = 'Sent';
    updateFields['approvals.machineProof.actualDate'] = now;
    
    // Update artwork remark if provided
    if (remark) {
      updateFields['remarks.artwork'] = remark;
    }
    
    appliedStatus = 'Sent';
    
  } else if (proc === 'PLATE OUTPUT') {
    const currentPlate = String(doc.plate?.output || '').trim().toUpperCase();
    if (currentPlate === 'DONE' || currentPlate === 'NOT REQUIRED') {
      throw new Error('Plate Output step not present, or already closed (Done / Not Required).');
    }

    // Check if plate output step exists (condition from SQL: PlatePlan IS NOT NULL OR PlatePersonID IS NOT NULL OR PlateOutput IS NOT NULL)
    const hasPlateStep = doc.plate?.planDate || doc.assignedTo?.plateUserKey || doc.plate?.output;
    if (!hasPlateStep) {
      throw new Error('Plate Output step not present, or already closed (Done / Not Required).');
    }
    
    // Update plate output to 'Done' and set actual date
    updateFields['plate.output'] = 'Done';
    updateFields['plate.actualDate'] = now;
    
    // Update plate remark if provided
    if (remark) {
      updateFields['plate.remark'] = remark;
    }
    
    appliedStatus = 'Done';

  } else if (proc === 'PLATE NOT REQUIRED') {
    const currentPlate = String(doc.plate?.output || '').trim().toUpperCase();
    if (currentPlate === 'DONE') {
      throw new Error('Plate Output is already marked Done - it cannot be set to Not Required.');
    }
    if (currentPlate === 'NOT REQUIRED') {
      throw new Error('Plate Output step not present, or already closed (Done / Not Required).');
    }

    updateFields['plate.output'] = 'Not Required';
    updateFields['plate.actualDate'] = now;

    if (remark) {
      updateFields['plate.remark'] = remark;
    }

    appliedStatus = 'Not Required';

  } else if (isToolingProcessName(operation)) {
    if (toolingStatus === undefined || toolingStatus === null || String(toolingStatus).trim() === '') {
      throw new Error('@ToolingStatus is required for a Tooling process.');
    }
    const canonical = normalizeToolingStatus(toolingStatus);
    const allowed = new Set(['NA', 'OLD', 'ORDERED', 'REQUIRED', 'RECEIVED']);
    if (!allowed.has(canonical.toUpperCase())) {
      throw new Error(`Invalid @ToolingStatus "${toolingStatus}". Use: NA | Old | Ordered | Required | Received.`);
    }

    const procName = String(operation || '').toUpperCase();
    let field = 'tooling.blanket';
    let currentVal = doc.tooling?.blanket;
    if (procName.includes('DIE')) {
      field = 'tooling.die';
      currentVal = doc.tooling?.die;
    } else if (procName.includes('BLOCK')) {
      field = 'tooling.block';
      currentVal = doc.tooling?.block;
    }

    if (normalizeToolingStatus(currentVal) === canonical) {
      return {
        id: mongoId,
        operation,
        newStatus: canonical,
        changed: 0,
        modifiedCount: 0,
      };
    }

    updateFields[field] = canonical;
    if (remark) {
      updateFields['tooling.remark'] = remark;
    }

    const nextDie = field === 'tooling.die' ? canonical : doc.tooling?.die;
    const nextBlock = field === 'tooling.block' ? canonical : doc.tooling?.block;
    const nextBlanket = field === 'tooling.blanket' ? canonical : doc.tooling?.blanket;
    const nextState = computeToolingState(nextDie, nextBlock, nextBlanket);
    if (nextState === 'Closed') {
      if (!doc.tooling?.actualDate) {
        updateFields['tooling.actualDate'] = now;
        if (username) {
          const userKey = await usernameToUserKey(db, username);
          if (userKey) updateFields['assignedTo.toolingUserKey'] = userKey;
        }
      }
    } else {
      updateFields['tooling.actualDate'] = null;
    }

    appliedStatus = canonical;
    
  } else {
    throw new Error(`Unsupported @Process "${operation}". Use: Soft Copy Approval | Hard Copy Approval | Machine Proof | Plate Output | Plate Not Required | Tooling - Die | Tooling - Block | Tooling - Blanket.`);
  }
  
  // Perform the update
  const result = await db.collection('ArtworkUnordered').updateOne(
    { _id, 'status.isDeleted': { $ne: true } },
    { $set: updateFields }
  );
  
  if (result.matchedCount === 0) {
    throw new Error(`Document with ID ${mongoId} not found or deleted`);
  }
  
  if (result.modifiedCount === 0) {
    // Document was found but no changes were made (unlikely but possible)
    console.warn(`[UPDATE] Document ${mongoId} found but no changes applied`);
  }
  
  return {
    id: mongoId,
    operation: operation,
    newStatus: appliedStatus,
    modifiedCount: result.modifiedCount
  };
}

// ---------- Update Artwork Process Status ----------
// POST /api/prepress/pending/update
// Body: { items: [{ __SourceDB, ID (or __MongoId), Operation, ledgerid (optional for Mongo), Remark, Link }] }
router.post('/prepress/pending/update', async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items array is required and must not be empty' });
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('📥 [API REQUEST] POST /api/prepress/pending/update');
    console.log('='.repeat(80));
    console.log(`📋 [API] Updating ${items.length} item(s)`);
    console.log(JSON.stringify(items, null, 2));
    
    // Log MongoDB items specifically
    const mongoItems = items.filter(item => item.__SourceDB === 'MONGO_UNORDERED');
    if (mongoItems.length > 0) {
      console.log('\n🔍 [API] MongoDB items in request:');
      mongoItems.forEach((item, idx) => {
        console.log(`  Item ${idx + 1}:`, {
          __SourceDB: item.__SourceDB,
          __MongoId: item.__MongoId,
          ID: item.ID,
          Operation: item.Operation,
          Remark: item.Remark,
          Link: item.Link
        });
      });
    }
    
    console.log('='.repeat(80) + '\n');
    
    const results = [];
    const errors = [];
    
    // Get MongoDB connection for MongoDB items
    const db = await getMongoDb();
    
    // Process each item
    for (const item of items) {
      try {
        const { __SourceDB, ID, __MongoId, Operation, ledgerid, Remark, Link, ToolingStatus } = item;
        
        // Validate required fields
        if (!__SourceDB || !Operation) {
          errors.push({
            item,
            error: 'Missing required fields: __SourceDB or Operation'
          });
          continue;
        }
        
        // Handle MongoDB items
        if (__SourceDB === 'MONGO_UNORDERED') {
          // For MongoDB, we need __MongoId (not ID)
          console.log(`[UPDATE] MongoDB item received:`, {
            __SourceDB,
            __MongoId,
            ID,
            Operation,
            ledgerid,
            Remark,
            Link,
            fullItem: item
          });
          
          const mongoId = __MongoId || ID;
          
          if (!mongoId) {
            console.error(`[UPDATE] MongoDB item missing ID! Received:`, {
              __MongoId,
              ID,
              item
            });
            errors.push({
              item,
              error: 'Missing required field: __MongoId or ID for MongoDB item'
            });
            continue;
          }
          
          console.log(`[UPDATE] Updating MongoDB document:`);
          console.log(`  __MongoId received = '${__MongoId}'`);
          console.log(`  ID received = '${ID}'`);
          console.log(`  Final mongoId used = '${mongoId}'`);
          console.log(`  @Process = '${Operation}'`);
          console.log(`  @Remark = '${Remark || 'NULL'}'`);
          console.log(`  @Link = '${Link || 'NULL'}'`);
          
          // Update MongoDB document
          const result = await updateMongoArtworkProcessStatus(db, mongoId, Operation, Remark, Link, ToolingStatus, item.username);
          
          console.log(`✅ [UPDATE] Successfully updated MongoDB document ${mongoId}`);
          
          results.push({
            item,
            success: true,
            databaseKey: 'MONGO',
            result: result
          });
          
        } else if (__SourceDB === 'KOL_SQL' || __SourceDB === 'AMD_SQL') {
          // Handle SQL items
          if (!ID || !ledgerid) {
            errors.push({
              item,
              error: 'Missing required fields: ID or ledgerid for SQL item'
            });
            continue;
          }
          
          // Determine database key from __SourceDB
          const databaseKey = __SourceDB === 'KOL_SQL' ? 'KOL' : 'AHM';
          
          // Get the appropriate database pool
          const pool = await getPool(databaseKey);
          const request = pool.request();
          
          // Set up parameters for UpdateArtworkProcessStatus stored procedure
          request.input('ArtworkProcessApprovalID', sql.Int, Number(ID));
          request.input('Process', sql.NVarChar(100), String(Operation));
          request.input('UserID', sql.Int, Number(ledgerid));
          request.input('Remark', sql.NVarChar(500), Remark ? String(Remark) : null);
          request.input('Link', sql.NVarChar(1000), Link ? String(Link) : null);
          if (isToolingProcessName(Operation)) {
            if (ToolingStatus === undefined || ToolingStatus === null || String(ToolingStatus).trim() === '') {
              throw new Error('@ToolingStatus is required for a Tooling process.');
            }
            const canonical = normalizeToolingStatus(ToolingStatus);
            const allowed = new Set(['NA', 'OLD', 'ORDERED', 'REQUIRED', 'RECEIVED']);
            if (!allowed.has(canonical.toUpperCase())) {
              throw new Error(`Invalid @ToolingStatus "${ToolingStatus}". Use: NA | Old | Ordered | Required | Received.`);
            }
            request.input('ToolingStatus', sql.NVarChar(50), canonical);
          }
          
          console.log(`[UPDATE] Executing UpdateArtworkProcessStatus for ${databaseKey}:`);
          console.log(`  @ArtworkProcessApprovalID = ${ID}`);
          console.log(`  @Process = '${Operation}'`);
          console.log(`  @UserID = ${ledgerid}`);
          console.log(`  @Remark = '${Remark || 'NULL'}'`);
          console.log(`  @Link = '${Link || 'NULL'}'`);
          if (isToolingProcessName(Operation)) {
            console.log(`  @ToolingStatus = '${ToolingStatus}'`);
          }
          
          // Execute the stored procedure
          const result = await request.execute('UpdateArtworkProcessStatus');
          
          console.log(`✅ [UPDATE] Successfully updated item ID ${ID} in ${databaseKey}`);
          
          results.push({
            item,
            success: true,
            databaseKey,
            result: result.recordset || null
          });
          
        } else {
          errors.push({
            item,
            error: `Unsupported __SourceDB: ${__SourceDB}`
          });
        }
        
      } catch (itemError) {
        console.error(`❌ [UPDATE] Error updating item:`, itemError);
        errors.push({
          item,
          error: itemError.message
        });
      }
    }
    
    const successCount = results.filter(r => r.success && !r.skipped).length;
    const skippedCount = results.filter(r => r.skipped).length;
    const errorCount = errors.length;
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 [UPDATE] Summary:');
    console.log(`  ✅ Success: ${successCount}`);
    console.log(`  ⏭️  Skipped: ${skippedCount}`);
    console.log(`  ❌ Errors: ${errorCount}`);
    console.log('='.repeat(80) + '\n');
    
    res.json({
      ok: true,
      success: successCount,
      skipped: skippedCount,
      errorCount,
      results,
      // Array of per-item failures (surface SP messages to the UI)
      errors: errors.length > 0 ? errors : [],
    });
    
  } catch (e) {
    console.error('Error in POST /api/prepress/pending/update:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
