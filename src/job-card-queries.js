/**
 * Parameterized queries for Job Card data.
 * Use @CompanyID, @JobBookingID, @JobBookingJobCardContentsID (optional, for component-wise commercial).
 * Component list comes from ProductionWorkOrderPrint procedure recordset (JobBookingJobCardContentsID per row).
 */
export const ItemDetailsQuery = `
SELECT
  IM.ItemCode,
  CONCAT(Nullif(IM.ItemName,''), '-', Nullif(IM.ManufecturerItemCode,'')) AS ItemName,
  ISNULL(IM.ItemSize, IM.SizeW) AS PaperSize,
  (ISNULL(JC.ActualSheets, 0) + ISNULL(JC.WastageSheets, 0) + ISNULL(JC.MakeReadyWastageSheet, 0)) AS TotalSheets,
  JC.CutSize,
  (ISNULL(JC.CutL, 0) * ISNULL(JC.CutW, 0) + ISNULL(JC.CutLH, 0) * ISNULL(JC.CutHL, 0)) AS Cuts,
  (ISNULL(JC.CutL, 0) * ISNULL(JC.CutW, 0) + ISNULL(JC.CutLH, 0) * ISNULL(JC.CutHL, 0)) * JC.FullSheets AS Final_Quantity,
  JC.TotalPaperWeightInKg AS ItemWeight,
  JC.PlanContName,
  JC.JobCardContentNo
FROM JobBookingJobCard J
INNER JOIN JobBookingJobCardContents JC ON J.JobBookingID = JC.JobBookingID AND J.CompanyID = JC.CompanyID
INNER JOIN JobBookingJobCardProcessMaterialRequirement JM ON JC.JobBookingJobCardContentsID = JM.JobBookingJobCardContentsID AND JC.CompanyID = JM.CompanyID AND ISNULL(JM.IsDeletedTransaction, 0) = 0
INNER JOIN ItemMaster IM ON JM.ItemID = IM.ItemID AND JC.CompanyID = IM.CompanyID
INNER JOIN ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID AND IGM.ItemGroupNameID IN (-1, -2, -14)
WHERE J.CompanyID = @CompanyID AND J.JobBookingID = @JobBookingID
  AND (@JobBookingJobCardContentsID IS NULL OR JC.JobBookingJobCardContentsID = @JobBookingJobCardContentsID)
GROUP BY IM.ItemCode, IM.ItemName, IM.ManufecturerItemCode, IM.ItemSize, IM.SizeW, JC.ActualSheets, JC.WastageSheets, JC.MakeReadyWastageSheet, JC.CutSize, JC.CutL, JC.CutW, JC.CutLH, JC.CutHL, JC.FullSheets, JC.TotalPaperWeightInKg, JC.PlanContName, JC.JobCardContentNo, JM.SequenceNo, JM.JobBookingJobCardContentsID, JM.JobBookingID
ORDER BY JM.SequenceNo
`;

