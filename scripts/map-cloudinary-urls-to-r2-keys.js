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

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadInventory(p) {
  if (!p) return null;
  if (!fs.existsSync(p)) {
    console.error(`inventory file not found: ${p}`);
    process.exit(1);
  }
  const keys = new Set();
  const rl = readline.createInterface({
    input: fs.createReadStream(p),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const k = o.key || o.Key || o.object_key || o.name;
      if (k) keys.add(String(k));
    } catch {
      // A plain-text key per line is also accepted.
      keys.add(t);
    }
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
        // The column has no room for a separate key field, so the applied
        // value would be the r2:// ref, not the bare key.
        new_key: key ? `r2://${key}` : '',
        public_id: '',
        public_id_matches: '',
        transformations: transformationSegments(url).join(' '),
        status: key ? 'ok' : isCloudinary ? 'UNPARSED' : 'SKIPPED_NOT_CLOUDINARY',
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
      const bare = row.new_key.replace(/^r2:\/\//, '');
      if (!inventory.has(bare)) row.status = 'MISSING_IN_BUCKET';
    }
  } else {
    console.log('Inventory: not supplied — bucket existence NOT verified (--inventory <path>)');
  }

  const header = [
    'source', 'record_id', 'location', 'field', 'old_value',
    'new_key', 'public_id', 'public_id_matches', 'transformations', 'status',
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

  const failed = unparsed.length > 0 || missing.length > 0;
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
