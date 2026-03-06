const express = require('express');
const router = express.Router();
const Series = require('../models/Series');

// Create a new series (save job numbers)
router.post('/', async (req, res) => {
  try {
    const { jobNumbers } = req.body;

    if (!jobNumbers || !Array.isArray(jobNumbers) || jobNumbers.length === 0) {
      return res.status(400).json({ error: 'Job numbers array is required and must not be empty' });
    }

    // Validate that all job numbers are strings
    const validJobNumbers = jobNumbers.filter(jn => typeof jn === 'string' && jn.trim() !== '').sort();
    
    if (validJobNumbers.length === 0) {
      return res.status(400).json({ error: 'At least one valid job number is required' });
    }

    // Check if any job number is already in another series
    const existingSeriesWithJobs = await Series.find({
      jobNumbers: { $in: validJobNumbers }
    });
    
    if (existingSeriesWithJobs.length > 0) {
      // Find which jobs are already in series
      const jobsInSeries = new Set();
      existingSeriesWithJobs.forEach(series => {
        series.jobNumbers.forEach(jn => {
          if (validJobNumbers.includes(jn)) {
            jobsInSeries.add(jn);
          }
        });
      });
      
      if (jobsInSeries.size > 0) {
        const jobsList = Array.from(jobsInSeries).join(', ');
        return res.status(400).json({ 
          error: `Job number(s) ${jobsList} is/are already in another series. A job cannot be added to multiple series.` 
        });
      }
    }

    // Check if a series with the exact same job numbers already exists
    // First, find series with the same count (optimization)
    const sortedValidJobNumbers = [...validJobNumbers].sort();
    const existingSeries = await Series.find({
      $expr: { $eq: [{ $size: "$jobNumbers" }, validJobNumbers.length] }
    });
    
    // Verify exact match (order-independent) by comparing sorted arrays
    for (const series of existingSeries) {
      const existingJobNumbers = [...series.jobNumbers].sort();
      
      if (existingJobNumbers.length === sortedValidJobNumbers.length &&
          existingJobNumbers.every((val, idx) => val === sortedValidJobNumbers[idx])) {
        // Series with same job numbers already exists
        return res.status(200).json({
          message: 'Series already exists',
          series: {
            _id: series._id,
            jobNumbers: series.jobNumbers,
            savedAt: series.savedAt
          }
        });
      }
    }

    // Create new series entry only if it doesn't exist
    const series = new Series({
      jobNumbers: validJobNumbers
    });

    await series.save();

    res.status(201).json({
      message: 'Series saved successfully',
      series: {
        _id: series._id,
        jobNumbers: series.jobNumbers,
        savedAt: series.savedAt
      }
    });
  } catch (error) {
    console.error('Error saving series:', error);
    res.status(500).json({ error: 'Error saving series' });
  }
});

// Get all series
router.get('/', async (req, res) => {
  try {
    const series = await Series.find().sort({ createdAt: -1 });
    res.json(series);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Error fetching series' });
  }
});

// Search series by job number
router.get('/search/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    
    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    // Find all series that contain this job number
    const series = await Series.find({
      jobNumbers: jobNumber
    }).sort({ createdAt: -1 });

    // If found, return the first one (most recent) with all its job numbers and ID
    if (series.length > 0) {
      return res.json({
        found: true,
        seriesId: series[0]._id.toString(),
        jobNumbers: series[0].jobNumbers
      });
    }

    // Not found
    res.json({
      found: false,
      seriesId: null,
      jobNumbers: []
    });
  } catch (error) {
    console.error('Error searching series:', error);
    res.status(500).json({ error: 'Error searching series' });
  }
});

// Get a specific series by ID
router.get('/:id', async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) {
      return res.status(404).json({ error: 'Series not found' });
    }
    res.json(series);
  } catch (error) {
    console.error('Error fetching series:', error);
    res.status(500).json({ error: 'Error fetching series' });
  }
});

module.exports = router;

