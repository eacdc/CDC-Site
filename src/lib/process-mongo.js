/**
 * Fetches ArtworkUnordered (MongoDB) rows for the Process / Coordinator Checklist sheet.
 * Mirrors the mongo side of GET /api/artwork/all, mapped to GetCoordinatorChecklist columns.
 */
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

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
    mongoClientPromise = MongoClient.connect(MONGO_URI, { maxPoolSize: 10 });
  }
  const client = await mongoClientPromise;
  return client.db(MONGO_DB);
}

async function loadUserKeyNameMap(db, userKeys) {
  const keys = [...new Set((userKeys || []).filter(Boolean).map((x) => String(x).toLowerCase()))];
  const map = new Map();
  if (keys.length === 0) return map;

  const users = await db
    .collection('user')
    .find({ active: true, _id: { $in: keys } }, { projection: { _id: 1, displayName: 1 } })
    .toArray();

  for (const u of users) map.set(u._id, u.displayName);
  return map;
}

function formatDateDDMMYYYY(d) {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function normalizeFileStatus(fileStatus) {
  const s = (fileStatus || 'PENDING').toString().toUpperCase();
  if (s === 'RECEIVED') return 'Received';
  if (s === 'OLD') return 'Old';
  return 'Pending';
}

function normalizeHeaderKey(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function siteFilterForDatabase(database) {
  if (database === 'AHM') {
    return { $in: ['AHMEDABAD', 'Ahmedabad', 'ahmedabad'] };
  }
  return { $in: ['KOLKATA', 'Kolkata', 'kolkata', 'COMMON', 'Common', 'common'] };
}

/**
 * @param {object} mongoRow - normalized row from mapUnorderedDoc
 * @returns {Record<string, string>}
 */
function buildMongoProcessFieldMap(mongoRow) {
  const soDate = mongoRow.createdAt ? new Date(mongoRow.createdAt) : null;
  const fileRcvd = mongoRow.fileReceivedDate ? new Date(mongoRow.fileReceivedDate) : null;

  return {
    clientname: mongoRow.clientName ?? '',
    ponumber: '',
    podate: '',
    saleordernumber: mongoRow.tokenNumber ?? '',
    saleorderdate: soDate && !Number.isNaN(soDate.getTime()) ? formatDateDDMMYYYY(soDate) : '',
    jobcardnumber: '',
    jobcarddate: '',
    division: mongoRow.category ?? mongoRow.segment ?? '',
    filestatus: mongoRow.fileStatus ?? '',
    prepresspersonallocated: mongoRow.prepressPerson ?? '',
    salesemployeeid: '',
    salesname: mongoRow.executive ?? '',
    coordinatoruserid: '',
    coordinatorname: mongoRow.createdBy ?? '',
    paperallocationstatus: '',
    paperallocationdate: '',
    filename: mongoRow.jobName ?? '',
    filereceiveddate: fileRcvd && !Number.isNaN(fileRcvd.getTime()) ? formatDateDDMMYYYY(fileRcvd) : '',
  };
}

/**
 * Maps a normalized mongo row to an array of cell values aligned with SQL headers.
 * @param {string[]} sqlHeaders
 * @param {object} mongoRow
 * @returns {Array<string|number>}
 */
export function mongoRowToProcessCells(sqlHeaders, mongoRow) {
  const fieldMap = buildMongoProcessFieldMap(mongoRow);
  return sqlHeaders.map((h) => {
    const norm = normalizeHeaderKey(h);
    if (Object.prototype.hasOwnProperty.call(fieldMap, norm)) {
      return fieldMap[norm];
    }
    return '';
  });
}

function mapUnorderedDoc(doc, userKeyNameMap) {
  const prepressKey = doc.assignedTo?.prepressUserKey
    ? String(doc.assignedTo.prepressUserKey).toLowerCase()
    : null;
  const prepressPerson = prepressKey
    ? (userKeyNameMap.get(prepressKey) || `Unknown (${prepressKey})`)
    : '';

  return {
    mongoId: doc._id.toString(),
    site: doc.site || 'COMMON',
    createdAt: doc.createdAt ?? null,
    createdBy: doc.createdBy ?? '',
    tokenNumber: doc.tokenNumber ?? '',
    clientName: doc.client?.name ?? '',
    jobName: doc.job?.jobName ?? '',
    category: doc.job?.category ?? '',
    segment: doc.job?.segment ?? '',
    executive: doc.executive ?? '',
    fileStatus: normalizeFileStatus(doc.artwork?.fileStatus),
    fileReceivedDate: doc.artwork?.fileReceivedDate ?? null,
    prepressPerson,
  };
}

/**
 * Fetch unordered artwork jobs from MongoDB for the Process sheet.
 * Excludes jobs already tagged to a SQL job card (tagedJobNo).
 *
 * @param {object} opts
 * @param {'KOL'|'AHM'} opts.database
 * @param {Date} opts.startDate - inclusive start (start of day)
 * @param {Date} opts.endDate - inclusive end (end of day)
 * @returns {Promise<object[]>}
 */
export async function fetchUnorderedForProcess({ database, startDate, endDate }) {
  const db = await getMongoDb();

  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(endDate);
  rangeEnd.setHours(23, 59, 59, 999);

  const docs = await db
    .collection('ArtworkUnordered')
    .find({
      'status.isDeleted': { $ne: true },
      createdAt: { $gte: rangeStart, $lte: rangeEnd },
      site: siteFilterForDatabase(database),
      $or: [
        { tagedJobNo: { $exists: false } },
        { tagedJobNo: null },
        { tagedJobNo: '' },
      ],
    })
    .sort({ createdAt: -1 })
    .toArray();

  const userKeys = docs
    .map((d) => d.assignedTo?.prepressUserKey)
    .filter(Boolean);
  const userKeyNameMap = await loadUserKeyNameMap(db, userKeys);

  return docs.map((d) => mapUnorderedDoc(d, userKeyNameMap));
}
