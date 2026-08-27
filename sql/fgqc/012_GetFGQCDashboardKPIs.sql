/*
================================================================================
  GetFGQCDashboardKPIs  —  drives GET /api/qc/dashboard
================================================================================
  Spec section 4.4 and section 7.4.

  Rules this procedure exists to keep (section 7.4):

    * Count lots, not submissions. FinishGoodsQCInspectionMain holds one row per
      lot, so counting it is correct.
    * A lot re-inspected after rework shows only its latest verdict there, so
      FIRST-PASS acceptance is computed from the detail history instead — the
      earliest submission of each lot, judged against that lot's AQL snapshot.
    * Do not average defect percentages across different sample sizes without
      weighting. The average here is SUM(defects) / SUM(sample), which weights
      each lot by the cartons actually inspected.
    * Show the record count behind each percentage. Every rate below ships with
      its numerator and denominator so the UI never has to state a bare
      percentage.

  Result sets, in order — the API reads them positionally:

    1  KPI totals
    2  Acceptance trend (daily for a range up to 21 days, weekly beyond that)
    3  Top defect characteristics, split by class
    4  Rejections by production unit
    5  Rejections by class
================================================================================
*/

IF OBJECT_ID('dbo.GetFGQCDashboardKPIs', 'P') IS NOT NULL
    DROP PROCEDURE dbo.GetFGQCDashboardKPIs;
GO