export const OperationDetailsQuery = `
SELECT DISTINCT
    JP.SequenceNo,
    JP.Remarks,

    CASE 
        WHEN ISNULL(JP.RateFactor, '') = '' 
        THEN PM.ProcessName 
        ELSE PM.ProcessName + ' - (' + JP.RateFactor + ')' 
    END AS ProcessName,

    /* ===============================
       Scheduled Machine (JSR → JP fallback)
       =============================== */
    CASE
        WHEN ISNULL(MCH_JSR.MachineName, '') <> '' 
            THEN MCH_JSR.MachineName
        ELSE ISNULL(MCH_JP.MachineName, '-')
    END AS ScheduledMachineName,

    /* ===============================
       Production Machine (from ProductionEntry)
       =============================== */
    ISNULL(MCH_PROD.MachineName, '-') AS ProductionMachineName,

    /* ===============================
       Quantities
       =============================== */
    ISNULL(OPS.ScheduledQty, JP.ToBeProduceQty) AS ToBeProduceQty,
    ISNULL(OPS.ProducedQty, 0) AS ReadyQty,
    ISNULL(OPS.ProducedQty, 0) AS ProductionQuantity,

    /* ===============================
       Operator + Time
       =============================== */
    ISNULL(UM.UserName, '-') AS EmployeeName,
    FORMAT(OPS.LastToTime, 'dd-MMM-yyyy') AS FromTime,

    JP.Status,
    ISNULL(NULLIF(PE.Remark, ''), '-') AS Remark

FROM JobBookingJobCard J

INNER JOIN JobBookingJobCardContents JJ
    ON J.JobBookingID = JJ.JobBookingID
   AND J.CompanyID = JJ.CompanyID

INNER JOIN JobBookingJobCardProcess JP
    ON JJ.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID
   AND JJ.CompanyID = JP.CompanyID
   AND ISNULL(JP.IsDeletedTransaction, 0) = 0

INNER JOIN ProcessMaster PM
    ON PM.ProcessID = JP.ProcessID
   AND PM.CompanyID = JP.CompanyID

/* =========================================================
   Aggregated Scheduled + Production data
   ========================================================= */
LEFT JOIN (
    SELECT
        JP.JobBookingJobCardContentsID,
        JP.ProcessID,

        CASE 
            WHEN SUM(ISNULL(JSR.ScheduleQty, 0)) > 0
                 THEN SUM(ISNULL(JSR.ScheduleQty, 0))
            ELSE ISNULL(JP.ToBeProduceQty, 0)
        END AS ScheduledQty,

        SUM(ISNULL(PE.ProductionQuantity, 0)) AS ProducedQty,

        MAX(JSR.MachineID) AS ScheduledMachineID,
        MAX(PE.MachineID)  AS ProductionMachineID,
        MAX(PE.ToTime)     AS LastToTime

    FROM JobBookingJobCardProcess JP

    LEFT JOIN JobScheduleRelease JSR
        ON JSR.JobBookingID = JP.JobBookingID
       AND JSR.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID
       AND JSR.ProcessID = JP.ProcessID
       AND JSR.CompanyID = JP.CompanyID
       AND ISNULL(JSR.IsDeletedTransaction, 0) = 0

    LEFT JOIN ProductionEntry PE
        ON PE.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID
       AND PE.ProcessID = JP.ProcessID

    WHERE JP.JobBookingID = @JobBookingID
      AND JP.CompanyID = @CompanyID

    GROUP BY
        JP.JobBookingJobCardContentsID,
        JP.ProcessID,
        JP.ToBeProduceQty
) OPS
    ON OPS.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID
   AND OPS.ProcessID = JP.ProcessID

/* =========================================================
   Machine joins
   ========================================================= */
LEFT JOIN MachineMaster MCH_JSR
    ON MCH_JSR.MachineId = OPS.ScheduledMachineID
   AND MCH_JSR.CompanyID = JP.CompanyID

LEFT JOIN MachineMaster MCH_JP
    ON MCH_JP.MachineId = JP.MachineID
   AND MCH_JP.CompanyID = JP.CompanyID

LEFT JOIN MachineMaster MCH_PROD
    ON MCH_PROD.MachineId = OPS.ProductionMachineID
   AND MCH_PROD.CompanyID = JP.CompanyID

/* =========================================================
   Latest production entry → operator & remark
   ========================================================= */
LEFT JOIN ProductionEntry PE
    ON PE.JobBookingJobCardContentsID = OPS.JobBookingJobCardContentsID
   AND PE.ProcessID = OPS.ProcessID
   AND PE.ToTime = OPS.LastToTime

LEFT JOIN UserMaster UM
    ON UM.UserID = PE.EmployeeID

WHERE J.CompanyID = @CompanyID
  AND J.JobBookingID = @JobBookingID
  AND (
        @JobBookingJobCardContentsID IS NULL
        OR JJ.JobBookingJobCardContentsID = @JobBookingJobCardContentsID
      )

ORDER BY JP.SequenceNo;



`;

