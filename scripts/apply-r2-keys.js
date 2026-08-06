/**
 * Apply the Cloudinary → R2 mapping (MIGRATION.md section 7, apply step).
 *
 * DRY RUN BY DEFAULT. Writes only with --apply, and the MSSQL half needs
 * --confirm-sql on top of that.
 *
 *   node scripts/apply-r2-keys.js                       # plan only, no writes
 *   node scripts/apply-r2-keys.js --source=mongo --apply --inventory <path>
 *   node scripts/apply-r2-keys.js --source=mssql --apply --confirm-sql --inventory <path>
 *   node scripts/apply-r2-keys.js --source=mongo --apply --inventory <path> --limit 25
 *
 * --inventory is REQUIRED for --apply. Writing a key that does not exist in
 * the bucket is the one failure this migration cannot recover from by itself,
 * so the apply path refuses to run without bucket verification.
 *
 * The two halves are deliberately asymmetric, because their risk is:
 *
 *   MongoDB  — ADDITIVE. Sets pages[].r2_key and leaves cloudinary_url
 *              untouched, so USE_R2 remains a true flag flip. Idempotent and
 *              safe to re-run.
 *
 *   MSSQL    — DESTRUCTIVE. dbo.JobBookingJobCard.Jobcardproductimg is a
 *              single column and no schema change is permitted, so the old
 *              Cloudinary URL is OVERWRITTEN. Rollback is therefore a script
 *              run, not a flag flip. Before touching anything this writes a
 *              rollback CSV and a ready-to-run revert .sql; if those cannot be
 *              written, nothing is updated.
 *
 * Because of that asymmetry: run the MongoDB half whenever you like, but hold
 * the MSSQL half until you are ready to stop relying on Cloudinary for job
 * product images. The existing rows keep working until then.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import sql from 'mssql';
import mongoose from 'mongoose';
import { getPool, closeAllPools } from '../src/db.js';
import { ensurePurchaseBillsReady, closePurchaseBillsMongo, PurchaseBill } from '../src/db-purchase-bills.js';
// Single source of truth for both the key derivation and the stored URL shape.
import { cloudinaryUrlToKey } from './map-cloudinary-urls-to-r2-keys.js';
import { portalViewUrlForKey } from '../src/routes-job-product-image.js';

const SLOT_TYPES = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];
const SQL_DATABASES = ['KOL', 'AHM'];

function argValue(flag, fallback = null) {
  const withEq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (f) => process.argv.includes(f);

const APPLY = hasFlag('--apply');
const CONFIRM_SQL = hasFlag('--confirm-sql');
const SOURCE = argValue('--source', 'all');
const INVENTORY_PATH = argValue('--inventory', null);
const LIMIT = Number(argValue('--limit', '0')) || 0;
const OUT_DIR = argValue('--out-dir', path.join(__dirname, '..'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------- inventory

function loadInventoryKeys(p) {
  const keys = new Set();
  const raw = fs.readFileSync(p, 'utf8');
  const push = (rec) => {
    if (typeof rec === 'string') { if (rec.trim()) keys.add(rec.trim()); return; }
    if (!rec || typeof rec !== 'object') return;
    const base =
      rec.key || rec.Key || rec.object_key || rec.objectKey || rec.name || rec.Name ||
      rec.path || rec.Path || rec.public_id || rec.publicId || rec.r2_key || rec.object || rec.file;
    if (typeof base !== 'string' || !base.trim()) return;
    const b = base.trim();
    keys.add(b);
    const fmt = rec.format || rec.ext || rec.extension || rec.resource_format;
    if (typeof fmt === 'string' && fmt.trim() && !/\.[^/.]+$/.test(b)) {
      keys.add(`${b}.${fmt.trim().replace(/^\./, '')}`);
    }
  };

  const t = raw.trim();
  if (t.startsWith('[')) {
    try { JSON.parse(t).forEach(push); } catch { /* fall through */ }
  }
  if (keys.size === 0) {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      if (s.startsWith('{')) {
        try { push(JSON.parse(s)); continue; } catch { /* treat as plain */ }
      }
      push(s);
    }
  }
  return keys;
}