CREATE PROCEDURE dbo.GetFGQCDashboardKPIs
    @CompanyID BIGINT = NULL,
    @FromDate  DATE   = NULL,
    @ToDate    DATE   = NULL,
    @UnitID    BIGINT = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @ToDate   IS NULL SET @ToDate   = CAST(GETDATE() AS DATE);
    IF @FromDate IS NULL SET @FromDate = DATEADD(day, -29, @ToDate);

    DECLARE @DaySpan INT = DATEDIFF(day, @FromDate, @ToDate);

    /* ------------------------------------------- lots in scope ----------- */
    IF OBJECT_ID('tempdb..#FgqcLots') IS NOT NULL DROP TABLE #FgqcLots;

    SELECT
        m.FinishGoodsQCInspectionMainID,
        m.QCStatus,
        ISNULL(TRY_CAST(m.SampleSize AS DECIMAL(18, 4)), 0) AS SampleSize,
        m.ProductionUnitID,
        TRY_CAST(m.ReferenceAQLCritical AS DECIMAL(18, 4))  AS AqlCritical,
        TRY_CAST(m.ReferenceAQLMajor    AS DECIMAL(18, 4))  AS AqlMajor,
        TRY_CAST(m.ReferenceAQLMinor    AS DECIMAL(18, 4))  AS AqlMinor,
        CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) AS InspectedDate
    INTO #FgqcLots
    FROM dbo.FinishGoodsQCInspectionMain m
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
      AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
      AND (@UnitID    IS NULL OR m.ProductionUnitID = @UnitID)
      AND CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) BETWEEN @FromDate AND @ToDate;

    CREATE CLUSTERED INDEX IX_FgqcLots ON #FgqcLots (FinishGoodsQCInspectionMainID);

    /* ------------- per-submission totals for every lot in scope ---------- */
    IF OBJECT_ID('tempdb..#FgqcSubmissions') IS NOT NULL DROP TABLE #FgqcSubmissions;

    SELECT
        d.FinishGoodsQCInspectionMainID,
        d.CreatedDate,
        DENSE_RANK() OVER (
            PARTITION BY d.FinishGoodsQCInspectionMainID
            ORDER BY d.CreatedDate
        ) AS SubmissionNo,
        DENSE_RANK() OVER (
            PARTITION BY d.FinishGoodsQCInspectionMainID
            ORDER BY d.CreatedDate DESC
        ) AS SubmissionNoDesc,
        SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
        SUM(ISNULL(d.Major,    0)) AS FoundMajor,
        SUM(ISNULL(d.Minor,    0)) AS FoundMinor
    INTO #FgqcSubmissions
    FROM dbo.FinishGoodsQCInspectionDetail d
    INNER JOIN #FgqcLots l
            ON l.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
    WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
    GROUP BY d.FinishGoodsQCInspectionMainID, d.CreatedDate;

    CREATE CLUSTERED INDEX IX_FgqcSubmissions
        ON #FgqcSubmissions (FinishGoodsQCInspectionMainID, SubmissionNo);

    /* --------------------------------- latest counts, joined onto lots --- */
    IF OBJECT_ID('tempdb..#FgqcLatest') IS NOT NULL DROP TABLE #FgqcLatest;

    SELECT
        l.FinishGoodsQCInspectionMainID,
        l.QCStatus,
        l.SampleSize,
        l.ProductionUnitID,
        l.AqlCritical,
        l.AqlMajor,
        l.AqlMinor,
        l.InspectedDate,
        ISNULL(s.FoundCritical, 0) AS FoundCritical,
        ISNULL(s.FoundMajor,    0) AS FoundMajor,
        ISNULL(s.FoundMinor,    0) AS FoundMinor,
        ISNULL(s.FoundCritical, 0) + ISNULL(s.FoundMajor, 0) + ISNULL(s.FoundMinor, 0) AS FoundTotal
    INTO #FgqcLatest
    FROM #FgqcLots l
    LEFT JOIN #FgqcSubmissions s
           ON  s.FinishGoodsQCInspectionMainID = l.FinishGoodsQCInspectionMainID
           AND s.SubmissionNoDesc = 1;

    /*
      First pass: the earliest submission of each lot, judged against that
      lot's AQL snapshot. A class with no accept number recorded cannot fail
      the lot, so it is compared against itself and passes — the same treatment
      the save procedure gives a lot with no plan, which lands as Pending
      rather than Rejected.

      Lots whose snapshot is entirely absent are excluded from the first-pass
      denominator rather than counted as passes. FirstPassLots is returned so
      the UI can show the count behind the percentage.
    */
    IF OBJECT_ID('tempdb..#FgqcFirstPass') IS NOT NULL DROP TABLE #FgqcFirstPass;

    SELECT
        l.FinishGoodsQCInspectionMainID,
        CASE
            WHEN s.FoundCritical > ISNULL(l.AqlCritical, 0)               THEN 0
            WHEN s.FoundMajor    > ISNULL(l.AqlMajor, s.FoundMajor)       THEN 0
            WHEN s.FoundMinor    > ISNULL(l.AqlMinor, s.FoundMinor)       THEN 0
            ELSE 1
        END AS FirstPassAccepted
    INTO #FgqcFirstPass
    FROM #FgqcLatest l
    INNER JOIN #FgqcSubmissions s
            ON  s.FinishGoodsQCInspectionMainID = l.FinishGoodsQCInspectionMainID
            AND s.SubmissionNo = 1
    WHERE l.AqlCritical IS NOT NULL
       OR l.AqlMajor    IS NOT NULL
       OR l.AqlMinor    IS NOT NULL;

    /* ============================ 1. KPI totals ========================== */
    SELECT
        COUNT(1)                                                         AS LotsInspected,
        SUM(CASE WHEN QCStatus = 'Accepted'    THEN 1 ELSE 0 END)        AS LotsAccepted,
        SUM(CASE WHEN QCStatus = 'Rejected'    THEN 1 ELSE 0 END)        AS LotsRejected,
        SUM(CASE WHEN QCStatus = 'Pending'     THEN 1 ELSE 0 END)        AS PendingVerdicts,
        SUM(CASE WHEN QCStatus = 'In Progress' THEN 1 ELSE 0 END)        AS InProgress,
        SUM(SampleSize)                                                  AS TotalSample,
        SUM(FoundTotal)                                                  AS TotalDefects,
        (SELECT COUNT(1) FROM #FgqcFirstPass)                            AS FirstPassLots,
        (SELECT ISNULL(SUM(FirstPassAccepted), 0) FROM #FgqcFirstPass)   AS FirstPassAccepted,
        (SELECT COUNT(DISTINCT FinishGoodsQCInspectionMainID)
           FROM #FgqcSubmissions WHERE SubmissionNo > 1)                 AS LotsReinspected
    FROM #FgqcLatest;

    /* ============================ 2. Trend =============================== */
    SELECT
        CASE WHEN @DaySpan <= 21 THEN InspectedDate
             ELSE DATEADD(day, -DATEPART(weekday, InspectedDate) + 1, InspectedDate)
        END AS PeriodStart,
        COUNT(1)                                                  AS LotsInspected,
        SUM(CASE WHEN QCStatus = 'Accepted' THEN 1 ELSE 0 END)    AS LotsAccepted,
        SUM(CASE WHEN QCStatus = 'Rejected' THEN 1 ELSE 0 END)    AS LotsRejected
    FROM #FgqcLatest
    GROUP BY
        CASE WHEN @DaySpan <= 21 THEN InspectedDate
             ELSE DATEADD(day, -DATEPART(weekday, InspectedDate) + 1, InspectedDate)
        END
    ORDER BY PeriodStart;

    /* ==================== 3. Top defect characteristics ================== */
    /*
      Latest submission only, so a reworked lot does not double-count the
      defects it was rejected for. This is the chart that drives shop-floor
      action, so it is scoped exactly like the KPI tiles above it.
    */
    SELECT TOP 20
        d.Characterstics,
        SUM(ISNULL(d.Critical, 0)) AS CriticalCount,
        SUM(ISNULL(d.Major,    0)) AS MajorCount,
        SUM(ISNULL(d.Minor,    0)) AS MinorCount,
        SUM(ISNULL(d.Critical, 0) + ISNULL(d.Major, 0) + ISNULL(d.Minor, 0)) AS TotalCount
    FROM dbo.FinishGoodsQCInspectionDetail d
    INNER JOIN #FgqcSubmissions s
            ON  s.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
            AND s.CreatedDate = d.CreatedDate
            AND s.SubmissionNoDesc = 1
    WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
    GROUP BY d.Characterstics
    HAVING SUM(ISNULL(d.Critical, 0) + ISNULL(d.Major, 0) + ISNULL(d.Minor, 0)) > 0
    ORDER BY TotalCount DESC;

    /* ==================== 4. Rejections by production unit =============== */
    /*
      ProductionUnitID is returned raw. The API resolves it to a name through
      the same lookup that feeds the unit filter, which already falls back
      gracefully when ProductionUnitMaster is not present in a given database.
    */
    SELECT
        ProductionUnitID,
        COUNT(1) AS RejectionCount
    FROM #FgqcLatest
    WHERE QCStatus = 'Rejected'
    GROUP BY ProductionUnitID
    ORDER BY RejectionCount DESC;

    /* ==================== 5. Rejections by class ========================= */
    /* A lot can fail more than one class, so these do not sum to LotsRejected. */
    SELECT
        SUM(CASE WHEN FoundCritical > ISNULL(AqlCritical, 0)             THEN 1 ELSE 0 END) AS CriticalRejects,
        SUM(CASE WHEN FoundMajor    > ISNULL(AqlMajor, FoundMajor)       THEN 1 ELSE 0 END) AS MajorRejects,
        SUM(CASE WHEN FoundMinor    > ISNULL(AqlMinor, FoundMinor)       THEN 1 ELSE 0 END) AS MinorRejects
    FROM #FgqcLatest
    WHERE QCStatus = 'Rejected';

    DROP TABLE #FgqcFirstPass;
    DROP TABLE #FgqcLatest;
    DROP TABLE #FgqcSubmissions;
    DROP TABLE #FgqcLots;
END
GO