// export const AllocateMaterialDetailsQuery = `
// SELECT
//   PM.ProcessName AS OperationName,
//   IM.ItemName AS Material,
//   ISNULL(ISS.IssueQuantity, JBMR.EstimatedQuantity) AS Qty,
//   IM.StockUnit AS Unit
// FROM JobBookingJobCard JB
// INNER JOIN JobBookingJobCardContents JBC ON JBC.JobBookingID = JB.JobBookingID AND JBC.CompanyID = JB.CompanyID AND ISNULL(JB.IsDeletedTransaction, 0) = 0 AND ISNULL(JBC.IsDeletedTransaction, 0) = 0
// INNER JOIN JobBookingJobCardProcess JCP ON JCP.JobBookingJobCardContentsID = JBC.JobBookingJobCardContentsID AND JCP.CompanyID = JBC.CompanyID AND ISNULL(JCP.IsDeletedTransaction, 0) = 0
// INNER JOIN JobBookingJobCardProcessMaterialRequirement JBMR ON JBMR.JobBookingID = JCP.JobBookingID AND JBMR.JobBookingJobCardContentsID = JCP.JobBookingJobCardContentsID AND JBMR.ProcessID = JCP.ProcessID AND JBMR.MachineID = JCP.MachineID AND JBMR.CompanyID = JCP.CompanyID AND ISNULL(JBMR.IsDeletedTransaction, 0) = 0
// INNER JOIN ItemMaster IM ON JBMR.ItemID = IM.ItemID AND JBMR.CompanyID = IM.CompanyID
// INNER JOIN ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
// LEFT JOIN ProcessMaster PM ON PM.ProcessID = JBMR.ProcessID AND PM.CompanyID = JBMR.CompanyID
// LEFT JOIN (SELECT IA.JobBookingJobcardContentsID, II.IssueQuantity FROM ItemAllocationPending IA LEFT JOIN ItemIssuePending II ON IA.JobBookingJobcardContentsID = II.JobBookingJobcardContentsID) AS ISS ON ISS.JobBookingJobcardContentsID = JBMR.JobBookingJobcardContentsID
// WHERE JB.CompanyID = @CompanyID AND JB.JobBookingID = @JobBookingID
// `;

export const AllocateMaterialDetailsQuery = `
SELECT
  PM.ProcessName AS OperationName,
  IM.ItemName AS Material,
  JBMR.RequiredQuantityInStockUnit as Qty,
  IM.StockUnit AS Unit
FROM JobBookingJobCard JB
INNER JOIN JobBookingJobCardContents JBC ON JBC.JobBookingID = JB.JobBookingID AND JBC.CompanyID = JB.CompanyID AND ISNULL(JB.IsDeletedTransaction, 0) = 0 AND ISNULL(JBC.IsDeletedTransaction, 0) = 0
INNER JOIN JobBookingJobCardProcess JCP ON JCP.JobBookingJobCardContentsID = JBC.JobBookingJobCardContentsID AND JCP.CompanyID = JBC.CompanyID AND ISNULL(JCP.IsDeletedTransaction, 0) = 0
INNER JOIN JobBookingJobCardProcessMaterialRequirement JBMR ON JBMR.JobBookingID = JCP.JobBookingID AND JBMR.JobBookingJobCardContentsID = JCP.JobBookingJobCardContentsID AND JBMR.ProcessID = JCP.ProcessID AND JBMR.MachineID = JCP.MachineID AND JBMR.CompanyID = JCP.CompanyID AND ISNULL(JBMR.IsDeletedTransaction, 0) = 0
INNER JOIN ItemMaster IM ON JBMR.ItemID = IM.ItemID AND JBMR.CompanyID = IM.CompanyID
INNER JOIN ItemGroupMaster IGM ON IGM.ItemGroupID = IM.ItemGroupID AND IGM.CompanyID = IM.CompanyID
LEFT JOIN ProcessMaster PM ON PM.ProcessID = JBMR.ProcessID AND PM.CompanyID = JBMR.CompanyID
WHERE JB.CompanyID = @CompanyID AND JB.JobBookingID = @JobBookingID
  AND (@JobBookingJobCardContentsID IS NULL OR JBC.JobBookingJobCardContentsID = @JobBookingJobCardContentsID)
`;


