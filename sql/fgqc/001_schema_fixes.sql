/*
================================================================================
  FG QC — schema fixes (spec section 4.5)
================================================================================
  Each item below produces silent wrong behaviour rather than an error, which is
  why they are listed as go-live blockers in the spec.

  The script is idempotent: run it as many times as you like. Every step checks
  the current state first and prints what it did.

  Run order:
      1. Run with @ApplyTypeChanges = 0 (default) on a restored copy of the
         database. Read the PRINT output.
      2. Run 002_verify.sql and confirm every check reports OK.
      3. Only then run against the live database.

  The type changes in section 4.5 item 5 are off by default, because they
  rewrite column types on tables that already hold rows. Turn them on
  deliberately by setting @ApplyTypeChanges = 1 in that section, after the dry
  run has shown that every existing value converts cleanly.
================================================================================
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

/*
--------------------------------------------------------------------------------
  4.5.1  FinishGoodsQCInspectionMain needs JobBookingID and a unique lot index
--------------------------------------------------------------------------------
  A GPN can span several jobs, so FGTransactionID alone cannot identify a lot.
  The unique index is what makes "one row per lot" actually true rather than
  merely intended — without it a double submit creates two rows and the pending
  queue silently misreports.
*/

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'JobBookingID'
)
BEGIN
    ALTER TABLE dbo.FinishGoodsQCInspectionMain ADD JobBookingID BIGINT NULL;
    PRINT '4.5.1  ADDED   dbo.FinishGoodsQCInspectionMain.JobBookingID';
END
ELSE
    PRINT '4.5.1  SKIP    JobBookingID already exists';
GO

/*
  Backfill JobBookingID for rows saved before the column existed.

  Only rows whose GPN carries exactly one job can be resolved automatically —
  for those the lot key is unambiguous. A GPN that spans several jobs cannot be
  attributed after the fact, so those rows are left NULL and reported by
  002_verify.sql for a human to resolve. Guessing here would assign a verdict to
  the wrong job.
*/

IF COL_LENGTH('dbo.FinishGoodsQCInspectionMain', 'JobBookingID') IS NOT NULL
BEGIN
    ;WITH SingleJobGpn AS (
        SELECT
            fgd.FGTransactionID,
            MIN(fgd.JobBookingID)   AS JobBookingID,
            COUNT(DISTINCT fgd.JobBookingID) AS JobCount
        FROM dbo.FinishGoodsTransactionDetail fgd
        WHERE ISNULL(fgd.IsDeletedTransaction, 0) = 0
        GROUP BY fgd.FGTransactionID
    )
    UPDATE m
       SET m.JobBookingID = s.JobBookingID
      FROM dbo.FinishGoodsQCInspectionMain m
      INNER JOIN SingleJobGpn s
              ON s.FGTransactionID = m.FGTransactionID
             AND s.JobCount = 1
     WHERE m.JobBookingID IS NULL
       AND ISNULL(m.IsDeletedTransaction, 0) = 0;

    PRINT '4.5.1  BACKFILL JobBookingID rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(20));
END
GO

/*
  The unique lot index. Filtered so that soft-deleted rows do not collide.

  Creating it fails loudly if duplicate lots already exist — that is the point.
  002_verify.sql lists the duplicates so they can be merged before this runs.
*/

IF COL_LENGTH('dbo.FinishGoodsQCInspectionMain', 'JobBookingID') IS NOT NULL
   AND NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
          AND name = 'UX_FGQCMain_Lot'
   )
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dbo.FinishGoodsQCInspectionMain
        WHERE ISNULL(IsDeletedTransaction, 0) = 0
        GROUP BY JobBookingID, FGTransactionID
        HAVING COUNT(1) > 1
    )
        PRINT '4.5.1  BLOCKED UX_FGQCMain_Lot — duplicate lots exist. Run 002_verify.sql, merge them, then re-run.';
    ELSE
    BEGIN
        CREATE UNIQUE INDEX UX_FGQCMain_Lot
            ON dbo.FinishGoodsQCInspectionMain (JobBookingID, FGTransactionID)
            WHERE ISNULL(IsDeletedTransaction, 0) = 0;
        PRINT '4.5.1  CREATED UX_FGQCMain_Lot';
    END
