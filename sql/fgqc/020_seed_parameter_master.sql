/*
================================================================================
  FG QC — seed the defect characteristics (spec section 4.2)
================================================================================
  FinishGoodsQCParameterSetting is the master list of defect characteristics.
  Each row is one line on the inspection sheet, so an empty table means the QC
  form has nothing to render — the inspector opens a lot and sees no grid.

  The 24 characteristics below are transcribed from CDC's paper form,
  "FINISHED GOODS INSPECTION REPORT", in the order they appear on it:

      Critical  8 lines
      Major    10 lines
      Minor     6 lines

  NOT SEEDED, DELIBERATELY: the paper form prints "ACCEPTABLE LIMIT 0.1%",
  "1.00%" and "4%" against the three sections. Spec section 3 is explicit that
  those are a different standard and are not used — the accept numbers come
  from Carter's AQL table in FinishGoodsQCSamplingPlan, by lot size, in inner
  cartons. Do not add percentage thresholds anywhere.

  ---------------------------------------------------------------- how to run

  1. Set @CompanyID and @CategoryID below.
  2. Run it. It prints what it would do and inserts only what is missing, so it
     is safe to run twice.
  3. Reopen a lot in the app. The grid should show Critical, Major and Minor
     sections with these lines.

  @CategoryID is NULL by default, meaning "applies to every product category".
  If the form still comes back empty after seeding, GetFinishGoodsQCTemplate
  filters on an exact CategoryID match rather than treating NULL as a wildcard.
  In that case re-run this script once per category, setting @CategoryID each
  time. The category list is printed at the end to make that easy.
================================================================================
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

DECLARE @CompanyID  BIGINT = 2;     -- the company the FG QC data lives under
DECLARE @CategoryID BIGINT = NULL;  -- NULL = all categories; see the header

/* ------------------------------------------------------- the paper form -- */
/*
 * A temp table rather than a table variable: the INSERT is built dynamically
 * from whichever columns the target table actually has, and #Seed is visible
 * inside sp_executesql without needing a user-defined table type.
 */
IF OBJECT_ID('tempdb..#Seed') IS NOT NULL DROP TABLE #Seed;
CREATE TABLE #Seed (
    SortOrder      INT,
    Severity       NVARCHAR(20),
    Characterstics NVARCHAR(512)
);

INSERT INTO #Seed (SortOrder, Severity, Characterstics) VALUES
    -- CRITICAL CHECK POINT
    ( 1, 'Critical', 'TEXT PRINT MISSING'),
    ( 2, 'Critical', 'WASTE PRINTING'),
    ( 3, 'Critical', 'OUT PUNCH'),
    ( 4, 'Critical', 'W/O FOIL'),
    ( 5, 'Critical', 'CARTON OPEN/LOCK BOTTOM'),
    ( 6, 'Critical', 'OUTSIDE STICKING'),
    ( 7, 'Critical', 'FLUTE DELAMINATION/FILM'),
    ( 8, 'Critical', 'WITHOUT LAMINATION/COATING'),
    -- MAJOR CHECK POINT
    ( 9, 'Major',    'SHADE VARIATION'),
    (10, 'Major',    'REGISTRATION OUT'),
    (11, 'Major',    'CRACKING/CREBDE'),
    (12, 'Major',    'ROUGH CUT'),
    (13, 'Major',    'DAMAGE CARTON'),
    (14, 'Major',    'FOIL OUT/BROKEN'),
    (15, 'Major',    'WRINKELS'),
    (16, 'Major',    'CROSS PASTING'),
    (17, 'Major',    'LAMINATION/SPOT UV'),
    (18, 'Major',    'WINDOW PASTING'),
    -- MINOR CHECK POINT
    (19, 'Minor',    'UN WANTED SPOT/MARK'),
    (20, 'Minor',    'LAMINATION DEFECT'),
    (21, 'Minor',    'VARISH DEFECT'),
    (22, 'Minor',    'SCRATCH MARK'),
    (23, 'Minor',    'SPOT UV'),
    (24, 'Minor',    'OTHERS');

/*
  The table's exact column list is not the same on every install, so the
  INSERT is built from the columns that actually exist. Anything required that
  this script does not know how to fill is reported rather than guessed at.
*/
DECLARE @tbl SYSNAME = 'dbo.FinishGoodsQCParameterSetting';

IF OBJECT_ID(@tbl) IS NULL
BEGIN
    RAISERROR('dbo.FinishGoodsQCParameterSetting does not exist.', 16, 1);
    RETURN;
END

DECLARE @charCol SYSNAME = NULL;
SELECT @charCol = c.name
  FROM sys.columns c
 WHERE c.object_id = OBJECT_ID(@tbl)
   AND c.name IN ('Characterstics', 'Characteristics');

IF @charCol IS NULL
BEGIN
    RAISERROR('No Characterstics column found — check the table definition.', 16, 1);
    RETURN;
END

/* Required columns with no default that we have no value for. */
DECLARE @unfillable NVARCHAR(MAX) = NULL;

