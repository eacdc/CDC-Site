/*
================================================================================
  FG QC — which saved verdicts change once the lot is sized from its GPN
================================================================================
  Read-only. It changes nothing; it tells you what is wrong.

  Until now the sampling plan was matched against the JOB quantity, so a GPN of
  100 pieces was judged against the band for 10,001-35,000: sample 315, Major
  accept 10, Minor accept 14. CDC's Carter table actually puts a lot of 100 in
  the first band: sample 20, Major accept 0, Minor accept 1.

  The error runs one way. The job is always at least as large as any one of its
  deliveries, so the band used was always at or above the right one, and a
  higher band always has a higher accept number. Every affected lot was
  therefore judged more leniently than the table allows — never more harshly.
  A lot that reads Accepted may not be one; a lot that reads Rejected is.

  Worked example from the current data:

      FGQC00030   lot 100, sample 315, Major 3 / accept 10   -> Accepted
      correct     lot 100, sample  20, Major 3 / accept  0   -> Rejected

  ---------------------------------------------------------------- what to do

  This reports. It does not re-verdict, because that is a decision about goods
  that have already shipped, not a data fix. Read the list, then decide per lot:
  re-inspect, accept on record with a note, or let it stand.

  Run 022_sampling_plan_from_paper.sql first so the bands are right, or this
  compares against a plan table that is itself wrong.
================================================================================
*/

SET NOCOUNT ON;
GO

DECLARE @CompanyID BIGINT = 2;

;WITH GpnQty AS (
    /*
      The lot is the GPN. outercarton x innercarton x quantityperpack is how
      GPNAgg in src/job-card-queries.js reads one, and now how the API does.
    */
    SELECT
        fgd.FGTransactionID,
        fgd.JobBookingID,
        SUM(
            ISNULL(fgd.outercarton, 0)
            * ISNULL(fgd.innercarton, 0)
            * ISNULL(fgd.quantityperpack, 0)
        ) AS GpnUnits
    FROM dbo.FinishGoodsTransactionDetail fgd
    WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
    GROUP BY fgd.FGTransactionID, fgd.JobBookingID
),
LatestDetail AS (
    /* Found counts come from the most recent submission only (spec section 3). */
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
Recheck AS (
    SELECT
        m.FGQCNo,
        fgm.VoucherNo                        AS GPNNo,
        jb.JobBookingNo,
        m.TotalBox                           AS StoredLotSize,
        q.GpnUnits                           AS CorrectLotSize,
        m.SampleSize                         AS StoredSample,
        plan.SampleSize                      AS CorrectSample,
        m.QCStatus                           AS StoredVerdict,
        ISNULL(ld.FoundCritical, 0)          AS FoundCritical,
        ISNULL(ld.FoundMajor,    0)          AS FoundMajor,
        ISNULL(ld.FoundMinor,    0)          AS FoundMinor,
        m.ReferenceAQLCritical               AS StoredAccCritical,
        m.ReferenceAQLMajor                  AS StoredAccMajor,
        m.ReferenceAQLMinor                  AS StoredAccMinor,
        ISNULL(plan.CriticalAcceptance, 0)   AS CorrectAccCritical,
        plan.MajorAcceptance                 AS CorrectAccMajor,
        plan.MinorAcceptance                 AS CorrectAccMinor
    FROM dbo.FinishGoodsQCInspectionMain m
    LEFT JOIN LatestDetail ld
           ON ld.FinishGoodsQCInspectionMainID = m.FinishGoodsQCInspectionMainID
    LEFT JOIN dbo.FinishGoodsTransactionMain fgm
           ON fgm.FGTransactionID = m.FGTransactionID
          AND ISNULL(fgm.IsDeletedTransaction, 0) = 0
    LEFT JOIN dbo.JobBookingJobCard jb
           ON jb.JobBookingID = m.JobBookingID
    LEFT JOIN GpnQty q
           ON  q.FGTransactionID = m.FGTransactionID
          AND (m.JobBookingID IS NULL OR q.JobBookingID = m.JobBookingID)
    OUTER APPLY (
        SELECT TOP 1 sp.SampleSize, sp.CriticalAcceptance, sp.MajorAcceptance, sp.MinorAcceptance
        FROM dbo.FinishGoodsQCSamplingPlan sp
        WHERE (sp.CompanyID = @CompanyID OR sp.CompanyID IS NULL)
          AND (sp.SamplingMethodType IS NULL OR sp.SamplingMethodType = 'Carter')
          AND q.GpnUnits >= sp.LotRangeFrom
          AND q.GpnUnits <= sp.LotRangeTo
        ORDER BY sp.LotRangeFrom
    ) AS plan
    WHERE ISNULL(m.IsDeletedTransaction, 0) = 0
)
SELECT
    FGQCNo, GPNNo, JobBookingNo,
    StoredLotSize, CorrectLotSize,
    StoredSample,  CorrectSample,
    FoundCritical, FoundMajor, FoundMinor,
    StoredAccMajor,  CorrectAccMajor,
    StoredAccMinor,  CorrectAccMinor,
    StoredVerdict,
    CASE
        WHEN CorrectLotSize IS NULL      THEN 'NO GPN QTY   — cannot resize this lot'
        WHEN CorrectSample  IS NULL      THEN 'NO BAND      — no sampling plan covers the corrected lot size'
        WHEN FoundCritical > ISNULL(CorrectAccCritical, 0)
          OR FoundMajor    > CorrectAccMajor
          OR FoundMinor    > CorrectAccMinor  THEN 'Rejected'
        ELSE 'Accepted'
    END AS CorrectVerdict,
    CASE
        WHEN CorrectLotSize IS NULL OR CorrectSample IS NULL THEN 'CHECK BY HAND'
        WHEN StoredVerdict = CASE
                WHEN FoundCritical > ISNULL(CorrectAccCritical, 0)
                  OR FoundMajor    > CorrectAccMajor
                  OR FoundMinor    > CorrectAccMinor THEN 'Rejected'
                ELSE 'Accepted' END                          THEN 'unchanged'
        ELSE '>>> VERDICT CHANGES <<<'
    END AS Change
FROM Recheck
ORDER BY
    CASE WHEN StoredVerdict = 'Accepted' THEN 0 ELSE 1 END,
    FGQCNo;
GO
