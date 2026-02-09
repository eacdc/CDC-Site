import { Router } from 'express';
import { getPool, sql } from './db.js';
import { MongoClient } from 'mongodb';
import { insertUnorderedMinimal } from './unordered.js';

// Combined pending API (Kolkata SQL + Ahmedabad SQL + Mongo ArtworkUnordered)
// Exposed as: GET /api/artwork/pending
//
// ENV USED (matches existing backend .env):
//   PORT                  - main Express port (already used in server.js)
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

// ---------- helpers ----------
function uniqNums(arr) {
  const s = new Set();
  for (const v of arr || []) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) s.add(n);
  }
  return [...s];
}

async function loadUserMaps(db, site, ledgerIds) {
  // returns Map<ledgerId, { userKey, displayName }>
  const ids = uniqNums(ledgerIds);
  const map = new Map();
  if (ids.length === 0) return map;

  const path = `erp.${site}.ledgerId`;
  const users = await db
    .collection('user')
    .find(
      { active: true, [path]: { $in: ids } },
      { projection: { _id: 1, displayName: 1, erp: 1 } }
    )
    .toArray();

  for (const u of users) {
    const lid = u?.erp?.[site]?.ledgerId;
    if (lid !== null && lid !== undefined) {
      map.set(Number(lid), { userKey: u._id, displayName: u.displayName });
    }
  }
  return map;
}

async function loadUserKeyNameMap(db, userKeys) {
  // returns Map<userKey, displayName>
  const keys = [...new Set((userKeys || []).filter(Boolean).map((x) => String(x).toLowerCase()))];
  const map = new Map();
  if (keys.length === 0) return map;

  const users = await db
    .collection('user')
    .find(
      { active: true, _id: { $in: keys } },
      { projection: { _id: 1, displayName: 1 } }
    )
    .toArray();

  for (const u of users) map.set(u._id, u.displayName);
  return map;
}

function resolveDisplayName({ map, ledgerId, sqlName, fallbackLabel }) {
  if (ledgerId === null || ledgerId === undefined) return sqlName || null;
  const m = map.get(Number(ledgerId));
  if (m?.displayName) return m.displayName;

  // If SQL already gave a name, keep it but mark unmapped
  if (sqlName) return `${sqlName} (Unmapped:${ledgerId})`;

  return `${fallbackLabel} (${ledgerId})`;
}

function attachSqlUserMapping(row, site, userMap) {
  const EmployeeID = row.EmployeeID ?? null;
  const ToolingPersonID = row.ToolingPersonID ?? null;
  const PlatePersonID = row.PlatePersonID ?? null;

  const empMapped = EmployeeID != null ? userMap.get(Number(EmployeeID)) : null;
  const toolMapped = ToolingPersonID != null ? userMap.get(Number(ToolingPersonID)) : null;
  const plateMapped = PlatePersonID != null ? userMap.get(Number(PlatePersonID)) : null;

  return {
    ...row,

    // IMPORTANT: FileName in SQL is actually file status
    FileStatus: row.FileName,

    EmployeeUserKey: empMapped?.userKey ?? null,
    ToolingUserKey: toolMapped?.userKey ?? null,
    PlateUserKey: plateMapped?.userKey ?? null,

    PrepressPerson: resolveDisplayName({
      map: userMap,
      ledgerId: EmployeeID,
      sqlName: row.PrepressPerson,
      fallbackLabel: 'Unknown',
    }),
    ToolingPerson: resolveDisplayName({
      map: userMap,
      ledgerId: ToolingPersonID,
      sqlName: row.ToolingPerson,
      fallbackLabel: 'Unknown',
    }),
    PlatePerson: resolveDisplayName({
      map: userMap,
      ledgerId: PlatePersonID,
      sqlName: row.PlatePerson,
      fallbackLabel: 'Unknown',
    }),

    __Site: site,
  };
}

function normalizeMongoRow(docRow, userKeyNameMap) {
  const toName = (userKey) => {
    if (!userKey) return null;
    const k = String(userKey).toLowerCase();
    return userKeyNameMap.get(k) || `Unknown (${k})`;
  };

  return {
    ...docRow,
    __Site: docRow.__Site || 'COMMON',

    // Convert userKeys to display names for UI
    PrepressPerson: toName(docRow.EmployeeUserKey),
    ToolingPerson: toName(docRow.ToolingUserKey),
    PlatePerson: toName(docRow.PlateUserKey),
  };
}

