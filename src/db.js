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

let poolPromise;
let currentDatabase = null;

export function getPool(database = null) {
	// If database is specified and different from current, create new connection
	if (database && database !== currentDatabase) {
		// Close existing pool if it exists
		if (poolPromise) {
			poolPromise.then(pool => {
				if (pool && pool.close) {
					pool.close();
				}
			}).catch(err => {
				console.error('Error closing existing pool:', err);
			});
		}
		
		// Determine the database name based on selection
		let dbName = process.env.DB_NAME;
		if (database === 'AHM') {
			dbName = process.env.DB_NAME + '2';
		}
		// For 'KOL', use the original database name as is
		
		// Create new config with the selected database
		const newConfig = {
			...sqlConfig,
			database: dbName
		};
		
		poolPromise = sql.connect(newConfig);
		currentDatabase = database;
	} else if (!poolPromise) {
		// Default connection if no specific database requested
		poolPromise = sql.connect(sqlConfig);
		currentDatabase = 'KOL'; // Default
	}
	
	return poolPromise;
}

export { sql };


