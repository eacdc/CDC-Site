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
		idleTimeoutMillis: 30000
	},
	options: {
		encrypt: true,
		trustServerCertificate: true
	}
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
		return existingPool.then(pool => {
			// Check if pool is still connected
			if (pool && pool.connected) {
				console.log(`[DB] Existing pool for ${dbKey} is connected`);
				return pool;
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
	
	// Determine the database name based on selection
	let dbName;
	if (database === 'KOL') {
		dbName = process.env.DB_NAME_KOL || process.env.DB_NAME; // fallback for backward compatibility
	} else if (database === 'AHM') {
		dbName = process.env.DB_NAME_AHM || (process.env.DB_NAME + '2'); // fallback to old logic
	}
	
	// Validate that we have a database name
	if (!dbName) {
		throw new Error(`No database name configured for ${database}`);
	}
	
	// Validate that KOL and AHM databases are different (prevent accidental same-DB config)
	const kolDb = process.env.DB_NAME_KOL || process.env.DB_NAME;
	const ahmDb = process.env.DB_NAME_AHM || (process.env.DB_NAME + '2');
	if (kolDb === ahmDb) {
		throw new Error(`KOL and AHM databases cannot be the same (both: ${kolDb}). Please configure DB_NAME_KOL and DB_NAME_AHM with different values.`);
	}
	
	console.log(`[DB] Creating new database connection`, { 
		dbKey, 
		dbName, 
		server: serverHost, 
		port: serverPort || null,
		envVars: {
			DB_NAME: process.env.DB_NAME,
			DB_NAME_KOL: process.env.DB_NAME_KOL,
			DB_NAME_AHM: process.env.DB_NAME_AHM,
			resolvedKolDb: kolDb,
			resolvedAhmDb: ahmDb
		}
	});
	
	// Create new config with the selected database
	const newConfig = {
		...sqlConfig,
		database: dbName
	};
	
	// Create new pool for this database
	const poolPromise = sql.connect(newConfig).then(pool => {
		console.log(`[DB] Successfully connected`, { dbKey, dbName });
		
		// Handle pool events
		pool.on('error', err => {
			console.error(`Pool error for ${dbKey}:`, err);
			pools.delete(dbKey);
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

export { sql };


