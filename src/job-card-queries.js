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
