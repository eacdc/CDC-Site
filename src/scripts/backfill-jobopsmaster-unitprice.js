import dotenv from 'dotenv';
import mongoose from 'mongoose';
import JobOpsMaster from '../models/JobOpsMaster.js';

dotenv.config();
let closeAllPoolsFn = async () => {};

function parseArgs(argv) {
  const args = {
    dryRun: false,
    onlyMissing: false,
    database: 'KOL',
    limit: 0,
    mongoUri: '',
    envFile: '',
  };

  for (const rawArg of argv) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--only-missing') args.onlyMissing = true;
    else if (arg.startsWith('--database=')) args.database = arg.split('=')[1] || 'KOL';
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1] || 0);
    else if (arg.startsWith('--mongo-uri=')) args.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg.startsWith('--env-file=')) args.envFile = arg.slice('--env-file='.length);
  }

  args.database = String(args.database || 'KOL').toUpperCase();
  if (!['KOL', 'AHM'].includes(args.database)) {
    throw new Error(`Invalid --database value: ${args.database}. Use KOL or AHM.`);
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`Invalid --limit value: ${args.limit}`);
  }

  return args;
}

function getMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    ''
  );
}

function getUnitPriceFromRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const candidates = [
    record.UnitPrice,
    record.unitPrice,
    record.unit_price,
    record['Unit Price'],
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return null;
}

async function fetchUnitPriceFromMssql(pool, sqlModule, jobId) {
  const request = pool.request();
  request.input('JobBookingNo', sqlModule.NVarChar(255), String(jobId));
  const result = await request.execute('dbo.contractor_get_job_details2');
  const firstRow = result?.recordset?.[0];
  return getUnitPriceFromRecord(firstRow);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envFile) {
    dotenv.config({ path: args.envFile });
  }

  const mongoUri = args.mongoUri || getMongoUri();
  if (!mongoUri) {
    throw new Error('Missing Mongo connection string. Set MONGODB_URI/MONGO_URI, or pass --mongo-uri=...');
  }

  // Import db helpers only after env is finalized, so db.js reads correct vars.
  const { getPool, closeAllPools, sql } = await import('../db.js');
  closeAllPoolsFn = closeAllPools;

  await mongoose.connect(mongoUri);
  const mssqlPool = await getPool(args.database);

  const query = args.onlyMissing
    ? { $or: [{ unitPrice: { $exists: false } }, { unitPrice: null }, { unitPrice: 0 }] }
    : {};

  let docs = await JobOpsMaster.find(query, { _id: 1, jobId: 1, unitPrice: 1 }).lean();
  if (args.limit > 0) docs = docs.slice(0, args.limit);

  console.log(`[backfill-unitprice] found ${docs.length} JobOpsMaster docs`);
  console.log(`[backfill-unitprice] options:`, args);

  const bulkOps = [];
  let scanned = 0;
  let matched = 0;
  let skippedNoPrice = 0;
  let failed = 0;

  for (const doc of docs) {
    scanned += 1;
    const jobId = String(doc.jobId || '').trim();
    if (!jobId) {
      skippedNoPrice += 1;
      continue;
    }

    try {
      const unitPrice = await fetchUnitPriceFromMssql(mssqlPool, sql, jobId);
      if (unitPrice == null) {
        skippedNoPrice += 1;
        continue;
      }
      matched += 1;

      bulkOps.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { unitPrice } },
        },
      });
    } catch (error) {
      failed += 1;
      console.warn(`[backfill-unitprice] failed jobId=${jobId}: ${error.message}`);
    }
  }

  if (args.dryRun) {
    console.log(`[backfill-unitprice] dry-run complete. Prepared updates: ${bulkOps.length}`);
  } else if (bulkOps.length > 0) {
    const writeResult = await JobOpsMaster.bulkWrite(bulkOps, { ordered: false });
    console.log(`[backfill-unitprice] bulkWrite result:`, {
      matchedCount: writeResult.matchedCount,
      modifiedCount: writeResult.modifiedCount,
      upsertedCount: writeResult.upsertedCount,
    });
  } else {
    console.log('[backfill-unitprice] no updates to apply.');
  }

  console.log('[backfill-unitprice] summary:', {
    scanned,
    matchedFromMssql: matched,
    skippedNoPrice,
    failed,
    preparedUpdates: bulkOps.length,
    dryRun: args.dryRun,
  });
}

run()
  .then(async () => {
    await closeAllPoolsFn().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[backfill-unitprice] fatal:', error);
    await closeAllPoolsFn().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });

