/*
================================================================================
  GetFGQCInspectionList  —  drives GET /api/qc/inspections
================================================================================
  Spec section 6: every route calls a stored procedure, no business logic in
  JavaScript. This is the paged inspection history behind the dashboard table
  and the job-number search in section 7.4.

  One row per lot. FinishGoodsQCInspectionMain already holds one row per lot, so
  counting it is correct — but a lot re-inspected after rework shows only its
  latest verdict here, which is why the dashboard labels this "latest verdict
  per lot" and takes first-pass acceptance from GetFGQCDashboardKPIs instead.

  Found defect counts come from the most recent submission only. Earlier counts
  are history and are never carried forward (spec section 3).

  Result set 1: the page of rows.
  Result set 2: Total — the unpaged row count, for the pager.
================================================================================
*/

IF OBJECT_ID('dbo.GetFGQCInspectionList', 'P') IS NOT NULL
    DROP PROCEDURE dbo.GetFGQCInspectionList;
GO

CREATE PROCEDURE dbo.GetFGQCInspectionList
    @CompanyID BIGINT        = NULL,
    @FromDate  DATE          = NULL,
    @ToDate    DATE          = NULL,
    @JobNo     NVARCHAR(100) = NULL,
    @Status    NVARCHAR(50)  = NULL,
    @UnitID    BIGINT        = NULL,
    @Offset    INT           = 0,
    @PageSize  INT           = 25
