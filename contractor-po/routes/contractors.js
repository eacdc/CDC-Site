const express = require('express');
const router = express.Router();
const Contractor = require('../models/Contractor');

// Get all contractors (only active ones - isdeleted = 0)
router.get('/', async (req, res) => {
  try {
    const contractors = await Contractor.find({ isdeleted: 0 }).sort({ creationDate: -1 });
    res.json(contractors);
  } catch (error) {
    console.error('Error fetching contractors:', error);
    res.status(500).json({ error: 'Error fetching contractors' });
  }
});

// Create new contractor
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    // Generate a unique contractorId
    // Using timestamp + random string to ensure uniqueness
    let contractorId;
    let existingContractor;
    do {
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
      contractorId = `CTR${timestamp}${randomStr}`;
      existingContractor = await Contractor.findOne({ contractorId });
    } while (existingContractor); // Keep generating until unique

    const contractor = new Contractor({
      contractorId,
      name: name.trim(),
      creationDate: new Date(),
      isdeleted: 0
    });

    await contractor.save();
    res.status(201).json(contractor);
  } catch (error) {
    console.error('Error creating contractor:', error);
    if (error.code === 11000) {
      // Duplicate key error
      return res.status(400).json({ error: 'Contractor ID already exists' });
    }
    res.status(500).json({ error: 'Error creating contractor' });
  }
});

// Update contractor (only name can be edited)
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    const contractor = await Contractor.findByIdAndUpdate(
      req.params.id,
      { name: name.trim() },
      { new: true, runValidators: true }
    );

    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json(contractor);
  } catch (error) {
    console.error('Error updating contractor:', error);
    res.status(500).json({ error: 'Error updating contractor' });
  }
});

// Delete contractor (soft delete - set isdeleted = 1)
router.delete('/:id', async (req, res) => {
  try {
    const contractor = await Contractor.findByIdAndUpdate(
      req.params.id,
      { isdeleted: 1 },
      { new: true }
    );

    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    res.json({ message: 'Contractor deleted successfully' });
  } catch (error) {
    console.error('Error deleting contractor:', error);
    res.status(500).json({ error: 'Error deleting contractor' });
  }
});

module.exports = router;
