/*
================================================================================
  GetFGQCInspectionByID  —  drives GET /api/qc/inspections/:id
================================================================================
  Spec section 4.4: full main + detail for the read-only view of a submitted
  inspection.

  Result set 1  Main row, with the job / GPN / client / inspector context and
                the snapshot of the AQL numbers that were in force when the
                verdict was computed. Never recompute an old verdict from the
                current plan (spec section 4.2).

  Result set 2  Detail rows of the LATEST submission only — this is what the
                verdict was computed from. Selected by exact CreatedDate match
                against MAX(CreatedDate), not by a time window: rows from one
                submission share a CreatedDate (spec section 4.1).

  Result set 3  Every detail row ever recorded against this lot, oldest
                submission first, with a SubmissionNo so the screen can group
                them. Section 5 question 2: a rejected lot is re-inspected
                against the same key and the main row is replaced, so the fact
                that the lot ever failed survives only in this history. Serving
                it here is what makes a rework visible in a buyer audit without
                adding a column that SaveFinishGoodsQCInspection would not fill.

  Result set 4  One row per submission: its stamp, its per-class totals, and
                whether it would have passed the AQL snapshot. SubmissionNo 1 is
                the first-pass result for this lot.
================================================================================
*/

IF OBJECT_ID('dbo.GetFGQCInspectionByID', 'P') IS NOT NULL
    DROP PROCEDURE dbo.GetFGQCInspectionByID;
GO

CREATE PROCEDURE dbo.GetFGQCInspectionByID
    @MainID BIGINT
