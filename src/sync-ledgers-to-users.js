// One-time script to sync SQL Server ledger data to MongoDB user collection
// 
// This script:
// 1. Fetches ledgerId and ledgerName from KOL database
// 2. Fetches ledgerId and ledgerName from AHM database
// 3. Detects duplicate ledger names across both databases
// 4. Merges data: if same name exists in both, tags both ledgerIds
// 5. Upserts into MongoDB user collection
//
// Run: node src/sync-ledgers-to-users.js

import { getPool } from './db.js';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env file path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// Default roles for all users
const DEFAULT_ROLES = ['prepress', 'plate', 'tooling'];

// Manual name mappings: Maps KOL ledger name -> AHM ledger name
// Use this when the same person has different names in different databases
const MANUAL_NAME_MAPPINGS = {
  'Deep': 'Dip',  // Kolkata "Deep" maps to Ahmedabad "Dip"
  // Add more mappings as needed:
  // 'KolkataName': 'AhmedabadName',
};

// SQL Query to fetch ledger data for KOL
// Fetches employees from LedgerMaster where:
// - LedgerType starts with 'emp' AND Designation is 'Prepress Executive' OR Designation is 'DESIGNING'
const KOL_LEDGER_QUERY = `
  SELECT 
    LedgerID as ledgerId,
    LedgerName as ledgerName
  FROM LedgerMaster
  WHERE (LedgerType LIKE 'emp%' AND Designation = 'Prepress Executive') 
     OR Designation = 'DESIGNING'
  ORDER BY LedgerName
`;

// SQL Query to fetch ledger data for AHM
// For testing: Only fetch "Debu", "Neel", and "Dip" (for manual mapping with "Deep")
const AHM_LEDGER_QUERY = `
  SELECT 
    LedgerID as ledgerId,
    LedgerName as ledgerName
  FROM LedgerMaster
  WHERE LedgerType LIKE 'emp%'
    AND LedgerName IN ('Debu', 'Neel', 'Dip')
  ORDER BY LedgerName
`;

/**
 * Fetch ledgers from a SQL database
 */
async function fetchLedgersFromSQL(databaseKey) {
  console.log(`\n📊 [${databaseKey}] Fetching ledgers from SQL...`);
  
  try {
    const pool = await getPool(databaseKey);
    
    // Use different query based on database
    const query = databaseKey === 'AHM' ? AHM_LEDGER_QUERY : KOL_LEDGER_QUERY;
    
    if (databaseKey === 'AHM') {
      console.log(`   Using AHM query (testing with "Debu", "Neel", and "Dip" only)`);
    }
    
    const result = await pool.request().query(query);
    
    const ledgers = result.recordset.map(row => ({
      ledgerId: Number(row.ledgerId),
      ledgerName: String(row.ledgerName).trim(),
    }));
    
    console.log(`✅ [${databaseKey}] Found ${ledgers.length} ledgers`);
    
    // Debug: Show all ledger names (especially important for AHM with only 2)
    if (ledgers.length > 0) {
      console.log(`   Ledger names found:`);
      ledgers.forEach(l => {
        console.log(`     - "${l.ledgerName}" (ID: ${l.ledgerId})`);
      });
    }
    
    return ledgers;
  } catch (error) {
    console.error(`❌ [${databaseKey}] Error fetching ledgers:`, error.message);
    throw error;
  }
}

/**
 * Generate userKey from ledger name (lowercase, replace spaces with dots)
 */
function generateUserKey(ledgerName) {
  return String(ledgerName)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9.]/g, '');
}

/**
 * Normalize ledger name for matching (trim, lowercase, remove extra spaces)
 */
function normalizeLedgerName(name) {
  return String(name)
    .trim()
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .toLowerCase();
}

/**
 * Merge ledger data from both databases
 * Returns a Map with ledgerName as key and merged data as value
 */