END
ELSE
    PRINT '4.5.1  SKIP    UX_FGQCMain_Lot already exists (or JobBookingID missing)';
GO

/*
--------------------------------------------------------------------------------
  4.5.2  FinishGoodsQCInspectionMainID must be an IDENTITY column
--------------------------------------------------------------------------------
  SaveFinishGoodsQCInspection links detail rows with SCOPE_IDENTITY(). If the
  column is not an identity, @MainID comes back NULL and every detail row is
  orphaned with no error raised.

  This cannot be fixed with ALTER COLUMN — SQL Server has no syntax for adding
  IDENTITY to an existing column. It needs a table rebuild, which is a scheduled
  maintenance job, not something a migration script should do unattended while
  the application is running. So this step reports and stops.

  Remediation (run in a maintenance window, with a backup taken first):
      1. CREATE TABLE dbo.FinishGoodsQCInspectionMain_New with an identical
         column list, but FinishGoodsQCInspectionMainID BIGINT IDENTITY(1,1).
      2. SET IDENTITY_INSERT dbo.FinishGoodsQCInspectionMain_New ON;
         INSERT ... SELECT every existing row, preserving the existing IDs.
         SET IDENTITY_INSERT ... OFF;
      3. DBCC CHECKIDENT('dbo.FinishGoodsQCInspectionMain_New', RESEED);
      4. Drop the foreign keys and indexes on the old table, rename old -> _Old
         and _New -> FinishGoodsQCInspectionMain, then recreate the indexes
         (including UX_FGQCMain_Lot above) and the detail foreign key.
      5. Re-run 002_verify.sql.
*/

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'FinishGoodsQCInspectionMainID'
      AND is_identity = 1
)
    PRINT '4.5.2  OK      FinishGoodsQCInspectionMainID is an IDENTITY column';
ELSE
    PRINT '4.5.2  ACTION  FinishGoodsQCInspectionMainID is NOT an identity. Detail rows will be orphaned. See the remediation steps in this file before go-live.';
GO

/*
--------------------------------------------------------------------------------
  4.5.3  FGQCSamplingPlanID backfill + unique band index
--------------------------------------------------------------------------------
  Two rows matching the same lot size makes plan selection non-deterministic —
  the same lot can then draw a different sample size on two different days.
*/

IF COL_LENGTH('dbo.FinishGoodsQCSamplingPlan', 'FGQCSamplingPlanID') IS NOT NULL
BEGIN
    IF EXISTS (SELECT 1 FROM dbo.FinishGoodsQCSamplingPlan WHERE FGQCSamplingPlanID IS NULL)
    BEGIN
        DECLARE @NextPlanID BIGINT =
            ISNULL((SELECT MAX(FGQCSamplingPlanID) FROM dbo.FinishGoodsQCSamplingPlan), 0);

        ;WITH Unnumbered AS (
            SELECT
                FGQCSamplingPlanID,
                ROW_NUMBER() OVER (
                    ORDER BY CompanyID, SamplingMethodType, CategoryID, LotRangeFrom
                ) AS rn
            FROM dbo.FinishGoodsQCSamplingPlan
            WHERE FGQCSamplingPlanID IS NULL
        )
        UPDATE Unnumbered
           SET FGQCSamplingPlanID = @NextPlanID + rn;

        PRINT '4.5.3  BACKFILL FGQCSamplingPlanID rows numbered: ' + CAST(@@ROWCOUNT AS VARCHAR(20));
    END
    ELSE
        PRINT '4.5.3  SKIP    FGQCSamplingPlanID already populated on every row';
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCSamplingPlan')
      AND name = 'UX_FGQCSamplingPlan_Band'
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dbo.FinishGoodsQCSamplingPlan
        GROUP BY CompanyID, SamplingMethodType, CategoryID, LotRangeFrom
        HAVING COUNT(1) > 1
    )
        PRINT '4.5.3  BLOCKED UX_FGQCSamplingPlan_Band — overlapping bands already exist. Run 002_verify.sql and remove the duplicates first.';
    ELSE
    BEGIN
        CREATE UNIQUE INDEX UX_FGQCSamplingPlan_Band
            ON dbo.FinishGoodsQCSamplingPlan (CompanyID, SamplingMethodType, CategoryID, LotRangeFrom);
        PRINT '4.5.3  CREATED UX_FGQCSamplingPlan_Band';
    END
