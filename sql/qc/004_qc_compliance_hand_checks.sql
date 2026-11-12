/*
================================================================================
  Hand checks for the QC compliance reports (003_qc_compliance_reports.sql)
================================================================================
  Read-only. Set the date, machine, process and QC operator below, run each
  part, and compare the raw rows with the report rows.
================================================================================
*/

/*------------------------------------------------------------------------------
  Report 1: one machine + process on one date
  - (a) lists the production entries. Entries whose GapFromPrevMin is 5 or
    less belong to one run; the run's first FromTime starts the slot clock.
  - (b) lists the checks with the slot (hour from run start) each falls in;
    set @RunStart to the run's start from (a).
  - (c)/(d) are the report rows to compare.
------------------------------------------------------------------------------*/
DECLARE @Date      DATE     = '2026-11-11',
        @MachineID INT      = 14,
        @ProcessID INT      = 279,
        @RunStart  DATETIME = '2026-11-11 21:05:52';

-- (a) production entries around the date
SELECT pe.ProductionID, pe.FromTime, pe.ToTime, pe.Status,
       GapFromPrevMin = CAST(DATEDIFF(SECOND, LAG(pe.ToTime) OVER (ORDER BY pe.FromTime), pe.FromTime) / 60.0 AS DECIMAL(9, 1)),
       RunMinutes     = DATEDIFF(MINUTE, pe.FromTime, ISNULL(pe.ToTime, GETDATE())),
       jc.JobBookingNo, um.UserName AS MachineOperator
FROM dbo.ProductionEntry pe
LEFT JOIN dbo.JobBookingJobCard jc ON jc.JobBookingID = pe.JobBookingID
LEFT JOIN dbo.UserMaster um ON um.UserID = pe.UserID
WHERE pe.MachineID = @MachineID
  AND pe.ProcessID = @ProcessID
  AND pe.FromTime <  DATEADD(DAY, 2, CAST(@Date AS DATETIME))
  AND ISNULL(pe.ToTime, GETDATE()) >= DATEADD(DAY, -1, CAST(@Date AS DATETIME))
ORDER BY pe.FromTime;

-- (b) checks on that machine + process, with their hour slot from @RunStart
SELECT m.VoucherNo, m.CreatedDate AS CheckTime, um.UserName AS QCOperator,
       SlotNo           = DATEDIFF(SECOND, @RunStart, m.CreatedDate) / 3600,
       SlotStart        = DATEADD(SECOND, (DATEDIFF(SECOND, @RunStart, m.CreatedDate) / 3600) * 3600, @RunStart),
       MinutesSincePrev = CAST(DATEDIFF(SECOND, LAG(m.CreatedDate) OVER (ORDER BY m.CreatedDate), m.CreatedDate) / 60.0 AS DECIMAL(9, 1))
FROM dbo.ProductionEntryProcessInspectionMain m
JOIN dbo.ProductionEntry pe ON pe.ProductionID = m.ProductionID
LEFT JOIN dbo.UserMaster um ON um.UserID = m.UserID
WHERE pe.MachineID = @MachineID
  AND m.ProcessID = @ProcessID
  AND ISNULL(m.IsDeletedTransaction, 0) = 0
  AND m.CreatedDate >= DATEADD(DAY, -1, CAST(@Date AS DATETIME))
  AND m.CreatedDate <  DATEADD(DAY, 2, CAST(@Date AS DATETIME))
ORDER BY m.CreatedDate;

-- (c) report summary row, (d) its unchecked slots
EXEC dbo.rpt_QC_MachineProcessCoverage @FromDate = @Date, @ToDate = @Date, @MachineID = @MachineID, @ProcessID = @ProcessID;
EXEC dbo.rpt_QC_MachineProcessCoverage @FromDate = @Date, @ToDate = @Date, @MachineID = @MachineID, @ProcessID = @ProcessID, @Mode = 'DETAIL';
GO

/*------------------------------------------------------------------------------
  Report 2: one QC operator on one date
  - (a) lists their checks around the date. A MinutesSincePrev over 240
    starts a new session; set @SessionStart to that session's first check.
    HourSlot counts hours from it: each slot should have at least 2 checks.
  - (b)/(c) are the report rows to compare.
------------------------------------------------------------------------------*/
DECLARE @Date         DATE     = '2026-11-11',
        @UserID       INT      = 140,
        @SessionStart DATETIME = '2026-11-11 09:21';

-- (a) the operator's checks
SELECT m.VoucherNo, m.CreatedDate AS CheckTime, mm.MachineName, pm.ProcessName, jc.JobBookingNo, m.SampleSize,
       MinutesSincePrev = CAST(DATEDIFF(SECOND, LAG(m.CreatedDate) OVER (ORDER BY m.CreatedDate), m.CreatedDate) / 60.0 AS DECIMAL(9, 1)),
       HourSlot         = CASE WHEN m.CreatedDate >= @SessionStart THEN DATEDIFF(SECOND, @SessionStart, m.CreatedDate) / 3600 END
FROM dbo.ProductionEntryProcessInspectionMain m
LEFT JOIN dbo.ProductionEntry pe ON pe.ProductionID = m.ProductionID
LEFT JOIN dbo.MachineMaster mm ON mm.MachineID = pe.MachineID
LEFT JOIN dbo.ProcessMaster pm ON pm.ProcessID = m.ProcessID
LEFT JOIN dbo.JobBookingJobCard jc ON jc.JobBookingID = m.JobBookingID
WHERE m.UserID = @UserID
  AND ISNULL(m.IsDeletedTransaction, 0) = 0
  AND m.CreatedDate >= DATEADD(DAY, -1, CAST(@Date AS DATETIME))
  AND m.CreatedDate <  DATEADD(DAY, 2, CAST(@Date AS DATETIME))
ORDER BY m.CreatedDate;

-- (b) report summary rows, (c) the checks it counted
EXEC dbo.rpt_QC_OperatorPerformance @FromDate = @Date, @ToDate = @Date, @UserID = @UserID;
EXEC dbo.rpt_QC_OperatorPerformance @FromDate = @Date, @ToDate = @Date, @UserID = @UserID, @Mode = 'DETAIL';
GO
