import { Router } from 'express';
import { getPool, sql } from './db.js';
import mongoose from 'mongoose';

const router = Router();
let concernMongoConnPromise = null;

function normalizeDatabase(value) {
  return String(value || '').trim().toUpperCase();
}

function asRequiredString(value, fieldName, maxLen) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(`${fieldName} is required.`);
  }
  return text.slice(0, maxLen);
}

function getMirrorDatabase(database) {
  return database === 'KOL' ? 'AHM' : 'KOL';
}

function getExpectedDbName(database) {
  if (database === 'KOL') return process.env.DB_NAME_KOL || process.env.DB_NAME;
  if (database === 'AHM') return process.env.DB_NAME_AHM;
  return null;
}

function resolveFinancialYear(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

async function getConcernMongoConnection() {
  if (!concernMongoConnPromise) {
    const uri = String(process.env.mongodb_uri_concern || '').trim();
    const dbName = String(process.env.mongo_db_concern || '').trim();
    if (!uri || !dbName) {
      throw new Error('Concern MongoDB config missing (mongodb_uri_concern/mongo_db_concern).');
    }
    concernMongoConnPromise = mongoose.createConnection(uri, { dbName }).asPromise();
  }
  return concernMongoConnPromise;
}

async function getLedgerById(pool, ledgerId) {
  const result = await pool.request()
    .input('LedgerID', sql.Int, ledgerId)
    .query(`
      SELECT TOP 1
        LedgerID,
        LedgerName AS clientname,
        LedgerCodeString AS ledgerCodeString
      FROM LedgerMaster
      WHERE LedgerID = @LedgerID
    `);
  return result.recordset?.[0] || null;
}

async function getLedgerByCode(pool, ledgerCodeString, expectedDbName) {
  if (expectedDbName) {
    const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
    const actualDb = dbCheck.recordset?.[0]?.currentDb;
    if (actualDb !== expectedDbName) {
      console.error('[getLedgerByCode] pool is on wrong database!', {
        expectedDbName,
        actualDb,
        ledgerCodeString
      });
      await pool.request().query(`USE [${expectedDbName}]`);
      console.log(`[getLedgerByCode] forced USE [${expectedDbName}]`);
    } else {
      console.log('[getLedgerByCode] pool db verified', { actualDb, ledgerCodeString });
    }
  }

  const result = await pool.request()
    .input('LedgerCodeString', sql.NVarChar(100), ledgerCodeString)
    .query(`
      SELECT TOP 1
        LedgerID,
        LedgerName AS clientname,
        LedgerCodeString AS ledgerCodeString
      FROM LedgerMaster
      WHERE LedgerCodeString = @LedgerCodeString
        AND IsDeleted = 0
    `);
  console.log('[getLedgerByCode] result', { ledgerCodeString, row: result.recordset?.[0] || null });
  return result.recordset?.[0] || null;
}

async function ensurePoolOnDb(pool, expectedDbName) {
  if (!expectedDbName) return;
  const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
  const actualDb = dbCheck.recordset?.[0]?.currentDb;
  if (actualDb !== expectedDbName) {
    console.error('[ensurePoolOnDb] pool on wrong database — forcing switch', { expectedDbName, actualDb });
    await pool.request().query(`USE [${expectedDbName}]`);
    console.log(`[ensurePoolOnDb] switched to [${expectedDbName}]`);
  }
}

async function getConcernPersonsByLedger(pool, ledgerId, expectedDbName) {
  await ensurePoolOnDb(pool, expectedDbName);
  const result = await pool.request()
    .input('LedgerID', sql.Int, ledgerId)
    .query(`
      SELECT
        ConcernPersonID,
        LedgerID,
        Name,
        Mobile,
        Email,
        FYear,
        Designation,
        ModifiedDate
      FROM ConcernPersonMaster
      WHERE LedgerID = @LedgerID
        AND ISNULL(IsDeleted, 0) = 0
        AND ISNULL(IsDeletedTransaction, 0) = 0
      ORDER BY ModifiedDate DESC, ConcernPersonID DESC
    `);
  return result.recordset || [];
}

async function softDeleteConcernPerson(pool, payload) {
  await ensurePoolOnDb(pool, payload.expectedDbName);
  const result = await pool.request()
    .input('ConcernPersonID', sql.Int, payload.concernPersonId)
    .input('LedgerID', sql.Int, payload.ledgerId)
    .query(`
      UPDATE ConcernPersonMaster
      SET
        IsDeleted = 1,
        IsDeletedTransaction = 1,
        DeletedDate = GETDATE(),
        ModifiedDate = GETDATE(),
        ModifiedBy = 2,
        DeletedBy = 2
      WHERE ConcernPersonID = @ConcernPersonID
        AND LedgerID = @LedgerID
        AND ISNULL(IsDeleted, 0) = 0
        AND ISNULL(IsDeletedTransaction, 0) = 0
    `);
  return (result.rowsAffected?.[0] || 0) > 0;
}

async function hasDuplicateEmail(pool, ledgerId, email, expectedDbName) {
  await ensurePoolOnDb(pool, expectedDbName);
  const duplicateResult = await pool.request()
    .input('LedgerID', sql.Int, ledgerId)
    .input('Email', sql.NVarChar(200), email)
    .query(`
      SELECT TOP 1 ConcernPersonID
      FROM ConcernPersonMaster
      WHERE LedgerID = @LedgerID
        AND LOWER(LTRIM(RTRIM(Email))) = LOWER(LTRIM(RTRIM(@Email)))
        AND ISNULL(IsDeleted, 0) = 0
        AND ISNULL(IsDeletedTransaction, 0) = 0
    `);
  return Boolean(duplicateResult.recordset?.length);
}

async function insertConcernPerson(pool, payload) {
  await ensurePoolOnDb(pool, payload.expectedDbName);
  const insertResult = await pool.request()
    .input('LedgerID', sql.Int, payload.ledgerId)
    .input('Name', sql.NVarChar(200), payload.name)
    .input('Mobile', sql.NVarChar(25), payload.mobile)
    .input('Email', sql.NVarChar(200), payload.email)
    .input('FYear', sql.NVarChar(20), payload.fYear)
    .query(`
      INSERT INTO ConcernPersonMaster (
        CompanyID,
        IsPrimaryConcernPerson,
        UserID,
        LedgerID,
        Name,
        Address1,
        Address2,
        Mobile,
        Email,
        Phone,
        Designation,
        Fax,
        CreatedDate,
        ModifiedDate,
        IsDeleted,
        IsBlocked,
        FYear,
        IsLocked,
        CreatedBy,
        ModifiedBy,
        DeletedBy,
        DeletedDate,
        IsActive,
        IsDeletedTransaction,
        ProductionUnitID,
        IsEmailSend,
        IsWhatsAppSend
      )
      OUTPUT INSERTED.ConcernPersonID AS ConcernPersonID
      VALUES (
        2,
        0,
        2,
        @LedgerID,
        @Name,
        NULL,
        NULL,
        @Mobile,
        @Email,
        NULL,
        'Executive',
        NULL,
        GETDATE(),
        GETDATE(),
        0,
        0,
        @FYear,
        0,
        2,
        2,
        2,
        NULL,
        0,
        0,
        NULL,
        1,
        1
      )
    `);
  return insertResult.recordset?.[0]?.ConcernPersonID ?? null;
}

router.get('/concern-person/clients', async (req, res) => {
  try {
    const database = normalizeDatabase(req.query.database);
    if (database !== 'KOL' && database !== 'AHM') {
      return res.status(400).json({ status: false, error: 'database must be KOL or AHM.' });
    }

    const pool = await getPool(database);
    const result = await pool.request().query(`
      SELECT
        LedgerName AS clientname,
        LedgerCodeString,
        LedgerID
      FROM LedgerMaster
      WHERE LedgerCodeString IS NOT NULL
        AND LedgerGroupID != 3
        AND (ledgertype = 'Sundry Debtors' OR ledgertype = 'Clients')
        AND IsDeleted = 0
      ORDER BY LedgerName
    `);

    return res.json({
      status: true,
      data: result.recordset || []
    });
  } catch (error) {
    console.error('[concern-person] clients lookup failed:', error);
    return res.status(500).json({
      status: false,
      error: error?.message || 'Failed to load clients.'
    });
  }
});

router.get('/concern-person/details', async (req, res) => {
  try {
    console.log('[concern-person/details] request', {
      database: req.query.database,
      ledgerId: req.query.ledgerId,
      ledgerCodeString: req.query.ledgerCodeString
    });

    const database = normalizeDatabase(req.query.database);
    if (database !== 'KOL' && database !== 'AHM') {
      console.warn('[concern-person/details] invalid database', { database: req.query.database });
      return res.status(400).json({ status: false, error: 'database must be KOL or AHM.' });
    }

    const ledgerId = Number.parseInt(String(req.query.ledgerId ?? ''), 10);
    if (Number.isNaN(ledgerId) || ledgerId <= 0) {
      console.warn('[concern-person/details] invalid ledgerId', { ledgerId: req.query.ledgerId });
      return res.status(400).json({ status: false, error: 'ledgerId is required and must be a positive integer.' });
    }
    const ledgerCodeString = String(req.query.ledgerCodeString ?? '').trim();
    if (!ledgerCodeString) {
      console.warn('[concern-person/details] missing ledgerCodeString');
      return res.status(400).json({ status: false, error: 'ledgerCodeString is required.' });
    }

    const mirrorDatabase = getMirrorDatabase(database);
    // Only mirror DB needs a LedgerMaster lookup — selected DB ledgerId comes directly from the dropdown
    const mirrorPool = await getPool(mirrorDatabase);
    const pool = await getPool(database);

    console.log('[concern-person/details] inputs', {
      selectedDatabase: database,
      mirrorDatabase,
      selectedLedgerId: ledgerId,
      ledgerCodeString
    });

    // Mirror: find the LedgerID in the other DB by matching LedgerCodeString
    const mirrorLedger = await getLedgerByCode(mirrorPool, ledgerCodeString, getExpectedDbName(mirrorDatabase));

    console.log('[concern-person/details] mirror ledger resolved', {
      mirrorDatabase,
      mirrorFound: Boolean(mirrorLedger),
      mirrorLedgerId: mirrorLedger?.LedgerID ?? null,
      mirrorClientName: mirrorLedger?.clientname ?? null
    });

    // Fetch concern persons from selected DB using the exact ledgerId from dropdown
    const currentDbRows = await getConcernPersonsByLedger(pool, ledgerId, getExpectedDbName(database));
    // Fetch concern persons from mirror DB using the mirror's own LedgerID
    const mirrorDbRows = mirrorLedger
      ? await getConcernPersonsByLedger(mirrorPool, mirrorLedger.LedgerID, getExpectedDbName(mirrorDatabase))
      : [];

    console.log('[concern-person/details] concern rows count', {
      selectedDatabase: database,
      selectedLedgerId: ledgerId,
      selectedCount: currentDbRows.length,
      mirrorDatabase,
      mirrorLedgerId: mirrorLedger?.LedgerID ?? null,
      mirrorCount: mirrorDbRows.length
    });

    return res.json({
      status: true,
      selectedClient: {
        db: database,
        ledgerId,
        ledgerCodeString
      },
      mirrorLookup: {
        db: mirrorDatabase,
        found: Boolean(mirrorLedger),
        ledgerId: mirrorLedger?.LedgerID ?? null,
        clientname: mirrorLedger?.clientname ?? null
      },
      concernPersons: [
        ...currentDbRows.map((row) => ({ ...row, db: database })),
        ...mirrorDbRows.map((row) => ({ ...row, db: mirrorDatabase }))
      ]
    });
  } catch (error) {
    console.error('[concern-person] details failed:', error);
    return res.status(500).json({
      status: false,
      error: error?.message || 'Failed to load concern person details.'
    });
  }
});

router.post('/concern-person', async (req, res) => {
  try {
    const database = normalizeDatabase(req.body?.database);
    if (database !== 'KOL' && database !== 'AHM') {
      return res.status(400).json({ status: false, error: 'database must be KOL or AHM.' });
    }

    const ledgerId = Number.parseInt(String(req.body?.ledgerId ?? ''), 10);
    if (Number.isNaN(ledgerId) || ledgerId <= 0) {
      return res.status(400).json({ status: false, error: 'ledgerId is required and must be a positive integer.' });
    }

    const name = asRequiredString(req.body?.name, 'name', 200);
    const mobile = asRequiredString(req.body?.mobile, 'mobile', 25);
    const email = asRequiredString(req.body?.email, 'email', 200);
    const ledgerCodeString = String(req.body?.ledgerCodeString ?? '').trim();
    if (!ledgerCodeString) {
      return res.status(400).json({ status: false, error: 'ledgerCodeString is required.' });
    }
    const clientname = String(req.body?.clientname ?? '').trim() || null;
    const fYear = resolveFinancialYear();

    const pool = await getPool(database);
    const mirrorDatabase = getMirrorDatabase(database);
    const mirrorPool = await getPool(mirrorDatabase);
    const selectedExpectedDbName = getExpectedDbName(database);
    const mirrorExpectedDbName = getExpectedDbName(mirrorDatabase);

    // Mirror: look up the other DB by LedgerCodeString to get that DB's own LedgerID
    const mirrorLedger = await getLedgerByCode(mirrorPool, ledgerCodeString, mirrorExpectedDbName);

    // Check existing records before saving to decide message template
    const existingPrimaryRows = await getConcernPersonsByLedger(pool, ledgerId, selectedExpectedDbName);
    const existingMirrorRows = mirrorLedger
      ? await getConcernPersonsByLedger(mirrorPool, mirrorLedger.LedgerID, mirrorExpectedDbName)
      : [];
    const existingCombinedCount = existingPrimaryRows.length + existingMirrorRows.length;

    const primaryDuplicate = await hasDuplicateEmail(pool, ledgerId, email, selectedExpectedDbName);
    if (primaryDuplicate) {
      return res.status(409).json({
        status: false,
        error: 'This email is already added for the selected client.'
      });
    }

    const primaryId = await insertConcernPerson(pool, {
      ledgerId,
      name,
      mobile,
      email,
      fYear,
      expectedDbName: selectedExpectedDbName
    });

    let mirrorLookup = {
      db: mirrorDatabase,
      found: false,
      ledgerId: null,
      clientname: null
    };
    let mirrorSave = {
      status: 'skipped',
      reason: 'mirror client not found',
      concernPersonId: null
    };

    if (mirrorLedger) {
      mirrorLookup = {
        db: mirrorDatabase,
        found: true,
        ledgerId: mirrorLedger.LedgerID,
        clientname: mirrorLedger.clientname || null
      };

      const mirrorDuplicate = await hasDuplicateEmail(mirrorPool, mirrorLedger.LedgerID, email, mirrorExpectedDbName);
      if (mirrorDuplicate) {
        mirrorSave = {
          status: 'skipped',
          reason: 'duplicate email exists in mirror db',
          concernPersonId: null
        };
      } else {
        const mirrorId = await insertConcernPerson(mirrorPool, {
          ledgerId: mirrorLedger.LedgerID,
          name,
          mobile,
          email,
          fYear,
          expectedDbName: mirrorExpectedDbName
        });
        mirrorSave = {
          status: 'saved',
          reason: null,
          concernPersonId: mirrorId
        };
      }
    }

    return res.status(201).json({
      status: true,
      concernPersonId: primaryId,
      clientname: clientname || null,
      ledgerCodeString: ledgerCodeString || null,
      resolvedFYear: fYear,
      primarySave: {
        db: database,
        concernPersonId: primaryId
      },
      templateType: existingCombinedCount === 0 ? 'first' : 'existing',
      mirrorLookup,
      mirrorSave
    });
  } catch (error) {
    console.error('[concern-person] insert failed:', error);
    return res.status(500).json({
      status: false,
      error: error?.message || 'Failed to create concerned person.'
    });
  }
});

router.delete('/concern-person/:concernPersonId', async (req, res) => {
  try {
    const concernPersonId = Number.parseInt(String(req.params.concernPersonId ?? ''), 10);
    if (Number.isNaN(concernPersonId) || concernPersonId <= 0) {
      return res.status(400).json({ status: false, error: 'concernPersonId must be a positive integer.' });
    }

    const database = normalizeDatabase(req.body?.database);
    if (database !== 'KOL' && database !== 'AHM') {
      return res.status(400).json({ status: false, error: 'database must be KOL or AHM.' });
    }

    const ledgerId = Number.parseInt(String(req.body?.ledgerId ?? ''), 10);
    if (Number.isNaN(ledgerId) || ledgerId <= 0) {
      return res.status(400).json({ status: false, error: 'ledgerId is required and must be a positive integer.' });
    }

    const email = asRequiredString(req.body?.email, 'email', 200).toLowerCase();
    const ledgerCodeString = asRequiredString(req.body?.ledgerCodeString, 'ledgerCodeString', 100);

    const pool = await getPool(database);
    const expectedDbName = getExpectedDbName(database);
    const sqlDelete = await softDeleteConcernPerson(pool, { concernPersonId, ledgerId, expectedDbName });
    if (!sqlDelete) {
      return res.status(404).json({
        status: false,
        error: 'Concerned person not found or already deleted.'
      });
    }

    const concernMongo = await getConcernMongoConnection();
    const usersDeleteResult = await concernMongo.collection('users').deleteMany({ email });
    const tenantsDeleteResult = await concernMongo.collection('tenants').deleteMany({
      email,
      customer_key: ledgerCodeString
    });

    return res.json({
      status: true,
      sqlDelete: {
        db: database,
        concernPersonId,
        ledgerId,
        deleted: true
      },
      mongoDeleteUsersCount: usersDeleteResult?.deletedCount || 0,
      mongoDeleteTenantsCount: tenantsDeleteResult?.deletedCount || 0
    });
  } catch (error) {
    console.error('[concern-person] delete failed:', error);
    return res.status(500).json({
      status: false,
      error: error?.message || 'Failed to delete concerned person.'
    });
  }
});

export default router;
