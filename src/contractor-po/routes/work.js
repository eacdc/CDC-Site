const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Job = require('../models/Job');
const JobOperation = require('../models/JobOperation');
const JobopsMaster = require('../models/JobOpsMaster');
const Operation = require('../models/Operation');
const ContractorWD = require('../models/ContractorWD');

// Get pending operations from JobOpsMaster by job number
router.get('/pending/jobopsmaster/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    // Find job in JobOpsMaster
    const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber }).lean();
    
    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobOpsMaster' });
    }

    // Filter operations where pendingOpsQty > 0
    const pendingOps = jobOpsMaster.ops.filter(op => op.pendingOpsQty > 0);

    if (pendingOps.length === 0) {
      return res.json({
        jobNumber,
        operations: []
      });
    }

    // Get all unique opIds and convert to ObjectIds
    const opIds = pendingOps.map(op => {
      try {
        return new mongoose.Types.ObjectId(op.opId);
      } catch (error) {
        return null;
      }
    }).filter(Boolean);

    // Fetch operation details from Operation collection
    // opId in JobOpsMaster is stored as String (ObjectId string), so we convert to ObjectId for query
    const operations = await Operation.find({
      _id: { $in: opIds }
    }).lean();

    // Create a map of opId to operation details (name and ratePerUnit)
    const opsMap = {};
    operations.forEach(op => {
      opsMap[op._id.toString()] = {
        opsName: op.opsName,
        ratePerUnit: op.ratePerUnit || 0
      };
    });

    // Build response with operation name, totalOpsQty, pendingOpsQty, qtyPerBook, rate, and valuePerBook
    const operationsWithNames = pendingOps.map(op => {
      // Get rate from Operation collection by mapping opId
      const operationData = opsMap[op.opId] || {};
      const rate = operationData.ratePerUnit || 0;
      
      return {
        opId: op.opId,
        opsName: operationData.opsName || 'Unknown',
        totalOpsQty: op.totalOpsQty,
        pendingOpsQty: op.pendingOpsQty,
        qtyPerBook: op.qtyPerBook,
        rate: rate,
        valuePerBook: op.valuePerBook || 0
      };
    });

    res.json({
      jobNumber,
      clientName: jobOpsMaster.clientName || '',
      jobTitle: jobOpsMaster.jobTitle || '',
      operations: operationsWithNames
    });
  } catch (error) {
    console.error('Error fetching pending operations from JobOpsMaster:', error);
    res.status(500).json({ error: 'Error fetching pending operations' });
  }
});

// Get pending operations for a contractor and job (legacy endpoint)
router.get('/pending/:contractor/:jobNumber', async (req, res) => {
  try {
    const { contractor, jobNumber } = req.params;

    const job = await Job.findOne({ jobNumber });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobOperations = await JobOperation.find({ job: job._id })
      .populate('operation', 'opsName type');

    const pendingOps = jobOperations.map(jobOp => {
      const contractorWork = jobOp.contractorWork.find(cw => cw.contractor === contractor);
      const completedQty = contractorWork ? contractorWork.completedQty : 0;
      const pendingQty = jobOp.qtyPerBook - completedQty;

      return {
        _id: jobOp._id,
        operation: jobOp.operation,
        qtyPerBook: jobOp.qtyPerBook,
        pendingQty: Math.max(0, pendingQty),
        completedQty
      };
    });

    res.json({
      job,
      operations: pendingOps
    });
  } catch (error) {
    console.error('Error fetching pending work:', error);
    res.status(500).json({ error: 'Error fetching pending work' });
  }
});

