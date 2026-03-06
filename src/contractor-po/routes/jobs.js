const express = require('express');

const router = express.Router();

const Job = require('../models/Job');

const JobOperation = require('../models/JobOperation');

const Operation = require('../models/Operation');

const ContractorWD = require('../models/ContractorWD');

const Contractor = require('../models/Contractor');

const JobopsMaster = require('../models/JobOpsMaster');

const { getConnection, sql } = require('../config/db');



// Get all jobs

router.get('/', async (req, res) => {

  try {

    const jobs = await Job.find().sort({ createdAt: -1 });

    res.json(jobs);

  } catch (error) {

    console.error('Error fetching jobs:', error);

    res.status(500).json({ error: 'Error fetching jobs' });

  }

});



// Search job by number

router.get('/search/:jobNumber', async (req, res) => {

  try {

    const { jobNumber } = req.params;



    // Get previous operations from JobopsMaster (jobId = job number)

    const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber }).lean();



    // Build previous operations summary from JobopsMaster + Contractor_WD

    let previousOps = null;



    if (jobOpsMaster && jobOpsMaster.ops && jobOpsMaster.ops.length > 0) {

      try {

        // Get all opIds from JobopsMaster

        const opIds = jobOpsMaster.ops.map(op => op.opId);



        // Get operation names from Operation collection

        const opsDocs = await Operation.find(

          { _id: { $in: opIds } },

          { _id: 1, opsName: 1 }

        ).lean();



        const opsNameById = {};

        opsDocs.forEach(op => {

          opsNameById[op._id.toString()] = op.opsName;

        });



        // Check Contractor_WD for completed work (jobId is job number string)

        const contractorWDDocs = await ContractorWD.find({

          jobId: jobNumber

        }).lean();



        // Collect unique contractor IDs

        const contractorIds = [

          ...new Set(contractorWDDocs.map(doc => doc.contractorId))

        ];



        // Get contractor names

        const contractors = await Contractor.find({

          contractorId: { $in: contractorIds }

        }).lean();



        const contractorNameById = {};

        contractors.forEach(c => {

          contractorNameById[c.contractorId] = c.name;

        });



        // Aggregate completed quantities by operation and contractor
        // Use opId as key for matching
        const quantitiesByOpAndContractor = {};

        const totalCompletedByOp = {}; // Track total completed across all contractors (key: opId)



        contractorWDDocs.forEach(doc => {

          const contractorId = doc.contractorId;

          (doc.opsDone || []).forEach(od => {

            if (!od.opsId || od.opsDoneQty == null) {

              return;

            }

            // Use opId as key for matching
            const opKey = String(od.opsId);

            // Only count if this opId exists in JobopsMaster (preliminary check)
            if (opIds.includes(od.opsId)) {

              if (!quantitiesByOpAndContractor[opKey]) {

                quantitiesByOpAndContractor[opKey] = {};

              }

              if (!quantitiesByOpAndContractor[opKey][contractorId]) {

                quantitiesByOpAndContractor[opKey][contractorId] = 0;

              }

              quantitiesByOpAndContractor[opKey][contractorId] += od.opsDoneQty;

              

              // Track total completed for this operation

              if (!totalCompletedByOp[opKey]) {

                totalCompletedByOp[opKey] = 0;

              }

              totalCompletedByOp[opKey] += od.opsDoneQty;

            }

          });

        });



        // Build previousOps from JobopsMaster.ops
        // Match using opId only

        previousOps = {

          contractors: contractorIds.map(id => ({

            contractorId: id,

            name: contractorNameById[id] || id

          })),

          operations: jobOpsMaster.ops.map(op => {

            const totalOpsQty = op.totalOpsQty || 0;
            
            // Get opsName for this operation
            const opOpsName = opsNameById[op.opId] || 'Unknown';
            
            // Use opId as key for matching
            const opKey = String(op.opId);

            const totalCompleted = totalCompletedByOp[opKey] || 0;

            const pending = Math.max(0, totalOpsQty - totalCompleted);

            

            return {

              opsId: op.opId,

              opsName: opOpsName,

              totalOpsQty,

              totalCompleted,

              pending,

              quantitiesByContractor:

                quantitiesByOpAndContractor[opKey] || {}

            };

          })

        };

      } catch (aggError) {

        console.error('Error building previous ops summary:', aggError);

      }

    }



    // Return response (job can be null if not in Job collection, but we don't need it)

    res.json({

      job: null, // Not using Job collection anymore

      operations: [], // Not using JobOperation collection anymore

      previousOps

    });

  } catch (error) {

    console.error('Error searching job:', error);

    res.status(500).json({ error: 'Error searching job' });

  }

});



