import { MongoClient } from "mongodb";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env file path - look in backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

async function upsertUser({
  userKey,            // required: "sourav.das"
  displayName,        // required
  active = true,
  kolLedgerId = null, // number or null
  ahmLedgerId = null, // number or null
  roles = [],
  sites = [],
  email = null,
  phone = null,
}) {
  if (!userKey || !displayName) throw new Error("userKey and displayName required");

  const uri = process.env.MONGODB_URI_Approval || process.env.MONGODB_URI_APPROVAL;
  if (!uri) throw new Error("Missing MONGODB_URI_Approval");

  const client = new MongoClient(uri);
  await client.connect();
  try {
    // Extract database name from URI if present, otherwise use default
    const dbName = uri.split('/').pop().split('?')[0] || "prepress";
    const db = client.db(dbName);
    const col = db.collection("user");

    const now = new Date();
    const doc = {
      _id: String(userKey).trim().toLowerCase(),
      displayName: String(displayName).trim(),
      active: !!active,
      roles: Array.isArray(roles) ? roles : [],
      sites: Array.isArray(sites) ? sites : [],
      erp: {
        KOLKATA: { ledgerId: kolLedgerId ? Number(kolLedgerId) : null },
        AHMEDABAD: { ledgerId: ahmLedgerId ? Number(ahmLedgerId) : null },
      },
      email,
      phone,
      updatedAt: now,
    };

    const result = await col.updateOne(
      { _id: doc._id },
      {
        $set: doc,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    console.log({
      ok: true,
      upserted: result.upsertedCount,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      userKey: doc._id,
    });
  } finally {
    await client.close();
  }
}

export { upsertUser };

// ---- EXAMPLE ----
// To run this file directly: node src/upsertUser.js
if (process.argv[1] === __filename || process.argv[1].endsWith('upsertUser.js')) {
  upsertUser({
    userKey: "biswajit",
    displayName: "Biswajit",
    kolLedgerId: 6581,
    ahmLedgerId: 0,
    roles: ["prepress", "plate", "tooling"],
    sites: ["KOLKATA"],
    email: "prepress@cdcprinters.com",
  }).catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
  });
}
