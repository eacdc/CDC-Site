const sql = require('mssql');

const config = {
  server: process.env.MSSQL_SERVER || 'cdcindas.24mycloud.com',
  port: parseInt(process.env.MSSQL_PORT || '51175'),
  database: process.env.MSSQL_DATABASE || 'IndusEnterprise',
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

let pool = null;
let connectionPromise = null;

async function getConnection() {
  try {
    // If already connected, return existing pool
    if (pool && pool.connected) {
      return pool;
    }

    // If connection is in progress, wait for it
    if (connectionPromise) {
      console.log('⏳ [MSSQL] Connection already in progress, waiting...');
      return await connectionPromise;
    }

    // Start new connection
    console.log('🔌 [MSSQL] Establishing connection...');
    const startTime = Date.now();
    
    connectionPromise = sql.connect(config);
    pool = await connectionPromise;
    
    const connectionTime = Date.now() - startTime;
    console.log(`✅ [MSSQL] Connected to MSSQL Server in ${connectionTime}ms`);
    
    connectionPromise = null;
    
    // Handle connection errors
    pool.on('error', (err) => {
      console.error('❌ [MSSQL] Connection pool error:', err);
      pool = null;
      connectionPromise = null;
    });

    return pool;
  } catch (error) {
    console.error('❌ [MSSQL] Connection error:', error);
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