// Get job by ID

router.get('/:id', async (req, res) => {

  try {

    const job = await Job.findById(req.params.id);

    if (!job) {

      return res.status(404).json({ error: 'Job not found' });

    }



    const operations = await JobOperation.find({ job: job._id })

      .populate('operation', 'opsName type');



    res.json({

      job,

      operations

    });

  } catch (error) {

    console.error('Error fetching job:', error);

    res.status(500).json({ error: 'Error fetching job' });

  }

});



// Create new job

router.post('/', async (req, res) => {

  try {

    const { jobNumber, clientName, jobTitle, qty, productCat, unitPrice } = req.body;



    if (!jobNumber || !clientName || !jobTitle || !qty) {

      return res.status(400).json({ error: 'Missing required fields' });

    }



    // Check if job number already exists

    const existingJob = await Job.findOne({ jobNumber });

    if (existingJob) {

      return res.status(400).json({ error: 'Job number already exists' });

    }



    const job = new Job({

      jobNumber,

      clientName,

      jobTitle,

      qty,

      productCat: productCat || '',

      unitPrice: unitPrice || 0

    });



    await job.save();

    res.status(201).json(job);

  } catch (error) {

    console.error('Error creating job:', error);

    res.status(500).json({ error: 'Error creating job' });

  }

});



// Add operations to job (existing JobOperation-based endpoint)

router.post('/:jobId/operations', async (req, res) => {

  try {

    const { jobId } = req.params;

    const { operations } = req.body; // Array of { operationId, qtyPerBook, rate, ratePerBook }



    const job = await Job.findById(jobId);

    if (!job) {

      return res.status(404).json({ error: 'Job not found' });

    }



    const createdOperations = [];



    for (const op of operations) {

      const { operationId, qtyPerBook, rate, ratePerBook } = op;



      if (!operationId || qtyPerBook === undefined || rate === undefined || ratePerBook === undefined) {

        continue; // Skip invalid operations

      }



      const jobOperation = new JobOperation({

        job: jobId,

        operation: operationId,

        qtyPerBook,

        rate,

        ratePerBook,

        contractorWork: []

      });



      await jobOperation.save();

      createdOperations.push(jobOperation);

    }



    res.status(201).json(createdOperations);

  } catch (error) {

    console.error('Error adding operations to job:', error);

    res.status(500).json({ error: 'Error adding operations to job' });

  }

});



// Save Job Ops to JobopsMaster only (no Job / JobOperation)

