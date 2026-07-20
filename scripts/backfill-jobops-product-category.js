/**
 * Backfill missing productCategory values in JobopsMaster from MSSQL.
 *
 * Run from the backend folder:
 *   node scripts/backfill-jobops-product-category.js --dry-run
 *   node scripts/backfill-jobops-product-category.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import sql from 'mssql';
import { getPool, closeAllPools } from '../src/db.js';
import JobOpsMaster from '../src/models/JobOpsMaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 400;

async function fetchCategories(pool, jobIds) {
  const request = pool.request();
  const placeholders = jobIds.map((jobId, index) => {
    const param = `job${index}`;
    request.input(param, sql.NVarChar(255), jobId);
    return `@${param}`;
  });

  const result = await request.query(`
    SELECT
      JB.JobBookingNo,
      CM.CategoryName
    FROM JobBookingJobCard JB
    LEFT JOIN CategoryMaster CM ON CM.CategoryID = JB.CategoryID
    WHERE JB.JobBookingNo IN (${placeholders.join(', ')})
  `);

  const map = new Map();
  for (const row of result.recordset || []) {
    const jobId = String(row.JobBookingNo || '').trim();
    const productCategory = String(row.CategoryName || '').trim();
    if (jobId) map.set(jobId, productCategory);
  }
  return map;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set in backend/.env');
  }

  if (DRY_RUN) console.log('*** DRY RUN — no MongoDB changes will be written ***');

  await mongoose.connect(process.env.MONGODB_URI);
  const pool = await getPool('KOL');

  try {
    const docs = await JobOpsMaster.find({
      $or: [
        { productCategory: { $exists: false } },
        { productCategory: null },
        { productCategory: '' },
      ],
    }).select('_id jobId productCategory').lean();

    let updated = 0;
    let noJobMatch = 0;
    let blankInErp = 0;

    for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
      const batch = docs.slice(offset, offset + BATCH_SIZE);
      const jobIds = [...new Set(batch.map((doc) => String(doc.jobId || '').trim()).filter(Boolean))];
      const categoryByJobId = await fetchCategories(pool, jobIds);
      const writes = [];

      for (const doc of batch) {
        const jobId = String(doc.jobId || '').trim();
        if (!categoryByJobId.has(jobId)) {
          noJobMatch++;
          continue;
        }

        const productCategory = categoryByJobId.get(jobId);
        if (!productCategory) {
          blankInErp++;
          continue;
        }

        updated++;
        if (DRY_RUN) {
          console.log(`[dry-run] ${jobId}: productCategory -> "${productCategory}"`);
        } else {
          writes.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { productCategory } },
            },
          });
        }
      }

      if (!DRY_RUN && writes.length > 0) {
        await JobOpsMaster.bulkWrite(writes, { ordered: false });
      }

      console.log(`Processed ${Math.min(offset + BATCH_SIZE, docs.length)} / ${docs.length}`);
    }

    console.log('\n--- Summary ---');
    console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
    console.log(`No MSSQL job match: ${noJobMatch}`);
    console.log(`Blank category in MSSQL: ${blankInErp}`);
  } finally {
    await mongoose.disconnect();
    await closeAllPools();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
