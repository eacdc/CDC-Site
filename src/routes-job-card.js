/**
 * Job Card API: packaging job card from ProductionWorkOrderPrint + ItemDetails, OperationDetails, AllocateMaterial, ToolAllocation, PaperFlow.
 */
import { Router } from 'express';
import { getPool } from './db.js';
import sql from 'mssql';
import {
  ItemDetailsQuery,
  OperationDetailsQuery,
  AllocateMaterialDetailsQuery,
  ToolAllocationDetailsQuery,
  CorrugationDetailsQuery
} from './job-card-queries.js';

const router = Router();
const COMPANY_ID = '2';

function get(row, key) {
  if (row == null) return undefined;
  const lower = key.toLowerCase();
  const found = Object.keys(row).find(k => k.toLowerCase() === lower);
  return found != null ? row[found] : undefined;
}

function str(val) {
  return val != null && val !== '' ? String(val).trim() : '';
}

router.get('/job-card', async (req, res) => {
  const { jobNumber, type, database } = req.query || {};
  const jobNo = str(jobNumber);
  const cardType = (str(type) || '').toLowerCase();
  const db = (str(database) || 'KOL').toUpperCase();

  if (!jobNo) return res.status(400).json({ error: 'jobNumber is required' });
  if (cardType !== 'packaging' && cardType !== 'commercial') return res.status(400).json({ error: 'type must be packaging or commercial' });
  if (db !== 'KOL' && db !== 'AHM') return res.status(400).json({ error: 'database must be KOL or AHM' });

  try {
    if (cardType === 'packaging' || cardType === 'commercial') {
      const pool = await getPool(db);
      let request = pool.request();
      request.input('JobNumber', sql.NVarChar(100), jobNo);
      const procResult = await request.query("EXEC dbo.ProductionWorkOrderPrint 1, @JobNumber, '2'");
      const row = (procResult.recordset && procResult.recordset[0]) || null;
      if (!row) return res.status(404).json({ error: 'Job not found' });
      // console.log("####",row);

      const raw = str(get(row, 'JobBookingID')) || str(get(row, 'BookingID'));
      const jobBookingId = raw.includes(',') ? raw.split(',')[0].trim() : raw;
      console.log("####",jobBookingId);
      const companyId = COMPANY_ID;

      // ---- Header ----
      const header = {
        jobNo: str(get(row, 'JobBookingNo')) || jobNo,
        soNo: str(get(row, 'OrderBookingNo')),
        jobDate: str(get(row, 'BookingDate')),
        estNo: '',
        delDate: str(get(row, 'DeliveryDate')),
        quantity: str(get(row, 'OrderQuantity')),
        refProductMasterCode: str(get(row, 'RefProductMasterCode')) || '',
        soQuantity: str(get(row, 'OrderQuantity'))
      };

      // ---- Job Info ----
      const jobInfo = {
        jobName: str(get(row, 'JobName')),
        clientName: str(get(row, 'LedgerName')),
        consignee: str(get(row, 'ConsigneeName')),
        coordinator: str(get(row, 'JobCoordinatorName')),
        category: str(get(row, 'CategoryName')) || str(get(row, 'Category')),
        contentName: str(get(row, 'ContentName')),
        jobSizeMm: str(get(row, 'JobCloseSize')),
        salesPerson: str(get(row, 'salespersonname')) || str(get(row, 'Salespersonname')),
        poNo: str(get(row, 'PONo')),
        poDate: str(get(row, 'PODate')),
        jobPriority: str(get(row, 'JobPriority')),
        jobType: str(get(row, 'JobType')),
        plateType: str(get(row, 'PlanType')) || str(get(row, 'PlateType')),
        productCode: str(get(row, 'ProductCode')),
        pcCode: str(get(row, 'ProductMasterCode')),
        ProductHSNName: str(get(row, 'ProductHSNName')),
        refPcCode: str(get(row, 'RefProductMasterCode')) || str(get(row, 'RefProductMasterCode1')),
        finishedFormat: str(get(row, 'FormprintStyle')) || '',
        ups: str(get(row, 'TotalUps')),
        paperBy: str(get(row, 'PaperBy')),
        actualSheets: str(get(row, 'ActualSheets')),
        processWaste: str(get(row, 'WastageSheets')),
        makeReadyWaste: str(get(row, 'MakeReadyWastageSheet')),
        totalReqSheets: str(get(row, 'TotalSheets'))
      };

      // ---- Paper Details: from procedure (1 row) then from ItemDetails query ----
      let paperDetails = [];
      const procPaper = str(get(row, 'Paper'));
      const procPaperSize = str(get(row, 'PaperSizeinMM'));
      const procTotalSheets = str(get(row, 'TotalSheets'));
      const procCutSize = str(get(row, 'CutSize'));
      const procCuts = str(get(row, 'Cuts'));
      const procWeight = str(get(row, 'TotalRequiredWt')) || str(get(row, 'ActualWt'));
      const procItemCode = str(get(row, 'PaperCode'));
      if (procItemCode || procPaper) {
        paperDetails.push({
          itemCode: procItemCode || '-',
          itemName: procPaper || '-',
          paperSize: procPaperSize || procCutSize || '-',
          totalSheets: procTotalSheets || '-',
          cutSize: procCutSize || '-',
          cuts: procCuts || '-',
          finalQty: procTotalSheets || '-',
          itemWeight: procWeight || '-'
        });
      }

      if (jobBookingId) {
        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', sql.BigInt, null);
          const itemRes = await request.query(ItemDetailsQuery);
          const itemRows = itemRes.recordset || [];
          if (itemRows.length > 0) {
            paperDetails = itemRows.map(r => ({
              itemCode: str(get(r, 'ItemCode')) || '-',
              itemName: str(get(r, 'ItemName')) || '-',
              paperSize: str(get(r, 'PaperSize')) || '-',
              totalSheets: str(get(r, 'TotalSheets')) || '-',
              cutSize: str(get(r, 'CutSize')) || '-',
              cuts: str(get(r, 'Cuts')) ?? '-',
              finalQty: str(get(r, 'Final_Quantity')) || str(get(r, 'TotalSheets')) || '-',
              itemWeight: str(get(r, 'ItemWeight')) || '-'
            }));
          }
        } catch (e) {
          console.warn('[job-card] ItemDetails query failed:', e.message);
        }
      }

      // ---- Print Details from procedure ----
      const printDetails = {
        machineName: str(get(row, 'MachineName')),
        printingStyle: str(get(row, 'PrintingStyle')),
        plateQty: str(get(row, 'PlateQty')),
        frontColor: str(get(row, 'FrontColor')) || str(get(row, 'FrontColorName')),
        spFrontColor: str(get(row, 'SpecialFrontColor')),
        soiRemark: '',
        remark: str(get(row, 'Remark')) || str(get(row, 'JobCardRemark')),
        specialInstr: str(get(row, 'SpecialInstructions')),
        jobReference: str(get(row, 'JobReference')),
        processSize: str(get(row, 'JobProcessSize')),
        reverseTuckIn: str(get(row, 'Orientation')) || str(get(row, 'ContentName')),
        onlineCoating: str(get(row, 'OnlineCoating')),
        gripperMm: str(get(row, 'GRIPPERREMARK')) || str(get(row, 'Gripper')),
        backColor: str(get(row, 'BackColor')) || str(get(row, 'BackColorName')),
        spBackColor: str(get(row, 'SpecialBackColor')),
        impressions: str(get(row, 'ImpressionsToBeCharged')) || str(get(row, 'totalimpressionsnew')) || str(get(row, 'PrintingImpressions'))
      };

      // ---- Operation Details + Tool allocation + Allocated Materials + Corrugation (packaging: once with null; commercial: per component in loop below) ----
      let operationDetails = [];
      let allocatedMaterials = [];
      let corrugationDetails = [];
      if (jobBookingId && cardType === 'packaging') {
        const toolBySeq = {};
        try {
          console.log('[job-card] OperationDetails query inputs:', { CompanyID: companyId, JobBookingID: jobBookingId });
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', sql.BigInt, null);
          const opRes = await request.query(OperationDetailsQuery);
          const opRows = opRes.recordset || [];
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', sql.BigInt, null);
          const toolRes = await request.query(ToolAllocationDetailsQuery);
          (toolRes.recordset || []).forEach(r => {
            const seq = get(r, 'SequenceNo');
            if (seq != null) toolBySeq[String(seq)] = { toolCode: str(get(r, 'ToolCode')), refNo: str(get(r, 'ToolRefCode')) };
          });
          operationDetails = opRows.map((r, i) => {
            const seq = get(r, 'SequenceNo');
            const tool = seq != null ? toolBySeq[String(seq)] : null;
            return {
              sn: i + 1,
              operationName: str(get(r, 'ProcessName')) || '-',
              scheduleMachineName: str(get(r, 'ScheduledMachineName')) || '-',
              scheduleQty: str(get(r, 'ToBeProduceQty')) || '0',
              employeeName: str(get(r, 'EmployeeName')) || '-',
              proMachineName: str(get(r, 'ProductionMachineName')) || '-',
              proQty: str(get(r, 'ReadyQty')) || str(get(r, 'ProductionQuantity')) || '0',
              date: str(get(r, 'FromTime')) || '',
              status: str(get(r, 'Status')) || '-',
              remark: str(get(r, 'Remarks')) || '',
              toolCode: tool ? tool.toolCode : '',
              refNo: tool ? tool.refNo : ''
            };
          });
          const opsWithoutTool = operationDetails.filter(op => !op.toolCode && !op.refNo);
          const opsWithTool = operationDetails.filter(op => op.toolCode || op.refNo);
          operationDetails = [...opsWithoutTool, ...opsWithTool];
          operationDetails.forEach((op, idx) => { op.sn = idx + 1; });
        } catch (e) {
          console.warn('[job-card] OperationDetails/Tool query failed:', e.message);
        }
        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', sql.BigInt, null);
          const allocRes = await request.query(AllocateMaterialDetailsQuery);
          const allocRows = allocRes.recordset || [];
          allocatedMaterials = allocRows.map(r => ({
            operationName: str(get(r, 'OperationName')) || '-',
            material: str(get(r, 'Material')) || '-',
            qty: str(get(r, 'Qty')) || '0',
            unit: str(get(r, 'Unit')) || '-'
          }));
        } catch (e) {
          console.warn('[job-card] AllocateMaterialDetails query failed:', e.message);
        }
        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          const corrRes = await request.query(CorrugationDetailsQuery);
          const corrRows = corrRes.recordset || [];
          corrugationDetails = corrRows.map(r => ({
            plyNo: str(get(r, 'PlyNo')) ?? '',
            flute: str(get(r, 'Flute')) || 'None',
            itemCode: str(get(r, 'ItemCode')) || '',
            itemDetails: str(get(r, 'ItemDetails')) || '',
            dechleSize: str(get(r, 'DechleSize')) || '',
            cutSize: str(get(r, 'CutSize')) || '',
            weightGm: str(get(r, 'WeightGm')) ?? '',
            sheets: str(get(r, 'Sheets')) ?? ''
          }));
        } catch (e) {
          console.warn('[job-card] CorrugationDetails query failed:', e.message);
        }
      }

      // ---- Paper Flow: from procedure GetPaperFlowForJob (and header rows from procedure row) ----
      let paperFlow = [];
      const paperFlowHeaderRows = [
        { operation: 'Printing Front Side', description: str(get(row, 'Paper')) || '', qty: str(get(row, 'TotalSheets')) || '', unit: 'Sheet' },
        { operation: 'Printing Front Side', description: str(get(row, 'FrontColorName')) || str(get(row, 'FrontColor')) || '', qty: '', unit: 'Kg' }
      ];
      try {
        request = pool.request();
        request.input('ContID', sql.NVarChar(100), jobNo);
        const flowResult = await request.query('EXEC dbo.GetPaperFlowForJob @ContID');
        const flowRows = flowResult.recordset || [];
        paperFlow = flowRows.map(r => ({
          jobNo: str(get(r, 'JobNo')) || jobNo,
          compName: str(get(r, 'CompName')) || str(get(r, 'PlanContName')) || '',
          stage: str(get(r, 'Stage')) || str(get(r, 'MaterialStatus')) || '',
          voucherNo: str(get(r, 'VoucherNo')) || '',
          voucherDate: str(get(r, 'VoucherDate')) || '',
          itemCode: str(get(r, 'ItemCode')) || '',
          itemName: str(get(r, 'ItemName')) || '',
          qty: str(get(r, 'Qty')) || ''
        }));
      } catch (e) {
        console.warn('[job-card] GetPaperFlowForJob failed:', e.message);
      }

      // ---- Footer from procedure ----
      const footer = {
        preparedBy: str(get(row, 'UserName')) || str(get(row, 'PrintedBy')),
        checkedBy: '',
        approved: str(get(row, 'ApprovalBy')) || '',
        printDateAndTime: str(get(row, 'PrintedDate')) || '',
        modifiedDate: str(get(row, 'LastModifiedDate')) || ''
      };

      const packaging = {
        type: 'packaging',
        jobNumber: jobNo,
        displayId: str(get(row, 'JobCardContentNo')) || jobNo,
        qrCode: str(get(row, 'JobCardContentNo')) || jobNo,
        header,
        jobInfo,
        paperDetails,
        printDetails,
        operationDetails,
        allocatedMaterials,
        corrugationDetails,
        paperFlow,
        paperFlowHeaderRows,
        footer
      };

      if (cardType === 'packaging') {
        return res.json(packaging);
      }

      // Commercial / book job card: get components from JobBookingJobCardContents, then run operations/allocations per component
      const bookHeader = {
        jobDocketNo: header.jobNo || jobNo,
        jobDocketDate: header.jobDate || '',
        orderQty: (header.quantity != null && header.quantity !== '') ? header.quantity + ' PCS' : '',
        jobQty: (header.soQuantity != null && header.soQuantity !== '') ? header.soQuantity + ' PCS' : header.quantity || '',
        deliveryDate: header.delDate || ''
      };
      const generalInfo = {
        clientName: jobInfo.clientName || '-',
        jobPriority: jobInfo.jobPriority || '-',
        quotationNo: str(get(row, 'BookingNo')) || '',
        jobName: jobInfo.jobName || '-',
        poNo: jobInfo.poNo || '-',
        poDate: jobInfo.poDate || '-',
        closeSize: jobInfo.jobSizeMm || '-',
        itemType: jobInfo.ProductHSNName,
        executive: jobInfo.coordinator || '-',
        erpCode: '',
        salesPerson: jobInfo.salesPerson || '-',
        jobCardRemarks: str(get(row, 'Remark')) || str(get(row, 'JobCardRemark')) || '',
        salesOrderRemarks: ''
      };

      console.log("#############4",JSON.stringify(jobInfo));

      // Components from ProductionWorkOrderPrint procedure recordset (one row per component with JobBookingJobCardContentsID)
      const recordset = procResult.recordset || [];
      const seenIds = new Set();
      const components = recordset
        .map((r, idx) => ({
          JobBookingJobCardContentsID: get(r, 'JobBookingJobCardContentsID')[0],
          PlanContName: str(get(r, 'PlanContName')) || str(get(r, 'ContentName')) || str(get(r, 'JobCardContentNo')) || ('Component ' + (idx + 1))
        }))
        .filter(c => {
          if (c.JobBookingJobCardContentsID == null) return false;
          if (seenIds.has(c.JobBookingJobCardContentsID)) return false;
          seenIds.add(c.JobBookingJobCardContentsID);
          return true;
        });
      console.log('[job-card] Components from procedure:', components);

      const parts = [];
      const contentIdType = sql.BigInt;
      // console.log("#############2",components);
      for (const comp of components) {
        const contentsId = comp.JobBookingJobCardContentsID;
        // if (contentsId == null) continue;
        const partName = comp.PlanContName ;

        // Find the component-specific row(s) from procedure output
        const compRows = recordset.filter(r => get(r, 'JobBookingJobCardContentsID')[0] === contentsId);
        // console.log("#############3",compRows);
        const compRow = compRows[0] || row; // fallback to first row if not found

        let compOperations = [];
        let compMaterials = [];
        let compPaperRows = [];

        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', contentIdType, contentsId);
          const opRes = await request.query(OperationDetailsQuery);
          const opRows = opRes.recordset || [];
          const toolBySeq = {};
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', contentIdType, contentsId);
          const toolRes = await request.query(ToolAllocationDetailsQuery);
          (toolRes.recordset || []).forEach(r => {
            const seq = get(r, 'SequenceNo');
            if (seq != null) toolBySeq[String(seq)] = { toolCode: str(get(r, 'ToolCode')), refNo: str(get(r, 'ToolRefCode')) };
          });
          compOperations = opRows.map((r, i) => {
            const seq = get(r, 'SequenceNo');
            const tool = seq != null ? toolBySeq[String(seq)] : null;
            return {
              sn: i + 1,
              operationName: str(get(r, 'ProcessName')) || '-',
              scheduleMachineName: str(get(r, 'ScheduledMachineName')) || '-',
              scheduleQty: str(get(r, 'ToBeProduceQty')) || '0',
              employeeName: str(get(r, 'EmployeeName')) || '-',
              proMachineName: str(get(r, 'ProductionMachineName')) || '-',
              proQty: str(get(r, 'ReadyQty')) || str(get(r, 'ProductionQuantity')) || '0',
              date: str(get(r, 'FromTime')) || '',
              status: str(get(r, 'Status')) || '-',
              remark: str(get(r, 'Remark')) || '',
              toolCode: tool ? tool.toolCode : '',
              refNo: tool ? tool.refNo : ''
            };
          });
          const opsWithoutTool = compOperations.filter(op => !op.toolCode && !op.refNo);
          const opsWithTool = compOperations.filter(op => op.toolCode || op.refNo);
          compOperations = [...opsWithoutTool, ...opsWithTool];
          compOperations.forEach((op, idx) => { op.sn = idx + 1; });
        } catch (e) {
          console.warn('[job-card] Commercial component op/tool failed for', contentsId, e.message);
        }

        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', contentIdType, contentsId);
          const allocRes = await request.query(AllocateMaterialDetailsQuery);
          const allocRows = allocRes.recordset || [];
          compMaterials = allocRows.map(r => ({
            processName: str(get(r, 'OperationName')) || '-',
            itemName: str(get(r, 'Material')) || '-',
            reqQty: str(get(r, 'Qty')) || '0',
            unit: str(get(r, 'Unit')) || '-'
          }));
        } catch (e) {
          console.warn('[job-card] Commercial component alloc failed for', contentsId, e.message);
        }

        try {
          request = pool.request();
          request.input('CompanyID', sql.NVarChar(10), companyId);
          request.input('JobBookingID', sql.NVarChar(50), jobBookingId);
          request.input('JobBookingJobCardContentsID', contentIdType, contentsId);
          const itemRes = await request.query(ItemDetailsQuery);
          compPaperRows = itemRes.recordset || [];
        } catch (e) {
          console.warn('[job-card] Commercial component ItemDetails failed for', contentsId, e.message);
        }

        // Component-specific details from procedure row
        const compJobCardContentNo = str(get(compRow, 'JobCardContentNo')) || '';
        const compCloseSize = str(get(compRow, 'JobCloseSize')) || str(get(compRow, 'CloseSize')) || '-';
        const compColour = str(get(compRow, 'FrontColor')) || str(get(compRow, 'FrontColorName')) || '-';
        const compQuantity = str(get(compRow, 'OrderQuantity')) || str(get(compRow, 'Quantity')) || '-';
        const compPaper = str(get(compRow, 'Paper')) || '-';
        const compPaperSize = str(get(compRow, 'PaperSizeinMM')) || str(get(compRow, 'PaperSize')) || '-';
        const compTotalSheets = str(get(compRow, 'TotalSheets')) || str(get(compRow, 'ActualSheets')) || '-';
        const compWeight = str(get(compRow, 'TotalRequiredWt')) || str(get(compRow, 'ActualWt')) || '-';
        const compPaperBy = str(get(compRow, 'PaperBy')) || '-';
        const compCutSize = str(get(compRow, 'CutSize')) || '-';
        const compMachine = str(get(compRow, 'MachineName')) || '-';
        const compUps = str(get(compRow, 'TotalUps')) || str(get(compRow, 'Ups')) || '-';
        const compPrintingStyle = str(get(compRow, 'PrintingStyle')) || '';
        const compImpressions = str(get(compRow, 'ImpressionsToBeCharged')) || '';

        const firstPaper = compPaperRows[0];
        parts.push({
          partName,
          qrCode: compJobCardContentNo,
          closeSize: compCloseSize,
          colour: compColour,
          quantity: compQuantity ? (compQuantity.includes('PCS') ? compQuantity : compQuantity + ' PCS') : '-',
          paperType: firstPaper ? str(get(firstPaper, 'ItemName')) : compPaper,
          sheetsFull: firstPaper ? str(get(firstPaper, 'TotalSheets')) : compTotalSheets,
          kgs: compWeight,
          paperBy: compPaperBy,
          cutSize: firstPaper ? str(get(firstPaper, 'CutSize')) : compCutSize,
          sheetsCut: firstPaper ? str(get(firstPaper, 'TotalSheets')) : compTotalSheets,
          machine: compMachine,
          ups: compUps,
          printingImpressions: compPrintingStyle ? `Form Details:${compPrintingStyle} & Impressions:${compImpressions}` : (compImpressions ? `Impressions:${compImpressions}` : '-'),
          operations: compOperations.map((op, i) => ({
            sn: op.sn != null ? op.sn : i + 1,
            operationName: op.operationName,
            scheduleMachineName: op.scheduleMachineName,
            scheduleQty: op.scheduleQty,
            employeeName: op.employeeName != null ? String(op.employeeName) : '-',
            proMachineName: op.proMachineName,
            proQty: op.proQty,
            date: op.date || '-',
            status: op.status,
            remark: op.remark || ''
          })),
          processMaterials: compMaterials
        });
      }

      if (parts.length === 0) {
        const firstPaper = paperDetails && paperDetails[0];
        parts.push({
          partName: jobInfo.contentName || 'Main',
          qrCode: str(get(row, 'JobCardContentNo')) || jobNo,
          closeSize: jobInfo.jobSizeMm || '-',
          colour: printDetails.frontColor || '-',
          quantity: (header.quantity != null && header.quantity !== '') ? header.quantity + ' PCS' : '-',
          paperType: firstPaper ? firstPaper.itemName : '-',
          sheetsFull: firstPaper ? firstPaper.totalSheets : jobInfo.totalReqSheets || '-',
          kgs: firstPaper ? firstPaper.itemWeight : '-',
          paperBy: jobInfo.paperBy || '-',
          cutSize: firstPaper ? firstPaper.cutSize : str(get(row, 'CutSize')) || '-',
          sheetsCut: firstPaper ? firstPaper.totalSheets : jobInfo.totalReqSheets || '-',
          machine: printDetails.machineName || '-',
          ups: jobInfo.ups || '-',
          printingImpressions: (printDetails.printingStyle || printDetails.frontColor) ? `Form Details:${printDetails.printingStyle || ''} & Impressions:${jobInfo.totalReqSheets || ''}` : '-',
          operations: [],
          processMaterials: []
        });
      }

      const commercial = {
        type: 'commercial',
        jobNumber: jobNo,
        displayId: str(get(row, 'JobCardContentNo')) || jobNo,
        header: bookHeader,
        generalInfo,
        parts,
        paperFlow: paperFlow || [],
        footer
      };
      return res.json(commercial);
    }
  } catch (err) {
    console.error('[job-card] Error:', err);
    return res.status(500).json({ error: 'Failed to load job card', message: err.message || String(err) });
  }
});

export default router;
