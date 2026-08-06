/**
 * Cloudinary URL → R2 key mapping report (MIGRATION.md section 7).
 *
 * THIS SCRIPT NEVER WRITES. It has no apply mode, no update path, and opens
 * MongoDB and MSSQL read-only. It emits a CSV of proposed old → new mappings
 * for a human to review before anything is changed.
 *
 * Two sources are covered:
 *   1. MongoDB  PurchaseBill.slots.<slot>.pages[].cloudinary_url
 *   2. MSSQL    dbo.JobBookingJobCard.Jobcardproductimg  (KOL, AHM)
 *
 * Run from the backend folder:
 *   node scripts/map-cloudinary-urls-to-r2-keys.js
 *   node scripts/map-cloudinary-urls-to-r2-keys.js --out /tmp/mapping.csv
 *   node scripts/map-cloudinary-urls-to-r2-keys.js --source=mongo
 *   node scripts/map-cloudinary-urls-to-r2-keys.js --inventory ../migration/inventory.jsonl
 *
 * Exit codes:
 *   0  every URL parsed (and, if an inventory was supplied, every key exists)
 *   1  at least one URL could not be parsed, or a key is missing from the
 *      bucket inventory — an unparsed URL is a record you are about to break,
 *      so the run is reported as FAILED and nothing should be applied.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import mongoose from 'mongoose';
import { getPool, closeAllPools } from '../src/db.js';
import { ensurePurchaseBillsReady, closePurchaseBillsMongo, PurchaseBill } from '../src/db-purchase-bills.js';

const SLOT_TYPES = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];
const SQL_DATABASES = ['KOL', 'AHM'];

function argValue(flag, fallback = null) {
  const withEq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT_PATH = argValue('--out', path.join(__dirname, '..', 'r2-key-mapping.csv'));
const INVENTORY_PATH = argValue('--inventory', null);
const SOURCE = argValue('--source', 'all'); // all | mongo | mssql

/**
 * MIGRATION.md section 7, verbatim in behaviour: strip the delivery prefix,
 * any transformation segments, and the version segment. What remains is the
 * public_id with its extension — which is exactly the R2 object key.
 */
export function cloudinaryUrlToKey(url) {
  const m = String(url || '').match(
    /\/(?:image|video|raw)\/(?:upload|private|authenticated)\/(.+)$/,
  );
  if (!m) return null;
  const parts = m[1].split('/');
  // drop transformation segments like "w_500,c_fill,f_auto"
  while (parts.length && /^[a-z]{1,3}_/.test(parts[0])) parts.shift();
  // drop the version segment like "v1712345678"
  if (parts.length && /^v\d+$/.test(parts[0])) parts.shift();
  const key = parts.join('/');
  return key || null;
}

/** Transformation segments carry real information loss; surface them loudly. */
function transformationSegments(url) {
  const m = String(url || '').match(
    /\/(?:image|video|raw)\/(?:upload|private|authenticated)\/(.+)$/,
  );
  if (!m) return [];
  const parts = m[1].split('/');
  const found = [];
  while (parts.length && /^[a-z]{1,3}_/.test(parts[0])) found.push(parts.shift());
  return found;
}

/**
 * Portal-facing URL that would be written into Jobcardproductimg.
 *
 * Mirrors portalViewUrlForKey in src/routes-job-product-image.js — kept inline
 * so this read-only script does not import the route module (and with it
 * multer, mssql and the cloudinary SDK). If the URL shape changes there,
 * change it here too.
 */