END
ELSE
    PRINT '4.5.3  SKIP    UX_FGQCSamplingPlan_Band already exists';
GO

/*
--------------------------------------------------------------------------------
  4.5.4  Column widths truncate
--------------------------------------------------------------------------------
  Characterstics is nvarchar(64) on the detail table while the master is
  nvarchar(512). Remark is nvarchar(64) in both main and detail — too short for
  a rejection reason. The save procedure guards with LEFT() so nothing fails,
  but data is lost silently.

  Widening an nvarchar column is a metadata-only operation. It cannot lose data.
  Once this has run, the LEFT() guards inside SaveFinishGoodsQCInspection should
  be removed so that full text is stored.
*/

DECLARE @widen TABLE (
    TableName  SYSNAME,
    ColumnName SYSNAME,
    TargetLen  INT
);

INSERT INTO @widen (TableName, ColumnName, TargetLen)
VALUES
    ('FinishGoodsQCInspectionDetail', 'Characterstics', 512),
    ('FinishGoodsQCInspectionDetail', 'Remark',         512),
    ('FinishGoodsQCInspectionMain',   'Remark',         512),
    ('FinishGoodsQCInspectionMain',   'PackingDescription', 512);

DECLARE @tbl SYSNAME, @col SYSNAME, @len INT, @curLen INT, @sqlText NVARCHAR(MAX);

DECLARE widen_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT TableName, ColumnName, TargetLen FROM @widen;

OPEN widen_cur;
FETCH NEXT FROM widen_cur INTO @tbl, @col, @len;

WHILE @@FETCH_STATUS = 0
BEGIN
    SELECT @curLen = c.max_length / 2          -- nvarchar: bytes -> characters
      FROM sys.columns c
     WHERE c.object_id = OBJECT_ID('dbo.' + @tbl)
       AND c.name = @col;

    IF @curLen IS NULL
        PRINT '4.5.4  SKIP    dbo.' + @tbl + '.' + @col + ' does not exist';
    ELSE IF @curLen = -1 OR @curLen >= @len
        PRINT '4.5.4  SKIP    dbo.' + @tbl + '.' + @col + ' is already wide enough';
    ELSE
    BEGIN
        SET @sqlText = 'ALTER TABLE dbo.' + QUOTENAME(@tbl)
                     + ' ALTER COLUMN ' + QUOTENAME(@col)
                     + ' NVARCHAR(' + CAST(@len AS VARCHAR(10)) + ') NULL;';
        EXEC sp_executesql @sqlText;
        PRINT '4.5.4  WIDENED dbo.' + @tbl + '.' + @col
            + ' from nvarchar(' + CAST(@curLen AS VARCHAR(10)) + ') to nvarchar('
            + CAST(@len AS VARCHAR(10)) + ')';
    END

    FETCH NEXT FROM widen_cur INTO @tbl, @col, @len;
END

CLOSE widen_cur;
DEALLOCATE widen_cur;
GO

/*
--------------------------------------------------------------------------------
  4.5.5  Type mismatches  (guarded by @ApplyTypeChanges)
--------------------------------------------------------------------------------
  SampleSize is nvarchar(128) in the plan, real in main, nvarchar(250) in
  detail. Sample size is a count of inner cartons, so DECIMAL(18,4) is the
  target: exact, sortable, and comparable across the three tables. real is the
  worst of the three — it is approximate, so 200 can compare as 199.99998.

  IsDeletedTransaction is bigint in the transaction tables and bit in the
  settings tables. Every query in the application already writes
  ISNULL(IsDeletedTransaction, 0) = 0, which works against both, so this one is
  reported rather than changed — normalising it touches far more tables than
  the FG QC module owns.

  This section only runs with @ApplyTypeChanges = 1, and only after checking
  that every existing value converts cleanly.
*/