function mergeLedgerData(kolLedgers, ahmLedgers) {
  console.log('\n🔄 Merging ledger data from both databases...');
  
  const merged = new Map();
  
  // Process KOL ledgers
  console.log(`\n📋 Processing ${kolLedgers.length} KOL ledgers...`);
  for (const ledger of kolLedgers) {
    const normalizedName = normalizeLedgerName(ledger.ledgerName);
    const originalName = String(ledger.ledgerName).trim();
    
    if (!merged.has(normalizedName)) {
      merged.set(normalizedName, {
        ledgerName: originalName, // Keep original casing for display
        kolLedgerId: ledger.ledgerId,
        ahmLedgerId: null,
        sites: [],
      });
    } else {
      // Update existing entry (shouldn't happen in KOL phase, but handle it)
      const existing = merged.get(normalizedName);
      existing.kolLedgerId = ledger.ledgerId;
      console.log(`  ⚠️  Duplicate KOL ledger name: "${originalName}" (LedgerID: ${ledger.ledgerId})`);
    }
    
    const entry = merged.get(normalizedName);
    if (!entry.sites.includes('KOLKATA')) {
      entry.sites.push('KOLKATA');
    }
  }
  
  // Process AHM ledgers
  console.log(`\n📋 Processing ${ahmLedgers.length} AHM ledgers...`);
  let duplicateCount = 0;
  
  for (const ledger of ahmLedgers) {
    const normalizedName = normalizeLedgerName(ledger.ledgerName);
    const originalName = String(ledger.ledgerName).trim();
    
    // Check for manual mappings (reverse lookup: AHM name -> KOL name)
    let mappedKolName = null;
    let matchingKolKey = null;
    
    for (const [kolName, ahmName] of Object.entries(MANUAL_NAME_MAPPINGS)) {
      if (normalizeLedgerName(ahmName) === normalizedName) {
        mappedKolName = kolName;
        matchingKolKey = normalizeLedgerName(kolName);
        console.log(`  🔗 Manual mapping detected: AHM "${originalName}" -> KOL "${kolName}"`);
        break;
      }
    }
    
    // If no manual mapping, try exact name match
    if (!matchingKolKey) {
      matchingKolKey = normalizedName;
    }
    
    if (matchingKolKey && merged.has(matchingKolKey)) {
      // DUPLICATE FOUND - exists in both databases (exact match or manual mapping)!
      const existing = merged.get(matchingKolKey);
      existing.ahmLedgerId = ledger.ledgerId; // Add AHM ledgerId to existing entry
      duplicateCount++;
      
      if (mappedKolName) {
        console.log(`  ✅ MANUAL MAPPING APPLIED: AHM "${originalName}" (ID: ${ledger.ledgerId}) -> KOL "${existing.ledgerName}" (ID: ${existing.kolLedgerId})`);
      } else {
        console.log(`  ✅ Duplicate found: "${originalName}"`);
        console.log(`     - KOL LedgerID: ${existing.kolLedgerId}`);
        console.log(`     - AHM LedgerID: ${ledger.ledgerId}`);
        console.log(`     - Will be merged into single user document`);
      }
      
      // Add AHMEDABAD to sites
      const entry = merged.get(matchingKolKey);
      if (!entry.sites.includes('AHMEDABAD')) {
        entry.sites.push('AHMEDABAD');
      }
    } else {
      // New entry - only exists in AHM (no match found, even with manual mappings)
      merged.set(normalizedName, {
        ledgerName: originalName,
        kolLedgerId: null,
        ahmLedgerId: ledger.ledgerId,
        sites: [],
      });
      
      const entry = merged.get(normalizedName);
      if (!entry.sites.includes('AHMEDABAD')) {
        entry.sites.push('AHMEDABAD');
      }
    }
  }
  
  console.log(`\n✅ Merged ${merged.size} unique ledger names`);
  console.log(`   - ${duplicateCount} exist in BOTH databases (will have both ledgerIds)`);
  console.log(`   - ${Array.from(merged.values()).filter(e => e.kolLedgerId && !e.ahmLedgerId).length} exist only in KOL`);
  console.log(`   - ${Array.from(merged.values()).filter(e => !e.kolLedgerId && e.ahmLedgerId).length} exist only in AHM`);
  
  // Debug: Show entries with both ledgerIds
  const bothDbEntries = Array.from(merged.values()).filter(e => e.kolLedgerId && e.ahmLedgerId);
  if (bothDbEntries.length > 0) {
    console.log(`\n📊 Entries with BOTH ledgerIds (showing all):`);
    bothDbEntries.forEach(entry => {
      console.log(`   - "${entry.ledgerName}": KOL=${entry.kolLedgerId}, AHM=${entry.ahmLedgerId}`);
    });
  } else {
    console.log(`\n⚠️  WARNING: No entries found with both KOL and AHM ledgerIds!`);
  }
  
  // Debug: Check for "Neel" specifically
  const neelEntries = Array.from(merged.entries()).filter(([key, value]) => 
    key.includes('neel') || value.ledgerName.toLowerCase().includes('neel')
  );
  if (neelEntries.length > 0) {
    console.log(`\n🔍 Debug: Found "Neel" entries in merged data:`);
    neelEntries.forEach(([key, value]) => {
      console.log(`   - Normalized key: "${key}"`);
      console.log(`   - Original name: "${value.ledgerName}"`);
      console.log(`   - KOL LedgerID: ${value.kolLedgerId}`);
      console.log(`   - AHM LedgerID: ${value.ahmLedgerId}`);
      console.log(`   - Sites: [${value.sites.join(', ')}]`);
    });
  } else {
    console.log(`\n🔍 Debug: "Neel" not found in merged data. Checking raw data...`);
    const kolNeel = kolLedgers.filter(l => normalizeLedgerName(l.ledgerName).includes('neel'));
    const ahmNeel = ahmLedgers.filter(l => normalizeLedgerName(l.ledgerName).includes('neel'));
    if (kolNeel.length > 0) {
      console.log(`   KOL "Neel" entries:`, kolNeel.map(l => `"${l.ledgerName}" (ID: ${l.ledgerId})`));
    }
    if (ahmNeel.length > 0) {
      console.log(`   AHM "Neel" entries:`, ahmNeel.map(l => `"${l.ledgerName}" (ID: ${l.ledgerId})`));
    }
    if (kolNeel.length > 0 && ahmNeel.length > 0) {
      console.log(`   ⚠️  "Neel" exists in both but didn't merge! Normalized keys:`);
      kolNeel.forEach(l => console.log(`     KOL: "${normalizeLedgerName(l.ledgerName)}"`));
      ahmNeel.forEach(l => console.log(`     AHM: "${normalizeLedgerName(l.ledgerName)}"`));
    }
  }
  
  return merged;
}