// Update work done in JobOpsMaster and Contractor_WD
router.post('/update/jobopsmaster', async (req, res) => {
  try {
    const { contractorId, jobNumber, operations } = req.body;

    if (!contractorId || !jobNumber || !operations || !Array.isArray(operations)) {
      return res.status(400).json({ error: 'Missing required fields: contractorId, jobNumber, and operations are required' });
    }

    // Find job in JobOpsMaster
    const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber });
    
    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobOpsMaster' });
    }

    // Fetch operation names for all operations in JobOpsMaster and incoming operations
    const allOpIds = [...new Set([
      ...jobOpsMaster.ops.map(jop => jop.opId),
      ...operations.map(op => op.opId).filter(Boolean)
    ])];
    
    // Convert string IDs to ObjectIds for MongoDB query
    const opObjectIds = allOpIds.map(opId => {
      try {
        return new mongoose.Types.ObjectId(opId);
      } catch (error) {
        console.error(`Invalid ObjectId format: ${opId}`, error);
        return null;
      }
    }).filter(Boolean);
    
    const operationDocs = await Operation.find({ _id: { $in: opObjectIds } });
    const operationNameMap = {};
    operationDocs.forEach(op => {
      const idStr = op._id.toString();
      operationNameMap[idStr] = op.opsName;
    });

    const updates = [];
    const contractorWDOps = [];

    for (const op of operations) {
      const { opId, opsName, valuePerBook, qtyToAdd } = op;

      // Validate required fields - more strict validation
      if (!opId || !opsName || opsName.trim() === '' || 
          valuePerBook === undefined || valuePerBook === null || 
          isNaN(Number(valuePerBook)) || 
          qtyToAdd === undefined || qtyToAdd === null || 
          isNaN(Number(qtyToAdd)) || Number(qtyToAdd) <= 0) {
        console.warn('Skipping invalid operation:', { opId, opsName, valuePerBook, qtyToAdd });
        continue;
      }

      // Find the operation in the ops array using opId only
      const normalizedOpsName = opsName.trim();
      
      const jobOp = jobOpsMaster.ops.find(jop => {
        return String(jop.opId) === String(opId);
      });
      
      if (!jobOp) {
        console.warn('Job operation not found for:', { opId, opsName, normalizedOpsName, normalizedValuePerBook });
        continue;
      }

      // Deduct qtyToAdd from pendingOpsQty
      const qtyToDeduct = Number(qtyToAdd);
      if (isNaN(qtyToDeduct) || qtyToDeduct <= 0) {
        console.warn('Invalid qtyToDeduct:', qtyToDeduct);
        continue;
      }
      
      jobOp.pendingOpsQty = Math.max(0, jobOp.pendingOpsQty - qtyToDeduct);
      jobOp.lastUpdatedDate = new Date();

      updates.push({
        opId: jobOp.opId,
        opsName: normalizedOpsName,
        valuePerBook: jobOp.valuePerBook,
        pendingOpsQty: jobOp.pendingOpsQty
      });

      // Prepare Contractor_WD operation entry - use values from jobOp as authoritative source
      // Ensure all required fields are properly set with validated values
      const contractorWDOp = {
        opsId: String(jobOp.opId).trim(), // Use jobOp.opId as authoritative source
        opsName: normalizedOpsName, // Use normalized opsName
        valuePerBook: Number(jobOp.valuePerBook), // Use jobOp.valuePerBook as authoritative source
        opsDoneQty: qtyToDeduct, // Already validated
        completionDate: new Date()
      };
      
      // Final validation before pushing - double check all required fields
      if (!contractorWDOp.opsId || contractorWDOp.opsId === '' ||
          !contractorWDOp.opsName || contractorWDOp.opsName === '' || 
          contractorWDOp.valuePerBook === undefined || contractorWDOp.valuePerBook === null ||
          isNaN(contractorWDOp.valuePerBook) || 
          contractorWDOp.opsDoneQty === undefined || contractorWDOp.opsDoneQty === null ||
          isNaN(contractorWDOp.opsDoneQty) || contractorWDOp.opsDoneQty <= 0) {
        console.error('Invalid Contractor_WD operation entry - validation failed:', contractorWDOp);
        console.error('Source operation data:', { opId, opsName, valuePerBook, qtyToAdd });
        console.error('JobOp data:', jobOp);
        continue;
      }
      
      contractorWDOps.push(contractorWDOp);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid operations to update' });
    }

    // Save JobOpsMaster
    await jobOpsMaster.save();

    // Update or create Contractor_WD document
    let contractorWD = await ContractorWD.findOne({
      contractorId: contractorId,
      jobId: jobNumber
    });

    if (contractorWD) {
      // For each operation, check if entry with same opsId exists
      for (const newOp of contractorWDOps) {
        // Find existing entry with same opsId
        const existingOp = contractorWD.opsDone.find(od => {
          return String(od.opsId) === String(newOp.opsId);
        });
        
        if (existingOp) {
          // Update existing entry: add to opsDoneQty
          existingOp.opsDoneQty += newOp.opsDoneQty;
          existingOp.completionDate = new Date(); // Update completion date
        } else {
          // Add new entry
          contractorWD.opsDone.push(newOp);
        }
      }
    } else {
      // Create new Contractor_WD document
      contractorWD = new ContractorWD({
        contractorId: contractorId,
        jobId: jobNumber,
        opsDone: contractorWDOps
      });
    }

    await contractorWD.save();

    res.json({ 
      message: 'Work updated successfully', 
      updates,
      jobNumber,
      contractorId
    });
  } catch (error) {
    console.error('Error updating work in JobOpsMaster and Contractor_WD:', error);
    res.status(500).json({ error: 'Error updating work', details: error.message });
  }
});

// Update work done (legacy endpoint)
router.post('/update', async (req, res) => {
  try {
    const { contractor, jobNumber, operations } = req.body;

    if (!contractor || !jobNumber || !operations || !Array.isArray(operations)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const job = await Job.findOne({ jobNumber });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const updates = [];

    for (const op of operations) {
      const { jobOperationId, qtyToAdd } = op;

      if (!jobOperationId || qtyToAdd === undefined) {
        continue;
      }

      const jobOperation = await JobOperation.findById(jobOperationId);
      if (!jobOperation) {
        continue;
      }

      // Find or create contractor work entry
      let contractorWork = jobOperation.contractorWork.find(
        cw => cw.contractor === contractor
      );

      if (contractorWork) {
        contractorWork.completedQty += qtyToAdd;
        // Ensure it doesn't exceed qtyPerBook
        contractorWork.completedQty = Math.min(
          contractorWork.completedQty,
          jobOperation.qtyPerBook
        );
      } else {
        jobOperation.contractorWork.push({
          contractor,
          completedQty: Math.min(qtyToAdd, jobOperation.qtyPerBook)
        });
      }

      await jobOperation.save();
      updates.push(jobOperation);
    }

    res.json({ message: 'Work updated successfully', updates });
  } catch (error) {
    console.error('Error updating work:', error);
    res.status(500).json({ error: 'Error updating work' });
  }
});

module.exports = router;
