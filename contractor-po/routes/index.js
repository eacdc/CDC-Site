const express = require('express');
const router = express.Router();

// Import all route modules
const authRoutes = require('./auth');
const jobsRoutes = require('./jobs');
const operationsRoutes = require('./operations');
const workRoutes = require('./work');
const contractorsRoutes = require('./contractors');
const billsRoutes = require('./bills');
const seriesRoutes = require('./series');

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

module.exports = router;