/**
 * Upsert user to MongoDB
 */
async function upsertUserToMongo(client, db, userData) {
  const col = db.collection('user');
  const now = new Date();
  
  const doc = {
    _id: userData.userKey,
    displayName: userData.displayName,
    active: true,
    roles: DEFAULT_ROLES,
    sites: userData.sites,
    erp: {
      KOLKATA: {
        ledgerId: userData.kolLedgerId,
      },
      AHMEDABAD: {
        ledgerId: userData.ahmLedgerId,
      },
    },
    email: null,
    phone: null,
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
  
  return {
    upserted: result.upsertedCount > 0,
    modified: result.modifiedCount > 0,
    matched: result.matchedCount > 0,
  };
}

/**
 * Main sync function
 */
async function syncLedgersToUsers() {
  console.log('🚀 Starting ledger sync to MongoDB user collection...\n');
  
  let mongoClient = null;
  
  try {
    // 1. Fetch ledgers from both SQL databases
    console.log('=' .repeat(80));
    console.log('STEP 1: Fetching data from SQL databases');
    console.log('=' .repeat(80));
    
    const kolLedgers = await fetchLedgersFromSQL('KOL');
    const ahmLedgers = await fetchLedgersFromSQL('AHM');
    
    // 2. Merge ledger data
    console.log('\n' + '='.repeat(80));
    console.log('STEP 2: Merging ledger data');
    console.log('='.repeat(80));
    
    const mergedLedgers = mergeLedgerData(kolLedgers, ahmLedgers);
    
    // 3. Connect to MongoDB
    console.log('\n' + '='.repeat(80));
    console.log('STEP 3: Connecting to MongoDB');
    console.log('='.repeat(80));
    
    const uri = process.env.MONGODB_URI_Approval || process.env.MONGODB_URI_APPROVAL;
    if (!uri) {
      throw new Error('Missing MONGODB_URI_Approval environment variable');
    }
    
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
    
    const dbName = uri.split('/').pop().split('?')[0] || 'prepress';
    const db = mongoClient.db(dbName);
    console.log(`✅ Using database: ${dbName}`);
    
    // 4. Upsert users to MongoDB
    console.log('\n' + '='.repeat(80));
    console.log('STEP 4: Upserting users to MongoDB');
    console.log('='.repeat(80));
    
    const entries = Array.from(mergedLedgers.values());
    let upsertedCount = 0;
    let modifiedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const userKey = generateUserKey(entry.ledgerName);
      
      try {
        // Debug: Log "Neel" specifically before upsert
        if (entry.ledgerName.toLowerCase().includes('neel')) {
          console.log(`\n🔍 [DEBUG] About to upsert "Neel":`);
          console.log(`   - Entry:`, JSON.stringify(entry, null, 2));
          console.log(`   - UserKey: ${userKey}`);
          console.log(`   - KOL LedgerID: ${entry.kolLedgerId}`);
          console.log(`   - AHM LedgerID: ${entry.ahmLedgerId}`);
        }
        
        const result = await upsertUserToMongo(mongoClient, db, {
          userKey,
          displayName: entry.ledgerName,
          kolLedgerId: entry.kolLedgerId,
          ahmLedgerId: entry.ahmLedgerId,
          sites: entry.sites,
        });
        
        // Debug: Log result for "Neel"
        if (entry.ledgerName.toLowerCase().includes('neel')) {
          console.log(`   - Upsert result:`, result);
        }
        
        if (result.upserted) {
          upsertedCount++;
          const ledgerInfo = entry.kolLedgerId && entry.ahmLedgerId 
            ? `(KOL:${entry.kolLedgerId}, AHM:${entry.ahmLedgerId})`
            : entry.kolLedgerId 
              ? `(KOL:${entry.kolLedgerId})`
              : `(AHM:${entry.ahmLedgerId})`;
          console.log(`  ✅ [${i + 1}/${entries.length}] Inserted: ${entry.ledgerName} ${ledgerInfo} (${userKey})`);
        } else if (result.modified) {
          modifiedCount++;
          const ledgerInfo = entry.kolLedgerId && entry.ahmLedgerId 
            ? `(KOL:${entry.kolLedgerId}, AHM:${entry.ahmLedgerId})`
            : entry.kolLedgerId 
              ? `(KOL:${entry.kolLedgerId})`
              : `(AHM:${entry.ahmLedgerId})`;
          console.log(`  🔄 [${i + 1}/${entries.length}] Updated: ${entry.ledgerName} ${ledgerInfo} (${userKey})`);
        } else {
          skippedCount++;
          console.log(`  ⏭️  [${i + 1}/${entries.length}] No changes: ${entry.ledgerName} (${userKey})`);
        }
      } catch (error) {
        console.error(`  ❌ [${i + 1}/${entries.length}] Error processing ${entry.ledgerName}:`, error.message);
      }
    }
    
    // 5. Summary
    console.log('\n' + '='.repeat(80));
    console.log('STEP 5: Summary');
    console.log('='.repeat(80));
    console.log(`✅ Total ledgers processed: ${entries.length}`);
    console.log(`   - Inserted (new): ${upsertedCount}`);
    console.log(`   - Updated (existing): ${modifiedCount}`);
    console.log(`   - Skipped (no changes): ${skippedCount}`);
    console.log(`\n🎉 Sync completed successfully!\n`);
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
      console.log('✅ MongoDB connection closed');
    }
  }
}

// Run if executed directly
if (process.argv[1] === __filename || process.argv[1].endsWith('sync-ledgers-to-users.js')) {
  syncLedgersToUsers().catch((error) => {
    console.error('FATAL ERROR:', error);
    process.exit(1);
  });
}

export { syncLedgersToUsers };