// ---------- ers ----------
// Use existing pooled connections from db.js
async function fetchSqlPending(databaseKey, sourceDb) {
  const pool = await getPool(databaseKey); // e.g. 'KOL' or 'AHM'
  const result = await pool.request().execute('GetArtworkApprovalPendingDetails');
  const rs = result.recordset || [];
  // console.log('********************rs', rs);
  
  // Log summary and check for specific IDs
  // console.log(`[FETCH] ${sourceDb} - Total rows from stored proc:`, rs.length);
  if (rs.length > 0) {
    console.log(`[FETCH] ${sourceDb} - First row:`, {
      OrderBookingDetailsID: rs[0].OrderBookingDetailsID,
      MProofApprovalReqd: rs[0].MProofApprovalReqd,
      MProofApprovalStatus: rs[0].MProofApprovalStatus,
      FinallyApproved: rs[0].FinallyApproved,
    });
    
    // Check if row 98 is in the results
    const row98 = rs.find(r => String(r.OrderBookingDetailsID) === '98');
    if (row98) {
      console.log(`[FETCH] ${sourceDb} - Row 98 found in results:`, {
        OrderBookingDetailsID: row98.OrderBookingDetailsID,
        MProofApprovalReqd: row98.MProofApprovalReqd,
        MProofApprovalStatus: row98.MProofApprovalStatus,
        FinallyApproved: row98.FinallyApproved,
      });
    } else {
      console.log(`[FETCH] ${sourceDb} - Row 98 NOT found in stored proc results. Checking if it's filtered out...`);
      // Try direct query to see if row 98 exists and why it might be filtered
      const directQuery = `
        SELECT TOP 1
          OrderBookingDetailsID,
          MProofApprovalReqd, MProofApprovalStatus,
          SoftApprovalReqd, SoftApprovalStatus,
          HardApprovalReqd, HardApprovalStatus,
          FinallyApproved, FinallyApprovedDate
        FROM dbo.ArtworkProcessApproval WITH (NOLOCK)
        WHERE OrderBookingDetailsID = 98;
      `;
      try {
        const directResult = await pool.request().query(directQuery);
        const directRow = directResult.recordset?.[0];
        if (directRow) {
          console.log(`[FETCH] ${sourceDb} - Row 98 exists in table but not in stored proc:`, {
            OrderBookingDetailsID: directRow.OrderBookingDetailsID,
            MProofApprovalReqd: directRow.MProofApprovalReqd,
            MProofApprovalStatus: directRow.MProofApprovalStatus,
            FinallyApproved: directRow.FinallyApproved,
            FinallyApprovedDate: directRow.FinallyApprovedDate,
            reason: 'Stored procedure may be filtering this row based on FinallyApproved or other criteria',
          });
        }
      } catch (err) {
        console.error(`[FETCH] ${sourceDb} - Error checking row 98 directly:`, err.message);
      }
    }
  }
  
  return rs.map((r) => ({ ...r, __SourceDB: sourceDb }));
}

