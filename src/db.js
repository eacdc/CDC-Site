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
    cache.delete(dbKey);
    pool.close().catch(() => {});
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
      const healthCheckPromise = pool.request().query('SELECT 1');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), 5000),
      );
      await Promise.race([healthCheckPromise, timeoutPromise]);

      const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
      const actualDbName = dbCheck.recordset[0]?.currentDb;
      if (actualDbName !== dbName) {
        console.warn(`[DB] Pool ${cacheKey} on wrong database! Expected: ${dbName}, Actual: ${actualDbName} — recreating`);
        try {
          await pool.close();
        } catch (closeErr) {
          console.warn(`[DB] Error closing misconfigured pool for ${cacheKey}:`, closeErr);
        }
        cache.delete(cacheKey);
        return recreate();
      }

      console.log(`[DB] Reusing healthy pool for ${cacheKey}`);
      return pool;
    } catch (pingErr) {
      console.warn(`[DB] Pool for ${cacheKey} failed health check, recreating`, { error: String(pingErr) });
      try {
        await pool.close();
      } catch (closeErr) {
        console.warn(`[DB] Error closing bad pool for ${cacheKey}:`, closeErr);
      }
      cache.delete(cacheKey);
      return recreate();
    }
  } catch (err) {
    console.error(`[DB] Error checking pool for ${cacheKey}:`, err);
    cache.delete(cacheKey);
    return recreate();
  }
}

export function getPool(database) {
	const dbKey = (database || '').toUpperCase();
	console.log('[DB] getPool called', { input: database, normalizedKey: dbKey });

	// Strict validation: require explicit KOL or AHM
	if (dbKey !== 'KOL' && dbKey !== 'AHM') {
		throw new Error(`Invalid or missing database selection: ${database}`);
	}
	
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
					// Use a timeout for the health check to prevent hanging
					const healthCheckPromise = pool.request().query('SELECT 1');
					const timeoutPromise = new Promise((_, reject) => 
						setTimeout(() => reject(new Error('Health check timeout')), 5000)
					);
					await Promise.race([healthCheckPromise, timeoutPromise]);
					
					// CRITICAL: Verify we're connected to the CORRECT database
					const dbCheck = await pool.request().query('SELECT DB_NAME() AS currentDb');
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
						await pool.close().catch(() => {});
						pools.delete(dbKey);
						return getPool(database);
					}
					
					console.log(`[DB] Existing pool for ${dbKey} is healthy and connected to correct database`);
					return pool;
				} catch (pingErr) {
					console.warn(`[DB] Pool for ${dbKey} failed health check, recreating`, { error: String(pingErr) });
					// Close the bad pool before removing
					try {
						await pool.close();
					} catch (closeErr) {
						console.warn(`[DB] Error closing bad pool for ${dbKey}:`, closeErr);
					}
					pools.delete(dbKey);
					return getPool(database);
				}
			} else {
				// Pool is disconnected, remove from cache and create new one
				console.log(`Pool for ${dbKey} is disconnected, creating new connection`);
				pools.delete(dbKey);
				return getPool(database); // Recursive call to create new pool
			}
		}).catch(err => {
			console.error(`Error checking pool for ${dbKey}:`, err);
			pools.delete(dbKey);
			return getPool(database); // Recursive call to create new pool
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
			pools.delete(dbKey);
			pool.close().catch(closeErr => {
				console.error(`[DB] Error closing pool after error for ${dbKey}:`, closeErr);
			});
		});

		const cleanupTimeout = setTimeout(() => {
			if (pools.has(dbKey)) {
				console.log(`[DB] Auto-cleanup: closing idle pool for ${dbKey}`);
				pool.close().catch(err => console.warn(`[DB] Error during auto-cleanup for ${dbKey}:`, err));
				pools.delete(dbKey);
			}
		}, 600000);

		pool.on('close', () => {
			clearTimeout(cleanupTimeout);
		});

		return pool;
	})();
	
	// Store the pool promise
	pools.set(dbKey, poolPromise);
	
	// Handle pool errors
	poolPromise.catch(err => {
		console.error(`[DB] Connection error`, { dbKey, dbName, error: String(err) });
		// Remove failed pool from cache
		pools.delete(dbKey);
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

	await closeMap(pools);
	await closeMap(longQueryPools);
}

// Function to clear pool cache (for logout/session clearing)
export function clearPoolCache() {
	console.log('[DB] Clearing pool cache', {
		poolKeys: Array.from(pools.keys()),
		longPoolKeys: Array.from(longQueryPools.keys()),
	});
	pools.clear();
	longQueryPools.clear();
}

export { sql };