// ------------------------------------------------------------------- output

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const body = [header.join(',')]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(',')))
    .join('\n');
  fs.writeFileSync(file, `${body}\n`, 'utf8');
}

// ------------------------------------------------------------------- mongo

/**
 * Additive: set pages[].r2_key, never clear cloudinary_url. Targets exact
 * array positions so untouched fields are left alone, and skips pages whose
 * r2_key is already correct, making re-runs no-ops.
 */
async function planMongo(inventory) {
  await ensurePurchaseBillsReady();
  const ops = [];
  const rows = [];
  const problems = [];

  const cursor = PurchaseBill.find({}, '_id slots').lean().cursor();
  for await (const bill of cursor) {
    const set = {};
    for (const slot of SLOT_TYPES) {
      const pages = bill.slots?.[slot]?.pages;
      if (!Array.isArray(pages)) continue;
      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        if (!page?.cloudinary_url) continue;
        const key = cloudinaryUrlToKey(String(page.cloudinary_url));
        if (!key) {
          problems.push({ id: String(bill._id), slot, i, reason: 'UNPARSED', value: page.cloudinary_url });
          continue;
        }
        if (inventory && !inventory.has(key)) {
          problems.push({ id: String(bill._id), slot, i, reason: 'MISSING_IN_BUCKET', value: key });
          continue;
        }
        if (page.r2_key === key) continue; // already applied
        set[`slots.${slot}.pages.${i}.r2_key`] = key;
        rows.push({
          record_id: String(bill._id),
          location: `slots.${slot}.pages[${i}]`,
          old_cloudinary_url: page.cloudinary_url,
          new_r2_key: key,
          previous_r2_key: page.r2_key || '',
        });
      }
    }
    if (Object.keys(set).length) {
      ops.push({ updateOne: { filter: { _id: bill._id }, update: { $set: set } } });
    }
    if (LIMIT && ops.length >= LIMIT) break;
  }
  return { ops, rows, problems };
}

async function runMongo(inventory) {
  console.log('\n--- MongoDB: PurchaseBill pages (additive) ---');
  const { ops, rows, problems } = await planMongo(inventory);

  console.log(`pages needing r2_key: ${rows.length} across ${ops.length} bill(s)`);
  if (problems.length) {
    console.log(`problems (skipped): ${problems.length}`);
    for (const p of problems.slice(0, 20)) {
      console.log(`   ${p.reason}  ${p.id}  ${p.slot}[${p.i}]  ${p.value}`);
    }
  }

  const planFile = path.join(OUT_DIR, `r2-apply-mongo-${stamp}.csv`);
  writeCsv(planFile, ['record_id', 'location', 'old_cloudinary_url', 'new_r2_key', 'previous_r2_key'], rows);
  console.log(`plan written: ${planFile}`);

  if (problems.length) {
    console.log('\nRefusing to write: unresolved pages above must be understood first.');
    return { changed: 0, failed: true };
  }
  if (!APPLY) {
    console.log('DRY RUN — no changes written. Re-run with --apply to write.');
    return { changed: 0, failed: false };
  }
  if (!ops.length) {
    console.log('Nothing to do — every page already carries its r2_key.');
    return { changed: 0, failed: false };
  }

  const result = await PurchaseBill.bulkWrite(ops, { ordered: false });
  const modified = result.modifiedCount ?? result.nModified ?? 0;
  console.log(`APPLIED: ${modified} bill document(s) updated, ${rows.length} page key(s) set.`);
  console.log('cloudinary_url left intact on every page — USE_R2 remains a flag flip.');
  return { changed: modified, failed: false };
}

// ------------------------------------------------------------------- mssql

