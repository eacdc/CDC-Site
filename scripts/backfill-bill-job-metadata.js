/**
 * One-time script to backfill missing clientName/jobTitle inside Bill.jobs
 * from JobOpsMaster (jobId = jobNumber).
 *
 * Run from backend folder:
 *   node scripts/backfill-bill-job-metadata.js
 *   node scripts/backfill-bill-job-metadata.js --dry-run
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Bill from '../src/models/Bill.js';
import JobOpsMaster from '../src/models/JobOpsMaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

async function getFallbackMap(jobNumbers) {
  const docs = await JobOpsMaster.find({ jobId: { $in: jobNumbers } })
    .select({ jobId: 1, clientName: 1, jobTitle: 1 })
    .lean();

  const map = {};
  for (const doc of docs) {
    const key = String(doc.jobId || '').trim();
    if (!key) continue;
    map[key] = {
      clientName: String(doc.clientName || '').trim(),
      jobTitle: String(doc.jobTitle || '').trim(),
    };
  }
  return map;
}

async function backfillBills() {
  const bills = await Bill.find({ jobs: { $exists: true, $ne: [] } }).lean();

  const jobNumberSet = new Set();
  for (const bill of bills) {
    for (const job of (bill.jobs || [])) {
      const isAdhoc = !!job.isAdhoc;
      const jobNumber = String(job.jobNumber || '').trim();
      if (!isAdhoc && jobNumber && (isBlank(job.clientName) || isBlank(job.jobTitle))) {
        jobNumberSet.add(jobNumber);
      }
    }
  }

  if (jobNumberSet.size === 0) {
    return { billsScanned: bills.length, billsUpdated: 0, jobRowsUpdated: 0 };
  }

  const fallbackMap = await getFallbackMap([...jobNumberSet]);

  let billsUpdated = 0;
  let jobRowsUpdated = 0;

  for (const bill of bills) {
    let changed = false;
    const updatedJobs = (bill.jobs || []).map((job) => {
      const isAdhoc = !!job.isAdhoc;
      const jobNumber = String(job.jobNumber || '').trim();
      if (isAdhoc || !jobNumber) return job;

      const fallback = fallbackMap[jobNumber];
      if (!fallback) return job;

      const nextClientName = isBlank(job.clientName) ? fallback.clientName : String(job.clientName || '').trim();
      const nextJobTitle = isBlank(job.jobTitle) ? fallback.jobTitle : String(job.jobTitle || '').trim();

      if (
        nextClientName !== String(job.clientName || '').trim() ||
        nextJobTitle !== String(job.jobTitle || '').trim()
      ) {
        changed = true;
        jobRowsUpdated += 1;
        return {
          ...job,
          clientName: nextClientName,
          jobTitle: nextJobTitle,
        };
      }
      return job;
    });

    if (!changed) continue;

    if (DRY_RUN) {
      console.log(`[dry-run] Bill ${bill.billNumber}: would update missing job metadata`);
    } else {
      await Bill.updateOne(
        { _id: bill._id },
        { $set: { jobs: updatedJobs } }
      );
      console.log(`Bill ${bill.billNumber}: updated`);
    }
    billsUpdated += 1;
  }

  return { billsScanned: bills.length, billsUpdated, jobRowsUpdated };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('*** DRY RUN — no changes will be written ***');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');

  try {
    const result = await backfillBills();
    console.log(
      `Backfill complete. Bills scanned: ${result.billsScanned}, bills updated: ${result.billsUpdated}, job rows updated: ${result.jobRowsUpdated}`
    );
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});