AS
BEGIN
    SET NOCOUNT ON;

    IF @Offset   IS NULL OR @Offset   < 0 SET @Offset   = 0;
    IF @PageSize IS NULL OR @PageSize < 1 SET @PageSize = 25;
    IF @JobNo = '' SET @JobNo = NULL;
    IF @Status = '' SET @Status = NULL;

    /*
      Latest submission per lot. Rows from one submission share a CreatedDate,
      which is what separates one submission from the next (spec section 4.1).
    */
    ;WITH LatestDetail AS (
        SELECT
            d.FinishGoodsQCInspectionMainID,
            SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
            SUM(ISNULL(d.Major,    0)) AS FoundMajor,
            SUM(ISNULL(d.Minor,    0)) AS FoundMinor
        FROM dbo.FinishGoodsQCInspectionDetail d
        INNER JOIN (
            SELECT FinishGoodsQCInspectionMainID, MAX(CreatedDate) AS MaxCreated
            FROM dbo.FinishGoodsQCInspectionDetail
            WHERE ISNULL(IsDeletedTransaction, 0) = 0
            GROUP BY FinishGoodsQCInspectionMainID
        ) latest
            ON  latest.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
            AND d.CreatedDate = latest.MaxCreated
        WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
        GROUP BY d.FinishGoodsQCInspectionMainID
    ),
    /*
      Submission count per lot — how many distinct CreatedDate stamps the detail
      history carries. Section 5 question 2: once the main row is replaced, the
      fact that a lot was ever rejected survives only here.
    */
    SubmissionCount AS (
        SELECT
            FinishGoodsQCInspectionMainID,
            COUNT(DISTINCT CreatedDate) AS Submissions
        FROM dbo.FinishGoodsQCInspectionDetail
        WHERE ISNULL(IsDeletedTransaction, 0) = 0
        GROUP BY FinishGoodsQCInspectionMainID
    ),
    /*
      Fallback job resolution for rows saved before JobBookingID existed on the
      main table. Once 001_schema_fixes.sql has run and backfilled, m.JobBookingID
      wins and this side of the ISNULL is never used.
    */
    LotJob AS (
        SELECT
            fgd.FGTransactionID,
            fgd.JobBookingID,
            ROW_NUMBER() OVER (
                PARTITION BY fgd.FGTransactionID, fgd.JobBookingID
                ORDER BY fgd.JobBookingID
            ) AS rn
        FROM dbo.FinishGoodsTransactionDetail fgd
        WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
    )
    SELECT
        m.FinishGoodsQCInspectionMainID,
        m.FGQCNo,
        m.QCStatus,
        m.SampleSize,
        m.TotalBox AS LotSize,
        m.PackedQuantity,
        m.ReferenceAQLCritical,
        m.ReferenceAQLMajor,
        m.ReferenceAQLMinor,
        m.FGTransactionID,
        ISNULL(m.JobBookingID, lj.JobBookingID)          AS JobBookingID,
        ISNULL(m.ModifiedDate, m.CreatedDate)            AS InspectedOn,
        m.Remark,
        m.ProductionUnitID,
        ISNULL(um.UserName, '')                          AS Inspector,
        m.CreatedBy                                      AS UserID,
        fgm.VoucherNo                                    AS GPNNo,
        fgm.VoucherDate                                  AS GPNDate,
        jb.JobBookingNo,
        jb.JobName,
        ISNULL(jb.ClientName, lm.LedgerName)             AS ClientName,
        cm.CategoryName,
        ISNULL(ld.FoundCritical, 0)                      AS FoundCritical,
        ISNULL(ld.FoundMajor,    0)                      AS FoundMajor,
        ISNULL(ld.FoundMinor,    0)                      AS FoundMinor,
        ISNULL(sc.Submissions,   0)                      AS SubmissionCount
    FROM dbo.FinishGoodsQCInspectionMain m
    LEFT JOIN LatestDetail ld
           ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
    LEFT JOIN SubmissionCount sc
           ON sc.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
    LEFT JOIN dbo.FinishGoodsTransactionMain fgm
           ON fgm.FGTransactionID = m.FGTransactionID
          AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
    LEFT JOIN LotJob lj
           ON lj.FGTransactionID = m.FGTransactionID
          AND (m.JobBookingID IS NULL OR lj.JobBookingID = m.JobBookingID)
          AND lj.rn = 1
    LEFT JOIN dbo.JobBookingJobCard jb
           ON jb.JobBookingID = ISNULL(m.JobBookingID, lj.JobBookingID)
    LEFT JOIN dbo.JobOrderBooking job
           ON job.OrderBookingID = jb.OrderBookingID
    LEFT JOIN dbo.LedgerMaster lm
           ON lm.LedgerID = job.LedgerID
    LEFT JOIN dbo.CategoryMaster cm
           ON cm.CategoryID = ISNULL(m.CategoryID, jb.CategoryID)
    LEFT JOIN dbo.UserMaster um
           ON um.UserID = m.CreatedBy
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
      AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
      AND (@FromDate  IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) >= @FromDate)
      AND (@ToDate    IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) <= @ToDate)
      AND (@Status    IS NULL OR m.QCStatus = @Status)
      AND (@UnitID    IS NULL OR m.ProductionUnitID = @UnitID)
      AND (
            @JobNo IS NULL
         OR jb.JobBookingNo LIKE '%' + @JobNo + '%'
         OR m.FGQCNo        LIKE '%' + @JobNo + '%'
         OR fgm.VoucherNo   LIKE '%' + @JobNo + '%'
      )
    ORDER BY ISNULL(m.ModifiedDate, m.CreatedDate) DESC
    OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;

    /* Unpaged count for the pager. */
    ;WITH LotJob AS (
        SELECT
            fgd.FGTransactionID,
            fgd.JobBookingID,
            ROW_NUMBER() OVER (
                PARTITION BY fgd.FGTransactionID, fgd.JobBookingID
                ORDER BY fgd.JobBookingID
            ) AS rn
        FROM dbo.FinishGoodsTransactionDetail fgd
        WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
    )
    SELECT COUNT(DISTINCT m.FinishGoodsQCInspectionMainID) AS Total
    FROM dbo.FinishGoodsQCInspectionMain m
    LEFT JOIN dbo.FinishGoodsTransactionMain fgm
           ON fgm.FGTransactionID = m.FGTransactionID
          AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
    LEFT JOIN LotJob lj
           ON lj.FGTransactionID = m.FGTransactionID
          AND (m.JobBookingID IS NULL OR lj.JobBookingID = m.JobBookingID)
          AND lj.rn = 1
    LEFT JOIN dbo.JobBookingJobCard jb
           ON jb.JobBookingID = ISNULL(m.JobBookingID, lj.JobBookingID)
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
      AND (@CompanyID IS NULL OR m.CompanyID = @CompanyID)
      AND (@FromDate  IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) >= @FromDate)
      AND (@ToDate    IS NULL OR CAST(ISNULL(m.ModifiedDate, m.CreatedDate) AS DATE) <= @ToDate)
      AND (@Status    IS NULL OR m.QCStatus = @Status)
      AND (@UnitID    IS NULL OR m.ProductionUnitID = @UnitID)
      AND (
            @JobNo IS NULL
         OR jb.JobBookingNo LIKE '%' + @JobNo + '%'
         OR m.FGQCNo        LIKE '%' + @JobNo + '%'
         OR fgm.VoucherNo   LIKE '%' + @JobNo + '%'
      );
END
GO
