/*
================================================================================
  In-process QC compliance reports
================================================================================
  dbo.rpt_QC_MachineProcessCoverage  - was every machine + process checked at
                                       least once per hour while it ran?
  dbo.rpt_QC_OperatorPerformance     - did every QC operator do at least two
                                       checks per hour of their shift?

  Both are read-only and take the same parameters:
      @FromDate, @ToDate              required
      @MachineID, @ProcessID, @UserID optional filters (NULL = all)
      @CompanyID                      optional
      @Mode                           'SUMMARY' (default) or 'DETAIL'

  Facts these rely on (checked in both databases, Nov 2026):
  - A check is one row of ProductionEntryProcessInspectionMain, timed by
    CreatedDate. Its machine comes from ProductionEntry via ProductionID. About
    1.5% of checks point at a production entry that was later deleted; those
    take the machine that ran the same job content + process nearest in time.
  - Run time comes from ProductionEntry.FromTime/ToTime. Status is only
    Complete, Part Complete or Running; no idle, stop or make-ready time is
    recorded anywhere, so all entry time is run time. A Running entry has no
    ToTime: it ends where the machine's next entry starts, else now.
  - CreatedDate and FromTime/ToTime are both server time, which is IST, so
    they are compared as stored.
  - Ahmedabad's ProductionEntry has no IsDeleted column (Kolkata's is always
    0), so it is not filtered on.
  - Only processes with a QC checklist (ProcessInspectionParameters) are
    expected to be checked.

  Run 002_inspection_sample_size.sql first (OperatorPerformance reads
  SampleSize). Idempotent. Run on BOTH databases:
      USE IndusEnterprise;   -- Kolkata
      USE IndusEnterprise2;  -- Ahmedabad
================================================================================
*/

SET NOCOUNT ON;
GO