DECLARE @ApplyTypeChanges BIT = 0;   -- set to 1 to apply, see file header

IF @ApplyTypeChanges = 0
    PRINT '4.5.5  DRYRUN  Type changes not applied. Set @ApplyTypeChanges = 1 to apply.';

DECLARE @badPlan INT = 0, @badDetail INT = 0;

IF COL_LENGTH('dbo.FinishGoodsQCSamplingPlan', 'SampleSize') IS NOT NULL
   AND EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCSamplingPlan')
          AND name = 'SampleSize' AND system_type_id IN (231, 167)   -- nvarchar / varchar
   )
BEGIN
    SELECT @badPlan = COUNT(1)
      FROM dbo.FinishGoodsQCSamplingPlan
     WHERE SampleSize IS NOT NULL
       AND LTRIM(RTRIM(SampleSize)) <> ''
       AND TRY_CAST(SampleSize AS DECIMAL(18, 4)) IS NULL;

    PRINT '4.5.5  CHECK   FinishGoodsQCSamplingPlan.SampleSize non-numeric rows: '
        + CAST(@badPlan AS VARCHAR(20));

    IF @ApplyTypeChanges = 1 AND @badPlan = 0
    BEGIN
        ALTER TABLE dbo.FinishGoodsQCSamplingPlan
            ALTER COLUMN SampleSize DECIMAL(18, 4) NULL;
        PRINT '4.5.5  ALTERED FinishGoodsQCSamplingPlan.SampleSize -> decimal(18,4)';
    END
END

IF COL_LENGTH('dbo.FinishGoodsQCInspectionDetail', 'SampleSize') IS NOT NULL
   AND EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionDetail')
          AND name = 'SampleSize' AND system_type_id IN (231, 167)
   )
BEGIN
    SELECT @badDetail = COUNT(1)
      FROM dbo.FinishGoodsQCInspectionDetail
     WHERE SampleSize IS NOT NULL
       AND LTRIM(RTRIM(SampleSize)) <> ''
       AND TRY_CAST(SampleSize AS DECIMAL(18, 4)) IS NULL;

    PRINT '4.5.5  CHECK   FinishGoodsQCInspectionDetail.SampleSize non-numeric rows: '
        + CAST(@badDetail AS VARCHAR(20));

    IF @ApplyTypeChanges = 1 AND @badDetail = 0
    BEGIN
        ALTER TABLE dbo.FinishGoodsQCInspectionDetail
            ALTER COLUMN SampleSize DECIMAL(18, 4) NULL;
        PRINT '4.5.5  ALTERED FinishGoodsQCInspectionDetail.SampleSize -> decimal(18,4)';
    END
END

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
      AND name = 'SampleSize' AND system_type_id = 59      -- real
)
BEGIN
    PRINT '4.5.5  CHECK   FinishGoodsQCInspectionMain.SampleSize is real (approximate) — should be decimal(18,4)';

    IF @ApplyTypeChanges = 1
    BEGIN
        ALTER TABLE dbo.FinishGoodsQCInspectionMain
            ALTER COLUMN SampleSize DECIMAL(18, 4) NULL;
        PRINT '4.5.5  ALTERED FinishGoodsQCInspectionMain.SampleSize -> decimal(18,4)';
    END
END

PRINT '4.5.5  NOTE    IsDeletedTransaction (bigint vs bit) left as is — every FG QC query uses ISNULL(IsDeletedTransaction, 0) = 0, which is correct against both. Normalising it is a database-wide change outside this module.';
GO

PRINT '';
PRINT 'FG QC schema fixes complete. Run 002_verify.sql next.';
GO
