const express = require('express');
const router = express.Router();
const Bill = require('../models/Bill');
const Operation = require('../models/Operation');
const JobopsMaster = require('../models/JobOpsMaster');
const ContractorWD = require('../models/ContractorWD');
const Contractor = require('../models/Contractor');
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

// Get all bills (excluding deleted ones)
// Handles both new bills (with isDeleted field) and old bills (without isDeleted field)
router.get('/', async (req, res) => {
  try {
    // Query: isDeleted is not 1, OR isDeleted field doesn't exist (for backward compatibility)
    const bills = await Bill.find({
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ]
    }).sort({ billNumber: -1 });
    res.json(bills);
  } catch (error) {
    console.error('Error fetching bills:', error);
    res.status(500).json({ error: 'Error fetching bills' });
  }
});

// Get all bills that contain a given job number (for Print Job page)
// Must be defined before /:billNumber to avoid "by-job" being treated as billNumber
router.get('/by-job/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;
    if (!jobNumber || !String(jobNumber).trim()) {
      return res.status(400).json({ error: 'Job number is required' });
    }
    const searchJob = String(jobNumber).trim();
    const bills = await Bill.find({
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ],
      'jobs.jobNumber': searchJob
    })
      .sort({ billNumber: 1, contractorName: 1 })
      .lean();
    res.json(bills);
  } catch (error) {
    console.error('Error fetching bills by job:', error);
    res.status(500).json({ error: 'Error fetching bills by job' });
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
        clientName: job.clientName || '',
        jobTitle: job.jobTitle || '',
        ops: job.ops.map(op => {
          // Save qtyBook and rate as is, no calculations
          return {
            opsName: op.opsName.trim(),
            qtyBook: Number(op.qtyBook), // Save qtyBook as is, no calculation
            rate: Number(op.rate), // Save rate (which contains valuePerBook) as is, no calculation
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
        clientName: job.clientName || '',
        jobTitle: job.jobTitle || '',
        ops: job.ops.map(op => {
          // Save qtyBook and rate as is, no calculations
          return {
            opsName: op.opsName.trim(),
            qtyBook: Number(op.qtyBook), // Save qtyBook as is, no calculation
            rate: Number(op.rate), // Save rate (which contains valuePerBook) as is, no calculation
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

// Edit unpaid bill quantities (completed qty only) and sync JobopsMaster / Contractor_WD
router.put('/:billNumber/edit-qty', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { billNumber } = req.params;
    const { contractorId, changes } = req.body;

    if (!contractorId || !String(contractorId).trim()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'contractorId is required' });
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'At least one change is required' });
    }

    // Load existing bill within the transaction
    const bill = await Bill.findOne({ billNumber }).session(session);
    if (!bill) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Bill not found' });
    }

    // Do not allow editing paid bills
    if (bill.paymentStatus === 'Yes') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Paid bills cannot be edited' });
    }

    // Build quick lookup for existing operations in the bill
    // key: jobNumber|opsName|rateRounded
    function buildKey(jobNumber, opsName, rate) {
      const jn = String(jobNumber || '').trim();
      const name = String(opsName || '').trim();
      const r = Number(rate || 0);
      const roundedRate = Number.isFinite(r) ? r.toFixed(4) : '0.0000';
      return `${jn}|${name}|${roundedRate}`;
    }

    const billOpsMap = new Map();
    bill.jobs.forEach(job => {
      const jobNumber = job.jobNumber;
      (job.ops || []).forEach(op => {
        const key = buildKey(jobNumber, op.opsName, op.rate);
        billOpsMap.set(key, { job, op });
      });
    });

    // Collect deltas per job for JobopsMaster / Contractor_WD updates
    const deltasByJob = new Map(); // jobNumber -> [{ opsName, rate, deltaQty }]

    // Apply changes to bill in-memory
    for (const change of changes) {
      const { jobNumber, opsName, rate, newQtyCompleted } = change || {};

      if (!jobNumber || !String(jobNumber).trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have a jobNumber' });
      }
      if (!opsName || !String(opsName).trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have an opsName' });
      }
      if (newQtyCompleted === undefined || newQtyCompleted === null) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Each change must have newQtyCompleted' });
      }

      const key = buildKey(jobNumber, opsName, rate);
      const entry = billOpsMap.get(key);
      if (!entry) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: `Operation not found in bill for job ${jobNumber}, operation ${opsName}` });
      }

      const { job, op } = entry;
      const oldQty = Number(op.qtyCompleted || 0);
      const newQty = Number(newQtyCompleted);

      if (!Number.isFinite(newQty) || newQty < 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'newQtyCompleted must be a non-negative number' });
      }

      const delta = newQty - oldQty;
      if (delta === 0) {
        continue; // nothing to do for this row
      }

      // Track delta for backend collections
      if (!deltasByJob.has(job.jobNumber)) {
        deltasByJob.set(job.jobNumber, []);
      }
      deltasByJob.get(job.jobNumber).push({
        opsName: String(op.opsName || '').trim(),
        rate: Number(op.rate || 0),
        deltaQty: delta
      });

      // Update bill op
      op.qtyCompleted = newQty;
      op.totalValue = Number(op.rate || 0) * newQty;
    }

    // If no effective changes, just return the existing bill
    if (deltasByJob.size === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.json(bill);
    }

    // Helper to round valuePerBook / rate consistently
    const round2 = (val) => parseFloat(Number(val || 0).toFixed(2));

    // For each job, update JobopsMaster and Contractor_WD using deltas
    for (const [jobNumber, deltas] of deltasByJob.entries()) {
      const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber }).session(session);
      if (!jobOpsMaster) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: `JobopsMaster not found for job ${jobNumber}` });
      }

      // Fetch operation names for this job's operations
      const opIds = jobOpsMaster.ops.map(op => op.opId).filter(Boolean);
      const opObjectIds = opIds.map(opId => {
        try {
          return new mongoose.Types.ObjectId(opId);
        } catch {
          return null;
        }
      }).filter(Boolean);

      const operationDocs = await Operation.find({ _id: { $in: opObjectIds } }).session(session);
      const operationNameMap = {};
      operationDocs.forEach(op => {
        operationNameMap[op._id.toString()] = op.opsName;
      });

      // Apply each delta to JobopsMaster.ops and prepare Contractor_WD adjustments
      const contractorWDAdjustments = []; // { opsName, valuePerBook, deltaQty }

      for (const { opsName, rate, deltaQty } of deltas) {
        const normalizedName = String(opsName || '').trim();
        const normalizedRate = round2(rate);

        const jobOp = jobOpsMaster.ops.find(jop => {
          const jopName = operationNameMap[String(jop.opId)] || 'Unknown';
          const jopValue = round2(jop.valuePerBook);
          return jopName === normalizedName && jopValue === normalizedRate;
        });

        if (!jobOp) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ error: `Operation ${normalizedName} (rate ${normalizedRate}) not found in JobopsMaster for job ${jobNumber}` });
        }

        const currentPending = Number(jobOp.pendingOpsQty || 0);
        const totalOpsQty = Number(jobOp.totalOpsQty || 0);

        // Apply delta to pendingOpsQty: pending = pending - delta
        let newPending = currentPending - deltaQty;

        // For increases in completed qty (delta > 0), pending cannot go below 0
        // For decreases (delta < 0), pending cannot exceed totalOpsQty
        if (newPending < 0 - 1e-6) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            error: `Insufficient pending quantity for job ${jobNumber}, operation ${normalizedName} to increase completed quantity by ${deltaQty}`
          });
        }

        newPending = Math.max(0, Math.min(totalOpsQty, newPending));
        jobOp.pendingOpsQty = newPending;
        jobOp.lastUpdatedDate = new Date();

        contractorWDAdjustments.push({
          opsName: normalizedName,
          valuePerBook: jobOp.valuePerBook,
          deltaQty
        });
      }

      await jobOpsMaster.save({ session });

      // Apply adjustments to Contractor_WD
      let contractorWD = await ContractorWD.findOne({
        contractorId: contractorId,
        jobId: jobNumber
      }).session(session);

      const wasNewDocument = !contractorWD;
      if (!contractorWD) {
        contractorWD = new ContractorWD({
          contractorId: contractorId,
          jobId: jobNumber,
          opsDone: []
        });
      }

      for (const adj of contractorWDAdjustments) {
        const { opsName, valuePerBook, deltaQty } = adj;
        const adjName = String(opsName || '').trim();
        const adjValue = round2(valuePerBook);

        const existingOp = contractorWD.opsDone.find(od => {
          const odName = String(od.opsName || '').trim();
          const odVal = round2(od.valuePerBook);
          return odName === adjName && odVal === adjValue;
        });

        if (deltaQty > 0) {
          // Increase completed quantity
          if (existingOp) {
            existingOp.opsDoneQty += deltaQty;
            existingOp.completionDate = new Date();
          } else {
            contractorWD.opsDone.push({
              opsId: null, // opsId is not used for matching here
              opsName: adjName,
              valuePerBook: adjValue,
              opsDoneQty: deltaQty,
              completionDate: new Date()
            });
          }
        } else if (deltaQty < 0 && existingOp) {
          // Decrease completed quantity
          const newDone = Number(existingOp.opsDoneQty || 0) + deltaQty; // deltaQty is negative
          if (newDone <= 0) {
            // Remove entry if fully reversed
            contractorWD.opsDone = contractorWD.opsDone.filter(od => od !== existingOp);
          } else {
            existingOp.opsDoneQty = newDone;
            existingOp.completionDate = new Date();
          }
        }
      }

      // After all adjustments, check if opsDone is empty - if so, delete the document
      if (!contractorWD.opsDone || contractorWD.opsDone.length === 0) {
        // Delete the Contractor_WD document if it exists (was not newly created)
        if (!wasNewDocument && contractorWD._id) {
          await ContractorWD.deleteOne({ _id: contractorWD._id }).session(session);
        }
        // If it was a new document with no ops, we just don't save it (skip)
      } else {
        // Save only if there are operations remaining
        await contractorWD.save({ session });
      }
    }

    // After adjustments, clean up bill jobs:
    // - Remove operations with qtyCompleted === 0
    // - Remove jobs with no operations
    bill.jobs = bill.jobs
      .map(job => {
        const filteredOps = (job.ops || []).filter(op => Number(op.qtyCompleted || 0) > 0);
        return {
          jobNumber: job.jobNumber,
          clientName: job.clientName || '',
          jobTitle: job.jobTitle || '',
          ops: filteredOps
        };
      })
      .filter(job => (job.ops || []).length > 0);

    await bill.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json(bill);
  } catch (error) {
    console.error('Error editing bill quantities:', error);
    try {
      await session.abortTransaction();
    } catch (e) {}
    session.endSession();
    res.status(500).json({ error: 'Error editing bill quantities' });
  }
});

