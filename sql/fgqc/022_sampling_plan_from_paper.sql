/*
================================================================================
  FG QC — check FinishGoodsQCSamplingPlan against CDC's Carter's AQL Table
================================================================================
  Transcribed from the sheet on the wall at Panchla:

      Carter's AQL Table
      FRI: Single sampling plan for normal inspection level II
      AQL Level: Critical not allowed, Major 1.5, Minor 2.5

      Lot Size            Sample   Major 1.5 A/R   Minor 2.5 A/R
      0 To 150               20        0 / 1           1 / 2
      151 To 280             32        1 / 2           2 / 3
      281 To 500             50        2 / 3           3 / 4
      501 To 1200            80        3 / 4           5 / 6
      1201 To 3200          125        5 / 6           7 / 8
      3201 To 10000         200        7 / 8          10 / 11
      10001 To 35000        315       10 / 11         14 / 15
      35001 To 150000       500       14 / 15         21 / 22
      150001 To 500000      500       14 / 15         21 / 22

      Note: "Critical not allowed" means the maximum number of acceptable
      defectives for critical defects is "0".

  The ACCEPT number is stored — the left half of each pair. Reject is always
  accept + 1, which is how the application reads it: found <= accept passes,
  found >= accept + 1 rejects. Storing the reject number instead would accept
  one more defect per class than the table allows, silently.

  Two things worth knowing before running this:

  1. The first band starts at 0 and asks for a sample of 20. A lot smaller than
     20 therefore cannot satisfy its own plan. FGQC_MIN_LOT_QTY (default 50)
     keeps those out of the queue, and 50 is comfortably above 20 — but if
     anyone lowers that setting below 20, this table is why they should not.

  2. The last band stops at 500,000. A GPN above that matches nothing and comes
     back "No sampling plan matched" rather than guessing.

  ------------------------------------------------------------------ how to run

    1. Run as is. @Execute = 0, so it only REPORTS. Read the comparison.
    2. Set @Execute = 1 and run again to insert missing bands and correct rows
       that disagree with the paper.

  It never deletes. A band in the database that is not on the paper is reported
  as EXTRA and left alone — overlapping bands make plan selection
  non-deterministic, so deal with those deliberately, not as a side effect of
  a seed script. 001_schema_fixes.sql adds UX_FGQCSamplingPlan_Band to stop new
  overlaps appearing.
================================================================================
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

DECLARE @Execute   BIT    = 0;   -- 0 = report only.
DECLARE @CompanyID BIGINT = 2;
DECLARE @Method    VARCHAR(128) = 'Carter';

IF OBJECT_ID('dbo.FinishGoodsQCSamplingPlan') IS NULL
BEGIN
    RAISERROR('dbo.FinishGoodsQCSamplingPlan does not exist.', 16, 1);
    RETURN;
END

/* ------------------------------------------------------------ the paper --- */
IF OBJECT_ID('tempdb..#Paper') IS NOT NULL DROP TABLE #Paper;
CREATE TABLE #Paper (
    LotRangeFrom BIGINT,
    LotRangeTo   BIGINT,
    SampleSize   BIGINT,
    MajorAccept  BIGINT,
    MinorAccept  BIGINT
);

INSERT INTO #Paper (LotRangeFrom, LotRangeTo, SampleSize, MajorAccept, MinorAccept) VALUES
    (     0,    150,  20,  0,  1),
    (   151,    280,  32,  1,  2),
    (   281,    500,  50,  2,  3),
    (   501,   1200,  80,  3,  5),
    (  1201,   3200, 125,  5,  7),
    (  3201,  10000, 200,  7, 10),
    ( 10001,  35000, 315, 10, 14),
    ( 35001, 150000, 500, 14, 21),
    (150001, 500000, 500, 14, 21);

/* Critical is 0 on every band — "Critical not allowed". */

/* --------------------------------------------------------- what is there -- */
PRINT '=== Bands currently stored (CompanyID ' + CAST(@CompanyID AS VARCHAR(20)) + ') ===';
SELECT
    LotRangeFrom, LotRangeTo, SampleSize,
    CriticalAcceptance, MajorAcceptance, MinorAcceptance,
    SamplingMethodType, CategoryID
FROM dbo.FinishGoodsQCSamplingPlan
WHERE (CompanyID = @CompanyID OR CompanyID IS NULL)
ORDER BY LotRangeFrom;

