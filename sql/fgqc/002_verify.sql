/*
================================================================================
  FG QC — pre go-live verification (spec sections 4.3 and 4.5)
================================================================================
  Read-only. Run it before and after 001_schema_fixes.sql, and once more on the
  live database on the morning of go-live.

  Every check prints OK or ACTION. Do not go live with an ACTION outstanding —
  each one produces a silently wrong verdict rather than an error.
================================================================================
*/

SET NOCOUNT ON;
GO

PRINT '=== FG QC verification ===';
PRINT '';

/* ---------------------------------------------------------------- 4.5.2 --- */
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'FinishGoodsQCInspectionMainID' AND is_identity = 1
)
    PRINT 'OK      4.5.2  FinishGoodsQCInspectionMainID is IDENTITY';
ELSE
    PRINT 'ACTION  4.5.2  FinishGoodsQCInspectionMainID is NOT IDENTITY — SCOPE_IDENTITY() in SaveFinishGoodsQCInspection returns NULL and every detail row is orphaned with no error.';

/* ---------------------------------------------------------------- 4.5.1 --- */
IF COL_LENGTH('dbo.FinishGoodsQCInspectionMain', 'JobBookingID') IS NULL
    PRINT 'ACTION  4.5.1  FinishGoodsQCInspectionMain.JobBookingID is missing — a GPN spanning several jobs cannot be split into lots.';
ELSE
    PRINT 'OK      4.5.1  JobBookingID exists';

IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'UX_FGQCMain_Lot'
)
    PRINT 'OK      4.5.1  UX_FGQCMain_Lot exists — one row per lot is enforced';
ELSE
    PRINT 'ACTION  4.5.1  UX_FGQCMain_Lot is missing — a double submit creates two rows and the pending queue silently misreports.';

/* --------------------------------------------------------------- 4.5.3 ---- */
IF EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCSamplingPlan')
      AND name = 'UX_FGQCSamplingPlan_Band'
)
    PRINT 'OK      4.5.3  UX_FGQCSamplingPlan_Band exists — lot bands cannot overlap';
ELSE
    PRINT 'ACTION  4.5.3  UX_FGQCSamplingPlan_Band is missing — two rows can match the same lot size, making plan selection non-deterministic.';

/* --------------------------------------------------------------- 4.5.4 ---- */
DECLARE @narrow INT = (
    SELECT COUNT(1)
    FROM sys.columns c
    WHERE c.object_id IN (
            OBJECT_ID('dbo.FinishGoodsQCInspectionDetail'),
            OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
          )
      AND c.name IN ('Characterstics', 'Remark', 'PackingDescription')
      AND c.max_length <> -1
      AND c.max_length / 2 < 512
);
IF @narrow = 0
    PRINT 'OK      4.5.4  Characterstics / Remark / PackingDescription are wide enough';
ELSE
    PRINT 'ACTION  4.5.4  ' + CAST(@narrow AS VARCHAR(10)) + ' column(s) still narrower than nvarchar(512) — the save procedure truncates with LEFT() and loses data silently.';

/* --------------------------------------------------------------- 4.5.5 ---- */
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'SampleSize' AND system_type_id = 59       -- real
)
    PRINT 'ACTION  4.5.5  FinishGoodsQCInspectionMain.SampleSize is real (approximate) — 200 can compare as 199.99998 against the plan.';
ELSE
    PRINT 'OK      4.5.5  FinishGoodsQCInspectionMain.SampleSize is an exact type';

/* ------------------------------------------------------ stored procedures - */
DECLARE @sp TABLE (Name SYSNAME, Section VARCHAR(20));
INSERT INTO @sp VALUES
    ('GetFinishGoodsQCTemplate',   '4.3'),
    ('SaveFinishGoodsQCInspection','4.3'),
    ('GetPendingFGQCList',         '4.3'),
    ('GetFGQCInspectionList',      '6'),
    ('GetFGQCInspectionByID',      '4.4'),
    ('GetFGQCDashboardKPIs',       '4.4');

DECLARE @spName SYSNAME, @spSection VARCHAR(20);
DECLARE sp_cur CURSOR LOCAL FAST_FORWARD FOR SELECT Name, Section FROM @sp;
OPEN sp_cur;
FETCH NEXT FROM sp_cur INTO @spName, @spSection;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID('dbo.' + @spName, 'P') IS NOT NULL
        PRINT 'OK      ' + @spSection + '    ' + @spName + ' exists';
    ELSE
        PRINT 'ACTION  ' + @spSection + '    ' + @spName + ' is missing — the API falls back to inline SQL, which section 6 forbids.';
    FETCH NEXT FROM sp_cur INTO @spName, @spSection;
END
CLOSE sp_cur;
DEALLOCATE sp_cur;
GO

PRINT '';
PRINT '=== Data checks ===';
GO

/* Duplicate lots — must be empty before UX_FGQCMain_Lot can be created. */
PRINT 'Duplicate lots (JobBookingID, FGTransactionID):';
SELECT
    JobBookingID,
    FGTransactionID,
    COUNT(1) AS RowCountForLot,
    MIN(FGQCNo) AS KeepThisFGQCNo