SELECT @unfillable = STUFF((
    SELECT ', ' + c.name
      FROM sys.columns c
     WHERE c.object_id = OBJECT_ID(@tbl)
       AND c.is_nullable = 0
       AND c.is_identity = 0
       AND c.is_computed = 0
       AND c.default_object_id = 0
       AND c.name NOT IN (
            @charCol, 'CategoryID', 'CompanyID', 'MasterFieldType',
            'CriticalCriteria', 'MajorCriteria', 'MinorCriteria',
            'IsDeletedTransaction', 'SortOrder', 'DisplayOrder', 'SrNo',
            'CreatedBy', 'CreatedDate', 'ModifiedBy', 'ModifiedDate',
            'FGQCParameterSettingID', 'FinishGoodsQCParameterSettingID'
       )
     FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '');

IF @unfillable IS NOT NULL
BEGIN
    PRINT 'STOP. These columns are NOT NULL with no default and this script has';
    PRINT 'no value for them: ' + @unfillable;
    PRINT 'Add them to the INSERT below, or give them defaults, then re-run.';
    RETURN;
END

/* ------------------------------------------------ build the column list -- */
DECLARE @cols NVARCHAR(MAX) = QUOTENAME(@charCol);
DECLARE @vals NVARCHAR(MAX) = 's.Characterstics';

DECLARE @has TABLE (Name SYSNAME);
INSERT INTO @has (Name)
SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(@tbl);

IF EXISTS (SELECT 1 FROM @has WHERE Name = 'CategoryID')
    SELECT @cols += ', CategoryID',      @vals += ', @CategoryID';
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'CompanyID')
    SELECT @cols += ', CompanyID',       @vals += ', @CompanyID';

/*
  Severity is written twice, on purpose.

  Spec section 5 question 1 is still open: GetFinishGoodsQCTemplate reads
  MasterFieldType and falls back to whichever of CriticalCriteria /
  MajorCriteria / MinorCriteria is populated, and nobody has confirmed which is
  authoritative. Writing both makes the two paths agree, so the answer to that
  question cannot change how these rows are classified. The application refuses
  to count a characteristic whose severity does not resolve, so a row seeded
  only one way would be a row the inspector cannot use.
*/
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'MasterFieldType')
    SELECT @cols += ', MasterFieldType', @vals += ', s.Severity';
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'CriticalCriteria')
    SELECT @cols += ', CriticalCriteria',
           @vals += ', CASE WHEN s.Severity = ''Critical'' THEN s.Characterstics END';
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'MajorCriteria')
    SELECT @cols += ', MajorCriteria',
           @vals += ', CASE WHEN s.Severity = ''Major'' THEN s.Characterstics END';
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'MinorCriteria')
    SELECT @cols += ', MinorCriteria',
           @vals += ', CASE WHEN s.Severity = ''Minor'' THEN s.Characterstics END';

IF EXISTS (SELECT 1 FROM @has WHERE Name = 'IsDeletedTransaction')
    SELECT @cols += ', IsDeletedTransaction', @vals += ', 0';
IF EXISTS (SELECT 1 FROM @has WHERE Name = 'SortOrder')
    SELECT @cols += ', SortOrder',   @vals += ', s.SortOrder';
ELSE IF EXISTS (SELECT 1 FROM @has WHERE Name = 'DisplayOrder')
    SELECT @cols += ', DisplayOrder', @vals += ', s.SortOrder';
ELSE IF EXISTS (SELECT 1 FROM @has WHERE Name = 'SrNo')
    SELECT @cols += ', SrNo',        @vals += ', s.SortOrder';

IF EXISTS (SELECT 1 FROM @has WHERE Name = 'CreatedDate')
    SELECT @cols += ', CreatedDate', @vals += ', GETDATE()';

/* --------------------------------------------------------------- insert -- */
DECLARE @sqlText NVARCHAR(MAX) =
    N'INSERT INTO ' + @tbl + N' (' + @cols + N')
      SELECT ' + @vals + N'
        FROM #Seed s
       WHERE NOT EXISTS (
             SELECT 1 FROM ' + @tbl + N' p
              WHERE p.' + QUOTENAME(@charCol) + N' = s.Characterstics
                AND ISNULL(p.CompanyID, -1) = ISNULL(@CompanyID, -1)
                AND ISNULL(p.CategoryID, -1) = ISNULL(@CategoryID, -1)
       )
       ORDER BY s.SortOrder;';

PRINT 'Inserting into ' + @tbl;
PRINT 'Columns: ' + @cols;

EXEC sp_executesql
     @sqlText,
     N'@CompanyID BIGINT, @CategoryID BIGINT',
     @CompanyID = @CompanyID, @CategoryID = @CategoryID;

DECLARE @inserted INT = @@ROWCOUNT;
PRINT 'Rows inserted: ' + CAST(@inserted AS VARCHAR(10)) + ' (of 24)';

DROP TABLE #Seed;
GO

/* ------------------------------------------------------------- verify ---- */
PRINT '';
PRINT 'Characteristics now on the master, by severity:';
SELECT
    MasterFieldType AS Severity,
    COUNT(1)        AS Lines
FROM dbo.FinishGoodsQCParameterSetting
WHERE ISNULL(IsDeletedTransaction, 0) = 0
GROUP BY MasterFieldType
ORDER BY CASE MasterFieldType
             WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2 WHEN 'Minor' THEN 3 ELSE 4
         END;
GO

PRINT '';
PRINT 'Categories, in case the template needs seeding per category:';
SELECT CategoryID, CategoryName FROM dbo.CategoryMaster ORDER BY CategoryName;
GO