// Check if contractor has paid bill with roomRent in last 30 days
router.get('/check-roomrent/:contractorName', async (req, res) => {
  try {
    const { contractorName } = req.params;
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const paidBillWithRoomRent = await Bill.findOne({
      contractorName: contractorName.trim(),
      paymentStatus: 'Yes',
      paymentDate: { $gte: thirtyDaysAgo },
      roomRent: { $gt: 0 },
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ]
    });
    
    res.json({ hasRoomRent: !!paidBillWithRoomRent });
  } catch (error) {
    console.error('Error checking room rent:', error);
    res.status(500).json({ error: 'Error checking room rent' });
  }
});

// Mark bill as paid
router.patch('/:billNumber/pay', async (req, res) => {
  try {
    const { billNumber } = req.params;
    const { roomRent } = req.body;
    
    const bill = await Bill.findOne({ billNumber });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    
    bill.paymentStatus = 'Yes';
    bill.paymentDate = new Date();
    
    // Set roomRent if provided (default to 0 if not provided)
    if (roomRent !== undefined && roomRent !== null) {
      const rentValue = Number(roomRent);
      if (isNaN(rentValue) || rentValue < 0) {
        return res.status(400).json({ error: 'roomRent must be a non-negative number' });
      }
      bill.roomRent = rentValue;
    } else {
      bill.roomRent = 0;
    }
    
    await bill.save();
    res.json(bill);
  } catch (error) {
    console.error('Error marking bill as paid:', error);
    res.status(500).json({ error: 'Error marking bill as paid' });
  }
});

