const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { getConnection } = require('./config/db');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/contractor-po-system';

mongoose.connect(MONGODB_URI)
.then(() => {
  console.log('✅ Connected to MongoDB');
})
.catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1);
});

// Test MSSQL connection at startup
async function testMSSQLConnection() {
  console.log('🔌 Testing MSSQL connection at startup...');
  try {
    const startTime = Date.now();
    await getConnection();
    console.log(`✅ MSSQL connection test successful (${Date.now() - startTime}ms)`);
  } catch (error) {
    console.error('⚠️ MSSQL connection test failed:', error.message);
    console.error('   (MSSQL features will retry when needed)');
  }
}

// Run MSSQL test after a short delay
setTimeout(testMSSQLConnection, 1000);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/operations', require('./routes/operations'));
app.use('/api/work', require('./routes/work'));
app.use('/api/contractors', require('./routes/contractors'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/series', require('./routes/series'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
