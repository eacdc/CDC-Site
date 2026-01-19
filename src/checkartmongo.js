import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config(); // loads backend/.env

const uri = process.env.MONGODB_URI_Approval;
const dbName = process.env.MONGO_DB || 'Approval_System';

async function run() {
  if (!uri) {
    console.error('Missing MONGODB_URI_Approval / MONGO_URI / MONGODB_URI');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('ArtworkUnordered');

  const total = await col.countDocuments({});
  const active = await col.countDocuments({ 'status.isDeleted': { $ne: true } });

  console.log('Total docs in ArtworkUnordered:', total);
  console.log('Active docs (status.isDeleted != true):', active);

  await client.close();
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});