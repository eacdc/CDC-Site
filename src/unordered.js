// file: unordered.js
// Purpose: Insert an UNORDERED artwork job into MongoDB ArtworkUnordered
//
// npm i mongodb
//
// ENV:
//   MONGODB_URI_Approval=mongodb://...
//
// Run:
//   node src/unordered.js

import { MongoClient } from "mongodb";
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env file path - look in backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const COL_NAME = "ArtworkUnordered";

function bool(v, def = false) {
  if (v === null || v === undefined) return def;
  if (typeof v === "boolean") return v;
  return ["true", "1", "yes", "y"].includes(String(v).toLowerCase());
}

// Helper function to generate next token number (UN-XXXXX)
async function getNextTokenNumber(db) {
  const counterCollection = db.collection('TokenCounter');
  
  // Find and increment the counter atomically
  // NOTE: We only $inc the sequence field. We do NOT also set it in $setOnInsert,
  // otherwise MongoDB throws ConflictingUpdateOperators for the same path.
  await counterCollection.findOneAndUpdate(
    { _id: 'unordered_token' },
    { 
      $inc: { sequence: 1 },
      $setOnInsert: { _id: 'unordered_token' }
    },
    { 
      upsert: true
    }
  );
  
  // After the atomic increment, query the document to get the current sequence value
  // This ensures we always get the correct incremented value
  const doc = await counterCollection.findOne({ _id: 'unordered_token' });
  
  if (!doc || typeof doc.sequence !== 'number') {
    // This should not happen, but if the document doesn't exist or sequence is missing,
    // initialize it to 1
    await counterCollection.updateOne(
      { _id: 'unordered_token' },
      { $set: { sequence: 1 } },
      { upsert: true }
    );
    console.log(`⚠️ [TOKEN] Counter document was missing/invalid, initialized to 1`);
    const tokenNumber = `UN-000001`;
    return tokenNumber;
  }
  
  const sequence = doc.sequence;
  const tokenNumber = `UN-${String(sequence).padStart(6, '0')}`;
  
  console.log(`🔢 [TOKEN] Generated token: ${tokenNumber} (sequence: ${sequence})`);
  
  return tokenNumber;
}