router.post('/jobopsmaster', async (req, res) => {

  try {

    const {

      jobNumber,

      operations,

      qty,

      clientName,

      jobTitle,

      segmentName

    } = req.body;



    if (!jobNumber || !operations || !Array.isArray(operations) || operations.length === 0) {

      return res.status(400).json({ error: 'Job number and at least one operation are required' });

    }



    // totalQty in JobopsMaster should be the qty from UI

    const totalQty = Number(qty || 0);

    // Fetch all operations to get their types and names for calculation
    const operationIds = operations.map(op => op.operationId).filter(Boolean);
    const operationDocs = await Operation.find({ _id: { $in: operationIds } });
    const operationTypeMap = {};
    const operationNameMap = {};
    operationDocs.forEach(op => {
      // Normalize ID to string for consistent lookup
      const idStr = op._id.toString();
      operationTypeMap[idStr] = op.type;
      operationNameMap[idStr] = op.opsName;
    });
    
    console.log('Operation Type Map:', JSON.stringify(operationTypeMap, null, 2));

    const ops = operations

      .map(op => {

        const { operationId, qtyPerBook, ratePerBook } = op;

        if (!operationId || qtyPerBook === undefined || ratePerBook === undefined) {

          return null;

        }



        const qtyPerBookNum = Number(qtyPerBook);

        const valuePerBookNum = parseFloat(Number(ratePerBook).toFixed(4));



        if (isNaN(qtyPerBookNum) || qtyPerBookNum < 0 || isNaN(valuePerBookNum) || valuePerBookNum < 0) {

          return null;

        }

        // Get operation type and name - normalize operationId to string for lookup
        const opIdStr = String(operationId);
        const operationType = operationTypeMap[opIdStr];
        const opsName = operationNameMap[opIdStr] || 'Unknown';
        
        // For 1/x operations: save qtyPerBook as (1/qtyPerBook value) and totalOpsQty = totalQty
        // For 1*x operations: save qtyPerBook as is and totalOpsQty = totalQty
        // For 1:1 operations: save qtyPerBook as is and totalOpsQty = qtyPerBook * totalQty
        let savedQtyPerBook;
        let totalOpsQty;
        if (operationType === '1/x') {
          // For 1/x: save qtyPerBook as 1/qtyPerBook (e.g., if user enters 4, save 1/4 = 0.25).
          // Use enough precision (e.g. 10 decimals) so 1/savedValue recovers the original denominator (e.g. 300 → 0.00333... → copy shows 300, not 303).
          savedQtyPerBook = qtyPerBookNum > 0 ? parseFloat((1 / qtyPerBookNum).toFixed(14)) : 0;
          // For 1/x: totalOpsQty = totalQty (no calculation)
          totalOpsQty = totalQty;
          console.log(`[1/x] Operation ${opIdStr}: totalQty=${totalQty}, user qtyPerBook=${qtyPerBookNum}, saved qtyPerBook=${savedQtyPerBook}, totalOpsQty=${totalOpsQty}`);
        } else if (operationType === '1*x') {
          // For 1*x: save qtyPerBook as is (no conversion)
          savedQtyPerBook = qtyPerBookNum;
          // For 1*x: totalOpsQty = totalQty (no calculation)
          totalOpsQty = totalQty;
          console.log(`[1*x] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty}`);
        } else {
          // For 1:1: save qtyPerBook as is
          savedQtyPerBook = qtyPerBookNum;
          // For 1:1: totalOpsQty = qtyPerBook * totalQty
          totalOpsQty = qtyPerBookNum * totalQty;
          if (operationType) {
            console.log(`[${operationType}] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty}`);
          } else {
            console.log(`[WARNING: Operation type not found] Operation ${opIdStr}: totalQty=${totalQty}, qtyPerBook=${qtyPerBookNum}, totalOpsQty=${totalOpsQty} (using default multiplication)`);
          }
        }



        return {

          opId: String(operationId),

          qtyPerBook: savedQtyPerBook,

          totalOpsQty,

          pendingOpsQty: totalOpsQty, // completed qty = 0 initially

          valuePerBook: valuePerBookNum

        };

      })

      .filter(Boolean);



    if (ops.length === 0) {

      return res.status(400).json({ error: 'No valid operations to save' });

    }



    // jobId in JobopsMaster is exactly the job number from UI

    let jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber });



    if (!jobOpsMaster) {

      // Create new JobopsMaster document

      jobOpsMaster = new JobopsMaster({

        jobId: jobNumber,

        totalQty,

        clientName: clientName || '',

        jobTitle: jobTitle || '',

        segmentName: segmentName || '',

        ops

      });

    } else {

      // Update totalQty (use the latest value from UI)

      jobOpsMaster.totalQty = totalQty;

      // Update clientName and jobTitle if provided

      if (clientName !== undefined) {

        jobOpsMaster.clientName = clientName || '';

      }

      if (jobTitle !== undefined) {

        jobOpsMaster.jobTitle = jobTitle || '';

      }

      if (segmentName !== undefined) {

        jobOpsMaster.segmentName = segmentName || '';

      }

      

      // Fetch operation names for existing operations in JobOpsMaster
      const existingOpIds = jobOpsMaster.ops.map(existingOp => existingOp.opId).filter(Boolean);
      const allOpIds = [...new Set([...operationIds, ...existingOpIds])];
      const allOperationDocs = await Operation.find({ _id: { $in: allOpIds } });
      const allOperationNameMap = {};
      allOperationDocs.forEach(op => {
        const idStr = op._id.toString();
        allOperationNameMap[idStr] = op.opsName;
      });

      // Process each new operation
      // Use opId as unique key - prevent duplicate operations regardless of valuePerBook
      for (const newOp of ops) {
        // Get opsName for this operation
        const opIdStr = String(newOp.opId);
        const opsName = allOperationNameMap[opIdStr] || 'Unknown';
        
        // Find existing operation with same opId (prevent duplicates by operation ID only)
        const existingOpIndex = jobOpsMaster.ops.findIndex(existingOp => {
          const existingOpIdStr = String(existingOp.opId);
          return existingOpIdStr === opIdStr;
        });
        
        if (existingOpIndex !== -1) {
          // Operation already exists - reject duplicate
          return res.status(400).json({ 
            error: `Operation "${opsName}" is already added to this job. Duplicate operations are not allowed.` 
          });
        } else {
          // Add new operation
          jobOpsMaster.ops.push(newOp);
        }
      }

    }



    await jobOpsMaster.save();



    res.status(201).json(jobOpsMaster);

  } catch (error) {

    console.error('Error saving job operations to JobopsMaster:', error);

    res.status(500).json({ error: 'Error saving job operations' });

  }

});