AS
BEGIN
    SET NOCOUNT ON;

    IF @MainID IS NULL
    BEGIN
        RAISERROR('@MainID is required', 16, 1);
        RETURN;
    END

    /* ---------------------------------------------------------- main row -- */
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
    ),
    LatestDetail AS (
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
              AND FinishGoodsQCInspectionMainID = @MainID
            GROUP BY FinishGoodsQCInspectionMainID
        ) latest
            ON  latest.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
            AND d.CreatedDate = latest.MaxCreated
        WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
        GROUP BY d.FinishGoodsQCInspectionMainID
    )
    SELECT TOP 1
        m.*,
        ISNULL(m.JobBookingID, lj.JobBookingID)  AS ResolvedJobBookingID,
        ISNULL(m.ModifiedDate, m.CreatedDate)    AS InspectedOn,
        ISNULL(um.UserName, '')                  AS Inspector,
        fgm.VoucherNo                            AS GPNNo,
        fgm.VoucherDate                          AS GPNDate,
        jb.JobBookingNo,
        jb.JobName,
        ISNULL(jb.ClientName, lm.LedgerName)     AS ClientName,
        cm.CategoryName,
        ISNULL(ld.FoundCritical, 0)              AS FoundCritical,
        ISNULL(ld.FoundMajor,    0)              AS FoundMajor,
        ISNULL(ld.FoundMinor,    0)              AS FoundMinor,
        (
            SELECT COUNT(DISTINCT CreatedDate)
            FROM dbo.FinishGoodsQCInspectionDetail
            WHERE FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
              AND ISNULL(IsDeletedTransaction, 0) = 0
        )                                        AS SubmissionCount
    FROM dbo.FinishGoodsQCInspectionMain m
    LEFT JOIN LatestDetail ld
           ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
    LEFT JOIN dbo.FinishGoodsTransactionMain fgm
           ON fgm.FGTransactionID = m.FGTransactionID
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
    WHERE m.FinishGoodsQCInspectionMainID = @MainID
      AND ISNULL(m.IsDeletedTransaction, 0) = 0;

    /* ------------------------------------ detail, latest submission only -- */
    DECLARE @LatestCreated DATETIME = (
        SELECT MAX(CreatedDate)
        FROM dbo.FinishGoodsQCInspectionDetail
        WHERE FinishGoodsQCInspectionMainID = @MainID
          AND ISNULL(IsDeletedTransaction, 0) = 0
    );

    SELECT *
    FROM dbo.FinishGoodsQCInspectionDetail
    WHERE FinishGoodsQCInspectionMainID = @MainID
      AND ISNULL(IsDeletedTransaction, 0) = 0
      AND (@LatestCreated IS NULL OR CreatedDate = @LatestCreated)
    ORDER BY FinishGoodsQCInspectionDetailID;

    /* -------------------------------------- full history, oldest first ---- */
    ;WITH Submissions AS (
        SELECT
            CreatedDate,
            DENSE_RANK() OVER (ORDER BY CreatedDate) AS SubmissionNo
        FROM dbo.FinishGoodsQCInspectionDetail
        WHERE FinishGoodsQCInspectionMainID = @MainID
          AND ISNULL(IsDeletedTransaction, 0) = 0
        GROUP BY CreatedDate
    )
    SELECT
        d.*,
        s.SubmissionNo
    FROM dbo.FinishGoodsQCInspectionDetail d
    INNER JOIN Submissions s ON s.CreatedDate = d.CreatedDate
    WHERE d.FinishGoodsQCInspectionMainID = @MainID
      AND ISNULL(d.IsDeletedTransaction, 0) = 0
    ORDER BY s.SubmissionNo, d.FinishGoodsQCInspectionDetailID;

    /* ------------------------------------------ per-submission summary ---- */
    DECLARE @AqlCritical DECIMAL(18, 4),
            @AqlMajor    DECIMAL(18, 4),
            @AqlMinor    DECIMAL(18, 4);

    SELECT
        @AqlCritical = TRY_CAST(ReferenceAQLCritical AS DECIMAL(18, 4)),
        @AqlMajor    = TRY_CAST(ReferenceAQLMajor    AS DECIMAL(18, 4)),
        @AqlMinor    = TRY_CAST(ReferenceAQLMinor    AS DECIMAL(18, 4))
    FROM dbo.FinishGoodsQCInspectionMain
    WHERE FinishGoodsQCInspectionMainID = @MainID;

    /*
      The accept numbers on the main row are the snapshot from the LATEST
      submission. Judging an earlier submission against them is the closest
      reading available once the row has been replaced — the plan for a given
      lot size does not change between rework rounds unless the sampling plan
      itself was edited in between, which section 4.2 treats as an event worth
      keeping the snapshot for.
    */
    ;WITH PerSubmission AS (
        SELECT
            d.CreatedDate,
            DENSE_RANK() OVER (ORDER BY d.CreatedDate) AS SubmissionNo,
            SUM(ISNULL(d.Critical, 0)) AS FoundCritical,
            SUM(ISNULL(d.Major,    0)) AS FoundMajor,
            SUM(ISNULL(d.Minor,    0)) AS FoundMinor,
            MAX(ISNULL(TRY_CAST(d.SampleSize AS DECIMAL(18, 4)), 0)) AS SampleSize,
            MIN(d.CreatedBy) AS CreatedBy
        FROM dbo.FinishGoodsQCInspectionDetail d
        WHERE d.FinishGoodsQCInspectionMainID = @MainID
          AND ISNULL(d.IsDeletedTransaction, 0) = 0
        GROUP BY d.CreatedDate
    )
    SELECT
        ps.SubmissionNo,
        ps.CreatedDate,
        ps.SampleSize,
        ps.FoundCritical,
        ps.FoundMajor,
        ps.FoundMinor,
        ISNULL(um.UserName, '') AS Inspector,
        CASE
            WHEN @AqlCritical IS NULL AND @AqlMajor IS NULL AND @AqlMinor IS NULL
                THEN NULL                                   -- no plan snapshot to judge against
            WHEN ps.FoundCritical > ISNULL(@AqlCritical, 0)
              OR ps.FoundMajor    > ISNULL(@AqlMajor, ps.FoundMajor)
              OR ps.FoundMinor    > ISNULL(@AqlMinor, ps.FoundMinor)
                THEN CAST(0 AS BIT)
            ELSE CAST(1 AS BIT)
        END AS WouldPass
    FROM PerSubmission ps
    LEFT JOIN dbo.UserMaster um ON um.UserID = ps.CreatedBy
    ORDER BY ps.SubmissionNo;
END
GO
