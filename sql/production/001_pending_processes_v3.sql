/*
================================================================================
  Operator start list — show "online" printing steps on presses that need them
================================================================================
  GetPendingProcesses_ForMachineAndContent hides every JobScheduleRelease row
  marked IsOnlineProcess = 1. The ERP marks Printing (10337) or Printing -
  2nd Pass (279) online when the planned press prints both sides in one run
  (SM102-8, the Manugraphs). When the job is then run on a press that prints
  one side per run (e.g. AHM CD102 -5L), that side never shows, so it can't be
  started or QC-inspected (J00605/26-27 [1_2], Nov 2026).

  GetPendingProcesses_ForMachineAndContent_v3 is the same procedure with one
  change: an online Printing / Printing - 2nd Pass row is shown on @MachineID
  when that press prints one side per run (the ERP never plans printing online
  on it) and the form's other side was not already run on a two-sided press.
  Every other online step (coating, embossing, ...) stays hidden as before.

  Same parameters and result columns as the original, which is left as is.
  (KOL already has an unused _v2, hence _v3.)

  Idempotent. Run on BOTH databases:
      USE IndusEnterprise;   -- Kolkata
      USE IndusEnterprise2;  -- Ahmedabad
================================================================================
*/


CREATE OR ALTER PROCEDURE [dbo].[GetPendingProcesses_ForMachineAndContent_v3]
    @UserID              INT,              -- App user id
    @MachineID           INT,              -- Target machine
    @JobCardContentNo    NVARCHAR(100),    -- e.g. 'J00016_25_26[1_1]'
    @EnforcePermission   BIT = 1           -- 1 = check user is allowed to operate @MachineID
