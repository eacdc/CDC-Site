import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Create require function for CommonJS modules
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Import all route modules (CommonJS)
const authRoutes = require(join(__dirname, 'auth.js'));
const jobsRoutes = require(join(__dirname, 'jobs.js'));
const operationsRoutes = require(join(__dirname, 'operations.js'));
const workRoutes = require(join(__dirname, 'work.js'));
const contractorsRoutes = require(join(__dirname, 'contractors.js'));
const billsRoutes = require(join(__dirname, 'bills.js'));
const seriesRoutes = require(join(__dirname, 'series.js'));

// Mount all routes
router.use('/auth', authRoutes);
router.use('/jobs', jobsRoutes);
router.use('/operations', operationsRoutes);
router.use('/work', workRoutes);
router.use('/contractors', contractorsRoutes);
router.use('/bills', billsRoutes);
router.use('/series', seriesRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Contractor PO API is running' });
});

export default router;
