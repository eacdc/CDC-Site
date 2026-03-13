/**
 * One-time script to backfill blank clientName and jobTitle in:
 * - JobopsMaster collection
 * - Bills collection (each job in bill.jobs)
 *
 * Fetches job details from MSSQL (dbo.contractor_get_job_details2) and updates MongoDB.
 *
 * Run from backend folder:
 *   node scripts/backfill-job-details.js          # run backfill
 *   node scripts/backfill-job-details.js --dry-run  # show what would be updated, no writes
 *
 * Requires: .env with MONGODB_URI, and KOL DB (DB_NAME_KOL=IndusEnterprise) with
 * stored procedure dbo.contractor_get_job_details2.
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
import Bill from '../src/models/Bill.js';

const DRY_RUN = process.argv.includes('--dry-run');
const isBlank = (v) => v == null || String(v).trim() === '';

async function fetchJobDetailsFromMSSQL(jobNumber) {
  let pool;
  try {
    pool = await getPool('KOL');
  } catch (e) {
    console.error('MSSQL getPool(KOL) failed. Ensure DB_NAME_KOL (e.g. IndusEnterprise) and DB credentials are set in .env:', e.message);
    return null;
  }
  const request = pool.request();
  request.input('JobBookingNo', sql.NVarChar(255), jobNumber);
  try {
    const result = await request.execute('dbo.contractor_get_job_details2');
    if (!result.recordset || result.recordset.length === 0) return null;
    const row = result.recordset[0];
    return {
      clientName: (row['Client Name'] ?? row.ClientName ?? row.clientName ?? '').toString().trim(),
      jobTitle: (row['Job Title'] ?? row.JobTitle ?? row.jobTitle ?? '').toString().trim(),
      segmentName: (row.SegmentName ?? row.segmentName ?? '').toString().trim()
    };
  } catch (err) {
    console.error(`MSSQL error for job ${jobNumber}:`, err.message);
    return null;
  }
}

async function backfillJobopsMaster() {
  const cursor = JobOpsMaster.find({
    $or: [
      { clientName: { $in: ['', null] } },
      { jobTitle: { $in: ['', null] } },
      { clientName: { $exists: false } },
      { jobTitle: { $exists: false } }
    ]
  }).cursor();

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  for await (const doc of cursor) {
    const jobId = doc.jobId;
    if (!jobId) {
      skipped++;
      continue;
    }
    const details = await fetchJobDetailsFromMSSQL(jobId);
    if (!details) {
      errors++;
      continue;
    }
    if (isBlank(details.clientName) && isBlank(details.jobTitle)) {
      skipped++;
      continue;
    }
    const newClientName = details.clientName || doc.clientName || '';
    const newJobTitle = details.jobTitle || doc.jobTitle || '';
    if (DRY_RUN) {
      console.log(`[dry-run] JobopsMaster would update: jobId=${jobId} clientName="${newClientName}" jobTitle="${newJobTitle}"`);
      updated++;
      continue;
    }
    doc.clientName = newClientName;
    doc.jobTitle = newJobTitle;
    if (details.segmentName) doc.segmentName = details.segmentName;
    await doc.save();
    updated++;
    console.log(`JobopsMaster updated: jobId=${jobId} clientName="${doc.clientName}" jobTitle="${doc.jobTitle}"`);
  }
  return { updated, skipped, errors };
}

async function backfillBills() {
  const bills = await Bill.find({
    $or: [
      { isDeleted: { $ne: 1 } },
      { isDeleted: { $exists: false } }
    ]
  }).lean();

  let billsUpdated = 0;
  let jobsUpdated = 0;
  for (const bill of bills) {
    const jobs = bill.jobs || [];
    let billModified = false;
    const updatedJobs = [];
    for (const job of jobs) {
      const jobNumber = job.jobNumber;
      if (!jobNumber) {
        updatedJobs.push(job);
        continue;
      }
      if (!isBlank(job.clientName) && !isBlank(job.jobTitle)) {
        updatedJobs.push(job);
        continue;
      }
      let details = await fetchJobDetailsFromMSSQL(jobNumber);
      if (!details) {
        const jom = await JobOpsMaster.findOne({ jobId: jobNumber }).lean();
        if (jom) {
          details = {
            clientName: (jom.clientName ?? '').toString().trim(),
            jobTitle: (jom.jobTitle ?? '').toString().trim()
          };
        }
      }
      if (details && (!isBlank(details.clientName) || !isBlank(details.jobTitle))) {
        updatedJobs.push({
          ...job,
          clientName: details.clientName || job.clientName || '',
          jobTitle: details.jobTitle || job.jobTitle || ''
        });
        billModified = true;
        jobsUpdated++;
      } else {
        updatedJobs.push(job);
      }
    }
    if (billModified) {
      if (!DRY_RUN) {
        await Bill.updateOne(
          { billNumber: bill.billNumber },
          { $set: { jobs: updatedJobs } }
        );
      }
      billsUpdated++;
      const count = updatedJobs.filter(j => !isBlank(j.clientName) || !isBlank(j.jobTitle)).length;
      console.log(DRY_RUN ? `[dry-run] Bill ${bill.billNumber}: would update ${count} job(s)` : `Bill ${bill.billNumber}: updated ${count} job(s)`);
    }
  }
  return { billsUpdated, jobsUpdated };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) console.log('*** DRY RUN — no changes will be written ***\n');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected.');

  try {
    console.log('\n--- JobopsMaster backfill ---');
    const jomResult = await backfillJobopsMaster();
    console.log(`JobopsMaster: ${jomResult.updated} updated, ${jomResult.skipped} skipped (no data), ${jomResult.errors} errors.`);

    console.log('\n--- Bills backfill ---');
    const billResult = await backfillBills();
    console.log(`Bills: ${billResult.billsUpdated} bills updated, ${billResult.jobsUpdated} job entries updated.`);
  } finally {
    await mongoose.disconnect();
    console.log('\nMongoDB disconnected. Done.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
