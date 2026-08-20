/**
 * Site-scoped MSSQL access for the Supplier Portal.
 *
 * Kolkata (Tangra + Panchla) is `IndusEnterprise`; Ahmedabad is
 * `IndusEnterprise2`. They are separate databases with separate ID spaces —
 * ItemID, LedgerID, WarehouseID, UserID and voucher sequences all differ.
 *
 * Two rules this module exists to enforce:
 *
 *  1. `site` is never optional and never defaults. A silent fallback to
 *     Kolkata writes an Ahmedabad GRN into the wrong database, and nothing
 *     downstream would notice.
 *  2. A read path must be physically unable to write. Reads go through the
 *     backend's shared read pools; writes use a separate login with insert and
 *     update on the receiving tables only. A stray UPDATE in a report then
 *     fails on permissions instead of succeeding.
 *
 * Read pooling is delegated to the shared `db.js`, which already handles pool
 * health, idle close and recreate-on-dead-socket. The write pools are held
 * here because they need different credentials.
 */

import { getPool, getLongQueryPool, sql } from '../../db.js';
import { SITES } from '../config/constants.js';

/**
 * Assert a caller passed a real site. Exported because service functions take
 * `site` as their first argument and should fail at their own boundary rather
 * than several frames deeper.
 */
export function assertSite(site) {
  if (!site || !SITES.includes(site)) {
    throw new Error(
      `A valid site is required (${SITES.join(' | ')}); received ${JSON.stringify(site)}. ` +
      'Site must never default — Kolkata and Ahmedabad are different databases.',
    );
  }
  return site;
}

/** The database name behind a site, for logging and connection checks. */
export function databaseFor(site) {
  assertSite(site);
  const name = site === 'KOL'
    ? (process.env.DB_NAME_KOL || process.env.DB_NAME)
    : process.env.DB_NAME_AHM;
  if (!name) {
    throw new Error(
      `No database configured for site ${site}. Set ${site === 'KOL' ? 'DB_NAME_KOL' : 'DB_NAME_AHM'}.`,
    );
  }
  return name;
}

// ── Write pools ─────────────────────────────────────────────────────────────
// Cached per site. Kept deliberately small: the only writer is the receiving
// module, which posts one document set at a time.

const writePools = new Map();

/** True when a dedicated write login is configured. */
export function hasWriteLogin() {
  return Boolean(process.env.SP_DB_WRITE_USER && process.env.SP_DB_WRITE_PASSWORD);
}

function writeConfig(site) {
  const serverEnv = process.env.DB_SERVER || process.env.DB_HOST || 'localhost';
  let server = serverEnv;
  let port = Number(process.env.DB_PORT || '');
  if (!port && serverEnv.includes(',')) {
    const [host, portPart] = serverEnv.split(',');
    server = host;
    const parsed = parseInt(portPart, 10);
    if (!Number.isNaN(parsed)) port = parsed;
  }
  return {
    user: process.env.SP_DB_WRITE_USER,
    password: process.env.SP_DB_WRITE_PASSWORD,
    database: databaseFor(site),
    server,
    ...(port ? { port } : {}),
    pool: { max: 4, min: 0, idleTimeoutMillis: 120000 },
    options: { encrypt: true, trustServerCertificate: true, enableArithAbort: true },
    connectionTimeout: 30000,
    requestTimeout: 120000,
  };
}

function getWritePool(site) {
  assertSite(site);
  if (!hasWriteLogin()) {
    throw new Error(
      'No MSSQL write login configured. Set SP_DB_WRITE_USER and SP_DB_WRITE_PASSWORD. ' +
      'The Supplier Portal deliberately refuses to write through the read login.',
    );
  }
  const cached = writePools.get(site);
  if (cached) return cached;

  const promise = (async () => {
    const config = writeConfig(site);
    const pool = new sql.ConnectionPool(config);
    await pool.connect();
    // Connecting to the wrong database is the failure mode that matters here,
    // so it is checked rather than assumed.
    const check = await pool.request().query('SELECT DB_NAME() AS currentDb');
    const actual = check.recordset[0]?.currentDb;
    if (actual !== config.database) {
      throw new Error(
        `Write pool for ${site} landed on database ${actual}, expected ${config.database}.`,
      );
    }
    pool.on('error', (err) => {
      console.error(`[SP][MSSQL] write pool error for ${site}:`, err);
      if (writePools.get(site) === promise) writePools.delete(site);
    });
    console.log(`[SP][MSSQL] write pool ready for ${site} (${config.database})`);
    return pool;
  })();

  writePools.set(site, promise);
  promise.catch((err) => {
    console.error(`[SP][MSSQL] write pool failed for ${site}:`, err.message);
    if (writePools.get(site) === promise) writePools.delete(site);
  });
  return promise;
}

