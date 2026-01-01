const express = require('express');
const router = express.Router();
const Operation = require('../models/Operation');

// Get all operations (only active ones - isdeleted = 0)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let query = { isdeleted: 0 };

    if (search) {
      query.opsName = { $regex: search, $options: 'i' };
    }

    const operations = await Operation.find(query).sort({ opsName: 1 });
    res.json(operations);
  } catch (error) {
    console.error('Error fetching operations:', error);
    res.status(500).json({ error: 'Error fetching operations' });
  }
});

// Get operation by ID
router.get('/:id', async (req, res) => {
  try {
    const operation = await Operation.findById(req.params.id);
    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }
    res.json(operation);
  } catch (error) {
    console.error('Error fetching operation:', error);
    res.status(500).json({ error: 'Error fetching operation' });
  }
});

// Create new operation
router.post('/', async (req, res) => {
  try {
    const { opsName, type, ratePerUnit } = req.body;

    // Validate required fields
    if (!opsName || !type) {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    // Validate ratePerUnit - must be a number and >= 0
    if (ratePerUnit === undefined || ratePerUnit === null || ratePerUnit === '') {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    const ratePerUnitNum = Number(ratePerUnit);
    if (isNaN(ratePerUnitNum) || ratePerUnitNum < 0) {
      return res.status(400).json({ error: 'Rate/unit must be a valid number greater than or equal to 0' });
    }

    // Check if operation already exists (only active ones)
    const existingOp = await Operation.findOne({ opsName, isdeleted: 0 });
    if (existingOp) {
      return res.status(400).json({ error: 'Operation already exists' });
    }

    const operation = new Operation({
      opsName,
      type,
      ratePerUnit: ratePerUnitNum,
      isdeleted: 0
    });

    await operation.save();
    res.status(201).json(operation);
  } catch (error) {
    console.error('Error creating operation:', error);
    res.status(500).json({ error: 'Error creating operation' });
  }
});

// Update operation
router.put('/:id', async (req, res) => {
  try {
    const { opsName, type, ratePerUnit } = req.body;
    
    // Validate required fields
    if (!opsName || !type) {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    // Validate ratePerUnit - must be a number and >= 0
    if (ratePerUnit === undefined || ratePerUnit === null || ratePerUnit === '') {
      return res.status(400).json({ error: 'Operation name, type, and rate/unit are required' });
    }

    const ratePerUnitNum = Number(ratePerUnit);
    if (isNaN(ratePerUnitNum) || ratePerUnitNum < 0) {
      return res.status(400).json({ error: 'Rate/unit must be a valid number greater than or equal to 0' });
    }
    
    const operation = await Operation.findByIdAndUpdate(
      req.params.id,
      { opsName, type, ratePerUnit: ratePerUnitNum },
      { new: true, runValidators: true }
    );

    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }

    res.json(operation);
  } catch (error) {
    console.error('Error updating operation:', error);
    res.status(500).json({ error: 'Error updating operation' });
  }
});

// Delete operation (soft delete - set isdeleted = 1)
router.delete('/:id', async (req, res) => {
  try {
    const operation = await Operation.findByIdAndUpdate(
      req.params.id,
      { isdeleted: 1 },
      { new: true }
    );
    if (!operation) {
      return res.status(404).json({ error: 'Operation not found' });
    }
    res.json({ message: 'Operation deleted successfully' });
  } catch (error) {
    console.error('Error deleting operation:', error);
    res.status(500).json({ error: 'Error deleting operation' });
  }
});

module.exports = router;