/*------------------------------------------------------------------------------
  Report 1: machine + process coverage
  SUMMARY: one row per date, machine and process.
  DETAIL:  one row per unchecked hour slot.

  - Entries of one machine + process at most 5 minutes apart (or overlapping)
    are one continuous run.
  - Each run is cut into 1-hour slots from its start. A final slot shorter
    than 30 minutes is not checked for, nor is the slot still in progress on
    a machine running now.
  - A slot counts on the date it starts, so a run across midnight keeps one
    slot clock. Run Start/End/Hours are those of that date's slots.
  - Longest gap: the longest stretch of a run with no check (run start to the
    first check, between checks, last check to run end) that touches the date.
  - @UserID counts only that QC operator's checks.
------------------------------------------------------------------------------*/
CREATE OR ALTER PROCEDURE dbo.rpt_QC_MachineProcessCoverage
    @FromDate  DATE,
    @ToDate    DATE,
    @MachineID INT         = NULL,
    @ProcessID INT         = NULL,
    @UserID    INT         = NULL,
    @CompanyID INT         = NULL,
    @Mode      VARCHAR(10) = 'SUMMARY'
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @MergeGapSec    INT = 300,
            @SlotSec        INT = 3600,
            @MinLastSlotSec INT = 1800,
            @Now            DATETIME = GETDATE(),
            -- Load a week before so a run already going on @FromDate starts its
            -- slot clock at its real start, and two days after so the last
            -- slots of @ToDate see where the run really ended.
            @LoadFrom       DATETIME = DATEADD(DAY, -7, CAST(@FromDate AS DATETIME)),
            @LoadTo         DATETIME = DATEADD(DAY, 2, CAST(@ToDate AS DATETIME)),
            @Plant          NVARCHAR(20) = CASE DB_NAME() WHEN N'IndusEnterprise2' THEN N'Ahmedabad' ELSE N'Kolkata' END;

    -- 1. Production entries of processes that have a QC checklist
    SELECT
        pe.ProductionID,
        pe.MachineID,
        pe.ProcessID,
        pe.JobBookingID,
        pe.UserID AS OperatorID,
        pe.FromTime,
        EndTime = CASE WHEN x.EndTime < pe.FromTime THEN pe.FromTime ELSE x.EndTime END,
        IsOpen  = CASE WHEN pe.ToTime IS NULL AND nx.NextStart IS NULL THEN 1 ELSE 0 END
    INTO #Entries
    FROM dbo.ProductionEntry pe
    OUTER APPLY (
        SELECT MIN(n.FromTime) AS NextStart
        FROM dbo.ProductionEntry n
        WHERE pe.ToTime IS NULL
          AND n.MachineID = pe.MachineID
          AND n.FromTime > pe.FromTime
    ) nx
    CROSS APPLY (SELECT EndTime = COALESCE(pe.ToTime, nx.NextStart, @Now)) x
    WHERE pe.FromTime >= @LoadFrom
      AND pe.FromTime <  @LoadTo
      AND ISNULL(pe.MachineID, 0) > 0
      AND (@MachineID IS NULL OR pe.MachineID = @MachineID)
      AND (@ProcessID IS NULL OR pe.ProcessID = @ProcessID)
      AND (@CompanyID IS NULL OR pe.CompanyID = @CompanyID)
      AND EXISTS (
          SELECT 1 FROM dbo.ProcessInspectionParameters pip
          WHERE pip.ProcessID = pe.ProcessID
            AND ISNULL(pip.IsDeletedTransaction, 0) = 0
      );

    -- 2. Checks, with the machine they were made on
    SELECT
        m.TransactionID,
        m.UserID,
        m.ProcessID,
        CheckTime = m.CreatedDate,
        MachineID = COALESCE(pe.MachineID, fb.MachineID)
    INTO #Checks
    FROM dbo.ProductionEntryProcessInspectionMain m
    LEFT JOIN dbo.ProductionEntry pe
        ON pe.ProductionID = m.ProductionID
    OUTER APPLY (
        SELECT TOP (1) p2.MachineID
        FROM dbo.ProductionEntry p2
        WHERE pe.ProductionID IS NULL
          AND p2.JobBookingJobCardContentsID = m.JobBookingJobCardContentsID
          AND p2.ProcessID = m.ProcessID
          AND ISNULL(p2.MachineID, 0) > 0
        ORDER BY ABS(DATEDIFF(SECOND, p2.FromTime, m.CreatedDate))
    ) fb
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
      AND m.CreatedDate >= @LoadFrom
      AND m.CreatedDate <  @LoadTo
      AND (@UserID IS NULL OR m.UserID = @UserID)
      AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID);

    -- 3. Merge entries into continuous runs
    ;WITH o AS (
        SELECT e.*,
               PrevEnd = MAX(e.EndTime) OVER (
                   PARTITION BY e.MachineID, e.ProcessID
                   ORDER BY e.FromTime, e.ProductionID
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        FROM #Entries e
    )
    SELECT o.ProductionID, o.MachineID, o.ProcessID, o.JobBookingID, o.OperatorID,
           o.FromTime, o.EndTime, o.IsOpen,
           RunNo = SUM(CASE WHEN o.PrevEnd IS NULL OR DATEDIFF(SECOND, o.PrevEnd, o.FromTime) > @MergeGapSec
                            THEN 1 ELSE 0 END)
                   OVER (PARTITION BY o.MachineID, o.ProcessID
                         ORDER BY o.FromTime, o.ProductionID
                         ROWS UNBOUNDED PRECEDING)
    INTO #EntryRuns
    FROM o;

    CREATE TABLE #Runs (
        RunID        INT IDENTITY(1,1) PRIMARY KEY,
        MachineID    BIGINT,
        ProcessID    BIGINT,
        RunNo        INT,
        RunStart     DATETIME,
        RunEnd       DATETIME,
        IsOpen       INT,
        RunSec       INT,
        AllSlots     INT,
        CountedSlots INT
    );

    INSERT INTO #Runs (MachineID, ProcessID, RunNo, RunStart, RunEnd, IsOpen)
    SELECT MachineID, ProcessID, RunNo, MIN(FromTime), MAX(EndTime), MAX(IsOpen)
    FROM #EntryRuns
    GROUP BY MachineID, ProcessID, RunNo;

    UPDATE #Runs SET RunSec = DATEDIFF(SECOND, RunStart, RunEnd);
    UPDATE #Runs
       SET AllSlots     = (RunSec + @SlotSec - 1) / @SlotSec,
           CountedSlots = RunSec / @SlotSec
                        + CASE WHEN IsOpen = 0 AND RunSec % @SlotSec >= @MinLastSlotSec THEN 1 ELSE 0 END;

    -- 4. Cut runs into 1-hour slots from the run start
    ;WITH E1(n) AS (SELECT 1 FROM (VALUES (1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) v(n)),
          Tally(k) AS (
              SELECT TOP (10000) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS INT) - 1
              FROM E1 a CROSS JOIN E1 b CROSS JOIN E1 c CROSS JOIN E1 d)
    SELECT
        r.RunID,
        SlotNo    = t.k,
        SlotStart = DATEADD(SECOND, t.k * @SlotSec, r.RunStart),
        SlotEnd   = CASE WHEN (t.k + 1) * @SlotSec < r.RunSec
                         THEN DATEADD(SECOND, (t.k + 1) * @SlotSec, r.RunStart)
                         ELSE r.RunEnd END,
        SlotDate  = CAST(DATEADD(SECOND, t.k * @SlotSec, r.RunStart) AS DATE),
        IsCounted = CASE WHEN t.k < r.CountedSlots THEN 1 ELSE 0 END,
        Checks    = 0
    INTO #Slots
    FROM #Runs r
    JOIN Tally t ON t.k < r.AllSlots;

    -- 5. Put each check in its run and slot (a check exactly at run end is in the last slot)
    SELECT
        r.RunID,
        c.TransactionID,
        c.CheckTime,
        SlotNo = CASE WHEN x.Sec >= r.AllSlots * @SlotSec THEN r.AllSlots - 1 ELSE x.Sec / @SlotSec END
    INTO #RunChecks
    FROM #Checks c
    JOIN #Runs r
        ON  r.MachineID = c.MachineID
        AND r.ProcessID = c.ProcessID
        AND c.CheckTime >= r.RunStart
        AND c.CheckTime <= r.RunEnd
        AND r.AllSlots > 0
    CROSS APPLY (SELECT Sec = DATEDIFF(SECOND, r.RunStart, c.CheckTime)) x;

    UPDATE s
       SET Checks = rc.n
    FROM #Slots s
    JOIN (SELECT RunID, SlotNo, COUNT(*) AS n FROM #RunChecks GROUP BY RunID, SlotNo) rc
        ON rc.RunID = s.RunID AND rc.SlotNo = s.SlotNo;

    IF UPPER(@Mode) = 'DETAIL'
    BEGIN
        SELECT
            Plant           = @Plant,
            ReportDate      = s.SlotDate,
            MachineID       = r.MachineID,
            MachineName     = mm.MachineName,
            ProcessID       = r.ProcessID,
            ProcessName     = pm.ProcessName,
            SlotStart       = s.SlotStart,
            SlotEnd         = s.SlotEnd,
            JobNo           = jobs.JobNo,
            MachineOperator = ops.Operators
        FROM #Slots s
        JOIN #Runs r ON r.RunID = s.RunID
        LEFT JOIN dbo.MachineMaster mm ON mm.MachineID = r.MachineID
        LEFT JOIN dbo.ProcessMaster pm ON pm.ProcessID = r.ProcessID
        OUTER APPLY (
            SELECT STRING_AGG(j.JobBookingNo, N', ') WITHIN GROUP (ORDER BY j.JobBookingNo) AS JobNo
            FROM (
                SELECT DISTINCT jc.JobBookingNo
                FROM #EntryRuns e
                JOIN dbo.JobBookingJobCard jc ON jc.JobBookingID = e.JobBookingID
                WHERE e.MachineID = r.MachineID AND e.ProcessID = r.ProcessID AND e.RunNo = r.RunNo
                  AND e.FromTime < s.SlotEnd AND e.EndTime > s.SlotStart
            ) j
        ) jobs
        OUTER APPLY (
            SELECT STRING_AGG(u.UserName, N', ') WITHIN GROUP (ORDER BY u.UserName) AS Operators
            FROM (
                SELECT DISTINCT um.UserName
                FROM #EntryRuns e
                JOIN dbo.UserMaster um ON um.UserID = e.OperatorID
                WHERE e.MachineID = r.MachineID AND e.ProcessID = r.ProcessID AND e.RunNo = r.RunNo
                  AND e.FromTime < s.SlotEnd AND e.EndTime > s.SlotStart
            ) u
        ) ops
        WHERE s.IsCounted = 1
          AND s.Checks = 0
          AND s.SlotDate BETWEEN @FromDate AND @ToDate
        ORDER BY s.SlotDate, mm.MachineName, pm.ProcessName, s.SlotStart;
        RETURN;
    END

    -- 6. One row per run and date
    SELECT
        s.RunID,
        s.SlotDate,
        DayStart     = MIN(s.SlotStart),
        DayEnd       = MAX(s.SlotEnd),
        Slots        = SUM(s.IsCounted),
        CheckedSlots = SUM(CASE WHEN s.IsCounted = 1 AND s.Checks > 0 THEN 1 ELSE 0 END),
        Checks       = SUM(s.Checks)
    INTO #RunDays
    FROM #Slots s
    WHERE s.SlotDate BETWEEN @FromDate AND @ToDate
    GROUP BY s.RunID, s.SlotDate;

    -- 7. Longest stretch without a check, per run and date
    ;WITH pts AS (
        SELECT RunID, T = RunStart FROM #Runs
        UNION ALL
        SELECT RunID, CheckTime FROM #RunChecks
        UNION ALL
        SELECT RunID, RunEnd FROM #Runs
    ),
    gaps AS (
        SELECT RunID, GapStart = T, GapEnd = LEAD(T) OVER (PARTITION BY RunID ORDER BY T)
        FROM pts
    )
    SELECT d.RunID, d.SlotDate, LongestGapMin = MAX(DATEDIFF(SECOND, g.GapStart, g.GapEnd)) / 60
    INTO #DayGaps
    FROM #RunDays d
    JOIN gaps g
        ON  g.RunID = d.RunID
        AND g.GapEnd IS NOT NULL
        AND g.GapStart < d.DayEnd
        AND g.GapEnd > d.DayStart
    GROUP BY d.RunID, d.SlotDate;

    SELECT
        Plant          = @Plant,
        ReportDate     = d.SlotDate,
        MachineID      = r.MachineID,
        MachineName    = mm.MachineName,
        ProcessID      = r.ProcessID,
        ProcessName    = pm.ProcessName,
        RunStart       = MIN(d.DayStart),
        RunEnd         = MAX(d.DayEnd),
        RunHours       = CAST(SUM(DATEDIFF(SECOND, d.DayStart, d.DayEnd)) / 3600.0 AS DECIMAL(9, 2)),
        ChecksDone     = SUM(d.Checks),
        HoursChecked   = SUM(d.CheckedSlots),
        HoursUnchecked = SUM(d.Slots - d.CheckedSlots),
        CoveragePct    = CAST(100.0 * SUM(d.CheckedSlots) / NULLIF(SUM(d.Slots), 0) AS DECIMAL(5, 1)),
        LongestGapMin  = MAX(dg.LongestGapMin),
        Status         = CASE WHEN SUM(d.Slots - d.CheckedSlots) > 0 THEN 'Missed' ELSE 'OK' END
    FROM #RunDays d
    JOIN #Runs r ON r.RunID = d.RunID
    LEFT JOIN #DayGaps dg ON dg.RunID = d.RunID AND dg.SlotDate = d.SlotDate
    LEFT JOIN dbo.MachineMaster mm ON mm.MachineID = r.MachineID
    LEFT JOIN dbo.ProcessMaster pm ON pm.ProcessID = r.ProcessID
    GROUP BY d.SlotDate, r.MachineID, mm.MachineName, r.ProcessID, pm.ProcessName
    ORDER BY d.SlotDate, mm.MachineName, pm.ProcessName;
END
GO

/*------------------------------------------------------------------------------
  Report 2: QC operator performance
  SUMMARY: one row per QC operator and shift session.
  DETAIL:  one row per check in those sessions.

  - An operator's checks in time order; a gap of more than 4 hours starts a
    new session, so a night shift across midnight stays one row. Shift Date
    is the date of the session's first check.
  - Span = last check - first check, at least 1 hour.
  - The span is cut into 1-hour slots from the first check. A final slot
    shorter than 30 minutes joins the slot before it (it holds the last
    check). Hours Below 2 Checks = slots with fewer than 2 checks.
  - Below Standard if checks per hour < 2 or any hour had fewer than 2.
  - @MachineID / @ProcessID keep the sessions with at least one check on that
    machine / process; the session's numbers still count all its checks.
------------------------------------------------------------------------------*/
CREATE OR ALTER PROCEDURE dbo.rpt_QC_OperatorPerformance
    @FromDate  DATE,
    @ToDate    DATE,
    @MachineID INT         = NULL,
    @ProcessID INT         = NULL,
    @UserID    INT         = NULL,
    @CompanyID INT         = NULL,
    @Mode      VARCHAR(10) = 'SUMMARY'
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @SessionGapSec  INT = 4 * 3600,
            @SlotSec        INT = 3600,
            @MinLastSlotSec INT = 1800,
            @TargetPerHour  INT = 2,
            -- A session on @FromDate may have started the evening before; one on
            -- @ToDate may run past midnight.
            @LoadFrom       DATETIME = DATEADD(DAY, -1, CAST(@FromDate AS DATETIME)),
            @LoadTo         DATETIME = DATEADD(DAY, 2, CAST(@ToDate AS DATETIME)),
            @Plant          NVARCHAR(20) = CASE DB_NAME() WHEN N'IndusEnterprise2' THEN N'Ahmedabad' ELSE N'Kolkata' END;

    -- 1. Checks, with the machine they were made on
    SELECT
        m.TransactionID,
        m.VoucherNo,
        m.UserID,
        m.ProcessID,
        m.JobBookingID,
        m.SampleSize,
        CheckTime = m.CreatedDate,
        MachineID = COALESCE(pe.MachineID, fb.MachineID)
    INTO #Checks
    FROM dbo.ProductionEntryProcessInspectionMain m
    LEFT JOIN dbo.ProductionEntry pe
        ON pe.ProductionID = m.ProductionID
    OUTER APPLY (
        SELECT TOP (1) p2.MachineID
        FROM dbo.ProductionEntry p2
        WHERE pe.ProductionID IS NULL
          AND p2.JobBookingJobCardContentsID = m.JobBookingJobCardContentsID
          AND p2.ProcessID = m.ProcessID
          AND ISNULL(p2.MachineID, 0) > 0
        ORDER BY ABS(DATEDIFF(SECOND, p2.FromTime, m.CreatedDate))
    ) fb
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
      AND m.CreatedDate >= @LoadFrom
      AND m.CreatedDate <  @LoadTo
      AND ISNULL(m.UserID, 0) > 0
      AND (@UserID IS NULL OR m.UserID = @UserID)
      AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID);

    -- 2. Split each operator's checks into shift sessions
    ;WITH o AS (
        SELECT c.*,
               PrevTime = LAG(c.CheckTime) OVER (PARTITION BY c.UserID ORDER BY c.CheckTime, c.TransactionID)
        FROM #Checks c
    )
    SELECT o.*,
           SessionNo = SUM(CASE WHEN o.PrevTime IS NULL OR DATEDIFF(SECOND, o.PrevTime, o.CheckTime) > @SessionGapSec
                                THEN 1 ELSE 0 END)
                       OVER (PARTITION BY o.UserID ORDER BY o.CheckTime, o.TransactionID ROWS UNBOUNDED PRECEDING)
    INTO #SessionChecks
    FROM o;

    CREATE TABLE #Sessions (
        UserID     INT,
        SessionNo  INT,
        FirstCheck DATETIME,
        LastCheck  DATETIME,
        SpanSec    INT,
        Slots      INT,
        Checks     INT,
        Machines   INT,
        PRIMARY KEY (UserID, SessionNo)
    );

    INSERT INTO #Sessions (UserID, SessionNo, FirstCheck, LastCheck, SpanSec, Checks, Machines)
    SELECT UserID, SessionNo, MIN(CheckTime), MAX(CheckTime),
           DATEDIFF(SECOND, MIN(CheckTime), MAX(CheckTime)), COUNT(*), COUNT(DISTINCT MachineID)
    FROM #SessionChecks
    GROUP BY UserID, SessionNo;

    DELETE s
    FROM #Sessions s
    WHERE CAST(s.FirstCheck AS DATE) NOT BETWEEN @FromDate AND @ToDate
       OR ((@MachineID IS NOT NULL OR @ProcessID IS NOT NULL)
           AND NOT EXISTS (
               SELECT 1 FROM #SessionChecks c
               WHERE c.UserID = s.UserID AND c.SessionNo = s.SessionNo
                 AND (@MachineID IS NULL OR c.MachineID = @MachineID)
                 AND (@ProcessID IS NULL OR c.ProcessID = @ProcessID)));

    UPDATE #Sessions
       SET Slots = CASE WHEN SpanSec < @SlotSec THEN 1
                        ELSE SpanSec / @SlotSec
                           + CASE WHEN SpanSec % @SlotSec >= @MinLastSlotSec THEN 1 ELSE 0 END
                   END;

    IF UPPER(@Mode) = 'DETAIL'
    BEGIN
        SELECT
            Plant            = @Plant,
            ShiftDate        = CAST(s.FirstCheck AS DATE),
            UserID           = s.UserID,
            QCOperator       = um.UserName,
            SessionStart     = s.FirstCheck,
            CheckTime        = c.CheckTime,
            MachineName      = mm.MachineName,
            ProcessName      = pm.ProcessName,
            JobNo            = jc.JobBookingNo,
            VoucherNo        = c.VoucherNo,
            SampleSize       = c.SampleSize,
            MinutesSincePrev = CAST(DATEDIFF(SECOND, c.PrevTime, c.CheckTime) / 60.0 AS DECIMAL(9, 1))
        FROM #Sessions s
        JOIN #SessionChecks c ON c.UserID = s.UserID AND c.SessionNo = s.SessionNo
        LEFT JOIN dbo.UserMaster um ON um.UserID = s.UserID
        LEFT JOIN dbo.MachineMaster mm ON mm.MachineID = c.MachineID
        LEFT JOIN dbo.ProcessMaster pm ON pm.ProcessID = c.ProcessID
        LEFT JOIN dbo.JobBookingJobCard jc ON jc.JobBookingID = c.JobBookingID
        ORDER BY um.UserName, c.CheckTime, c.TransactionID;
        RETURN;
    END

    -- 3. Count checks in each hour slot of each session; the short last slot joins the one before
    ;WITH E1(n) AS (SELECT 1 FROM (VALUES (1),(1),(1),(1),(1),(1),(1),(1),(1),(1)) v(n)),
          Tally(k) AS (
              SELECT TOP (1000) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS INT) - 1
              FROM E1 a CROSS JOIN E1 b CROSS JOIN E1 c),
          SlotChecks AS (
              SELECT c.UserID, c.SessionNo, x.SlotNo, COUNT(*) AS n
              FROM #SessionChecks c
              JOIN #Sessions s ON s.UserID = c.UserID AND s.SessionNo = c.SessionNo
              CROSS APPLY (
                  SELECT SlotNo = CASE WHEN DATEDIFF(SECOND, s.FirstCheck, c.CheckTime) / @SlotSec >= s.Slots
                                       THEN s.Slots - 1
                                       ELSE DATEDIFF(SECOND, s.FirstCheck, c.CheckTime) / @SlotSec END
              ) x
              GROUP BY c.UserID, c.SessionNo, x.SlotNo)
    SELECT s.UserID, s.SessionNo,
           HoursBelow = SUM(CASE WHEN ISNULL(sc.n, 0) < @TargetPerHour THEN 1 ELSE 0 END)
    INTO #SessionSlots
    FROM #Sessions s
    JOIN Tally t ON t.k < s.Slots
    LEFT JOIN SlotChecks sc ON sc.UserID = s.UserID AND sc.SessionNo = s.SessionNo AND sc.SlotNo = t.k
    GROUP BY s.UserID, s.SessionNo;

    SELECT
        Plant           = @Plant,
        ShiftDate       = CAST(s.FirstCheck AS DATE),
        UserID          = s.UserID,
        QCOperator      = um.UserName,
        FirstCheck      = s.FirstCheck,
        LastCheck       = s.LastCheck,
        SpanHours       = CAST(h.SpanHours AS DECIMAL(9, 2)),
        ChecksDone      = s.Checks,
        TargetChecks    = CAST(@TargetPerHour * h.SpanHours AS DECIMAL(9, 1)),
        Shortfall       = CAST(CASE WHEN @TargetPerHour * h.SpanHours > s.Checks
                                    THEN @TargetPerHour * h.SpanHours - s.Checks ELSE 0 END AS DECIMAL(9, 1)),
        ChecksPerHour   = CAST(s.Checks / h.SpanHours AS DECIMAL(9, 2)),
        HoursBelow2     = ss.HoursBelow,
        MachinesCovered = s.Machines,
        Status          = CASE WHEN s.Checks / h.SpanHours < @TargetPerHour OR ss.HoursBelow > 0
                               THEN 'Below Standard' ELSE 'OK' END
    FROM #Sessions s
    JOIN #SessionSlots ss ON ss.UserID = s.UserID AND ss.SessionNo = s.SessionNo
    CROSS APPLY (SELECT SpanHours = CASE WHEN s.SpanSec < @SlotSec THEN 1.0 ELSE s.SpanSec / 3600.0 END) h
    LEFT JOIN dbo.UserMaster um ON um.UserID = s.UserID
    ORDER BY ShiftDate, um.UserName, s.FirstCheck;
END
GO

PRINT 'rpt_QC_MachineProcessCoverage and rpt_QC_OperatorPerformance ready';
GO