PRINT '';
PRINT '=== Paper vs database ===';
SELECT
    ISNULL(p.LotRangeFrom, d.LotRangeFrom) AS LotRangeFrom,
    ISNULL(p.LotRangeTo,   d.LotRangeTo)   AS LotRangeTo,
    p.SampleSize   AS PaperSample,   d.SampleSize        AS DbSample,
    p.MajorAccept  AS PaperMajorAcc, d.MajorAcceptance   AS DbMajorAcc,
    p.MinorAccept  AS PaperMinorAcc, d.MinorAcceptance   AS DbMinorAcc,
    0              AS PaperCritAcc,  d.CriticalAcceptance AS DbCritAcc,
    CASE
        WHEN d.LotRangeFrom IS NULL THEN 'MISSING  — not in the database'
        WHEN p.LotRangeFrom IS NULL THEN 'EXTRA    — in the database, not on the paper'
        WHEN ISNULL(d.SampleSize,-1)         <> p.SampleSize
          OR ISNULL(d.MajorAcceptance,-1)    <> p.MajorAccept
          OR ISNULL(d.MinorAcceptance,-1)    <> p.MinorAccept
          OR ISNULL(d.CriticalAcceptance,-1) <> 0
            THEN 'DIFFERS  — stored numbers do not match the paper'
        ELSE 'OK'
    END AS Verdict
FROM #Paper p
FULL OUTER JOIN dbo.FinishGoodsQCSamplingPlan d
    ON  d.LotRangeFrom = p.LotRangeFrom
    AND d.LotRangeTo   = p.LotRangeTo
    AND (d.CompanyID = @CompanyID OR d.CompanyID IS NULL)
ORDER BY ISNULL(p.LotRangeFrom, d.LotRangeFrom);

IF @Execute = 0
BEGIN
    PRINT '';
    PRINT 'Nothing was changed. Read the comparison above, then set @Execute = 1';
    PRINT 'to insert the MISSING bands and correct the DIFFERS ones.';
    PRINT 'EXTRA bands are never touched — overlapping bands make plan selection';
    PRINT 'non-deterministic and are a decision, not a side effect.';
    RETURN;
END

/* -------------------------------------------------------------- correct --- */
BEGIN TRY
    BEGIN TRANSACTION;

    UPDATE d
       SET d.SampleSize          = p.SampleSize,
           d.CriticalAcceptance  = 0,
           d.MajorAcceptance     = p.MajorAccept,
           d.MinorAcceptance     = p.MinorAccept
    FROM dbo.FinishGoodsQCSamplingPlan d
    INNER JOIN #Paper p
        ON  p.LotRangeFrom = d.LotRangeFrom
        AND p.LotRangeTo   = d.LotRangeTo
    WHERE (d.CompanyID = @CompanyID OR d.CompanyID IS NULL)
      AND (   ISNULL(d.SampleSize,-1)         <> p.SampleSize
           OR ISNULL(d.MajorAcceptance,-1)    <> p.MajorAccept
           OR ISNULL(d.MinorAcceptance,-1)    <> p.MinorAccept
           OR ISNULL(d.CriticalAcceptance,-1) <> 0);

    PRINT 'Bands corrected: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    INSERT INTO dbo.FinishGoodsQCSamplingPlan
        (CompanyID, SamplingMethodType, LotRangeFrom, LotRangeTo, SampleSize,
         CriticalAcceptance, MajorAcceptance, MinorAcceptance)
    SELECT
        @CompanyID, @Method, p.LotRangeFrom, p.LotRangeTo, p.SampleSize,
        0, p.MajorAccept, p.MinorAccept
    FROM #Paper p
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.FinishGoodsQCSamplingPlan d
        WHERE d.LotRangeFrom = p.LotRangeFrom
          AND d.LotRangeTo   = p.LotRangeTo
          AND (d.CompanyID = @CompanyID OR d.CompanyID IS NULL)
    );

    PRINT 'Bands inserted: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    PRINT 'FAILED, rolled back: ' + ERROR_MESSAGE();
END CATCH

DROP TABLE #Paper;
GO

/* --------------------------------------------------------------- after ---- */
PRINT '';
PRINT 'Bands now stored:';
SELECT LotRangeFrom, LotRangeTo, SampleSize,
       CriticalAcceptance, MajorAcceptance, MinorAcceptance
FROM dbo.FinishGoodsQCSamplingPlan
ORDER BY LotRangeFrom;
GO
