const express = require('express');
const router = express.Router();
const Bill = require('../models/Bill');
const Operation = require('../models/Operation');
const mongoose = require('mongoose');

// Helper function to generate next bill number (8-digit, starting from 00000001)
async function generateNextBillNumber() {
  try {
    // Find the highest bill number
    const lastBill = await Bill.findOne().sort({ billNumber: -1 });
    
    if (!lastBill) {
      // No bills exist, start from 00000001
      return '00000001';
    }
    
    // Extract the numeric part and increment
    const lastNumber = parseInt(lastBill.billNumber, 10);
    const nextNumber = lastNumber + 1;
    
    // Format as 8-digit string with leading zeros
    return nextNumber.toString().padStart(8, '0');
  } catch (error) {
    console.error('Error generating bill number:', error);
    throw error;
  }
}

// Get all bills
router.get('/', async (req, res) => {
  try {
    const bills = await Bill.find().sort({ billNumber: -1 });
    res.json(bills);
  } catch (error) {
    console.error('Error fetching bills:', error);
    res.status(500).json({ error: 'Error fetching bills' });
  }
});

// Get bill by bill number
router.get('/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const bill = await Bill.findOne({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    res.json(bill);
  } catch (error) {
    console.error('Error fetching bill:', error);
    res.status(500).json({ error: 'Error fetching bill' });
  }
});

// Create new bill
router.post('/', async (req, res) => {
  try {
    const { contractorName, jobs } = req.body;

    if (!contractorName || !contractorName.trim()) {
      return res.status(400).json({ error: 'Contractor name is required' });
    }

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'At least one job is required' });
    }

    // Validate jobs structure
    for (const job of jobs) {
      if (!job.jobNumber || !job.jobNumber.trim()) {
        return res.status(400).json({ error: 'Each job must have a job number' });
      }
      if (!job.ops || !Array.isArray(job.ops) || job.ops.length === 0) {
        return res.status(400).json({ error: 'Each job must have at least one operation' });
      }

      for (const op of job.ops) {
        if (!op.opsName || !op.opsName.trim()) {
          return res.status(400).json({ 
            error: 'Each operation must have an operation name (opsName)' 
          });
        }
        if (
          op.qtyBook === undefined || 
          op.rate === undefined || 
          op.qtyCompleted === undefined || 
          op.totalValue === undefined
        ) {
          return res.status(400).json({ 
            error: 'Each operation must have qtyBook, rate, qtyCompleted, and totalValue' 
          });
        }

        // Validate numbers
        if (
          isNaN(Number(op.qtyBook)) || 
          isNaN(Number(op.rate)) || 
          isNaN(Number(op.qtyCompleted)) || 
          isNaN(Number(op.totalValue))
        ) {
          return res.status(400).json({ 
            error: 'All operation fields must be valid numbers' 
          });
        }

        if (
          Number(op.qtyBook) < 0 || 
          Number(op.rate) < 0 || 
          Number(op.qtyCompleted) < 0 || 
          Number(op.totalValue) < 0
        ) {
          return res.status(400).json({ 
            error: 'All operation values must be non-negative' 
          });
        }
      }
    }

    // Generate bill number
    const billNumber = await generateNextBillNumber();

    // Collect all unique opIds from all jobs
    const allOpIds = [];
    jobs.forEach(job => {
      job.ops.forEach(op => {
        if (op.opId) {
          allOpIds.push(op.opId);
        }
      });
    });

    // Fetch operation types for all operations
    const operationTypeMap = {};
    if (allOpIds.length > 0) {
      const opObjectIds = allOpIds.map(opId => {
        try {
          return new mongoose.Types.ObjectId(opId);
        } catch (error) {
          return null;
        }
      }).filter(Boolean);

      if (opObjectIds.length > 0) {
        const operationDocs = await Operation.find({ _id: { $in: opObjectIds } }).lean();
        operationDocs.forEach(op => {
          const idStr = op._id.toString();
          operationTypeMap[idStr] = op.type;
        });
      }
    }

    // Create bill
    const bill = new Bill({
      billNumber,
      contractorName: contractorName.trim(),
      jobs: jobs.map(job => ({
        jobNumber: job.jobNumber,
        ops: job.ops.map(op => {
          // Get operation type
          const opIdStr = String(op.opId || '');
          const operationType = operationTypeMap[opIdStr];
          const actualQtyBook = Number(op.qtyBook);
          
          // For 1/x type operations, save qtyBook as 1/actual qtyBook
          let qtyBookToSave = actualQtyBook;
          if (operationType === '1/x' && actualQtyBook > 0) {
            qtyBookToSave = 1 / actualQtyBook;
          }
          
          return {
            opsName: op.opsName.trim(),
            qtyBook: qtyBookToSave,
            rate: Number(op.rate),
            qtyCompleted: Number(op.qtyCompleted),
            totalValue: Number(op.totalValue)
          };
        })
      }))
    });

    await bill.save();
    res.status(201).json(bill);
  } catch (error) {
    console.error('Error creating bill:', error);
    if (error.code === 11000) {
      // Duplicate key error (bill number)
      return res.status(400).json({ error: 'Bill number already exists' });
    }
    res.status(500).json({ error: 'Error creating bill' });
  }
});