/**
 * Destructive: overwrites Jobcardproductimg. Writes rollback artefacts first,
 * and updates each row only if its current value is still the one that was
 * read, so a concurrent edit is skipped rather than clobbered.
 */
async function runMssql(inventory) {
  console.log('\n--- MSSQL: JobBookingJobCard.Jobcardproductimg (DESTRUCTIVE) ---');

  const planned = [];
  const problems = [];

  for (const db of SQL_DATABASES) {
    let pool;
    try {
      pool = await getPool(db);
    } catch (e) {
      console.warn(`[${db}] skipped — pool unavailable: ${e.message}`);
      continue;
    }
    const result = await pool.request().query(`
      SELECT JobBookingID, Jobcardproductimg
      FROM dbo.JobBookingJobCard
      WHERE ISNULL(IsDeletedTransaction, 0) = 0
        AND ISNULL(IsCancel, 0) = 0
        AND Jobcardproductimg IS NOT NULL
        AND LTRIM(RTRIM(Jobcardproductimg)) <> ''
        AND LOWER(LEFT(LTRIM(RTRIM(Jobcardproductimg)), 4)) = 'http'
    `);
    for (const r of result.recordset || []) {
      const oldValue = String(r.Jobcardproductimg).trim();
      if (!/cloudinary\.com\//i.test(oldValue)) continue; // already migrated or third-party
      const key = cloudinaryUrlToKey(oldValue);
      if (!key) { problems.push({ db, id: r.JobBookingID, reason: 'UNPARSED', value: oldValue }); continue; }
      if (inventory && !inventory.has(key)) {
        problems.push({ db, id: r.JobBookingID, reason: 'MISSING_IN_BUCKET', value: key });
        continue;
      }
      const newValue = portalViewUrlForKey(key);
      if (!newValue) {
        problems.push({ db, id: r.JobBookingID, reason: 'NO_PUBLIC_API_BASE_URL', value: key });
        continue;
      }
      planned.push({ db, job_booking_id: r.JobBookingID, r2_key: key, old_value: oldValue, new_value: newValue });
      if (LIMIT && planned.length >= LIMIT) break;
    }
    if (LIMIT && planned.length >= LIMIT) break;
  }

  console.log(`rows to rewrite: ${planned.length}`);
  if (problems.length) {
    console.log(`problems (skipped): ${problems.length}`);
    for (const p of problems.slice(0, 20)) {
      console.log(`   ${p.reason}  ${p.db}:${p.id}  ${p.value}`);
    }
  }

  // Rollback artefacts, written BEFORE any update.
  const planFile = path.join(OUT_DIR, `r2-apply-mssql-${stamp}.csv`);
  const revertFile = path.join(OUT_DIR, `r2-revert-mssql-${stamp}.sql`);
  writeCsv(planFile, ['db', 'job_booking_id', 'r2_key', 'old_value', 'new_value'], planned);

  const revert = [
    '/* Revert Jobcardproductimg to its pre-migration Cloudinary URLs.',
    `   Generated ${new Date().toISOString()} by scripts/apply-r2-keys.js`,
    '   Each row reverts only if it still holds the migrated value. */',
    '',
  ];
  for (const db of SQL_DATABASES) {
    const rowsFor = planned.filter((p) => p.db === db);
    if (!rowsFor.length) continue;
    revert.push(`USE [${db === 'KOL' ? process.env.DB_NAME_KOL || 'IndusEnterprise' : process.env.DB_NAME_AHM || 'IndusEnterprise2'}];`, 'GO', '');
    for (const p of rowsFor) {
      const oldEsc = p.old_value.replace(/'/g, "''");
      const newEsc = p.new_value.replace(/'/g, "''");
      revert.push(
        `UPDATE dbo.JobBookingJobCard SET Jobcardproductimg = N'${oldEsc}' ` +
        `WHERE JobBookingID = ${Number(p.job_booking_id)} AND Jobcardproductimg = N'${newEsc}';`,
      );
    }
    revert.push('GO', '');
  }
  fs.writeFileSync(revertFile, `${revert.join('\n')}\n`, 'utf8');

  console.log(`plan written:   ${planFile}`);
  console.log(`revert script:  ${revertFile}`);

  if (problems.length) {
    console.log('\nRefusing to write: unresolved rows above must be understood first.');
    return { changed: 0, failed: true };
  }
  if (!APPLY) {
    console.log('DRY RUN — no changes written.');
    return { changed: 0, failed: false };
  }
  if (!CONFIRM_SQL) {
    console.log('\nRefusing to write: this overwrites the only copy of the Cloudinary URL.');
    console.log('Re-run with --confirm-sql once you have read the plan and revert script above.');
    return { changed: 0, failed: true };
  }
  if (!planned.length) {
    console.log('Nothing to do.');
    return { changed: 0, failed: false };
  }

  let changed = 0;
  let skipped = 0;
  for (const p of planned) {
    const pool = await getPool(p.db);
    const rq = pool.request();
    rq.input('Id', sql.Int, Number(p.job_booking_id));
    rq.input('Old', sql.NVarChar(sql.MAX), p.old_value);
    rq.input('New', sql.NVarChar(sql.MAX), p.new_value);
    // Optimistic: only rewrite if the value is still what was read.
    const res = await rq.query(`
      UPDATE dbo.JobBookingJobCard
      SET Jobcardproductimg = @New
      WHERE JobBookingID = @Id
        AND LTRIM(RTRIM(Jobcardproductimg)) = @Old
        AND ISNULL(IsDeletedTransaction, 0) = 0
        AND ISNULL(IsCancel, 0) = 0
    `);
    const ra = Array.isArray(res?.rowsAffected) ? Number(res.rowsAffected[0]) || 0 : 0;
    if (ra > 0) changed += 1;
    else skipped += 1;
  }
  console.log(`APPLIED: ${changed} row(s) rewritten, ${skipped} skipped (changed concurrently or already migrated).`);
  console.log(`To undo: run ${revertFile}`);
  return { changed, failed: false };
}

// -------------------------------------------------------------------- main

async function main() {
  console.log(`=== Apply R2 keys — ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'} ===`);

  if (APPLY && !INVENTORY_PATH) {
    console.error('\n--inventory is required with --apply.');
    console.error('Writing a key that is not in the bucket is the one mistake this');
    console.error('migration cannot undo on its own. Verify first.\n');
    return 1;
  }
  let inventory = null;
  if (INVENTORY_PATH) {
    if (!fs.existsSync(INVENTORY_PATH)) {
      console.error(`inventory file not found: ${INVENTORY_PATH}`);
      return 1;
    }
    inventory = loadInventoryKeys(INVENTORY_PATH);
    if (inventory.size === 0) {
      console.error(`\nFATAL: inventory parsed to 0 keys: ${INVENTORY_PATH}`);
      console.error('Aborting rather than treating every key as missing.\n');
      return 1;
    }
    console.log(`Inventory: ${inventory.size} key forms loaded`);
  } else {
    console.log('Inventory: not supplied — bucket existence NOT verified (dry run only)');
  }

  let failed = false;
  if (SOURCE === 'all' || SOURCE === 'mongo') {
    try {
      const r = await runMongo(inventory);
      failed = failed || r.failed;
    } catch (e) {
      console.error(`MongoDB step failed: ${e.message}`);
      failed = true;
    }
  }
  if (SOURCE === 'all' || SOURCE === 'mssql') {
    try {
      const r = await runMssql(inventory);
      failed = failed || r.failed;
    } catch (e) {
      console.error(`MSSQL step failed: ${e.message}`);
      failed = true;
    }
  }

  console.log(
    failed
      ? '\nResult: INCOMPLETE — see refusals above.'
      : APPLY ? '\nResult: applied.' : '\nResult: dry run complete. Nothing was modified.',
  );
  return failed ? 1 : 0;
}

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
