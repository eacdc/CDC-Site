import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

// MSSQL connection env: DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME_KOL (and DB_NAME_AHM for AHM).
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

const baseSqlConfig = {
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	server: serverHost,
	...(serverPort ? { port: serverPort } : {}),
	pool: {
		max: 10,
		min: 1,
		idleTimeoutMillis: 600_000, // 10 min – keep connections warm during long production runs
	},
	options: {
		encrypt: true,
		trustServerCertificate: true,
		enableArithAbort: true,
	},
	connectionTimeout: 30_000,
	requestTimeout: 120_000,
};

/** Used by heavy report endpoints (e.g. rpt_job_gp_per_impression_v11). */
export const LONG_REQUEST_TIMEOUT_MS = Number(process.env.DB_LONG_REQUEST_TIMEOUT_MS) || 600_000;

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

function validateDbConfig() {
	const kolDb = process.env.DB_NAME_KOL;
	const ahmDb = process.env.DB_NAME_AHM;
	if (kolDb && ahmDb && kolDb === ahmDb) {
		throw new Error(`KOL and AHM databases cannot be the same (both: ${kolDb}). Set DB_NAME_KOL and DB_NAME_AHM to different values.`);
	}
}

async function pingPool(pool, timeoutMs = 5000) {
	const healthCheck = pool.request().query('SELECT 1 AS ok');
	const timeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Health check timeout')), timeoutMs)
	);
	await Promise.race([healthCheck, timeout]);
}

async function createConnectionPool(dbKey, dbName, requestTimeout) {
	validateDbConfig();
	if (!dbName) {
		throw new Error(`No database name configured for ${dbKey}. Set DB_NAME_${dbKey} in .env`);
	}

	const config = {
		...baseSqlConfig,
		database: dbName,
		requestTimeout,
	};

	console.log('[DB] Creating pool', { dbKey, dbName, requestTimeout });

	// IMPORTANT: use ConnectionPool, NOT sql.connect().
	// sql.connect() is a global singleton – KOL and AHM would share one pool and
	// require fragile USE [db] switching, which caused wrong-DB queries after idle time.
	const pool = new sql.ConnectionPool(config);
	await pool.connect();

	pool.on('error', (err) => {
		console.error(`[DB] Pool error for ${dbKey}:`, err);
	});

	console.log('[DB] Pool ready', { dbKey, dbName });
	return pool;
}

async function getOrCreatePool(database, cache, requestTimeout) {
	const { dbKey, dbName } = resolveDbName(database);
	if (!dbKey || !dbName) {
		throw new Error(`Invalid or missing database selection: ${database}`);
	}

	if (cache.has(dbKey)) {
		const existing = cache.get(dbKey);
		try {
			const pool = await existing;
			if (pool?.connected) {
				try {
					await pingPool(pool);
					return pool;
				} catch (pingErr) {
					console.warn(`[DB] Pool ${dbKey} failed health check, recreating`, { error: String(pingErr) });
					await pool.close().catch(() => {});
				}
			} else {
				console.warn(`[DB] Pool ${dbKey} disconnected, recreating`);
			}
		} catch (err) {
			console.warn(`[DB] Cached pool ${dbKey} unusable, recreating`, { error: String(err) });
		}
		cache.delete(dbKey);
	}

	const poolPromise = createConnectionPool(dbKey, dbName, requestTimeout);
	cache.set(dbKey, poolPromise);
	poolPromise.catch((err) => {
		console.error('[DB] Connection error', { dbKey, dbName, error: String(err) });
		cache.delete(dbKey);
	});
	return poolPromise;
}

export function getPool(database) {
	return getOrCreatePool(database, pools, baseSqlConfig.requestTimeout);
}

/**
 * Connection pool with a longer requestTimeout for slow reports.
 * Kept separate so report timeouts do not affect production routes.
 */
export function getLongQueryPool(database) {
	const { dbKey } = resolveDbName(database);
	if (!dbKey) {
		throw new Error(`Invalid or missing database selection: ${database}`);
	}
	return getOrCreatePool(database, longQueryPools, LONG_REQUEST_TIMEOUT_MS);
}

async function closeMap(map) {
	const promises = [];
	for (const [dbKey, poolPromise] of map) {
		promises.push(
			poolPromise
				.then((pool) => {
					if (pool?.close) {
						console.log(`[DB] Closing pool for ${dbKey}`);
						return pool.close();
					}
				})
				.catch((err) => {
					console.error(`[DB] Error closing pool for ${dbKey}:`, err);
				})
		);
	}
	await Promise.all(promises);
	map.clear();
}

export async function closeAllPools() {
	await closeMap(pools);
	await closeMap(longQueryPools);
}

/** Clears cache entries only; does not close underlying TCP connections. Prefer closeAllPools on shutdown. */
export function clearPoolCache() {
	console.log('[DB] Clearing pool cache', {
		poolKeys: Array.from(pools.keys()),
		longPoolKeys: Array.from(longQueryPools.keys()),
	});
	pools.clear();
	longQueryPools.clear();
}

export { sql };