// Update bill
router.put('/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const { contractorName, jobs } = req.body;

    const bill = await Bill.findOne({ billNumber });
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    if (contractorName !== undefined) {
      if (!contractorName || !contractorName.trim()) {
        return res.status(400).json({ error: 'Contractor name cannot be empty' });
      }
      bill.contractorName = contractorName.trim();
    }

    if (jobs !== undefined) {
      if (!Array.isArray(jobs) || jobs.length === 0) {
        return res.status(400).json({ error: 'At least one job is required' });
      }

      // Validate jobs structure (same as create)
      for (const job of jobs) {
        if (!job.jobNumber || !job.jobNumber.trim()) {
          return res.status(400).json({ error: 'Each job must have a job number' });
        }
        if (!job.ops || !Array.isArray(job.ops) || job.ops.length === 0) {
          return res.status(400).json({ error: 'Each job must have at least one operation' });
        }

        for (const op of job.ops) {
          if (
            op.qtyBook === undefined || 
            op.rate === undefined || 
            op.qtyCompleted === undefined || 
            op.totalValue === undefined
          ) {
            return res.status(400).json({ 
              error: 'Each operation must have qtyBook, rate, qtyCompleted, and totalValue' 
            });
          }
        }
      }

      // Collect all unique opIds from all jobs
      const allOpIds = [];
      jobs.forEach(job => {
        job.ops.forEach(op => {
          if (op.opId) {
            allOpIds.push(op.opId);
          }
        });
      });

      // Fetch operation types for all operations
      const operationTypeMap = {};
      if (allOpIds.length > 0) {
        const opObjectIds = allOpIds.map(opId => {
          try {
            return new mongoose.Types.ObjectId(opId);
          } catch (error) {
            return null;
          }
        }).filter(Boolean);

        if (opObjectIds.length > 0) {
          const operationDocs = await Operation.find({ _id: { $in: opObjectIds } }).lean();
          operationDocs.forEach(op => {
            const idStr = op._id.toString();
            operationTypeMap[idStr] = op.type;
          });
        }
      }

      bill.jobs = jobs.map(job => ({
        jobNumber: job.jobNumber,
        ops: job.ops.map(op => {
          // Get operation type
          const opIdStr = String(op.opId || '');
          const operationType = operationTypeMap[opIdStr];
          const actualQtyBook = Number(op.qtyBook);
          
          // For 1/x type operations, save qtyBook as 1/actual qtyBook
          let qtyBookToSave = actualQtyBook;
          if (operationType === '1/x' && actualQtyBook > 0) {
            qtyBookToSave = 1 / actualQtyBook;
          }
          
          return {
            opsName: op.opsName.trim(),
            qtyBook: qtyBookToSave,
            rate: Number(op.rate),
            qtyCompleted: Number(op.qtyCompleted),
            totalValue: Number(op.totalValue)
          };
        })
      }));
    }

    await bill.save();
    res.json(bill);
  } catch (error) {
    console.error('Error updating bill:', error);
    res.status(500).json({ error: 'Error updating bill' });
  }
});

// Mark bill as paid
router.patch('/:billNumber/pay', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const bill = await Bill.findOne({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    bill.paymentStatus = 'Yes';
    bill.paymentDate = new Date();
    
    await bill.save();
    res.json(bill);
  } catch (error) {
    console.error('Error marking bill as paid:', error);
    res.status(500).json({ error: 'Error marking bill as paid' });
  }
});

// Delete bill
router.delete('/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const bill = await Bill.findOneAndDelete({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    res.json({ message: 'Bill deleted successfully' });
  } catch (error) {
    console.error('Error deleting bill:', error);
    res.status(500).json({ error: 'Error deleting bill' });
  }
});

module.exports = router;
