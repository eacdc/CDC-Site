import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const serverEnv = process.env.DB_SERVER || 'localhost';
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
	database: process.env.DB_NAME,
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
	requestTimeout: 30000
};

// Store multiple pools for different databases
const pools = new Map();

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
						console.warn(`[DB] Pool ${dbKey} on wrong database! Expected: ${expectedDbName}, Actual: ${actualDbName}`);
						console.log(`[DB] Switching to correct database [${expectedDbName}]...`);
						
						try {
							await pool.request().query(`USE [${expectedDbName}]`);
							
							// Verify switch was successful
							const verifyDb = await pool.request().query('SELECT DB_NAME() AS currentDb');
							const newActualDb = verifyDb.recordset[0]?.currentDb;
							
							if (newActualDb !== expectedDbName) {
								console.error(`[DB] Failed to switch database! Still on: ${newActualDb}`);
								// Close and recreate pool
								await pool.close().catch(() => {});
								pools.delete(dbKey);
								return getPool(database);
							}
							
							console.log(`[DB] Successfully switched pool ${dbKey} to [${expectedDbName}]`);
						} catch (switchErr) {
							console.error(`[DB] Error switching database:`, switchErr);
							// Close and recreate pool
							await pool.close().catch(() => {});
							pools.delete(dbKey);
							return getPool(database);
						}
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
	
	// Determine the database name based on selection - NO FALLBACKS
	let dbName;
	if (database === 'KOL') {
		dbName = process.env.DB_NAME_KOL;
	} else if (database === 'AHM') {
		dbName = process.env.DB_NAME_AHM;
	}
	
	// Validate that we have a database name
	if (!dbName) {
		throw new Error(`No database name configured for ${database}`);
	}
	
	// Strict validation - require explicit database names, no fallbacks
	if (database === 'KOL' && !process.env.DB_NAME_KOL) {
		throw new Error(`DB_NAME_KOL environment variable is required for KOL database selection`);
	}
	if (database === 'AHM' && !process.env.DB_NAME_AHM) {
		throw new Error(`DB_NAME_AHM environment variable is required for AHM database selection`);
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
	
	// Create new pool for this database
	const poolPromise = sql.connect(newConfig).then(async pool => {
		console.log(`[DB] Successfully connected`, { dbKey, dbName });
		
		// CRITICAL: Explicitly switch to the correct database using USE statement
		// This ensures we're using the right DB even if user's default DB is different
		try {
			await pool.request().query(`USE [${dbName}]`);
			console.log(`[DB] Explicitly switched to database [${dbName}]`);
			
			// Verify we're on the correct database
			const verifyDb = await pool.request().query('SELECT DB_NAME() AS currentDb');
			const actualDb = verifyDb.recordset[0]?.currentDb;
			if (actualDb !== dbName) {
				throw new Error(`Failed to switch to database ${dbName}. Currently on: ${actualDb}`);
			}
			console.log(`[DB] Verified connection to correct database`, { expected: dbName, actual: actualDb });
		} catch (useErr) {
			console.error(`[DB] Failed to switch to database ${dbName}:`, useErr);
			throw useErr;
		}
		
		// Handle pool events
		pool.on('error', err => {
			console.error(`[DB] Pool error for ${dbKey}:`, err);
			pools.delete(dbKey);
			// Try to close the pool
			pool.close().catch(closeErr => {
				console.error(`[DB] Error closing pool after error for ${dbKey}:`, closeErr);
			});
		});
		
		// Auto-cleanup: remove pool after extended idle time
		// This prevents stale connections from persisting too long
		const cleanupTimeout = setTimeout(() => {
			if (pools.has(dbKey)) {
				console.log(`[DB] Auto-cleanup: closing idle pool for ${dbKey}`);
				pool.close().catch(err => console.warn(`[DB] Error during auto-cleanup for ${dbKey}:`, err));
				pools.delete(dbKey);
			}
		}, 600000); // 10 minutes of idle time
		
		// Clear timeout if pool is manually closed
		pool.on('close', () => {
			clearTimeout(cleanupTimeout);
		});
		
		return pool;
	});
	
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

// Function to close all database connections
export async function closeAllPools() {
	const promises = [];
	for (const [dbKey, poolPromise] of pools) {
		promises.push(
			poolPromise.then(pool => {
				if (pool && pool.close) {
					console.log(`Closing database pool for ${dbKey}`);
					return pool.close();
				}
			}).catch(err => {
				console.error(`Error closing pool for ${dbKey}:`, err);
			})
		);
	}
	
	await Promise.all(promises);
	pools.clear();
}

// Function to clear pool cache (for logout/session clearing)
export function clearPoolCache() {
	console.log('[DB] Clearing pool cache', { poolKeys: Array.from(pools.keys()) });
	pools.clear();
}

export { sql };


