import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

// MSSQL connection env: DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME_KOL (and DB_NAME_AHM for AHM).
// Optional previous fallbacks: DB_HOST (for server), DB_NAME (for database when DB_NAME_KOL not set).
const serverEnv = process.env.DB_SERVER || process.env.DB_HOST || 'localhost';
let serverHost = serverEnv;
let serverPort = Number(process.env.DB_PORT || '');

if (!serverPort && serverEnv.includes(',')) {
	const parts = serverEnv.split(',');
	serverHost = parts[0];
	const parsed = parseInt(parts[1], 10);
	if (!Number.isNaN(parsed)) {
		serverPort = parsed;
	}
}

const sqlConfig = {
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME || process.env.DB_NAME_KOL,
	server: serverHost,
	...(serverPort ? { port: serverPort } : {}),
	pool: {
		max: 10,
		min: 0,
		idleTimeoutMillis: 300000
	},
	options: {
		encrypt: true,
		trustServerCertificate: true,
		enableArithAbort: true
	},
	connectionTimeout: 30000,
	requestTimeout: 120000  // 2 minutes - artwork pending/completed procs can be slow
};

/** Used by heavy report endpoints (e.g. rpt_job_gp_per_impression_v11). */
export const LONG_REQUEST_TIMEOUT_MS = Number(process.env.DB_LONG_REQUEST_TIMEOUT_MS) || 600_000;

// Store multiple pools for different databases
const pools = new Map();
const longQueryPools = new Map();

/** How long a health check may run before the pool is treated as dead. */
const HEALTH_CHECK_TIMEOUT_MS = 5000;
/** How long to wait for a close() before abandoning the pool object. */
const POOL_CLOSE_TIMEOUT_MS = 5000;
/** Idle time after which an unused pool is closed. Reset on every use. */
const POOL_IDLE_TIMEOUT_MS = 600000;
/** One recreate attempt per request; beyond that the error is the answer. */
const MAX_POOL_RECREATE_ATTEMPTS = 1;

/** Idle timers by cache key, so a pool in active use is never auto-closed. */
const idleTimers = new Map();

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * Promise.race keeps a handler attached to `promise`, so a late rejection
 * after the timeout wins is absorbed rather than surfacing as an unhandled
 * rejection (which would take the process down under Node's default policy).
 */
function withTimeout(promise, ms, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label)), ms);
		})
	]).finally(() => clearTimeout(timer));
}

/**
 * Close a pool without making anyone wait for it.
 *
 * mssql's close() drains the underlying connection pool, which waits for every
 * checked-out connection to be returned. A request stuck on a dead socket never
 * returns its connection, so close() can hang indefinitely. Awaiting it is what
 * made a single stale pool freeze every later request: the caller blocked here
 * and never sent a response. The pool must already have been evicted from its
 * cache before this is called.
 */
function closePoolDetached(pool, cacheKey) {
	if (!pool || typeof pool.close !== 'function') return;
	const stuck = setTimeout(() => {
		console.warn(
			`[DB] close() for ${cacheKey} still unfinished after ${POOL_CLOSE_TIMEOUT_MS}ms; abandoning the pool object`
		);
	}, POOL_CLOSE_TIMEOUT_MS);
	if (typeof stuck.unref === 'function') stuck.unref();
	Promise.resolve()
		.then(() => pool.close())
		.catch((err) => console.warn(`[DB] Error closing pool for ${cacheKey}:`, err))
		.finally(() => clearTimeout(stuck));
}

/**
 * Cancel the idle timer for a key. When `pool` is given, the timer is only
 * cancelled if it belongs to that pool — an evicted pool's late 'close' event
 * must not disarm the timer of the replacement pool now under the same key.
 */
function clearIdleTimer(cacheKey, pool) {
	const entry = idleTimers.get(cacheKey);
	if (!entry) return;
	if (pool && entry.pool !== pool) return;
	clearTimeout(entry.timer);
	idleTimers.delete(cacheKey);
}

/**
 * (Re)arm the idle close for a pool. Called every time the pool is handed to a
 * caller, so the timer measures idleness rather than age — the previous version
 * fired 10 minutes after creation regardless of traffic and closed pools out
 * from under in-flight requests.
 */
