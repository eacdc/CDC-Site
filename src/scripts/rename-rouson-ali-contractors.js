/**
 * One-time migration: rename duplicate "Rouson Ali" contractors across all collections.
 * Run: node src/scripts/rename-rouson-ali-contractors.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const CONTRACTORS = [
  {
    contractorId: 'CTR1766402421268YHAUWU',
    oldName: 'Rouson Ali',
    newName: 'Rouson Ali 1',
  },
  {
    contractorId: 'CTR17676966761481LAHK1',
    oldName: 'Rouson Ali',
    newName: 'Rouson Ali 2',
  },
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log('Connected to', db.databaseName);

  // 1. Update Contractor collection
  for (const c of CONTRACTORS) {
    const result = await db.collection('Contractor').updateOne(
      { contractorId: c.contractorId },
      { $set: { name: c.newName } }
    );
    console.log(`Contractor ${c.contractorId}: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
  }

  // Build job/adhoc sets per contractor from Contractor_WD
  const jobsByContractor = {};
  for (const c of CONTRACTORS) {
    const wdDocs = await db.collection('Contractor_WD').find({ contractorId: c.contractorId }).toArray();
    jobsByContractor[c.contractorId] = {
      jobIds: new Set(wdDocs.filter(d => d.jobId).map(d => String(d.jobId).trim())),
      adhocOrderIds: new Set(wdDocs.filter(d => d.adhocOrderId).map(d => String(d.adhocOrderId).trim())),
      newName: c.newName,
    };
  }

  // 2. Update Bills - match by job numbers or adhoc order ids
  const bills = await db.collection('Bills').find({ contractorName: 'Rouson Ali' }).toArray();
  console.log(`Found ${bills.length} bills with contractorName "Rouson Ali"`);

  for (const bill of bills) {
    const jobNumbers = (bill.jobs || []).map(j => String(j.jobNumber || '').trim()).filter(Boolean);
    const adhocIds = (bill.jobs || []).map(j => String(j.adhocOrderId || '').trim()).filter(Boolean);

    let matchedContractor = null;
    for (const c of CONTRACTORS) {
      const info = jobsByContractor[c.contractorId];
      const jobMatch = jobNumbers.some(jn => info.jobIds.has(jn));
      const adhocMatch = adhocIds.some(id => info.adhocOrderIds.has(id));
      if (jobMatch || adhocMatch) {
        matchedContractor = c;
        break;
      }
    }

    if (!matchedContractor) {
      // Fallback: assign by bill creation date vs contractor creation date
      const contractors = await db.collection('Contractor').find({
        contractorId: { $in: CONTRACTORS.map(c => c.contractorId) },
      }).toArray();
      const billDate = bill.createdAt || bill.updatedAt || new Date(0);
      let closest = contractors[0];
      let minDiff = Infinity;
      for (const contractor of contractors) {
        const diff = Math.abs(new Date(billDate) - new Date(contractor.creationDate));
        if (diff < minDiff) {
          minDiff = diff;
          closest = contractor;
        }
      }
      matchedContractor = CONTRACTORS.find(c => c.contractorId === closest.contractorId);
      console.warn(`Bill ${bill.billNumber}: no job match, assigned by date to ${matchedContractor.newName}`);
    }

    const result = await db.collection('Bills').updateOne(
      { _id: bill._id },
      { $set: { contractorName: matchedContractor.newName } }
    );
    console.log(`Bill ${bill.billNumber} -> ${matchedContractor.newName} (modified=${result.modifiedCount})`);
  }

  // 3. Scan all collections for any remaining "Rouson Ali" string fields
  const collections = await db.listCollections().toArray();
  for (const { name: collName } of collections) {
    if (collName === 'Contractor' || collName === 'Bills') continue;

    const cursor = db.collection(collName).find({
      $or: [
        { name: 'Rouson Ali' },
        { contractorName: 'Rouson Ali' },
        { 'contractorWork.contractor': 'Rouson Ali' },
      ],
    });

    const docs = await cursor.toArray();
    if (docs.length === 0) continue;

    console.log(`Collection ${collName}: ${docs.length} doc(s) with "Rouson Ali"`);

    for (const doc of docs) {
      const updates = {};

      if (doc.name === 'Rouson Ali' && doc.contractorId) {
        const match = CONTRACTORS.find(c => c.contractorId === doc.contractorId);
        if (match) updates.name = match.newName;
      }

      if (doc.contractorName === 'Rouson Ali') {
        const jobNumbers = (doc.jobs || []).map(j => String(j.jobNumber || '').trim()).filter(Boolean);
        const adhocIds = (doc.jobs || []).map(j => String(j.adhocOrderId || '').trim()).filter(Boolean);
        for (const c of CONTRACTORS) {
          const info = jobsByContractor[c.contractorId];
          if (jobNumbers.some(jn => info.jobIds.has(jn)) || adhocIds.some(id => info.adhocOrderIds.has(id))) {
            updates.contractorName = c.newName;
            break;
          }
        }
      }

      if (Array.isArray(doc.contractorWork)) {
        const hasRouson = doc.contractorWork.some(cw => cw.contractor === 'Rouson Ali');
        if (hasRouson) {
          // JobOperation: determine contractor from job link - use Contractor_WD on same job
          let newContractorName = null;
          if (doc.job) {
            const jobOp = doc;
            const jobDoc = await db.collection('jobs').findOne({ _id: jobOp.job }) ||
              await db.collection('Jobs').findOne({ _id: jobOp.job });
            if (jobDoc?.jobNumber) {
              for (const c of CONTRACTORS) {
                if (jobsByContractor[c.contractorId].jobIds.has(String(jobDoc.jobNumber).trim())) {
                  newContractorName = c.newName;
                  break;
                }
              }
            }
          }
          if (newContractorName) {
            updates.contractorWork = doc.contractorWork.map(cw =>
              cw.contractor === 'Rouson Ali' ? { ...cw, contractor: newContractorName } : cw
            );
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.collection(collName).updateOne({ _id: doc._id }, { $set: updates });
        console.log(`  Updated ${collName} doc ${doc._id}`);
      }
    }
  }

  // 4. JobOperation collection (mongoose default lowercase plural)
  for (const collName of ['joboperations', 'JobOperations']) {
    const jobOps = await db.collection(collName).find({
      'contractorWork.contractor': 'Rouson Ali',
    }).toArray();

    for (const jobOp of jobOps) {
      let newName = null;
      const jobDoc = jobOp.job
        ? await db.collection('jobs').findOne({ _id: jobOp.job })
        : null;
      const jobNumber = jobDoc?.jobNumber ? String(jobDoc.jobNumber).trim() : null;

      if (jobNumber) {
        for (const c of CONTRACTORS) {
          if (jobsByContractor[c.contractorId].jobIds.has(jobNumber)) {
            newName = c.newName;
            break;
          }
        }
      }

      if (newName) {
        const updatedWork = jobOp.contractorWork.map(cw =>
          cw.contractor === 'Rouson Ali' ? { ...cw, contractor: newName } : cw
        );
        await db.collection(collName).updateOne(
          { _id: jobOp._id },
          { $set: { contractorWork: updatedWork } }
        );
        console.log(`JobOperation ${jobOp._id} contractorWork -> ${newName}`);
      } else {
        console.warn(`JobOperation ${jobOp._id}: could not determine contractor for rename`);
      }
    }
  }

  // Final verification
  const remaining = {};
  for (const { name: collName } of collections) {
    const count = await db.collection(collName).countDocuments({
      $or: [
        { name: 'Rouson Ali' },
        { contractorName: 'Rouson Ali' },
        { 'contractorWork.contractor': 'Rouson Ali' },
      ],
    });
    if (count > 0) remaining[collName] = count;
  }

  if (Object.keys(remaining).length > 0) {
    console.warn('Remaining "Rouson Ali" references:', remaining);
  } else {
    console.log('✅ No remaining "Rouson Ali" references found.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
