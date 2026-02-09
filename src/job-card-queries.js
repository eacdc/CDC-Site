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
  CASE WHEN ISNULL(JP.RateFactor, '') = '' THEN PM.ProcessName ELSE (PM.ProcessName + ' - (' + JP.RateFactor + ')') END AS ProcessName,
  CASE WHEN ISNULL(PROD.MachineID, 0) = 0 THEN CASE WHEN ISNULL(JSR.MachineId, 0) = 0 THEN ISNULL(MCH.MachineName, '') ELSE ISNULL(MCH1.MachineName, '') END ELSE ISNULL(PROD.MachineName, '-') END AS MachineName,
  CASE WHEN ISNULL(JSR.ScheduleQty, 0) = 0 THEN ISNULL(JP.ToBeProduceQty, 0) ELSE ISNULL(JSR.ScheduleQty, 0) END AS ToBeProduceQty,
  ISNULL(PROD.EmployeeName, '-') AS EmployeeName,
  (SELECT SUM(ISNULL(ProductionQuantity, 0)) FROM ProductionEntry WHERE JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID AND ProcessID = JP.ProcessID) AS ReadyQty,
  ISNULL(PROD.ProductionQuantity, 0) AS ProductionQuantity,
  FORMAT(PROD.FromTime, 'dd-MMM-yyyy') AS FromTime,
  CASE WHEN ISNULL(PROD.Status, '') = '' THEN JP.Status ELSE PROD.Status END AS Status,
  ISNULL(NULLIF(PROD.Remark, ''), '-') AS Remark
FROM JobBookingJobCard J
INNER JOIN JobBookingJobCardContents JJ ON J.JobBookingID = JJ.JobBookingID AND J.CompanyID = JJ.CompanyID
INNER JOIN JobBookingJobCardProcess JP ON JJ.JobBookingJobCardContentsID = JP.JobBookingJobCardContentsID AND JJ.CompanyID = JP.CompanyID
INNER JOIN ProcessMaster PM ON PM.ProcessID = JP.ProcessID AND JP.CompanyID = PM.CompanyID
LEFT JOIN MachineMaster MCH ON MCH.MachineId = ISNULL(JP.MachineID, 0) AND MCH.CompanyID = JP.CompanyID
LEFT JOIN JobScheduleRelease JSR ON JP.JobBookingID = JSR.JobBookingID AND JP.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID AND JP.ProcessID = JSR.ProcessID AND JP.CompanyID = JSR.CompanyID AND ISNULL(JSR.IsDeletedTransaction, 0) = 0
LEFT JOIN MachineMaster MCH1 ON MCH1.MachineId = JSR.MachineId AND ISNULL(MCH1.IsDeletedTransaction, 0) = 0
LEFT JOIN (SELECT PE.JobBookingJobCardContentsID, PE.ProcessID, PE.MachineID, MM.MachineName, PE.ProductionQuantity, PE.FromTime, PE.Remark, PE.Status, UM.UserName AS EmployeeName
  FROM ProductionEntry PE
  INNER JOIN ProductionUpdateEntry PEU ON PEU.ProductionID = PE.ProductionID AND PEU.CompanyID = PE.CompanyID AND ISNULL(PEU.IsDeletedTransaction, 0) = 0
  LEFT JOIN UserMaster UM ON UM.UserID = PE.EmployeeID
  LEFT JOIN MachineMaster MM ON MM.MachineId = PE.MachineID) AS PROD ON PROD.JobBookingJobCardContentsID = JSR.JobBookingJobCardContentsID AND PROD.ProcessID = JSR.ProcessID
WHERE J.CompanyID = @CompanyID AND J.JobBookingID = @JobBookingID
  AND (@JobBookingJobCardContentsID IS NULL OR JJ.JobBookingJobCardContentsID = @JobBookingJobCardContentsID)
ORDER BY JP.SequenceNo
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