// Get all job numbers from JobopsMaster

router.get('/jobopsmaster/jobnumbers', async (req, res) => {

  try {

    const jobOpsMasters = await JobopsMaster.find({}, 'jobId').sort({ jobId: 1 }).lean();

    const jobNumbers = jobOpsMasters.map(job => job.jobId);

    res.json(jobNumbers);

  } catch (error) {

    console.error('Error fetching job numbers:', error);

    res.status(500).json({ error: 'Error fetching job numbers' });

  }

});



// Get a single JobopsMaster document by job number (used for copy-ops in UI)
// Uses query parameter to safely handle job numbers with special characters like '/'
router.get('/jobopsmaster/by-job-number', async (req, res) => {
  try {
    const { jobNumber } = req.query;

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber }).lean();

    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobopsMaster' });
    }

    // Return only the fields the frontend needs for copying (ops array + jobId)
    res.json({
      jobId: jobOpsMaster.jobId,
      ops: jobOpsMaster.ops || [],
    });
  } catch (error) {
    console.error('Error fetching JobopsMaster by job number:', error);
    res.status(500).json({ error: 'Error fetching JobopsMaster by job number' });
  }
});



// Search job numbers from MSSQL (when 4+ digits entered)

router.get('/search-numbers/:jobNumberPart', async (req, res) => {

  try {

    const { jobNumberPart } = req.params;

    console.log('🔍 [BACKEND] /jobs/search-numbers called with jobNumberPart:', jobNumberPart);

    if (!jobNumberPart || jobNumberPart.length < 4) {

      return res.status(400).json({ error: 'Job number part must be at least 4 characters' });

    }



    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();

    // Pass as string parameter to stored procedure

    request.input('JobNumberPart', sql.NVarChar(255), String(jobNumberPart));

    console.log('🔍 [MSSQL] Calling dbo.contractor_search_jobnumbers with @JobNumberPart =', jobNumberPart);

    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_search_jobnumbers');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    console.log('🔍 [MSSQL] Raw result.recordset:', JSON.stringify(result.recordset, null, 2));

    console.log('🔍 [MSSQL] result.recordset.length:', result.recordset.length);

    

    // Extract job numbers from result

    // The procedure should return a recordset with job numbers

    const jobNumbers = result.recordset.map((row, index) => {

      console.log(`🔍 [MSSQL] Row ${index}:`, JSON.stringify(row, null, 2));

      // Try common column name variations

      const jobNum = row.JobNumber || row.Job_Number || row.jobNumber || row.job_number || 

             row.JobNo || row.Job_NO || Object.values(row)[0];

      console.log(`🔍 [MSSQL] Row ${index} extracted jobNumber:`, jobNum);

      return jobNum;

    }).filter(Boolean); // Remove any undefined/null values

    console.log('🔍 [BACKEND] Final jobNumbers array:', jobNumbers);

    res.json(jobNumbers);

  } catch (error) {

    console.error('❌ [BACKEND] Error searching job numbers:', error);

    console.error('❌ [BACKEND] Error stack:', error.stack);

    res.status(500).json({ error: 'Error searching job numbers: ' + error.message });

  }

});



// Get job details from MSSQL (when job number selected)

