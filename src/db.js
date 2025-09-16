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

export function getPool() {
	if (!poolPromise) {
		poolPromise = sql.connect(sqlConfig);
	}
	return poolPromise;
}

export { sql };


