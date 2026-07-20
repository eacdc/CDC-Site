/**
 * One-time script to backfill missing/zero unitPrice in the JobopsMaster collection.
 *
 * Why this is needed:
 *   The summary export computes "Total Job Value" as unitPrice * totalQty using the
 *   value stored on each JobopsMaster document. unitPrice is only captured when a job
 *   is first added to JobopsMaster (from the ERP rate at that moment). Jobs added before
 *   the ERP rate was entered were saved with unitPrice = 0, so their Total Job Value
 *   shows 0 even though the rate now exists in MSSQL.
 *
 * What it does:
 *   For every JobopsMaster doc with unitPrice missing or 0 (or ALL docs with --all),
 *   it re-fetches the current rate from MSSQL (dbo.contractor_get_job_details2, same
 *   proc the Add-Ops page uses) and updates unitPrice when a positive rate is found.
 *
 * Run from the backend folder:
 *   node scripts/backfill-jobops-unitprice.js            # backfill zero/missing unitPrice
 *   node scripts/backfill-jobops-unitprice.js --dry-run  # show what would change, no writes
 *   node scripts/backfill-jobops-unitprice.js --all      # re-price EVERY job from MSSQL
 *   node scripts/backfill-jobops-unitprice.js --all --dry-run
 *
 * Requires: .env with MONGODB_URI, and KOL DB (DB_NAME_KOL=IndusEnterprise) credentials
 * with stored procedure dbo.contractor_get_job_details2.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import mongoose from 'mongoose';
import sql from 'mssql';
import { getPool } from '../src/db.js';
import JobOpsMaster from '../src/models/JobOpsMaster.js';

const DRY_RUN = process.argv.includes('--dry-run');
const REPRICE_ALL = process.argv.includes('--all');

async function fetchUnitPriceFromMSSQL(jobNumber) {
  let pool;
  try {
    pool = await getPool('KOL');
  } catch (e) {
    console.error('MSSQL getPool(KOL) failed. Ensure DB_NAME_KOL (e.g. IndusEnterprise) and DB credentials are set in .env:', e.message);
    return null;
  }
  const request = pool.request();
  // The stored proc matches the job number exactly as stored (underscore or slash form),
  // so pass the JobopsMaster jobId as-is.
  request.input('JobBookingNo', sql.NVarChar(255), jobNumber);
  try {
    const result = await request.execute('dbo.contractor_get_job_details2');
    if (!result.recordset || result.recordset.length === 0) return null;
    const row = result.recordset[0];
    const raw = row.UnitPrice ?? row.unitPrice ?? row.unit_price;
    const price = Number(raw);
    if (!Number.isFinite(price)) return null;
    return price;
  } catch (err) {
    console.error(`MSSQL error for job ${jobNumber}:`, err.message);
    return null;
  }
}

async function backfillUnitPrice() {
  const query = REPRICE_ALL
    ? {}
    : {
        $or: [
          { unitPrice: { $in: [0, null] } },
          { unitPrice: { $exists: false } },
        ],
      };

  const cursor = JobOpsMaster.find(query).cursor();

  let updated = 0;   // docs whose unitPrice changed
  let unchanged = 0; // docs where MSSQL rate equals current value (nothing to do)
  let noRate = 0;    // MSSQL returned no/zero rate
  let errors = 0;    // MSSQL/lookup errors or missing jobId

  for await (const doc of cursor) {
    const jobId = doc.jobId;
    if (!jobId) {
      errors++;
      continue;
    }

    const mssqlPrice = await fetchUnitPriceFromMSSQL(jobId);
    if (mssqlPrice == null) {
      errors++;
      console.warn(`  ! No lookup result for jobId=${jobId}`);
      continue;
    }

    if (mssqlPrice <= 0) {
      noRate++;
      console.log(`  - jobId=${jobId}: MSSQL rate is 0/blank, left as-is (current=${doc.unitPrice ?? 0})`);
      continue;
    }

    const current = Number(doc.unitPrice || 0);
    if (Math.abs(current - mssqlPrice) < 1e-9) {
      unchanged++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] jobId=${jobId}: unitPrice ${current} -> ${mssqlPrice}`);
      updated++;
      continue;
    }

    doc.unitPrice = mssqlPrice;
    await doc.save();
    updated++;
    console.log(`jobId=${jobId}: unitPrice ${current} -> ${mssqlPrice}`);
  }

  return { updated, unchanged, noRate, errors };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) console.log('*** DRY RUN — no changes will be written ***');
  console.log(REPRICE_ALL ? 'Mode: re-price ALL jobs' : 'Mode: only zero/missing unitPrice');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected.\n');

  try {
    const result = await backfillUnitPrice();
    console.log('\n--- Summary ---');
    console.log(`Updated:    ${result.updated}`);
    console.log(`Unchanged:  ${result.unchanged} (MSSQL rate matched existing)`);
    console.log(`No rate:    ${result.noRate} (MSSQL rate still 0/blank)`);
    console.log(`Errors:     ${result.errors} (no lookup result / missing jobId)`);
  } finally {
    await mongoose.disconnect();
    console.log('\nMongoDB disconnected. Done.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