function armIdleTimer(cacheKey, pool, cache) {
	clearIdleTimer(cacheKey);
	const timer = setTimeout(() => {
		idleTimers.delete(cacheKey);
		if (!cache.has(cacheKey)) return;
		console.log(`[DB] Auto-cleanup: closing idle pool for ${cacheKey}`);
		cache.delete(cacheKey);
		closePoolDetached(pool, cacheKey);
	}, POOL_IDLE_TIMEOUT_MS);
	if (typeof timer.unref === 'function') timer.unref();
	idleTimers.set(cacheKey, { timer, pool });
}

/**
 * Drop a pool from its cache and close it in the background.
 * Eviction happens first so no other caller can pick up the broken pool.
 */
function evictPool(cacheKey, pool, cache) {
	clearIdleTimer(cacheKey, pool);
	cache.delete(cacheKey);
	closePoolDetached(pool, cacheKey);
}

function resolveDbName(database) {
	const dbKey = (database || '').toUpperCase();
	if (dbKey === 'KOL') {
		return { dbKey, dbName: process.env.DB_NAME_KOL || process.env.DB_NAME };
	}
	if (dbKey === 'AHM') {
		return { dbKey, dbName: process.env.DB_NAME_AHM || process.env.DB_NAME };
	}
	return { dbKey: null, dbName: null };
}

async function connectPool(dbKey, dbName, requestTimeout, cache) {
  const newConfig = {
    ...sqlConfig,
    database: dbName,
    requestTimeout,
  };
  console.log(`[DB] Creating pool`, { dbKey, dbName, requestTimeout });

  const pool = new sql.ConnectionPool(newConfig);
  await pool.connect();

  const verifyDb = await pool.request().query('SELECT DB_NAME() AS currentDb');
  const actualDb = verifyDb.recordset[0]?.currentDb;
  if (actualDb !== dbName) {
    throw new Error(`Failed to connect to database ${dbName}. Currently on: ${actualDb}`);
  }

  pool.on('error', (err) => {
    console.error(`[DB] Pool error for ${dbKey}:`, err);
    evictPool(dbKey, pool, cache);
  });

  return pool;
}

/**
 * Returns a healthy pool from cache, or recreates it after idle disconnect / pool errors.
 * Shared by getPool() and getLongQueryPool().
 */
async function resolveHealthyPool(cacheKey, dbKey, dbName, requestTimeout, cache, recreate) {
  if (!cache.has(cacheKey)) {
    return recreate();
  }

  try {
    const pool = await cache.get(cacheKey);
    if (!pool || !pool.connected) {
      console.log(`[DB] Pool for ${cacheKey} is disconnected, creating new connection`);
      cache.delete(cacheKey);
      return recreate();
    }

    try {
      await withTimeout(
        pool.request().query('SELECT 1'),
        HEALTH_CHECK_TIMEOUT_MS,
        'Health check timeout',
      );

      const dbCheck = await withTimeout(
        pool.request().query('SELECT DB_NAME() AS currentDb'),
        HEALTH_CHECK_TIMEOUT_MS,
        'Database verification timeout',
      );
      const actualDbName = dbCheck.recordset[0]?.currentDb;
      if (actualDbName !== dbName) {
        console.warn(`[DB] Pool ${cacheKey} on wrong database! Expected: ${dbName}, Actual: ${actualDbName} — recreating`);
        // Evict first, close in the background: awaiting close() here could
        // block forever on a connection the dead socket never gives back.
        evictPool(cacheKey, pool, cache);
        return recreate();
      }

      console.log(`[DB] Reusing healthy pool for ${cacheKey}`);
      return pool;
    } catch (pingErr) {
      console.warn(`[DB] Pool for ${cacheKey} failed health check, recreating`, { error: String(pingErr) });
      evictPool(cacheKey, pool, cache);
      return recreate();
    }
  } catch (err) {
    console.error(`[DB] Error checking pool for ${cacheKey}:`, err);
    cache.delete(cacheKey);
    return recreate();
  }
}

