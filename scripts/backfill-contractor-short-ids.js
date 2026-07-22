/**
 * Assign unique 3-digit shortIds (001–999) to Contractor docs that lack one.
 * Assigns in creationDate ascending order so older contractors get lower IDs.
 *
 * Run from the backend folder:
 *   node scripts/backfill-contractor-short-ids.js --dry-run
 *   node scripts/backfill-contractor-short-ids.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Contractor from '../src/models/Contractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set in backend/.env');
  }

  if (DRY_RUN) console.log('*** DRY RUN — no MongoDB changes will be written ***');

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const existing = await Contractor.find({ shortId: { $ne: null } })
      .select('shortId name')
      .lean();
    const used = new Set(
      existing.map((c) => Number(c.shortId)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 999),
    );
    console.log(`Already have shortId: ${used.size}`);

    const missing = await Contractor.find({
      $or: [
        { shortId: { $exists: false } },
        { shortId: null },
      ],
    })
      .sort({ creationDate: 1, _id: 1 })
      .select('_id name creationDate isdeleted')
      .lean();

    console.log(`Missing shortId: ${missing.length}`);

    if (missing.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    let next = 1;
    const takeNext = () => {
      while (next <= 999 && used.has(next)) next += 1;
      if (next > 999) {
        throw new Error('Ran out of 3-digit IDs (001–999)');
      }
      const id = next;
      used.add(id);
      next += 1;
      return id;
    };

    const ops = [];
    for (const doc of missing) {
      const shortId = takeNext();
      const padded = String(shortId).padStart(3, '0');
      const status = doc.isdeleted === 1 ? ' [deleted]' : '';
      console.log(`  ${padded}  ←  ${doc.name}${status}`);
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { shortId } },
        },
      });
    }

    if (!DRY_RUN && ops.length) {
      const result = await Contractor.bulkWrite(ops, { ordered: true });
      console.log(`Updated ${result.modifiedCount} contractor(s).`);
    } else {
      console.log(`Would update ${ops.length} contractor(s).`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