function portalViewUrlForKey(key) {
  const base = (process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/job-product-image/view/${Buffer.from(key, 'utf8').toString('base64url')}`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Field names that have been seen to hold the object key. Checked in order.
 * Cloudinary exports tend to use public_id; S3/rclone listings use Key/Path.
 */
const KEY_FIELDS = [
  'key', 'Key', 'object_key', 'objectKey', 'name', 'Name',
  'path', 'Path', 'public_id', 'publicId', 'r2_key', 'object', 'file',
];

/**
 * Returns every form of the key this record could represent.
 *
 * A Cloudinary-style export lists public_id WITHOUT the extension, while the
 * R2 key has it appended (MIGRATION.md section 1). Where a format/extension
 * field is present both forms are registered, so matching succeeds whichever
 * convention the inventory used.
 */
function keysFromRecord(o) {
  if (typeof o === 'string') return [o.trim()].filter(Boolean);
  if (!o || typeof o !== 'object') return [];
  let base = null;
  for (const f of KEY_FIELDS) {
    if (typeof o[f] === 'string' && o[f].trim()) { base = o[f].trim(); break; }
  }
  if (!base) return [];
  const out = [base];
  const fmt = o.format || o.ext || o.extension || o.resource_format;
  if (typeof fmt === 'string' && fmt.trim() && !/\.[^/.]+$/.test(base)) {
    out.push(`${base}.${fmt.trim().replace(/^\./, '')}`);
  }
  return out;
}

/**
 * Accepts JSONL (one object or string per line), a single JSON array, or a
 * plain text file with one key per line.
 *
 * Exits rather than returning an empty set: an inventory that parses to zero
 * keys would mark every record MISSING_IN_BUCKET, which reads exactly like a
 * catastrophic result but means only that the file was not understood.
 */
async function loadInventory(p) {
  if (!p) return null;
  if (!fs.existsSync(p)) {
    console.error(`inventory file not found: ${p}`);
    process.exit(1);
  }

  const keys = new Set();
  const sampleFieldNames = new Set();
  let lines = 0;
  let parsedObjects = 0;

  const raw = fs.readFileSync(p, 'utf8');
  const trimmed = raw.trim();

  // Whole-file JSON: an array, or an object wrapping one.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed);
      const arr = Array.isArray(doc)
        ? doc
        : Array.isArray(doc.objects) ? doc.objects
        : Array.isArray(doc.keys) ? doc.keys
        : Array.isArray(doc.items) ? doc.items
        : Array.isArray(doc.results) ? doc.results
        : null;
      if (arr) {
        for (const rec of arr) {
          parsedObjects += 1;
          if (rec && typeof rec === 'object') {
            Object.keys(rec).forEach((k) => sampleFieldNames.add(k));
          }
          for (const k of keysFromRecord(rec)) keys.add(k);
        }
      }
    } catch {
      // fall through to line-by-line
    }
  }

  if (keys.size === 0) {
    const rl = readline.createInterface({
      input: fs.createReadStream(p),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      lines += 1;
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const o = JSON.parse(t);
          parsedObjects += 1;
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            Object.keys(o).forEach((k) => sampleFieldNames.add(k));
          }
          for (const k of keysFromRecord(o)) keys.add(k);
          continue;
        } catch {
          // not valid JSON — fall through and treat as a plain key
        }
      }
      keys.add(t);
    }
  }

  if (keys.size === 0) {
    console.error(`\nFATAL: inventory file parsed but yielded 0 keys: ${p}`);
    console.error(`  lines read: ${lines}, JSON records parsed: ${parsedObjects}`);
    if (sampleFieldNames.size) {
      console.error(`  field names present: ${[...sampleFieldNames].join(', ')}`);
      console.error(`  none matched a known key field: ${KEY_FIELDS.join(', ')}`);
      console.error('  Add the correct field name to KEY_FIELDS in this script.');
    } else {
      console.error('  No JSON records were parsed. Check the file format.');
    }
    console.error('\nAborting. Continuing would mark every record MISSING_IN_BUCKET,');
    console.error('which would look like data loss but only means the file was not read.\n');
    process.exit(1);
  }

  return keys;
}

async function collectFromMongo(rows) {
  await ensurePurchaseBillsReady();
  const cursor = PurchaseBill.find({}, '_id slots').lean().cursor();
  let bills = 0;
  for await (const bill of cursor) {
    bills += 1;
    for (const slot of SLOT_TYPES) {
      const pages = bill.slots?.[slot]?.pages;
      if (!Array.isArray(pages)) continue;
      for (const page of pages) {
        if (!page?.cloudinary_url) continue;
        const url = String(page.cloudinary_url);
        const key = cloudinaryUrlToKey(url);
        // The stored public_id is an independent witness: key should be
        // public_id + extension. A mismatch means one of them is wrong.
        const pid = page.cloudinary_public_id ? String(page.cloudinary_public_id) : '';
        const keyMinusExt = key ? key.replace(/\.[^/.]+$/, '') : '';
        rows.push({
          source: 'mongo:PurchaseBill',
          record_id: String(bill._id),
          location: `slots.${slot}.pages[page_no=${page.page_no}]`,
          field: 'cloudinary_url',
          old_value: url,
          new_key: key || '',
          r2_key: key || '',
          public_id: pid,
          public_id_matches: key ? String(!pid || keyMinusExt === pid) : '',
          transformations: transformationSegments(url).join(' '),
          status: key ? 'ok' : 'UNPARSED',
        });
      }
    }
  }
  return bills;
}

async function collectFromMssql(rows) {
  let scanned = 0;
  for (const db of SQL_DATABASES) {
    let pool;
    try {
      pool = await getPool(db);
    } catch (e) {
      console.warn(`[${db}] skipped — pool unavailable: ${e.message}`);
      continue;
    }
    // Read-only. Only rows whose stored value is an absolute http(s) URL are
    // candidates; bare filenames belong to the legacy ProductImages path and
    // are not part of this migration.
    const result = await pool.request().query(`
      SELECT JobBookingID, JobBookingNo, Jobcardproductimg
      FROM dbo.JobBookingJobCard
      WHERE ISNULL(IsDeletedTransaction, 0) = 0
        AND ISNULL(IsCancel, 0) = 0
        AND Jobcardproductimg IS NOT NULL
        AND LTRIM(RTRIM(Jobcardproductimg)) <> ''
        AND LOWER(LEFT(LTRIM(RTRIM(Jobcardproductimg)), 4)) = 'http'
    `);
    for (const r of result.recordset || []) {
      scanned += 1;
      const url = String(r.Jobcardproductimg).trim();
      const isCloudinary = /(^|\.)cloudinary\.com\//i.test(url) || url.includes('res.cloudinary.com');
      const key = isCloudinary ? cloudinaryUrlToKey(url) : null;
      rows.push({
        source: `mssql:${db}.JobBookingJobCard`,
        record_id: String(r.JobBookingID),
        location: String(r.JobBookingNo || ''),
        field: 'Jobcardproductimg',
        old_value: url,
        // The column has no room for a separate key field, and the customer
        // portal reads it directly and cannot sign R2 URLs — so the applied
        // value is the portal redirect URL, not the bare key.
        // Without PUBLIC_API_BASE_URL the portal URL cannot be built. Rather
        // than proposing an r2:// value the app would never write (and which
        // would break the portal), mark the row so the run cannot read clean.
        new_key: key ? (portalViewUrlForKey(key) || '') : '',
        r2_key: key || '',
        public_id: '',
        public_id_matches: '',
        transformations: transformationSegments(url).join(' '),
        status: !key
          ? (isCloudinary ? 'UNPARSED' : 'SKIPPED_NOT_CLOUDINARY')
          : (portalViewUrlForKey(key) ? 'ok' : 'NO_PUBLIC_API_BASE_URL'),
      });
    }
  }
  return scanned;
}

async function main() {
  console.log('=== Cloudinary → R2 key mapping (DRY RUN — this script never writes) ===\n');

  const rows = [];
  let mongoBills = 0;
  let sqlRows = 0;

  if (SOURCE === 'all' || SOURCE === 'mongo') {
    try {
      mongoBills = await collectFromMongo(rows);
      console.log(`MongoDB: scanned ${mongoBills} bills`);
    } catch (e) {
      console.error(`MongoDB scan failed: ${e.message}`);
    }
  }
  if (SOURCE === 'all' || SOURCE === 'mssql') {
    try {
      sqlRows = await collectFromMssql(rows);
      console.log(`MSSQL:   scanned ${sqlRows} job-card rows`);
    } catch (e) {
      console.error(`MSSQL scan failed: ${e.message}`);
    }
  }

  const inventory = await loadInventory(INVENTORY_PATH);
  if (inventory) {
    console.log(`Inventory: ${inventory.size} keys loaded from ${INVENTORY_PATH}`);
    for (const row of rows) {
      if (row.status !== 'ok') continue;
      const bare = (row.r2_key || row.new_key).replace(/^r2:\/\//, '');
      if (!inventory.has(bare)) row.status = 'MISSING_IN_BUCKET';
    }
  } else {
    console.log('Inventory: not supplied — bucket existence NOT verified (--inventory <path>)');
  }

  const header = [
    'source', 'record_id', 'location', 'field', 'old_value',
    'new_key', 'r2_key', 'public_id', 'public_id_matches', 'transformations', 'status',
  ];
  const csv = [header.join(',')]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(',')))
    .join('\n');
  fs.writeFileSync(OUT_PATH, `${csv}\n`, 'utf8');

  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const unparsed = rows.filter((r) => r.status === 'UNPARSED');
  const noBase = rows.filter((r) => r.status === 'NO_PUBLIC_API_BASE_URL');
  const missing = rows.filter((r) => r.status === 'MISSING_IN_BUCKET');
  const mismatched = rows.filter((r) => r.public_id_matches === 'false');
  const transformed = rows.filter((r) => r.transformations);

  console.log(`\nCSV written: ${OUT_PATH}`);
  console.log(`Rows: ${rows.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  if (transformed.length) {
    console.log(`\n!! ${transformed.length} URL(s) carry transformation segments.`);
    console.log('   These are photographed tax invoices — the R2 originals are');
    console.log('   unresized, so display sizing must be dropped, not reimplemented.');
    for (const r of transformed.slice(0, 20)) {
      console.log(`   ${r.record_id}  [${r.transformations}]  ${r.old_value}`);
    }
  }
  if (mismatched.length) {
    console.log(`\n!! ${mismatched.length} row(s) where derived key != stored public_id + ext:`);
    for (const r of mismatched.slice(0, 20)) {
      console.log(`   ${r.record_id}  key=${r.new_key}  public_id=${r.public_id}`);
    }
  }
  if (noBase.length) {
    console.log(`\nFAILED: PUBLIC_API_BASE_URL is not set, so the portal URL for`);
    console.log(`  ${noBase.length} job-card row(s) could not be built. The CSV cannot show`);
    console.log('  what would really be written. Set it in .env and re-run.');
  }
  if (unparsed.length) {
    console.log(`\nFAILED: ${unparsed.length} URL(s) could not be parsed. Do not apply.`);
    for (const r of unparsed.slice(0, 50)) {
      console.log(`   ${r.source}  ${r.record_id}  ${r.old_value}`);
    }
  }
  if (missing.length) {
    console.log(`\nFAILED: ${missing.length} key(s) absent from the bucket inventory. Do not apply.`);
    for (const r of missing.slice(0, 50)) {
      console.log(`   ${r.source}  ${r.record_id}  ${r.new_key}`);
    }
  }

  const failed = unparsed.length > 0 || missing.length > 0 || noBase.length > 0;
  console.log(
    failed
      ? '\nResult: FAILED — review the CSV before any apply step is written.'
      : '\nResult: clean — every URL parsed. Review the CSV, then decide on an apply step.',
  );
  console.log('No records were modified. This script has no apply mode by design.');
  return failed ? 1 : 0;
}

// Only run when executed directly, so cloudinaryUrlToKey can be imported and
// unit-tested without opening database connections.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
  .then(async (code) => {
    await closePurchaseBillsMongo().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await closeAllPools().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('Fatal:', err);
    await closePurchaseBillsMongo().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await closeAllPools().catch(() => {});
    process.exit(1);
  });
}