async function fetchMongoPending(db) {
  // Mongo pending logic mirrors SQL:
  // - not finally approved OR tooling/blanket/plate pending

  const docs = await db
    .collection('ArtworkUnordered')
    .find({
      'status.isDeleted': { $ne: true },
      $or: [
        // not finally approved
        { 'finalApproval.approved': { $ne: true } },

        // tooling pending conditions
        { 'tooling.die': { $in: ['REQUIRED', 'ORDERED', 'Required', 'Ordered'] } },
        { 'tooling.block': { $in: ['REQUIRED', 'ORDERED', 'Required', 'Ordered'] } },
        { 'tooling.blanket': { $in: ['REQUIRED', 'Required'] } },

        // plate pending (FIXED)
        { 'plate.output': { $exists: true, $nin: [null, 'DONE', 'Done'] } },
      ],
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  return docs.map((d) => ({
    __SourceDB: 'MONGO_UNORDERED',
    __MongoId: d._id.toString(),
    __Site: d.site || 'COMMON',

    // Map MongoDB fields for column mapping
    SODate: d.createdAt ?? null, // SO Date -> createdAt
    PWONO: d.tokenNumber ?? null, // PWO No -> tokenNumber (UN-XXXXX)
    RefPCC: d.reference ?? null, // Ref P.C.C... -> reference
    Executive: d.executive ?? null, // Executive name from ArtworkUnordered.executive

    ClientName: d.client?.name ?? null,
    JobName: d.job?.jobName ?? null,
    CategoryName: d.job?.category ?? null,
    SegmentName: d.job?.segment ?? null,

    FileStatus:
      (d.artwork?.fileStatus || 'PENDING').toString().toUpperCase() === 'RECEIVED'
        ? 'Received'
        : (d.artwork?.fileStatus || '').toString().toUpperCase() === 'OLD'
          ? 'Old'
          : 'Pending',
    FileReceivedDate: d.artwork?.fileReceivedDate ?? null,

    SoftApprovalReqd: d.approvals?.soft?.required === null || d.approvals?.soft?.required === undefined
      ? null
      : d.approvals?.soft?.required ? 'Yes' : 'No',
    SoftApprovalStatus: d.approvals?.soft?.status ?? null,
    SoftApprovalSentPlanDate: d.approvals?.soft?.planDate ?? null,
    SoftApprovalSentActdate: d.approvals?.soft?.actualDate ?? null,

    HardApprovalReqd: d.approvals?.hard?.required === null || d.approvals?.hard?.required === undefined
      ? null
      : d.approvals?.hard?.required ? 'Yes' : 'No',
    HardApprovalStatus: d.approvals?.hard?.status ?? null,
    HardApprovalSentPlanDate: d.approvals?.hard?.planDate ?? null,
    HardApprovalSentActdate: d.approvals?.hard?.actualDate ?? null,

    MProofApprovalReqd: d.approvals?.machineProof?.required === null || d.approvals?.machineProof?.required === undefined
      ? null
      : d.approvals?.machineProof?.required ? 'Yes' : 'No',
    MProofApprovalStatus: d.approvals?.machineProof?.status ?? null,
    MProofApprovalSentPlanDate: d.approvals?.machineProof?.planDate ?? null,
    MProofApprovalSentActdate: d.approvals?.machineProof?.actualDate ?? null,

    FinallyApproved: d.finalApproval?.approved ? 'Yes' : 'No',
    FinallyApprovedDate: d.finalApproval?.approvedDate ?? null,

    ToolingDie: d.tooling?.die ?? null,
    ToolingBlock: d.tooling?.block ?? null,
    Blanket: d.tooling?.blanket ?? null,
    ToolingBlanketPlan: d.tooling?.planDate ?? null,
    ToolingBlanketActual: d.tooling?.actualDate ?? null,

    PlateOutput: d.plate?.output ?? null,
    PlatePlan: d.plate?.planDate ?? null,
    PlateActual: d.plate?.actualDate ?? null,

    PlateRemark: d.plate?.remark ?? null,
    ToolingRemark: d.tooling?.remark ?? null,
    ArtworkRemark: d.remarks?.artwork ?? null,

    EmployeeUserKey: d.assignedTo?.prepressUserKey ?? null,
    ToolingUserKey: d.assignedTo?.toolingUserKey ?? null,
    PlateUserKey: d.assignedTo?.plateUserKey ?? null,
  }));
}

// ---------- endpoint ----------
router.get('/artwork/pending', async (req, res) => {
  try {
    const db = await getMongoDb();

    // Optional source filter:
    //   ?source=kol       -> only Kolkata SQL
    //   ?source=ahm       -> only Ahmedabad SQL
    //   ?source=mongo     -> only Mongo ArtworkUnordered
    //   ?source=kol,ahm   -> KOL + AHM
    //   (default / missing) -> all three
    const sourceParam = (req.query.source || 'all').toString().toLowerCase();
    const parts = sourceParam.split(',').map(s => s.trim()).filter(Boolean);
    const wantsAll = parts.length === 0 || parts.includes('all');

    const includeKOL = wantsAll || parts.includes('kol');
    const includeAHM = wantsAll || parts.includes('ahm');
    const includeMongo = wantsAll || parts.includes('mongo');

    // Fetch from selected sources in parallel
    const [kolRows, amdRows, mongoRows] = await Promise.all([
      includeKOL ? fetchSqlPending('KOL', 'KOL_SQL') : Promise.resolve([]),
      includeAHM ? fetchSqlPending('AHM', 'AMD_SQL') : Promise.resolve([]),
      includeMongo ? fetchMongoPending(db) : Promise.resolve([]),
    ]);

    // Build ledgerId sets for SQL mapping
    const kolLedgerIds = kolRows.flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);
    const amdLedgerIds = amdRows.flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);

    // Load maps from UserMaster
    const [kolMap, amdMap] = await Promise.all([
      loadUserMaps(db, 'KOLKATA', kolLedgerIds),
      loadUserMaps(db, 'AHMEDABAD', amdLedgerIds),
    ]);

    // Attach mapping to SQL rows
    const kolNorm = kolRows.map((r) => attachSqlUserMapping(r, 'KOLKATA', kolMap));
    const amdNorm = amdRows.map((r) => attachSqlUserMapping(r, 'AHMEDABAD', amdMap));

    // Mongo userKey -> displayName mapping
    const mongoUserKeys = mongoRows
      .flatMap((r) => [r.EmployeeUserKey, r.ToolingUserKey, r.PlateUserKey])
      .filter(Boolean);
    const userKeyNameMap = await loadUserKeyNameMap(db, mongoUserKeys);
    const mongoNorm = mongoRows.map((r) => normalizeMongoRow(r, userKeyNameMap));

    // Combined
    const combined = [...kolNorm, ...amdNorm, ...mongoNorm];

    res.json({
      ok: true,
      count: combined.length,
      data: combined,
      unmapped: {
        kolkata: kolLedgerIds.filter((id) => id && !kolMap.has(Number(id))).map(Number),
        ahmedabad: amdLedgerIds.filter((id) => id && !amdMap.has(Number(id))).map(Number),
      },
    });
  } catch (e) {
    console.error('Error in /api/artwork/pending:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Fetch SQL completed data ----------
async function fetchSqlCompleted(databaseKey, sourceDb) {
  const pool = await getPool(databaseKey); // e.g. 'KOL' or 'AHM'
  const result = await pool.request().execute('GetArtworkApprovalCompletedDetails');
  const rs = result.recordset || [];
  
  console.log(`[FETCH] ${sourceDb} COMPLETED - Total rows from stored proc:`, rs.length);
  
  return rs.map((r) => ({ ...r, __SourceDB: sourceDb }));
}

// ---------- Fetch MongoDB completed data ----------
async function fetchMongoCompleted(db) {
  // Mongo completed logic is the reverse of pending:
  // Pending: not finally approved OR tooling/plate pending
  // Completed: finally approved AND NOT (tooling/plate pending)
  
  const docs = await db
    .collection('ArtworkUnordered')
    .find({
      'status.isDeleted': { $ne: true },
      // Finally approved
      'finalApproval.approved': true,
      // AND NOT (any tooling/plate pending)
      $nor: [
        // Tooling pending conditions (reversed)
        { 'tooling.die': { $in: ['REQUIRED', 'ORDERED', 'Required', 'Ordered'] } },
        { 'tooling.block': { $in: ['REQUIRED', 'ORDERED', 'Required', 'Ordered'] } },
        { 'tooling.blanket': { $in: ['REQUIRED', 'Required'] } },
        // Plate pending (reversed) - exists and is not DONE/Done
        { 
          $and: [
            { 'plate.output': { $exists: true } },
            { 'plate.output': { $nin: [null, 'DONE', 'Done'] } }
          ]
        },
      ],
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  // Use the same mapping function as pending
  return docs.map((d) => ({
    __SourceDB: 'MONGO_UNORDERED',
    __MongoId: d._id.toString(),
    __Site: d.site || 'COMMON',

    // Map MongoDB fields for column mapping
    SODate: d.createdAt ?? null, // SO Date -> createdAt
    PWONO: d.tokenNumber ?? null, // PWO No -> tokenNumber (UN-XXXXX)
    RefPCC: d.reference ?? null, // Ref P.C.C... -> reference

    ClientName: d.client?.name ?? null,
    JobName: d.job?.jobName ?? null,
    CategoryName: d.job?.category ?? null,
    SegmentName: d.job?.segment ?? null,

    FileStatus:
      (d.artwork?.fileStatus || 'PENDING').toString().toUpperCase() === 'RECEIVED'
        ? 'Received'
        : (d.artwork?.fileStatus || '').toString().toUpperCase() === 'OLD'
          ? 'Old'
          : 'Pending',
    FileReceivedDate: d.artwork?.fileReceivedDate ?? null,

    SoftApprovalReqd: d.approvals?.soft?.required === null || d.approvals?.soft?.required === undefined
      ? null
      : d.approvals?.soft?.required ? 'Yes' : 'No',
    SoftApprovalStatus: d.approvals?.soft?.status ?? null,
    SoftApprovalSentPlanDate: d.approvals?.soft?.planDate ?? null,
    SoftApprovalSentActdate: d.approvals?.soft?.actualDate ?? null,

    HardApprovalReqd: d.approvals?.hard?.required === null || d.approvals?.hard?.required === undefined
      ? null
      : d.approvals?.hard?.required ? 'Yes' : 'No',
    HardApprovalStatus: d.approvals?.hard?.status ?? null,
    HardApprovalSentPlanDate: d.approvals?.hard?.planDate ?? null,
    HardApprovalSentActdate: d.approvals?.hard?.actualDate ?? null,

    MProofApprovalReqd: d.approvals?.machineProof?.required === null || d.approvals?.machineProof?.required === undefined
      ? null
      : d.approvals?.machineProof?.required ? 'Yes' : 'No',
    MProofApprovalStatus: d.approvals?.machineProof?.status ?? null,
    MProofApprovalSentPlanDate: d.approvals?.machineProof?.planDate ?? null,
    MProofApprovalSentActdate: d.approvals?.machineProof?.actualDate ?? null,

    FinallyApproved: d.finalApproval?.approved ? 'Yes' : 'No',
    FinallyApprovedDate: d.finalApproval?.approvedDate ?? null,

    ToolingDie: d.tooling?.die ?? null,
    ToolingBlock: d.tooling?.block ?? null,
    Blanket: d.tooling?.blanket ?? null,
    ToolingBlanketPlan: d.tooling?.planDate ?? null,
    ToolingBlanketActual: d.tooling?.actualDate ?? null,

    PlateOutput: d.plate?.output ?? null,
    PlatePlan: d.plate?.planDate ?? null,
    PlateActual: d.plate?.actualDate ?? null,

    PlateRemark: d.plate?.remark ?? null,
    ToolingRemark: d.tooling?.remark ?? null,
    ArtworkRemark: d.remarks?.artwork ?? null,

    EmployeeUserKey: d.assignedTo?.prepressUserKey ?? null,
    ToolingUserKey: d.assignedTo?.toolingUserKey ?? null,
    PlateUserKey: d.assignedTo?.plateUserKey ?? null,
  }));
}

// ---------- Completed endpoint ----------
router.get('/artwork/completed', async (req, res) => {
  try {
    const db = await getMongoDb();

    // Optional source filter (same as pending endpoint):
    //   ?source=kol       -> only Kolkata SQL
    //   ?source=ahm       -> only Ahmedabad SQL
    //   ?source=mongo     -> only Mongo ArtworkUnordered
    //   ?source=kol,ahm   -> KOL + AHM
    //   (default / missing) -> all three
    const sourceParam = (req.query.source || 'all').toString().toLowerCase();
    const parts = sourceParam.split(',').map(s => s.trim()).filter(Boolean);
    const wantsAll = parts.length === 0 || parts.includes('all');

    const includeKOL = wantsAll || parts.includes('kol');
    const includeAHM = wantsAll || parts.includes('ahm');
    const includeMongo = wantsAll || parts.includes('mongo');

    // Fetch from selected sources in parallel
    const [kolRows, amdRows, mongoRows] = await Promise.all([
      includeKOL ? fetchSqlCompleted('KOL', 'KOL_SQL') : Promise.resolve([]),
      includeAHM ? fetchSqlCompleted('AHM', 'AMD_SQL') : Promise.resolve([]),
      includeMongo ? fetchMongoCompleted(db) : Promise.resolve([]),
    ]);

    // Build ledgerId sets for SQL mapping
    const kolLedgerIds = kolRows.flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);
    const amdLedgerIds = amdRows.flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);

    // Load maps from UserMaster
    const [kolMap, amdMap] = await Promise.all([
      loadUserMaps(db, 'KOLKATA', kolLedgerIds),
      loadUserMaps(db, 'AHMEDABAD', amdLedgerIds),
    ]);

    // Attach mapping to SQL rows
    const kolNorm = kolRows.map((r) => attachSqlUserMapping(r, 'KOLKATA', kolMap));
    const amdNorm = amdRows.map((r) => attachSqlUserMapping(r, 'AHMEDABAD', amdMap));

    // Mongo userKey -> displayName mapping
    const mongoUserKeys = mongoRows
      .flatMap((r) => [r.EmployeeUserKey, r.ToolingUserKey, r.PlateUserKey])
      .filter(Boolean);
    const userKeyNameMap = await loadUserKeyNameMap(db, mongoUserKeys);
    const mongoNorm = mongoRows.map((r) => normalizeMongoRow(r, userKeyNameMap));

    // Combined
    const combined = [...kolNorm, ...amdNorm, ...mongoNorm];

    res.json({
      ok: true,
      count: combined.length,
      data: combined,
      unmapped: {
        kolkata: kolLedgerIds.filter((id) => id && !kolMap.has(Number(id))).map(Number),
        ahmedabad: amdLedgerIds.filter((id) => id && !amdMap.has(Number(id))).map(Number),
      },
    });
  } catch (e) {
    console.error('Error in /api/artwork/completed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Combined pending + completed: only specified columns in order ----------
// Exposed as: GET /api/artwork/all (pending + completed, same columns only)
const ARTWORK_ALL_COLUMNS = [
  'LedgerID',
  'ClientName',
  'SONO',
  'SODate',
  'PONo',
  'PODate',
  'JobName',
  'CategoryName',
  'CategoryID',
  'OrderBookingID',
  'OrderBookingDetailsID',
  'PWONO',
  'RefProductMasterCode',
  'PWODate',
  'JobBookingID',
  'PrepressPerson',
  'EmployeeID',
  'FileName',
  'FileReceivedDate',
  'SoftApprovalReqd',
  'SoftApprovalStatus',
  'SoftApprovalSentPlanDate',
  'SoftApprovalSentActdate',
  'LinkofSoftApprovalfile',
  'HardApprovalReqd',
  'HardApprovalStatus',
  'HardApprovalSentPlanDate',
  'HardApprovalSentActdate',
  'MProofApprovalReqd',
  'MProofApprovalStatus',
  'MProofApprovalSentPlanDate',
  'MProofApprovalSentActdate',
  'FinallyApproved',
  'FinallyApprovedDate',
  'ArtworkProcessApprovalID',
  'PlatePerson',
  'ToolingPerson',
  'ToolingDie',
  'ToolingBlock',
  'Blanket',
  'ToolingBlanketPlan',
  'ToolingBlanketActual',
  'PlateOutput',
  'PlatePlan',
  'PlateActual',
  'PlateRemark',
  'ToolingRemark',
  'ArtworkRemark',
  'SegmentName',
];

function toArtworkAllRow(row) {
  const r = row || {};
  const get = (...args) => {
    for (const k of args) {
      if (r[k] !== undefined && r[k] !== null) return r[k];
    }
    return null;
  };
  const getStr = (...args) => {
    const v = get(...args);
    return v === null || v === undefined ? null : String(v);
  };
  const getDate = (...args) => {
    const v = get(...args);
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };

  return {
    LedgerID: get('LedgerID', 'ledgerid', 'LedgerId') ?? null,
    ClientName: getStr('ClientName', 'clientName') ?? null,
    SONO: getStr('SONO', 'SONo', 'SoNo', 'soNo') ?? null,
    SODate: getDate('SODate', 'SoDate', 'soDate') ?? null,
    PONo: getStr('PONo', 'PONumber', 'poNo') ?? null,
    PODate: getDate('PODate', 'PoDate', 'poDate') ?? null,
    JobName: getStr('JobName', 'jobName') ?? null,
    CategoryName: getStr('CategoryName', 'categoryName') ?? null,
    CategoryID: get('CategoryID', 'CategoryId', 'categoryID') ?? null,
    OrderBookingID: get('OrderBookingID', 'OrderBookingId') ?? null,
    OrderBookingDetailsID: get('OrderBookingDetailsID', 'OrderBookingDetailsId') ?? null,
    PWONO: getStr('PWONO', 'PWONo', 'PwoNo', 'pwoNo') ?? null,
    RefProductMasterCode: getStr('RefProductMasterCode', 'RefPCC', 'RefPcc', 'refPCC') ?? null,
    PWODate: getDate('PWODate', 'PwoDate', 'pwoDate') ?? null,
    JobBookingID: get('JobBookingID', 'JobBookingId') ?? null,
    PrepressPerson: getStr('PrepressPerson', 'PrepressPersonName', 'prepressPerson') ?? null,
    EmployeeID: get('EmployeeID', 'EmployeeId', 'employeeID') ?? null,
    FileName: getStr('FileStatus', 'FileName', 'fileName') ?? null,
    FileReceivedDate: getDate('FileReceivedDate', 'FileRcvdDate') ?? null,
    SoftApprovalReqd: getStr('SoftApprovalReqd', 'SoftApprovalRequired') ?? null,
    SoftApprovalStatus: getStr('SoftApprovalStatus') ?? null,
    SoftApprovalSentPlanDate: getDate('SoftApprovalSentPlanDate', 'SoftApprovalPlanDate') ?? null,
    SoftApprovalSentActdate: getDate('SoftApprovalSentActdate', 'SoftApprovalSentActDate') ?? null,
    LinkofSoftApprovalfile: getStr('LinkofSoftApprovalfile', 'SoftApprovalLink') ?? null,
    HardApprovalReqd: getStr('HardApprovalReqd', 'HardApprovalRequired') ?? null,
    HardApprovalStatus: getStr('HardApprovalStatus') ?? null,
    HardApprovalSentPlanDate: getDate('HardApprovalSentPlanDate', 'HardApprovalPlanDate') ?? null,
    HardApprovalSentActdate: getDate('HardApprovalSentActdate', 'HardApprovalSentActDate') ?? null,
    MProofApprovalReqd: getStr('MProofApprovalReqd', 'MProofApprovalRequired') ?? null,
    MProofApprovalStatus: getStr('MProofApprovalStatus') ?? null,
    MProofApprovalSentPlanDate: getDate('MProofApprovalSentPlanDate', 'MProofApprovalPlanDate') ?? null,
    MProofApprovalSentActdate: getDate('MProofApprovalSentActdate', 'MProofApprovalSentActDate') ?? null,
    FinallyApproved: getStr('FinallyApproved') ?? null,
    FinallyApprovedDate: getDate('FinallyApprovedDate', 'FinalApprovalDate') ?? null,
    ArtworkProcessApprovalID: get('ArtworkProcessApprovalID', 'ArtworkProcessApprovalId', 'ID') ?? null,
    PlatePerson: getStr('PlatePerson', 'platePerson') ?? null,
    ToolingPerson: getStr('ToolingPerson', 'toolingPerson') ?? null,
    ToolingDie: getStr('ToolingDie', 'toolingDie') ?? null,
    ToolingBlock: getStr('ToolingBlock', 'toolingBlock') ?? null,
    Blanket: getStr('Blanket', 'blanket') ?? null,
    ToolingBlanketPlan: getDate('ToolingBlanketPlan', 'ToolingBlanketPlanDate') ?? null,
    ToolingBlanketActual: getDate('ToolingBlanketActual', 'ToolingBlanketActualDate') ?? null,
    PlateOutput: getStr('PlateOutput', 'plateOutput') ?? null,
    PlatePlan: getDate('PlatePlan', 'PlatePlanDate') ?? null,
    PlateActual: getDate('PlateActual', 'PlateActualDate') ?? null,
    PlateRemark: getStr('PlateRemark', 'plateRemark') ?? null,
    ToolingRemark: getStr('ToolingRemark', 'toolingRemark') ?? null,
    ArtworkRemark: getStr('ArtworkRemark', 'artworkRemark') ?? null,
    SegmentName: getStr('SegmentName', 'segmentName') ?? null,
  };
}

router.get('/artwork/all', async (req, res) => {
  try {
    const db = await getMongoDb();

    const sourceParam = (req.query.source || 'all').toString().toLowerCase();
    const parts = sourceParam.split(',').map((s) => s.trim()).filter(Boolean);
    const wantsAll = parts.length === 0 || parts.includes('all');
    const includeKOL = wantsAll || parts.includes('kol');
    const includeAHM = wantsAll || parts.includes('ahm');
    const includeMongo = wantsAll || parts.includes('mongo');

    // Fetch sequentially to avoid connection pool race conditions and fluctuating counts:
    // 1) Kolkata (indusdatabase), 2) AHM (indusdatabase2), 3) MongoDB
    let kolPending = [];
    let kolCompleted = [];
    let amdPending = [];
    let amdCompleted = [];
    let mongoPending = [];
    let mongoCompleted = [];

    if (includeKOL) {
      kolPending = await fetchSqlPending('KOL', 'KOL_SQL');
      kolCompleted = await fetchSqlCompleted('KOL', 'KOL_SQL');
    }
    if (includeAHM) {
      amdPending = await fetchSqlPending('AHM', 'AMD_SQL');
      amdCompleted = await fetchSqlCompleted('AHM', 'AMD_SQL');
    }
    if (includeMongo) {
      mongoPending = await fetchMongoPending(db);
      mongoCompleted = await fetchMongoCompleted(db);
    }

    const kolLedgerIds = [
      ...kolPending,
      ...kolCompleted,
    ].flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);
    const amdLedgerIds = [
      ...amdPending,
      ...amdCompleted,
    ].flatMap((r) => [r.EmployeeID, r.ToolingPersonID, r.PlatePersonID]);

    const [kolMap, amdMap] = await Promise.all([
      loadUserMaps(db, 'KOLKATA', kolLedgerIds),
      loadUserMaps(db, 'AHMEDABAD', amdLedgerIds),
    ]);

    const kolPendingNorm = kolPending.map((r) => attachSqlUserMapping(r, 'KOLKATA', kolMap));
    const amdPendingNorm = amdPending.map((r) => attachSqlUserMapping(r, 'AHMEDABAD', amdMap));
    const kolCompletedNorm = kolCompleted.map((r) => attachSqlUserMapping(r, 'KOLKATA', kolMap));
    const amdCompletedNorm = amdCompleted.map((r) => attachSqlUserMapping(r, 'AHMEDABAD', amdMap));

    const mongoUserKeys = [
      ...mongoPending,
      ...mongoCompleted,
    ].flatMap((r) => [r.EmployeeUserKey, r.ToolingUserKey, r.PlateUserKey]).filter(Boolean);
    const userKeyNameMap = await loadUserKeyNameMap(db, mongoUserKeys);
    const mongoPendingNorm = mongoPending.map((r) => normalizeMongoRow(r, userKeyNameMap));
    const mongoCompletedNorm = mongoCompleted.map((r) => normalizeMongoRow(r, userKeyNameMap));

    const combined = [
      ...kolPendingNorm,
      ...amdPendingNorm,
      ...mongoPendingNorm,
      ...kolCompletedNorm,
      ...amdCompletedNorm,
      ...mongoCompletedNorm,
    ];

    const data = combined.map((row) => {
      const out = toArtworkAllRow(row);
      const obj = {};
      for (const key of ARTWORK_ALL_COLUMNS) {
        obj[key] = out[key];
      }
      return obj;
    });

    res.json({
      ok: true,
      count: data.length,
      columns: ARTWORK_ALL_COLUMNS,
      data,
    });
  } catch (e) {
    console.error('Error in /api/artwork/all:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Insert unordered entry (MongoDB only)
// Exposed as: POST /api/artwork/unordered/insert
router.post('/artwork/unordered/insert', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📥 [API REQUEST] POST /api/artwork/unordered/insert');
    console.log('📋 [API] Incoming payload:', JSON.stringify(payload, null, 2));

    // Validate required fields
    if (!payload.clientName || !payload.jobName) {
      return res.status(400).json({ 
        ok: false, 
        error: 'clientName and jobName are required' 
      });
    }

    // Call the insert function
    const result = await insertUnorderedMinimal(payload);
    
    // Handle both old format (string) and new format (object with insertedId and tokenNumber)
    const insertedId = typeof result === 'string' ? result : result.insertedId;
    const tokenNumber = typeof result === 'object' && result.tokenNumber ? result.tokenNumber : null;
    
    console.log('✅ [API] New unordered entry inserted:', insertedId, 'Token:', tokenNumber);

    res.status(201).json({
      ok: true,
      message: 'Entry added successfully',
      insertedId: insertedId,
      tokenNumber: tokenNumber
    });
  } catch (e) {
    console.error('❌ Error in /api/artwork/unordered/insert:', e);
    res.status(500).json({ 
      ok: false, 
      error: e.message || 'Failed to insert entry' 
    });
  }
});

// Get next unordered token number (reserves the next sequence)
// Exposed as: GET /api/artwork/unordered/next-token
router.get('/artwork/unordered/next-token', async (req, res) => {
  try {
    const db = await getMongoDb();
    const counterCollection = db.collection('TokenCounter');

    // Atomically increment sequence (same pattern as getNextTokenNumber in unordered.js)
    await counterCollection.findOneAndUpdate(
      { _id: 'unordered_token' },
      {
        $inc: { sequence: 1 },
        $setOnInsert: { _id: 'unordered_token' }
      },
      {
        upsert: true
      }
    );

    // Read back the updated document to get the current sequence
    const doc = await counterCollection.findOne({ _id: 'unordered_token' });

    const sequence = doc && typeof doc.sequence === 'number' ? doc.sequence : 1;
    const tokenNumber = `UN-${String(sequence).padStart(6, '0')}`;

    res.json({
      ok: true,
      tokenNumber
    });
  } catch (e) {
    console.error('❌ Error in /api/artwork/unordered/next-token:', e);
    res.status(500).json({
      ok: false,
      error: e.message || 'Failed to get next token number'
    });
  }
});

// Get users from MongoDB user collection
// Exposed as: GET /api/artwork/users?site=KOLKATA or ?site=AHMEDABAD
router.get('/artwork/users', async (req, res) => {
  try {
    const db = await getMongoDb();
    const site = req.query.site?.toUpperCase(); // KOLKATA or AHMEDABAD
    
    // Build query: active users, optionally filtered by site
    const query = { active: true };
    
    if (site === 'KOLKATA' || site === 'AHMEDABAD') {
      // Filter by site: user must have this site in their sites array
      query.sites = site;
    }
    
    const users = await db
      .collection('user')
      .find(query, {
        projection: { _id: 1, displayName: 1, sites: 1, erp: 1 }
      })
      .sort({ displayName: 1 })
      .toArray();
    
    // Format response: return userKey, displayName, sites, and ERP data (with ledgerIds)
    const userList = users.map(user => ({
      userKey: user._id,
      displayName: user.displayName,
      sites: user.sites || [],
      erp: user.erp || {} // Include ERP data with ledgerIds for SQL updates
    }));
    
    res.json({
      ok: true,
      data: userList,
      count: userList.length
    });
  } catch (e) {
    console.error('Error in /api/artwork/users:', e);
    res.status(500).json({ 
      ok: false, 
      error: e.message || 'Failed to fetch users' 
    });
  }
});

export default router;

