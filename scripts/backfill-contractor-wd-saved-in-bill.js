/**
 * One-time backfill: set savedInBill = 'Yes' on legacy Contractor_WD opsDone
 * entries that predate the field. Leaves explicit savedInBill: 'No' unchanged.
 *
 * Usage:
 *   npm run backfill-contractor-wd-saved-in-bill:dry-run
 *   npm run backfill-contractor-wd-saved-in-bill
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/contractor-po-system';

function needsBackfill(od) {
  const val = String(od?.savedInBill ?? '').trim();
  return val !== 'Yes' && val !== 'No';
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB${dryRun ? ' (dry run)' : ''}`);

  const col = mongoose.connection.collection('Contractor_WD');
  const cursor = col.find({});

  let docsUpdated = 0;
  let opsUpdated = 0;

  for await (const doc of cursor) {
    const opsDone = doc.opsDone || [];
    let changed = false;

    for (const od of opsDone) {
      if (needsBackfill(od)) {
        od.savedInBill = 'Yes';
        opsUpdated++;
        changed = true;
      }
    }

    if (changed) {
      docsUpdated++;
      if (!dryRun) {
        await col.updateOne({ _id: doc._id }, { $set: { opsDone } });
      }
    }
  }

  console.log(`Documents ${dryRun ? 'that would be ' : ''}updated: ${docsUpdated}`);
  console.log(`opsDone entries ${dryRun ? 'that would be ' : ''}set to savedInBill:'Yes': ${opsUpdated}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