FROM dbo.FinishGoodsQCInspectionMain
WHERE ISNULL(IsDeletedTransaction, 0) = 0
GROUP BY JobBookingID, FGTransactionID
HAVING COUNT(1) > 1
ORDER BY COUNT(1) DESC;
GO

/* QC rows that could not be attributed to a job — a human has to resolve these. */
PRINT 'QC rows with no JobBookingID (GPN spans several jobs):';
IF COL_LENGTH('dbo.FinishGoodsQCInspectionMain', 'JobBookingID') IS NOT NULL
    EXEC sp_executesql N'
        SELECT m.FinishGoodsQCInspectionMainID, m.FGQCNo, m.FGTransactionID
        FROM dbo.FinishGoodsQCInspectionMain m
        WHERE m.JobBookingID IS NULL
          AND ISNULL(m.IsDeletedTransaction, 0) = 0
        ORDER BY m.FinishGoodsQCInspectionMainID;';
GO

/* Overlapping sampling-plan bands — plan selection is non-deterministic here. */
PRINT 'Overlapping sampling plan bands:';
SELECT
    a.CompanyID,
    a.SamplingMethodType,
    a.CategoryID,
    a.LotRangeFrom AS RangeFromA, a.LotRangeTo AS RangeToA,
    b.LotRangeFrom AS RangeFromB, b.LotRangeTo AS RangeToB
FROM dbo.FinishGoodsQCSamplingPlan a
INNER JOIN dbo.FinishGoodsQCSamplingPlan b
        ON  ISNULL(a.CompanyID, -1)          = ISNULL(b.CompanyID, -1)
        AND ISNULL(a.SamplingMethodType, '') = ISNULL(b.SamplingMethodType, '')
        AND ISNULL(a.CategoryID, -1)         = ISNULL(b.CategoryID, -1)
        AND a.LotRangeFrom < b.LotRangeFrom
        AND a.LotRangeTo  >= b.LotRangeFrom
ORDER BY a.CompanyID, a.CategoryID, a.LotRangeFrom;
GO

/*
  Orphaned detail rows — the symptom of 4.5.2. If FinishGoodsQCInspectionMainID
  is not an identity, SCOPE_IDENTITY() returns NULL and detail rows land with no
  parent. No error is raised, so this query is the only way to see it.
*/
PRINT 'Orphaned detail rows (symptom of a non-identity main ID):';
SELECT COUNT(1) AS OrphanedDetailRows
FROM dbo.FinishGoodsQCInspectionDetail d
WHERE ISNULL(d.IsDeletedTransaction, 0) = 0
  AND (
        d.FinishGoodsQCInspectionMainID IS NULL
     OR NOT EXISTS (
            SELECT 1 FROM dbo.FinishGoodsQCInspectionMain m
            WHERE m.FinishGoodsQCInspectionMainID = d.FinishGoodsQCInspectionMainID
        )
  );
GO

/*
  Section 4.3 marks VoucherNo / VoucherDate / CompanyID / ProductionUnitID on
  FinishGoodsTransactionMain as [VERIFY] — assumed by GetPendingFGQCList but not
  proven. This confirms they exist and are populated.
*/
PRINT '[VERIFY] columns on FinishGoodsTransactionMain:';
SELECT
    c.name          AS ColumnName,
    t.name          AS DataType,
    c.is_nullable   AS IsNullable
FROM sys.columns c
INNER JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.FinishGoodsTransactionMain')
  AND c.name IN ('VoucherNo', 'VoucherDate', 'CompanyID', 'ProductionUnitID')
ORDER BY c.name;

SELECT
    COUNT(1)                                                   AS TotalGpnRows,
    SUM(CASE WHEN VoucherNo   IS NULL THEN 1 ELSE 0 END)       AS NullVoucherNo,
    SUM(CASE WHEN VoucherDate IS NULL THEN 1 ELSE 0 END)       AS NullVoucherDate
FROM dbo.FinishGoodsTransactionMain
WHERE ISNULL(IsDeletedTransaction, 0) = 0;
GO

/*
  Section 5 question 1 — how severity is stored on the parameter master.

  This is the check that matters most. GetFinishGoodsQCTemplate reads
  MasterFieldType and falls back to whichever of CriticalCriteria /
  MajorCriteria / MinorCriteria is populated. If that is wrong, defects appear
  in the wrong section of the form and are counted in the wrong class — a
  Critical defect counted as Minor turns a rejected lot into an accepted one.

  Read the distribution below and confirm which column is authoritative before
  go-live. Any row landing in UnresolvedSeverity is a row the application will
  refuse to count, by design.
*/
PRINT 'Severity distribution on FinishGoodsQCParameterSetting:';
SELECT
    MasterFieldType,
    COUNT(1) AS RowsFound
FROM dbo.FinishGoodsQCParameterSetting
GROUP BY MasterFieldType
ORDER BY COUNT(1) DESC;
GO

PRINT '';
PRINT '=== End of verification ===';
GO