export const ToolAllocationDetailsQuery = `
SELECT DISTINCT
  JP.SequenceNo,
  ISNULL(TM.ToolCode, '-') AS ToolCode,
  ISNULL(TM.ToolRefCode, '') AS ToolRefCode
FROM JobBookingJobCard J
INNER JOIN JobBookingJobCardContents JJ ON J.JobBookingID = JJ.JobBookingID AND J.CompanyID = JJ.CompanyID
INNER JOIN JobBookingJobCardProcess JP ON JJ.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID AND JJ.CompanyID = JP.CompanyID
INNER JOIN ProcessMaster PM ON PM.ProcessID = JP.ProcessID AND JP.CompanyID = PM.CompanyID
LEFT JOIN JobBookingJobCardProcessToolAllocation JJPTA ON JJPTA.JobBookingID = J.JobBookingID AND JJPTA.JobBookingJobCardContentsID = JJ.JobBookingJobCardContentsID AND ISNULL(JJPTA.IsDeletedTransaction, 0) = 0
LEFT JOIN ToolMaster TM ON TM.ToolID = JJPTA.ToolID AND PM.ProcessID = JJPTA.ProcessID AND ISNULL(TM.IsDeletedTransaction, 0) = 0
WHERE ISNULL(TM.ToolCode, '') <> '' AND J.CompanyID = @CompanyID AND JJ.JobBookingID = @JobBookingID
  AND (@JobBookingJobCardContentsID IS NULL OR JJ.JobBookingJobCardContentsID = @JobBookingJobCardContentsID)
ORDER BY JP.SequenceNo
`;

/**
 * Corrugation details for packaging job card (JobBookingJobCardCorrugation + ItemMaster + JobBookingJobCardContents).
 * Uses Cutting→CutSize, Deckle→DechleSize; excludes PlyNo = 1. Output: PlyNo, Flute, ItemCode, ItemDetails, DechleSize, CutSize, Weight(Gm), Sheets.
 */
export const CorrugationDetailsQuery = `
SELECT
  JBC.PlyNo,
  ISNULL(JBC.FluteName, 'None') AS Flute,
  IM.ItemCode,
  ISNULL(JBC.ItemDetails, '') AS ItemDetails,
  JBC.Deckle AS DechleSize,
  JBC.Cutting AS CutSize,
  JBC.Weight AS WeightGm,
  JBC.Sheets
FROM JobBookingJobCardCorrugation AS JBC
INNER JOIN ItemMaster AS IM
  ON JBC.ItemID = IM.ItemID
 AND JBC.CompanyID = IM.CompanyID
 AND ISNULL(IM.IsDeletedTransaction, 0) = 0
INNER JOIN JobBookingJobCardContents AS JJ
  ON JJ.JobBookingJobCardContentsID = JBC.JobBookingJobCardContentsID
WHERE JBC.JobBookingID = @JobBookingID
  AND JBC.CompanyID = @CompanyID
  AND ISNULL(JBC.IsDeletedTransaction, 0) = 0
  AND JBC.PlyNo <> 1
ORDER BY JBC.PlyNo ASC
`;

/**
 * Job card search for UI: filter by JobBookingNo, ClientName, SalesPersonID, FromJobDate, ToJobDate.
 * Returns TOP 10 rows for download selection.
 */