export async function insertUnorderedMinimal(input) {
  const uri = process.env.MONGODB_URI_Approval || process.env.MONGODB_URI_APPROVAL;
  if (!uri) throw new Error("Missing MONGODB_URI_Approval");

  // Use the same database name logic as routes-pending.js
  const MONGO_DB = process.env.MONGO_DB || 'artwork_portal';

  const site = String(input.site || "KOLKATA").toUpperCase();
  const createdBy = input.createdBy || "Coordinator";

  if (!input.clientName) throw new Error("clientName is required");
  if (!input.jobName) throw new Error("jobName is required");
  if (!input.reference) throw new Error("reference is required");
  if (!input.executive) throw new Error("executive is required");

  // Prepress user key - only use if explicitly provided, otherwise null (don't default)
  const prepressUserKey = (input.userKey || input.prepressUserKey) 
    ? String(input.userKey || input.prepressUserKey).toLowerCase() 
    : null;
  // Only use tooling/plate userKey if explicitly provided, otherwise use null (don't default to prepress)
  const toolingUserKey = (input.toolingUserKey && input.toolingUserKey.trim() !== '') 
    ? String(input.toolingUserKey).toLowerCase() 
    : null;
  const plateUserKey = (input.plateUserKey && input.plateUserKey.trim() !== '') 
    ? String(input.plateUserKey).toLowerCase() 
    : null;

  // approvals required flags (optional inputs)
  // If not provided or blank, keep as null (don't default to false)
  // Only set to true/false if explicitly provided as Yes/No
  const softReq = input.softRequired === undefined || input.softRequired === null || input.softRequired === ''
    ? null
    : bool(input.softRequired, false);
  const hardReq = input.hardRequired === undefined || input.hardRequired === null || input.hardRequired === ''
    ? null
    : bool(input.hardRequired, false);
  const mpReq = input.machineProofRequired === undefined || input.machineProofRequired === null || input.machineProofRequired === ''
    ? null
    : bool(input.machineProofRequired, false);

    const now = new Date();

  const doc = {
    site,
    createdBy,
      createdAt: now,
      updatedAt: now,

    client: { name: input.clientName },

      job: {
      jobName: input.jobName,
      category: input.category || null,
      segment: input.segment || null,
      },

      artwork: {
      fileStatus: "PENDING",
      fileReceivedDate: null,
      },

      assignedTo: {
      prepressUserKey: prepressUserKey,
      toolingUserKey: toolingUserKey,
      plateUserKey: plateUserKey,
      },

      approvals: {
        soft: {
        required: softReq,
        status: softReq === null ? null : (softReq ? "Pending" : "Approved"),
        planDate: null,          // blank because file not received
        actualDate: null,
        },
        hard: {
        required: hardReq,
        status: hardReq === null ? null : (hardReq ? "Pending" : "Approved"),
        planDate: null,          // blank because file not received
        actualDate: null,
        },
        machineProof: {
        required: mpReq,
        status: mpReq === null ? null : (mpReq ? "Pending" : "Approved"),
        planDate: null,          // blank because file not received
        actualDate: null,
      },
    },

    finalApproval: { approved: false, approvedDate: null },

    tooling: { die: null, block: null, blanket: null, planDate: null, actualDate: null, remark: input.toolingRemark || null },
    plate: { output: null, planDate: null, actualDate: null, remark: input.plateRemark || null },

    remarks: { artwork: input.artworkRemark || null },

    status: { isDeleted: false, updatedBy: createdBy, updatedAt: now },
    };

    const client = new MongoClient(uri);
    await client.connect();
    try {
      // Use consistent database name (same as routes-pending.js)
      const db = client.db(MONGO_DB);
      const col = db.collection(COL_NAME);

      // Generate unique token number before inserting
      const tokenNumber = await getNextTokenNumber(db);
      
      // Add tokenNumber, reference, and executive to document
      doc.tokenNumber = tokenNumber;
      doc.reference = input.reference;
      doc.executive = input.executive;

      const result = await col.insertOne(doc);

    console.log({
      ok: true,
      insertedId: result.insertedId.toString(),
      tokenNumber: tokenNumber,
      site,
      assignedTo: {
        prepressUserKey: prepressUserKey,
        toolingUserKey: toolingUserKey,
        plateUserKey: plateUserKey,
      },
    });

    // Return both insertedId and tokenNumber
    return {
      insertedId: result.insertedId.toString(),
      tokenNumber: tokenNumber
    };
  } finally {
    await client.close();
  }
}

// ---------------- EXAMPLE RUN ----------------
// To run this file directly: node src/unordered.js
if (process.argv[1] === __filename || process.argv[1].endsWith('unordered.js')) {
// ---------------- EXAMPLE 1: FILE NOT RECEIVED YET ----------------
insertUnorderedMinimal({
    site: "KOLKATA",
    createdBy: "Coordinator",

      clientName: "ABC Publishers",
      jobName: "Carton Rev 04",
      category: "Mono Carton",
      segment: "Packaging",

      // input controls behavior
      fileStatus: "Pending",           // => fileReceivedDate becomes null, plan dates stay null

    assignedTo: {
      prepressUserKey: "biswajit",
      toolingUserKey: "biswajit",
      plateUserKey: "biswajit",
    },

      softRequired: true,
      hardRequired: true,
      machineProofRequired: false,
  
      artworkRemark: "Unordered job created. File not received yet.",
    }).catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
  });
  
    // ---------------- EXAMPLE 2: FILE RECEIVED NOW ----------------
    // Uncomment to test stamping behavior
    
    insertUnorderedMinimal({
      site: "KOLKATA",
      createdBy: "Coordinator",
      clientName: "XYZ Publishers",
      jobName: "Carton Rev 05",
      fileStatus: "Received",          // => fileReceivedDate stamps NOW (if not passed)
      assignedTo: { prepressUserKey: "biswajit", toolingUserKey: "biswajit", plateUserKey: "biswajit" },
      softRequired: true,
      hardRequired: true,
      machineProofRequired: true,
    }).catch(console.error);
    
  }
  