AS
BEGIN
    SET NOCOUNT ON;

    /* ---- Online printing steps ----
       Printing (10337) / Printing - 2nd Pass (279) are marked online when the
       planned press prints both sides in one run. A press counts as two-sided
       if the ERP has ever planned either side online on it. On a one-sided
       press an online printing row of this job card is shown, unless that
       form already has a printing run on a two-sided press (then both sides
       were printed there; the ERP never closes online rows, so their status
       can't tell us). Worked out once here: inside the main query this check
       makes the plan scan ProductionEntry. */
    DECLARE @OnlinePrintingShown TABLE (ScheduleSequenceID BIGINT PRIMARY KEY);

    IF NOT EXISTS (SELECT 1 FROM dbo.JobScheduleRelease
                   WHERE ProcessID IN (10337, 279) AND MachineID = @MachineID
                     AND ISNULL(IsOnlineProcess, 0) = 1 AND ISNULL(IsDeletedTransaction, 0) = 0)
    BEGIN
        INSERT INTO @OnlinePrintingShown (ScheduleSequenceID)
        SELECT jss.ScheduleSequenceID
        FROM dbo.JobBookingJobCardContents c
        JOIN dbo.JobScheduleRelease jss
          ON jss.JobBookingJobCardContentsID = c.JobBookingJobCardContentsID
        WHERE c.JobCardContentNo = @JobCardContentNo
          AND jss.ProcessID IN (10337, 279)
          AND ISNULL(jss.IsOnlineProcess, 0) = 1
          AND NOT EXISTS (
                SELECT 1
                FROM dbo.ProductionEntry pe
                WHERE pe.JobBookingJobCardContentsID = jss.JobBookingJobCardContentsID
                  AND pe.JobCardFormNo = jss.JobCardFormNo
                  AND pe.ProcessID IN (10337, 279)
                  AND EXISTS (SELECT 1 FROM dbo.JobScheduleRelease x
                              WHERE x.ProcessID IN (10337, 279) AND x.MachineID = pe.MachineID
                                AND ISNULL(x.IsOnlineProcess, 0) = 1 AND ISNULL(x.IsDeletedTransaction, 0) = 0));
    END;

    /* ---- Target component (job card content) ---- */
    ;WITH TargetComp AS (
        SELECT
            c.JobBookingJobCardContentsID,
            c.JobCardContentNo,
            c.JobBookingID,
            c.PlanContName AS ComponentName
        FROM dbo.JobBookingJobCardContents AS c
        WHERE c.JobCardContentNo = @JobCardContentNo
    ),

    /* ---- Processes this machine can perform (non-online) ---- */
    CapableProcesses AS (
        SELECT DISTINCT pm.ProcessID, pm.ProcessName
        FROM dbo.ProcessMaster pm
        CROSS APPLY STRING_SPLIT(pm.allocattedmachineid, ',') AS s
        WHERE ISNULL(pm.isdeletedtransaction, 0) = 0
     --     AND ISNULL(pm.IsOnlineProcess, 0) = 0
          AND TRY_CONVERT(INT, LTRIM(RTRIM(s.value))) = @MachineID
    ),

    /* ---- Processes on this component that are pending (non-online, or online printing that runs separately here) ---- */
    PendingProcOnJob AS (
        SELECT DISTINCT jss.JobBookingJobCardContentsID, jss.ProcessID
        FROM dbo.JobScheduleRelease AS jss
        JOIN TargetComp tc
          ON tc.JobBookingJobCardContentsID = jss.JobBookingJobCardContentsID
        WHERE (ISNULL(jss.IsOnlineProcess, 0) = 0
               OR jss.ScheduleSequenceID IN (SELECT ScheduleSequenceID FROM @OnlinePrintingShown))
          AND ISNULL(jss.IsDeletedTransaction, 0) = 0
          AND jss.Status IN (N'In Queue', N'Part Complete', N'Running')
    ),

    /* ---- Intersection: pending & machine-capable ---- */
    Worklist AS (
        SELECT pp.JobBookingJobCardContentsID, cp.ProcessID, cp.ProcessName
        FROM PendingProcOnJob pp
        JOIN CapableProcesses cp
          ON cp.ProcessID = pp.ProcessID
    ),

    /* ---- Schedule qty per process + form; carry JSS status (process-level) ---- */
    SchedAgg AS (
        SELECT
            jss.JobBookingJobCardContentsID,
            jss.ProcessID,
            CAST(jss.JobCardFormNo AS NVARCHAR(100)) AS JCFormNo,
            SUM(ISNULL(jss.ScheduleQty, 0)) AS ScheduleQty,
            MAX(jss.Status)                  AS ProcessStatus
        FROM dbo.JobScheduleRelease jss
        JOIN Worklist w
          ON w.JobBookingJobCardContentsID = jss.JobBookingJobCardContentsID
         AND w.ProcessID = jss.ProcessID
        WHERE (ISNULL(jss.IsOnlineProcess, 0) = 0
               OR jss.ScheduleSequenceID IN (SELECT ScheduleSequenceID FROM @OnlinePrintingShown))
          AND jss.Status IN (N'In Queue', N'Part Complete', N'Running')
          AND ISNULL(jss.IsDeletedTransaction, 0) = 0
        GROUP BY jss.JobBookingJobCardContentsID, jss.ProcessID, jss.JobCardFormNo
    ),

    /* ---- Produced qty per process + form (all machines) ---- */
    ProdAgg AS (
        SELECT
            TRY_CONVERT(BIGINT, pe.JobBookingJobCardContentsID) AS JobBookingJobCardContentsID,
            TRY_CONVERT(BIGINT, pe.ProcessID)                   AS ProcessID,
            CAST(pe.JobCardFormNo AS NVARCHAR(100))             AS JCFormNo,
            SUM(ISNULL(pe.ProductionQuantity, 0))               AS QtyProduced
        FROM dbo.ProductionEntry pe
        JOIN TargetComp tc
          ON TRY_CONVERT(BIGINT, pe.JobBookingJobCardContentsID) = tc.JobBookingJobCardContentsID
        GROUP BY TRY_CONVERT(BIGINT, pe.JobBookingJobCardContentsID),
                 TRY_CONVERT(BIGINT, pe.ProcessID),
                 CAST(pe.JobCardFormNo AS NVARCHAR(100))
    ),

    /* ---- Running form(s): most recent run + starter user + machine ---- */
    RunningForm AS (
        SELECT
            pe.JobBookingJobCardContentsID,
            pe.ProcessID,
            CAST(pe.JobCardFormNo AS NVARCHAR(100)) AS JCFormNo,
            pe.ProductionID,
            pe.UserID  AS StarterUserID,
            pe.MachineID AS RunningMachineID,             -- NEW
            ROW_NUMBER() OVER (
                PARTITION BY pe.JobBookingJobCardContentsID, pe.ProcessID, CAST(pe.JobCardFormNo AS NVARCHAR(100))
                ORDER BY pe.ProductionID DESC
            ) AS rn
        FROM dbo.ProductionEntry pe
        WHERE ISNULL(pe.Status, N'') = N'Running'
    ),
    RunningFormTop AS (
        SELECT JobBookingJobCardContentsID, ProcessID, JCFormNo, ProductionID, StarterUserID, RunningMachineID
        FROM RunningForm
        WHERE rn = 1
    ),

    /* ---- Paper required / issued for the component ---- */
    PaperBooked AS (
        SELECT tc.JobBookingJobCardContentsID,
               SUM(ISNULL(iap.BookedQuantity, 0)) AS PaperBookedQty
        FROM TargetComp tc
        LEFT JOIN dbo.ItemAllocationPending iap
          ON iap.JobBookingJobCardContentsID = tc.JobBookingJobCardContentsID
        GROUP BY tc.JobBookingJobCardContentsID
    ),
    PaperIssued AS (
        SELECT tc.JobBookingJobCardContentsID,
               SUM(ISNULL(itd.IssueQuantity, 0)) AS PaperIssuedQty
        FROM TargetComp tc
        LEFT JOIN dbo.ItemTransactionDetail itd
          ON itd.JobBookingJobCardContentsID = tc.JobBookingJobCardContentsID
        LEFT JOIN dbo.ItemTransactionMain itm
          ON itm.TransactionID = itd.TransactionID
        WHERE itm.VoucherID = -19
          AND ISNULL(itm.IsDeleted, 0) = 0
          AND ISNULL(itd.IsDeletedTransaction, 0) = 0
          AND ISNULL(itm.IsDeletedTransaction, 0) = 0
        GROUP BY tc.JobBookingJobCardContentsID
    ),
    ClPaperIssued AS (
        SELECT tc.JobBookingJobCardContentsID,
               SUM(ISNULL(itd.IssueQuantity, 0)) AS PaperIssuedQty
        FROM TargetComp tc
        LEFT JOIN dbo.ClientTransactionDetail itd
          ON itd.JobBookingJobCardContentsID = tc.JobBookingJobCardContentsID
        LEFT JOIN dbo.ClientTransactionMain itm
          ON itm.ClientTransactionID = itd.ClientTransactionID
        WHERE itm.VoucherID = -19
          AND ISNULL(itm.IsDeleted, 0) = 0
          AND ISNULL(itd.IsDeletedTransaction, 0) = 0
          AND ISNULL(itm.IsDeletedTransaction, 0) = 0
        GROUP BY tc.JobBookingJobCardContentsID
    ),

    /* ---- Header context ---- */
    Header AS (
        SELECT
            tc.JobBookingJobCardContentsID,
            tc.JobCardContentNo,
            tc.ComponentName,
            lm.LedgerName                              AS Client,
            jbj.JobName                                AS JobName,
            ISNULL(jbj.JobBookingNo, job.SalesOrderNo) AS PWOno,
            jbj.JobBookingDate                         AS PWODate
        FROM TargetComp tc
        JOIN dbo.JobBookingJobCard jbj
          ON jbj.JobBookingID = tc.JobBookingID
        JOIN dbo.JobOrderBookingDetails jobd
          ON jobd.OrderBookingID = jbj.OrderBookingID
         AND jobd.OrderBookingDetailsID = jbj.OrderBookingDetailsID
        JOIN dbo.JobOrderBooking job
          ON job.OrderBookingID = jobd.OrderBookingID
        JOIN dbo.LedgerMaster lm
          ON lm.LedgerID = job.LedgerID
    )

    /* ---- FINAL RESULT ---- */
    SELECT
        h.PWOno,
        CONVERT(date, h.PWODate)             AS PWODate,
        h.Client,
        h.JobName,
        h.ComponentName                      AS ComponentName,
        w.ProcessID,
        w.ProcessName,
        sa.JCFormNo                          AS FormNo,
        sa.ScheduleQty,
        ISNULL(pa.QtyProduced, 0)            AS QtyProduced,

        /* Status per process/form: prefer live Running form, else JSS status */
        CASE WHEN rf.ProductionID IS NOT NULL
             THEN N'Running'
             ELSE sa.ProcessStatus
        END                                   AS CurrentStatus,

        /* The ProductionID of a running form (most recent), else NULL */
        rf.ProductionID                       AS RunningProductionID,

        /* The UserID who started the running form, else NULL */
        CASE WHEN rf.ProductionID IS NOT NULL THEN rf.StarterUserID ELSE NULL END AS RunningUserID,

        /* NEW: MachineID of the running instance, else NULL */
        CASE WHEN rf.ProductionID IS NOT NULL THEN rf.RunningMachineID ELSE NULL END AS RunningMachineID,

        /* Paper requirement & issuance (component level; repeated per row) */
        ISNULL(pb.PaperBookedQty, 0)          AS PaperBookedQty,
        (ISNULL(pi.PaperIssuedQty, 0) + ISNULL(cpi.PaperIssuedQty, 0)) AS PaperIssuedQty,

        /* Convenience: can we start right now? (front-end can disable when 0) */
        CASE WHEN (ISNULL(pi.PaperIssuedQty, 0)+ISNULL(cpi.PaperIssuedQty, 0)) > 0
                  AND (CASE WHEN rf.ProductionID IS NOT NULL THEN N'Running' ELSE sa.ProcessStatus END)
                      IN (N'In Queue', N'Part Complete')
             THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS CanStart,

        /* Ids for convenience */
        h.JobCardContentNo                    AS JobCardContentNo,
        h.JobBookingJobCardContentsID         AS JobBookingJobCardContentsID
    FROM Header h
    JOIN Worklist w
      ON w.JobBookingJobCardContentsID = h.JobBookingJobCardContentsID
    JOIN SchedAgg sa
      ON sa.JobBookingJobCardContentsID = w.JobBookingJobCardContentsID
     AND sa.ProcessID = w.ProcessID
    LEFT JOIN ProdAgg pa
      ON pa.JobBookingJobCardContentsID = sa.JobBookingJobCardContentsID
     AND pa.ProcessID = sa.ProcessID
     AND pa.JCFormNo = sa.JCFormNo
    LEFT JOIN PaperBooked pb
      ON pb.JobBookingJobCardContentsID = h.JobBookingJobCardContentsID
    LEFT JOIN PaperIssued pi
      ON pi.JobBookingJobCardContentsID = h.JobBookingJobCardContentsID
    LEFT JOIN ClPaperIssued cpi
      ON cpi.JobBookingJobCardContentsID = h.JobBookingJobCardContentsID
    LEFT JOIN RunningFormTop rf
      ON rf.JobBookingJobCardContentsID = sa.JobBookingJobCardContentsID
     AND rf.ProcessID = sa.ProcessID
     AND rf.JCFormNo  = sa.JCFormNo
    ORDER BY h.PWODate, h.Client, h.JobName, sa.JCFormNo, w.ProcessName;
END
GO
