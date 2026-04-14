const sql = require('mssql');
const CONTRACTOR_PO_DATABASE = 'IndusEnterprise';

const config = {
  server: process.env.MSSQL_SERVER || 'cdcindas.24mycloud.com',
  port: parseInt(process.env.MSSQL_PORT || '51175'),
  // Contractor PO must always use IndusEnterprise.
  // Keep this isolated from shared backend DB env vars.
  database: CONTRACTOR_PO_DATABASE,
  user: process.env.MSSQL_USER || 'indus',
  password: process.env.MSSQL_PASSWORD || 'Param@99811',
  connectionTimeout: 10000, // 10 seconds to establish connection
  requestTimeout: 30000, // 30 seconds for queries to complete
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: false, // Use true if connecting to Azure
    trustServerCertificate: true,
    enableArithAbort: true
  }
};

// Use an explicit ConnectionPool (NOT sql.connect) so this pool is fully isolated
// from the global mssql singleton pool used by the shared backend routes.
// sql.connect() writes to the mssql global pool and can be overwritten by any other
// caller (e.g. routes.js getConnection / getPool('AHM')), causing wrong-DB queries.
let pool = null;
let connectionPromise = null;

async function getConnection() {
  try {
    if (pool && pool.connected) {
      return pool;
    }

    if (connectionPromise) {
      console.log('⏳ [Contractor-PO MSSQL] Connection already in progress, waiting...');
      return await connectionPromise;
    }

    console.log('🔌 [Contractor-PO MSSQL] Establishing isolated connection pool...');
    const startTime = Date.now();

    // new sql.ConnectionPool() creates an isolated pool — never touches the global pool.
    const newPool = new sql.ConnectionPool(config);
    connectionPromise = newPool.connect();
    pool = await connectionPromise;

    const connectionTime = Date.now() - startTime;
    console.log(`✅ [Contractor-PO MSSQL] Connected to ${CONTRACTOR_PO_DATABASE} in ${connectionTime}ms`);

    connectionPromise = null;

    pool.on('error', (err) => {
      console.error('❌ [Contractor-PO MSSQL] Pool error:', err);
      pool = null;
      connectionPromise = null;
    });

    return pool;
  } catch (error) {
    console.error('❌ [Contractor-PO MSSQL] Connection error:', error);
    pool = null;
    connectionPromise = null;
    throw error;
  }
}

async function closeConnection() {
  try {
    if (pool) {
      await pool.close();
      pool = null;
      console.log('MSSQL connection closed');
    }
  } catch (error) {
    console.error('Error closing MSSQL connection:', error);
  }
}

module.exports = {
  getConnection,
  closeConnection,
  sql
};