export const JobCardSearchQuery = `
-- ============================================================
-- Supporting CTEs for PrintStatus & PrintEnd
-- ============================================================
WITH PrintingProcs AS (
    SELECT PM.ProcessID
    FROM dbo.ProcessMaster PM
    WHERE PM.ProcessName LIKE '%Printing%'
),

PrintingAgg AS (
    SELECT
        JSR.JobBookingJobCardContentsID,
        SUM(ISNULL(JSR.ScheduleQty, 0)) AS PrintPlanQty,
        ISNULL((
            SELECT SUM(ISNULL(PE.ProductionQuantity, 0))
            FROM dbo.ProductionEntry PE
            WHERE PE.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID
              AND PE.ProcessID IN (SELECT ProcessID FROM PrintingProcs)
        ), 0) AS PrintDoneQty,
        (
            SELECT MAX(JSS.PlannedEndTime)
            FROM dbo.JobScheduleRelease JSS
            WHERE JSS.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID
              AND JSS.ProcessID IN (SELECT ProcessID FROM PrintingProcs)
        ) AS LastPrintPlanEnd,
        (
            SELECT MAX(TRY_CONVERT(datetime, PE.ToTime))
            FROM dbo.ProductionEntry PE
            WHERE PE.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID
              AND PE.ProcessID IN (SELECT ProcessID FROM PrintingProcs)
        ) AS LastPrintActualEnd
    FROM dbo.JobScheduleRelease JSR
    WHERE JSR.ProcessID IN (SELECT ProcessID FROM PrintingProcs)
      AND ISNULL(JSR.IsDeletedTransaction, 0) = 0
    GROUP BY JSR.JobBookingJobCardContentsID
),

PrintingByJob AS (
    SELECT
        JEJC.JobBookingID,
        SUM(ISNULL(PA.PrintPlanQty, 0))  AS JobPrintPlanQty,
        SUM(ISNULL(PA.PrintDoneQty, 0))  AS JobPrintDoneQty,
        MAX(PA.LastPrintPlanEnd)          AS JobLastPrintPlanEnd,
        MAX(PA.LastPrintActualEnd)        AS JobLastPrintActualEnd
    FROM dbo.JobBookingJobCardContents JEJC
    LEFT JOIN PrintingAgg PA
           ON PA.JobBookingJobCardContentsID = JEJC.JobBookingJobCardContentsID
    GROUP BY JEJC.JobBookingID
),

-- ============================================================
-- NEW: Binding Production Qty
-- (Perfect Binding / Stitch / Pasting processes)
-- ============================================================
BindingAgg AS (
    SELECT
        PE.JobBookingID,
        SUM(ISNULL(PE.ProductionQuantity, 0)) AS BindingQty
    FROM dbo.ProductionEntry PE
    WHERE PE.ProcessID IN (
        SELECT ProcessID
        FROM dbo.ProcessMaster
        WHERE ProcessName LIKE '%perfect%'
           OR ProcessName LIKE '%stitch%'
           OR ProcessName LIKE '%past%'
    )
    GROUP BY PE.JobBookingID
),

-- ============================================================
-- GPN Qty (voucherid = -50)
-- ============================================================
GPNAgg AS (
    SELECT
        fgd.JobBookingID,
        SUM(
            ISNULL(fgd.outercarton, 0)
            * ISNULL(fgd.innercarton, 0)
            * ISNULL(fgd.quantityperpack, 0)
        ) AS GpnUnits
    FROM dbo.FinishGoodsTransactionMain fgm
    JOIN dbo.FinishGoodsTransactionDetail fgd
        ON fgd.FGTransactionID = fgm.FGtransactionID
    WHERE fgm.voucherid = -50
      AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
      AND ISNULL(fgd.IsDeletedTransaction, 0) = 0
    GROUP BY fgd.JobBookingID
),

-- ============================================================
-- Dispatch / Delivered Qty (voucherid = -51)
-- ============================================================
DispatchAgg AS (
    SELECT
        fgd.JobBookingID,
        SUM(
            ISNULL(fgd.innercarton, 0)
            * ISNULL(fgd.quantityperpack, 0)
        ) AS DispatchQty
    FROM dbo.FinishGoodsTransactionMain fgm
    JOIN dbo.FinishGoodsTransactionDetail fgd
        ON fgd.FGTransactionID = fgm.FGtransactionID
    WHERE fgm.voucherid = -51
      AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
      AND ISNULL(fgd.IsDeletedTransaction, 0) = 0
    GROUP BY fgd.JobBookingID
)

-- ============================================================
-- Main Query
-- ============================================================
SELECT TOP 1000
    JOB.SalesOrderNo,
    JB.PONo,
    JB.PODate,
    JB.JobBookingNo,
    JB.JobBookingDate,
    CM.CategoryName,
    SM.SegmentName,

    ISNULL(JB.ClientName, LM_CLIENT.LedgerName)        AS ClientName,
    LM.LedgerName                                       AS SalesPersonName,
    JB.JobName,
    JJC_MAX.JobType,
    JB.OrderQuantity,
	    -- GPN & Delivered Qty
    ISNULL(GPN.GpnUnits, 0)                            AS GpnQty,
    ISNULL(DISP.DispatchQty, 0)                        AS DeliveredQty,

    -- Binding Production Qty
    ISNULL(BA.BindingQty, 0)                           AS BindingProdQty,

    -- Print Status
    CASE
        WHEN ISNULL(PBJ.JobPrintPlanQty, 0) = 0
         AND ISNULL(PBJ.JobPrintDoneQty, 0) = 0
            THEN 'Not Planned'
        WHEN (
                (   ISNULL(PBJ.JobPrintDoneQty, 0) * 10
                    >= ISNULL(PBJ.JobPrintPlanQty, 0) * 9
                    AND ISNULL(PBJ.JobPrintPlanQty, 0) > 0
                )
             OR (   ISNULL(PBJ.JobPrintDoneQty, 0) > 0
                    AND ABS(ISNULL(PBJ.JobPrintPlanQty, 0)
                            - ISNULL(PBJ.JobPrintDoneQty, 0)) < 250
                )
             )
            THEN 'Complete'
        WHEN ISNULL(PBJ.JobPrintDoneQty, 0) = 0
         AND ISNULL(PBJ.JobPrintPlanQty, 0) > 0
            THEN 'Pending'
        ELSE 'Incomplete'
    END                                                 AS PrintStatus,

    /* Unique bracketed aliases — avoids duplicate colName collisions in mssql driver */
    CASE
        WHEN ISNULL(JB.IsCancel, 0) = 1                                         THEN 'Cancelled'
        WHEN ISNULL(JB.IsClose, 0) = 1                                          THEN 'Closed'
        WHEN ISNULL(DISP.DispatchQty, 0) >= 0.9 * ISNULL(JB.OrderQuantity, 0)
             AND ISNULL(JB.OrderQuantity, 0) > 0                              THEN 'Closed'
        ELSE 'Pending'
    END                                                                      AS [JC_Search_Status],

    CASE
        WHEN ISNULL(JB.IsCancel, 0) = 1
            THEN 'Cancelled'
        WHEN ISNULL(JB.IsClose, 0) = 1
            THEN 'Manually Closed'
        WHEN ISNULL(DISP.DispatchQty, 0) >= 0.9 * ISNULL(JB.OrderQuantity, 0)
             AND ISNULL(JB.OrderQuantity, 0) > 0
            THEN 'Delivered >= 90% of Order Qty'
        WHEN ISNULL(DISP.DispatchQty, 0) > 0
            THEN 'Partially Delivered ('
                 + CAST(ISNULL(DISP.DispatchQty, 0) AS VARCHAR(50))
                 + ' of '
                 + CAST(ISNULL(JB.OrderQuantity, 0) AS VARCHAR(50))
                 + ')'
        WHEN ISNULL(GPN.GpnUnits, 0) > 0
            THEN 'Packed, Awaiting Dispatch'
        WHEN ISNULL(BA.BindingQty, 0) > 0
            THEN 'In Binding / Finishing'
        WHEN ISNULL(PBJ.JobPrintDoneQty, 0) > 0
            THEN 'Printing In Progress'
        WHEN ISNULL(PBJ.JobPrintPlanQty, 0) > 0
            THEN 'Planned, Not Yet Started'
        ELSE 'Not Planned'
    END                                                                      AS [JC_Search_StatusReason],

    -- Print End
    CASE
        WHEN ISNULL(PBJ.JobPrintDoneQty, 0)
             >= ISNULL(PBJ.JobPrintPlanQty, 0) * 0.5
          AND ISNULL(PBJ.JobPrintPlanQty, 0) > 0
            THEN PBJ.JobLastPrintActualEnd
        ELSE PBJ.JobLastPrintPlanEnd
    END                                                 AS PrintEnd,
    JB.IsCompletePacked,
    ISNULL(JB.IsClose, 0)                              AS IsClose,
    ISNULL(JB.IsCancel, 0)                             AS IsCancel,
    LM2.LedgerName                                      AS CoordinatorName,
    JB.DeliveryDate,
    JB.ProductCode,
    JB.RefProductMasterCode



FROM JobBookingJobCard JB

LEFT JOIN JobOrderBooking JOB
    ON JB.OrderBookingID = JOB.OrderBookingID

LEFT JOIN CategoryMaster CM
    ON JB.CategoryID = CM.CategoryID

LEFT JOIN SegmentMaster SM
    ON CM.SegmentID = SM.SegmentID

LEFT JOIN LedgerMaster LM
    ON JB.SalesEmployeeID = LM.LedgerID

LEFT JOIN LedgerMaster LM_CLIENT
    ON JOB.LedgerID = LM_CLIENT.LedgerID

LEFT JOIN (
    SELECT
        JobBookingID,
        MAX(JobType)              AS JobType,
        MAX(CoordinatorLedgerID)  AS CoordinatorLedgerID
    FROM JobBookingJobCardContents
    GROUP BY JobBookingID
) JJC_MAX
    ON JB.JobBookingID = JJC_MAX.JobBookingID

LEFT JOIN LedgerMaster LM2
    ON JJC_MAX.CoordinatorLedgerID = LM2.LedgerID

-- GPN Qty
LEFT JOIN GPNAgg GPN
    ON GPN.JobBookingID = JB.JobBookingID

-- Delivered Qty
LEFT JOIN DispatchAgg DISP
    ON DISP.JobBookingID = JB.JobBookingID

-- Binding Pr. Qty
LEFT JOIN BindingAgg BA
    ON BA.JobBookingID = JB.JobBookingID

-- Print Status & Print End
LEFT JOIN PrintingByJob PBJ
    ON PBJ.JobBookingID = JB.JobBookingID

WHERE ( @JobBookingNo IS NULL OR JB.JobBookingNo LIKE '%' + @JobBookingNo + '%' )
  AND ( @ClientName IS NULL OR @ClientName = ''
        OR ISNULL(JB.ClientName, LM_CLIENT.LedgerName) LIKE '%' + @ClientName + '%' )
  AND ( @SalesPersonID IS NULL OR JB.SalesEmployeeID = @SalesPersonID )
  AND ( @FromJobDate IS NULL OR JB.JobBookingDate >= @FromJobDate )
  AND ( @ToJobDate   IS NULL OR JB.JobBookingDate < DATEADD(DAY, 1, @ToJobDate) )

ORDER BY JB.JobBookingDate DESC;

`;

/** Sales person filter: LedgerName, LedgerID for Designation = 'Sales Executive' */
export const SalesPersonsFilterQuery = `
SELECT LedgerName, LedgerID
FROM LedgerMaster
WHERE Designation = 'Sales Executive'
ORDER BY LedgerName
`;

/** Client name filter: distinct ClientName from JobBookingJobCard */
export const ClientNamesFilterQuery = `
SELECT DISTINCT ClientName
FROM JobBookingJobCard
WHERE CompanyID = @CompanyID
  AND ISNULL(ClientName, '') <> ''
ORDER BY ClientName
`;