/**
 * Get a connection pool for a site.
 *
 * @param {'KOL'|'AHM'} site
 * @param {'read'|'write'} mode
 * @returns {Promise<import('mssql').ConnectionPool>}
 */
export function db(site, mode = 'read') {
  assertSite(site);
  if (mode === 'write') return getWritePool(site);
  if (mode !== 'read') throw new Error(`Unknown db mode "${mode}" — expected 'read' or 'write'.`);
  return getPool(site);
}

/** Pool with the long request timeout, for the heavy report queries. */
export function dbLong(site) {
  assertSite(site);
  return getLongQueryPool(site);
}

/** Close the write pools. Called from the server's shutdown handler. */
export async function closeWritePools() {
  const pending = Array.from(writePools.values());
  writePools.clear();
  await Promise.allSettled(pending.map(async (p) => {
    const pool = await p;
    await pool.close();
  }));
}

/**
 * Bind params, inferring the SQL type when the caller gives a bare value.
 *
 * Inference covers what this application actually passes. Anything
 * type-sensitive — money columns, dates written to the ERP — should pass an
 * explicit `{type, value}` so precision is the caller's choice rather than
 * the driver's guess.
 */
export function bindParams(request, params) {
  for (const [name, spec] of Object.entries(params || {})) {
    if (spec && typeof spec === 'object' && !(spec instanceof Date) && 'type' in spec) {
      request.input(name, spec.type, spec.value);
      continue;
    }
    if (typeof spec === 'number') {
      request.input(name, Number.isInteger(spec) ? sql.Int : sql.Float, spec);
    } else if (spec instanceof Date) {
      request.input(name, sql.DateTime, spec);
    } else if (typeof spec === 'boolean') {
      request.input(name, sql.Bit, spec);
    } else if (spec === null || spec === undefined) {
      request.input(name, sql.NVarChar, null);
    } else {
      request.input(name, sql.NVarChar, String(spec));
    }
  }
}

/**
 * Run a parameterised read query.
 *
 * @param {'KOL'|'AHM'} site
 * @param {string} queryText
 * @param {Object} params
 * @returns {Promise<Array<Object>>}
 */
export async function query(site, queryText, params = {}, { long = false } = {}) {
  const pool = await (long ? dbLong(site) : db(site, 'read'));
  const request = pool.request();
  bindParams(request, params);
  const result = await request.query(queryText);
  return result.recordset || [];
}

/** Run a read query and return the first row, or null. */
export async function queryOne(site, queryText, params = {}, opts = {}) {
  const rows = await query(site, queryText, params, opts);
  return rows.length ? rows[0] : null;
}

/**
 * Run `fn` inside a transaction on the write pool.
 *
 * The voucher-number allocation in §12.1 has to happen inside the same
 * transaction as the insert it numbers, so `fn` receives the transaction and
 * builds its own requests from it.
 *
 * @param {'KOL'|'AHM'} site
 * @param {(tx: import('mssql').Transaction) => Promise<any>} fn
 */
export async function withTransaction(site, fn) {
  const pool = await db(site, 'write');
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  let committed = false;
  try {
    const result = await fn(tx);
    await tx.commit();
    committed = true;
    return result;
  } catch (err) {
    if (!committed) {
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        // A rollback failure after a failed statement is usually the driver
        // reporting the transaction was already aborted. The original error is
        // the useful one, so it is what propagates.
        console.warn('[SP][MSSQL] rollback failed:', rollbackErr.message);
      }
    }
    throw err;
  }
}

/** Build a request bound to a transaction, with params applied. */
export function txRequest(tx, params = {}) {
  const request = new sql.Request(tx);
  bindParams(request, params);
  return request;
}

/** Run a statement inside a transaction and return its recordset. */
export async function txQuery(tx, queryText, params = {}) {
  const result = await txRequest(tx, params).query(queryText);
  return result.recordset || [];
}

export { sql };