export function getPool(database, _attempt = 0) {
	const dbKey = (database || '').toUpperCase();
	console.log('[DB] getPool called', { input: database, normalizedKey: dbKey });

	// Strict validation: require explicit KOL or AHM
	if (dbKey !== 'KOL' && dbKey !== 'AHM') {
		throw new Error(`Invalid or missing database selection: ${database}`);
	}

	// A recreate that itself fails must surface the error rather than retry
	// forever: the old code recursed from its own catch handler, so a database
	// that was simply down turned into an endless reconnect loop and the caller
	// never got an answer.
	const recreate = (reason, err) => {
		if (_attempt >= MAX_POOL_RECREATE_ATTEMPTS) {
			console.error(`[DB] Giving up on pool for ${dbKey} after ${_attempt} recreate attempt(s)`, {
				reason,
				error: String(err ?? reason)
			});
			return Promise.reject(
				err instanceof Error ? err : new Error(`Could not obtain a database pool for ${dbKey}: ${reason}`)
			);
		}
		return getPool(database, _attempt + 1);
	};

	// Return existing pool if available and still connected
	if (pools.has(dbKey)) {
		const existingPool = pools.get(dbKey);
		console.log(`[DB] Reusing existing pool for ${dbKey}`);
		console.log(`[DB] Current pools in cache:`, Array.from(pools.keys()));
		return existingPool.then(async pool => {
			// Check if pool appears connected
			if (pool && pool.connected) {
				// Actively verify with a lightweight ping AND check which database we're connected to
				try {
					// Both checks are bounded. Previously only the ping was, so a
					// half-dead socket could still block here for the full 2-minute
					// requestTimeout on the DB_NAME() call.
					await withTimeout(
						pool.request().query('SELECT 1'),
						HEALTH_CHECK_TIMEOUT_MS,
						'Health check timeout'
					);

					// CRITICAL: Verify we're connected to the CORRECT database
					const dbCheck = await withTimeout(
						pool.request().query('SELECT DB_NAME() AS currentDb'),
						HEALTH_CHECK_TIMEOUT_MS,
						'Database verification timeout'
					);
					const actualDbName = dbCheck.recordset[0]?.currentDb;
					const expectedDbName = dbKey === 'KOL' ? process.env.DB_NAME_KOL : process.env.DB_NAME_AHM;

					console.log(`[DB] Pool verification for ${dbKey}:`, {
						requestedKey: dbKey,
						actualDatabase: actualDbName,
						expectedDatabase: expectedDbName,
						match: actualDbName === expectedDbName
					});

					// If connected to wrong database, switch to correct one
					if (actualDbName !== expectedDbName) {
						console.warn(`[DB] Pool ${dbKey} on wrong database! Expected: ${expectedDbName}, Actual: ${actualDbName} — recreating`);
						evictPool(dbKey, pool, pools);
						return recreate('pool on wrong database');
					}

					console.log(`[DB] Existing pool for ${dbKey} is healthy and connected to correct database`);
					armIdleTimer(dbKey, pool, pools);
					return pool;
				} catch (pingErr) {
					console.warn(`[DB] Pool for ${dbKey} failed health check, recreating`, { error: String(pingErr) });
					// Evict before closing: the close may hang on the very request
					// that just timed out, and no caller may wait on that.
					evictPool(dbKey, pool, pools);
					return recreate('failed health check');
				}
			} else {
				// Pool is disconnected, remove from cache and create new one
				console.log(`Pool for ${dbKey} is disconnected, creating new connection`);
				clearIdleTimer(dbKey);
				pools.delete(dbKey);
				return recreate('pool disconnected');
			}
		}).catch(err => {
			// Only reached when the cached promise itself rejected, or when the
			// recreate above did. Recursing unconditionally here was the second
			// infinite-retry path.
			if (pools.get(dbKey) === existingPool) {
				clearIdleTimer(dbKey);
				pools.delete(dbKey);
			}
			if (_attempt >= MAX_POOL_RECREATE_ATTEMPTS) throw err;
			console.error(`Error checking pool for ${dbKey}:`, err);
			return getPool(database, _attempt + 1);
		});
	}

	// Determine the database name: use DB_NAME_KOL / DB_NAME_AHM (new backend) or fall back to DB_NAME (previous) for KOL
	let dbName;
	if (database === 'KOL') {
		dbName = process.env.DB_NAME_KOL || process.env.DB_NAME;
	} else if (database === 'AHM') {
		dbName = process.env.DB_NAME_AHM || process.env.DB_NAME;
	}
	
	// Validate that we have a database name
	if (!dbName) {
		throw new Error(`No database name configured for ${database}. Set DB_NAME_KOL (or DB_NAME for KOL) in .env`);
	}

	// Validate that KOL and AHM databases are different (prevent accidental same-DB config)
	const kolDb = process.env.DB_NAME_KOL;
	const ahmDb = process.env.DB_NAME_AHM;
	if (kolDb && ahmDb && kolDb === ahmDb) {
		throw new Error(`KOL and AHM databases cannot be the same (both: ${kolDb}). Please configure DB_NAME_KOL and DB_NAME_AHM with different values.`);
	}
	
	console.log(`[DB] Creating new database connection`, { 
		dbKey, 
		dbName, 
		server: serverHost, 
		port: serverPort || null,
		envVars: {
			DB_NAME_KOL: process.env.DB_NAME_KOL,
			DB_NAME_AHM: process.env.DB_NAME_AHM
		}
	});
	
	// Create new config with the selected database
	const newConfig = {
		...sqlConfig,
		database: dbName
	};
	
	// Create new pool for this database (separate ConnectionPool per DB — not sql.connect global singleton)
	const poolPromise = (async () => {
		const pool = new sql.ConnectionPool(newConfig);
		await pool.connect();
		console.log(`[DB] Successfully connected`, { dbKey, dbName });

		const verifyDb = await pool.request().query('SELECT DB_NAME() AS currentDb');
		const actualDb = verifyDb.recordset[0]?.currentDb;
		if (actualDb !== dbName) {
			throw new Error(`Failed to connect to database ${dbName}. Currently on: ${actualDb}`);
		}
		console.log(`[DB] Verified connection to correct database`, { expected: dbName, actual: actualDb });

		pool.on('error', err => {
			console.error(`[DB] Pool error for ${dbKey}:`, err);
			evictPool(dbKey, pool, pools);
		});

		// Idle-based, and re-armed on every hand-out (see armIdleTimer). The old
		// timer was armed once at creation and fired 10 minutes later no matter
		// how busy the pool was, closing it under live requests.
		armIdleTimer(dbKey, pool, pools);

		pool.on('close', () => {
			clearIdleTimer(dbKey, pool);
		});

		return pool;
	})();
	
	// Store the pool promise
	pools.set(dbKey, poolPromise);
	
	// Handle pool errors
	poolPromise.catch(err => {
		console.error(`[DB] Connection error`, { dbKey, dbName, error: String(err) });
		// Remove failed pool from cache so the next request retries from scratch
		// instead of re-awaiting a promise that is already known to be rejected.
		if (pools.get(dbKey) === poolPromise) {
			clearIdleTimer(dbKey);
			pools.delete(dbKey);
		}
	});
	
	return poolPromise;
}