// Soft delete bill (set isDeleted = 1 and update pending/completed quantities)
router.delete('/:billNumber', async (req, res) => {
  try {
    const { billNumber } = req.params;
    // Query: billNumber matches AND (isDeleted is not 1 OR isDeleted doesn't exist)
    const bill = await Bill.findOne({
      billNumber,
      $or: [
        { isDeleted: { $ne: 1 } },
        { isDeleted: { $exists: false } }
      ]
    });
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found or already deleted' });
    }

    // Find the non-deleted contractor by name (Contractor model uses field "isdeleted", not "isDeleted")
    const contractorName = bill.contractorName.trim();
    const contractor = await Contractor.findOne({
      name: contractorName,
      $or: [ { isdeleted: 0 }, { isdeleted: { $exists: false } } ]
    });
    console.log('contractor', JSON.stringify(contractor));
    if (!contractor) {
      return res.status(404).json({ error: `Contractor not found for name: ${bill.contractorName}` });
    }
    const contractorId = contractor.contractorId;
    

    // Reverse all work from this bill: restore JobopsMaster pending and reduce Contractor_WD opsDone
    for (const job of bill.jobs) {
      const jobOpsMaster = await JobopsMaster.findOne({ jobId: job.jobNumber });

      if (jobOpsMaster) {
        const isPackaging = (jobOpsMaster.segmentName || '').trim() === 'Packaging';
        const jobTotalQty = Number(jobOpsMaster.totalQty) || 0;

        // Total completed qty per op for this job (all contractors) – Packaging rule applies only when this > op's totalOpsQty
        const contractorWDDocsForJob = await ContractorWD.find({ jobId: job.jobNumber }).lean();
        const totalCompletedByOp = {};
        (contractorWDDocsForJob || []).forEach(doc => {
          (doc.opsDone || []).forEach(od => {
            if (od.opsId == null || od.opsDoneQty == null) return;
            const opKey = String(od.opsId);
            totalCompletedByOp[opKey] = (totalCompletedByOp[opKey] || 0) + od.opsDoneQty;
          });
        });

        for (const op of job.ops) {
          const operation = await Operation.findOne({ opsName: op.opsName.trim() });
          if (operation) {
            const opIdStr = operation._id.toString();
            const jobOp = jobOpsMaster.ops.find(jop => String(jop.opId) === opIdStr);
            if (jobOp) {
              const qtyCompleted = Number(op.qtyCompleted || 0);
              const totalOpsQty = Number(jobOp.totalOpsQty) || 0;
              const totalCompletedForOp = totalCompletedByOp[opIdStr] || 0;
              const usePackagingRule = isPackaging && totalCompletedForOp > totalOpsQty;
              let restored;
              if (usePackagingRule) {
                const addBack = Math.max(0, qtyCompleted - jobTotalQty * 0.05);
                restored = jobOp.pendingOpsQty + addBack;
              } else {
                restored = jobOp.pendingOpsQty + qtyCompleted;
              }
              jobOp.pendingOpsQty = Math.min(totalOpsQty, Math.max(0, restored)); // pending must not exceed total
              jobOp.lastUpdatedDate = new Date();
            }
          }
        }
        jobOpsMaster.markModified('ops');
        await jobOpsMaster.save();
      }

      // Reverse Contractor_WD: subtract each op's qtyCompleted from opsDone (remove entry if qty goes to 0)
      const contractorWD = await ContractorWD.findOne({
        contractorId: contractorId,
        jobId: job.jobNumber
      });

      if (contractorWD) {
        for (const op of job.ops) {
          const operation = await Operation.findOne({ opsName: op.opsName.trim() });
          if (operation) {
            const opIdStr = operation._id.toString();
            const wdOp = contractorWD.opsDone.find(od => String(od.opsId) === opIdStr);
            if (wdOp) {
              const qtyCompleted = Number(op.qtyCompleted || 0);
              wdOp.opsDoneQty = Math.max(0, wdOp.opsDoneQty - qtyCompleted);
              if (wdOp.opsDoneQty <= 0) {
                contractorWD.opsDone = contractorWD.opsDone.filter(od => String(od.opsId) !== opIdStr);
              }
            }
          }
        }
        contractorWD.markModified('opsDone');
        if (contractorWD.opsDone.length > 0) {
          await contractorWD.save();
        } else {
          await ContractorWD.deleteOne({ _id: contractorWD._id });
        }
      }
    }

    // Soft delete the bill
    bill.isDeleted = 1;
    await bill.save();
    
    res.json({ message: 'Bill deleted successfully' });
  } catch (error) {
    console.error('Error deleting bill:', error);
    res.status(500).json({ error: 'Error deleting bill', details: error.message });
  }
});

module.exports = router;