router.get('/details/:jobNumber', async (req, res) => {

  try {

    const { jobNumber } = req.params;

    

    if (!jobNumber) {

      return res.status(400).json({ error: 'Job number is required' });

    }



    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();

    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Calling dbo.contractor_get_job_details2 with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.execute('dbo.contractor_get_job_details2');
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Stored procedure executed in ${queryTime}ms`);

    

    if (result.recordset.length === 0) {

      return res.status(404).json({ error: 'Job not found' });

    }



    const jobDetails = result.recordset[0];

    

    // Map MSSQL column names to our expected format based on the image description

    // Columns: Client Name, Job Title, OrderQty, ProductCategory, UnitPrice

    res.json({

      clientName: jobDetails['Client Name'] || jobDetails.ClientName || jobDetails.clientName || '',

      jobTitle: jobDetails['Job Title'] || jobDetails.JobTitle || jobDetails.jobTitle || '',

      qty: jobDetails.OrderQty || jobDetails.orderQty || jobDetails.Qty || jobDetails.qty || 0,

      productCat: jobDetails.ProductCategory || jobDetails.productCategory || jobDetails.ProductCat || jobDetails.productCat || '',

      unitPrice: jobDetails.UnitPrice || jobDetails.unitPrice || jobDetails.unit_price || 0,

      segmentName: jobDetails.SegmentName || jobDetails.segmentName || ''

    });

  } catch (error) {

    console.error('Error fetching job details:', error);

    res.status(500).json({ error: 'Error fetching job details: ' + error.message });

  }

});



// Get job details for update job card app (with ClientName, JobName, OrderQuantity, PODate)
router.get('/details-update/:jobNumber', async (req, res) => {
  try {
    const { jobNumber } = req.params;

    if (!jobNumber) {
      return res.status(400).json({ error: 'Job number is required' });
    }

    const connectionStartTime = Date.now();
    const pool = await getConnection();
    const connectionTime = Date.now() - connectionStartTime;
    console.log(`⏱️ [MSSQL] Connection obtained in ${connectionTime}ms`);

    const request = pool.request();
    
    // Query for update job card app
    const query = `
      SELECT ClientName, JobName, OrderQuantity, PODate 
      FROM jobbookingjobcard 
      WHERE jobbookingno = @JobBookingNo
    `;
    
    request.input('JobBookingNo', sql.NVarChar(255), jobNumber);

    console.log('🔍 [MSSQL] Executing query for update job card with @JobBookingNo =', jobNumber);
    const queryStartTime = Date.now();
    const result = await request.query(query);
    const queryTime = Date.now() - queryStartTime;
    console.log(`⏱️ [MSSQL] Query executed in ${queryTime}ms`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobDetails = result.recordset[0];

    // Format PODate to show only date (no time)
    let poDateFormatted = null;
    if (jobDetails.PODate) {
      const poDate = new Date(jobDetails.PODate);
      if (!isNaN(poDate.getTime())) {
        // Format as YYYY-MM-DD
        const year = poDate.getFullYear();
        const month = String(poDate.getMonth() + 1).padStart(2, '0');
        const day = String(poDate.getDate()).padStart(2, '0');
        poDateFormatted = `${year}-${month}-${day}`;
      }
    }

    res.json({
      clientName: jobDetails.ClientName || jobDetails.clientName || null,
      jobName: jobDetails.JobName || jobDetails.jobName || null,
      orderQuantity: jobDetails.OrderQuantity || jobDetails.orderQuantity || 0,
      poDate: poDateFormatted
    });
  } catch (error) {
    console.error('Error fetching job details for update:', error);
    res.status(500).json({ error: 'Error fetching job details: ' + error.message });
  }
});

// Delete an operation from JobopsMaster
// Use query parameters instead of path params to handle special characters in job numbers
router.delete('/jobopsmaster/operation', async (req, res) => {
  try {
    const { jobNumber, opId } = req.query;

    if (!jobNumber || !opId) {
      return res.status(400).json({ error: 'Job number and operation ID are required' });
    }

    // Find the job in JobopsMaster
    const jobOpsMaster = await JobopsMaster.findOne({ jobId: jobNumber });

    if (!jobOpsMaster) {
      return res.status(404).json({ error: 'Job not found in JobopsMaster' });
    }

    // Find the operation index
    const opIndex = jobOpsMaster.ops.findIndex(op => String(op.opId) === String(opId));

    if (opIndex === -1) {
      return res.status(404).json({ error: 'Operation not found in this job' });
    }

    const operation = jobOpsMaster.ops[opIndex];

    // Check if totalOpsQty equals pendingOpsQty (no work has been done)
    if (operation.totalOpsQty !== operation.pendingOpsQty) {
      return res.status(400).json({ 
        error: 'Cannot delete operation. Work has already been completed on this operation.' 
      });
    }

    // Remove the operation from the array
    jobOpsMaster.ops.splice(opIndex, 1);

    // Save the updated document
    await jobOpsMaster.save();

    res.json({ 
      message: 'Operation deleted successfully',
      jobNumber,
      opId
    });
  } catch (error) {
    console.error('Error deleting operation from JobopsMaster:', error);
    res.status(500).json({ error: 'Error deleting operation', details: error.message });
  }
});

module.exports = router;