/**
 * Connection pool with a longer requestTimeout for slow reports.
 * Separate from getPool() so cached 2-minute pools are not reused.
 */
export function getLongQueryPool(database) {
	const { dbKey, dbName } = resolveDbName(database);
	if (!dbKey || !dbName) {
		throw new Error(`Invalid or missing database selection: ${database}`);
	}

	const cacheKey = `${dbKey}_LONG`;

	const recreate = () => {
		longQueryPools.delete(cacheKey);
		const poolPromise = connectPool(cacheKey, dbName, LONG_REQUEST_TIMEOUT_MS, longQueryPools);
		longQueryPools.set(cacheKey, poolPromise);
		poolPromise.catch((err) => {
			console.error(`[DB] Long-query connection error`, { cacheKey, dbName, error: String(err) });
			longQueryPools.delete(cacheKey);
		});
		return poolPromise;
	};

	return resolveHealthyPool(cacheKey, dbKey, dbName, LONG_REQUEST_TIMEOUT_MS, longQueryPools, recreate);
}

// Function to close all database connections
export async function closeAllPools() {
	const closeMap = async (map) => {
		const promises = [];
		for (const [dbKey, poolPromise] of map) {
			promises.push(
				poolPromise.then((pool) => {
					if (pool?.close) {
						console.log(`Closing database pool for ${dbKey}`);
						return pool.close();
					}
				}).catch((err) => {
					console.error(`Error closing pool for ${dbKey}:`, err);
				})
			);
		}
		await Promise.all(promises);
		map.clear();
	};

	for (const key of Array.from(idleTimers.keys())) clearIdleTimer(key);
	await closeMap(pools);
	await closeMap(longQueryPools);
}

// Function to clear pool cache (for logout/session clearing)
export function clearPoolCache() {
	console.log('[DB] Clearing pool cache', {
		poolKeys: Array.from(pools.keys()),
		longPoolKeys: Array.from(longQueryPools.keys()),
	});
	for (const key of Array.from(idleTimers.keys())) clearIdleTimer(key);
	pools.clear();
	longQueryPools.clear();
}

export { sql };


