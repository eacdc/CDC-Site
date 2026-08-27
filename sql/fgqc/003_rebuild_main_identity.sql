/*
================================================================================
  FG QC — make FinishGoodsQCInspectionMainID an IDENTITY column (spec 4.5.2)
================================================================================
  Confirmed on this database: sys.columns reports is_identity = 0.

  What that costs, both silently:

  1. SaveFinishGoodsQCInspection inserts the main row without naming the ID
     column and then reads SCOPE_IDENTITY(). With no identity in scope that
     returns NULL, so every detail row is written with
     FinishGoodsQCInspectionMainID = NULL — orphaned, with no error raised. The
     verdict is computed correctly and stored, but the counts behind it are
     unreachable: the dashboard reads them back as zero next to a Rejected
     status.

  2. The same NULL breaks re-submission. The procedure looks the lot up by
     (JobBookingID, FGTransactionID) and takes @MainID from the row it finds —
     also NULL — so it takes the "first submission" branch and INSERTS A SECOND
     MAIN ROW with a new FGQCNo instead of replacing the first. Spec section 4.1
     says one row per lot; without this fix that is not true.

  SQL Server cannot add IDENTITY to an existing column, so the table has to be
  rebuilt. This script generates the DDL from the live schema rather than
  assuming a column list.

  ------------------------------------------------------------------ how to run

    1. Run as is. @Execute = 0, so it only PRINTS the statements. Read them.
    2. Take a backup.
    3. Set @Execute = 1 and run again.
    4. Run 002_verify.sql — 4.5.2 should now report OK.
    5. Run 001_schema_fixes.sql to add UX_FGQCMain_Lot, which is what stops a
       double submit from creating two rows for one lot.

  Existing rows: their IDs are NULL and their detail rows cannot be re-linked,
  so there is nothing to preserve. The script refuses to run while the table has
  rows — clear it first (detail before main, they are test records). Doing this
  while the table is empty is the whole reason to do it now rather than later.
================================================================================
*/

SET NOCOUNT ON;
GO

DECLARE @Execute BIT = 0;   -- 0 = print only. Set to 1 once you have read the DDL.

DECLARE @tbl  SYSNAME = 'FinishGoodsQCInspectionMain';
DECLARE @idc  SYSNAME = 'FinishGoodsQCInspectionMainID';
DECLARE @full SYSNAME = 'dbo.' + @tbl;

/* ------------------------------------------------------------- guards ---- */
IF OBJECT_ID(@full) IS NULL
BEGIN
    RAISERROR('%s does not exist.', 16, 1, @full);
    RETURN;
END

IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID(@full) AND name = @idc AND is_identity = 1
)
BEGIN
    PRINT 'Nothing to do — ' + @idc + ' is already an IDENTITY column.';
    RETURN;
END

DECLARE @rows BIGINT;
DECLARE @cnt NVARCHAR(MAX) = N'SELECT @r = COUNT_BIG(1) FROM ' + @full + N';';
EXEC sp_executesql @cnt, N'@r BIGINT OUTPUT', @r = @rows OUTPUT;

IF @rows > 0
BEGIN
    PRINT 'STOP. ' + @full + ' holds ' + CAST(@rows AS VARCHAR(20)) + ' row(s).';
    PRINT 'Their IDs are NULL and their detail rows cannot be re-linked, so there is';
    PRINT 'nothing worth preserving. Clear both tables first (detail, then main):';
    PRINT '';
    PRINT '    DELETE FROM dbo.FinishGoodsQCInspectionDetail;';
    PRINT '    DELETE FROM dbo.FinishGoodsQCInspectionMain;';
    PRINT '';
    PRINT 'If any of those rows DO matter, stop and work out how to keep them before';
    PRINT 'deleting anything.';
    RETURN;
END

/* ------------------------------------------- foreign keys pointing here -- */
DECLARE @fkDrop NVARCHAR(MAX) = N'', @fkList NVARCHAR(MAX) = N'';

SELECT
    @fkDrop += N'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + N'.' + QUOTENAME(t.name)
             + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(13) + CHAR(10),
    @fkList += fk.name + N' (on ' + t.name + N'), '
FROM sys.foreign_keys fk
INNER JOIN sys.tables t ON t.object_id = fk.parent_object_id
WHERE fk.referenced_object_id = OBJECT_ID(@full);

IF @fkList <> N''
BEGIN
    PRINT 'NOTE. Foreign keys reference this table and must be dropped first:';
    PRINT '      ' + @fkList;
    PRINT '      Recreate them after the rebuild — this script does not put them back,';
    PRINT '      because the correct ON DELETE / ON UPDATE behaviour is yours to decide.';
    PRINT '';
END

/* --------------------------------------- column list from the live table -- */
DECLARE @cols NVARCHAR(MAX) = N'';

SELECT @cols = @cols + N'    ' + QUOTENAME(c.name) + N' '
    + CASE
        WHEN c.name = @idc THEN N'BIGINT IDENTITY(1,1) NOT NULL'
        ELSE UPPER(ty.name)
             + CASE
                 WHEN ty.name IN ('varchar','char','varbinary','binary')
                     THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX'
                                      ELSE CAST(c.max_length AS NVARCHAR(10)) END + N')'
                 WHEN ty.name IN ('nvarchar','nchar')
                     THEN N'(' + CASE WHEN c.max_length = -1 THEN N'MAX'
                                      ELSE CAST(c.max_length / 2 AS NVARCHAR(10)) END + N')'
                 WHEN ty.name IN ('decimal','numeric')
                     THEN N'(' + CAST(c.precision AS NVARCHAR(10)) + N','
                               + CAST(c.scale AS NVARCHAR(10)) + N')'
                 WHEN ty.name IN ('datetime2','time','datetimeoffset')
                     THEN N'(' + CAST(c.scale AS NVARCHAR(10)) + N')'
                 ELSE N''
               END
             + CASE WHEN c.is_nullable = 1 THEN N' NULL' ELSE N' NOT NULL' END
      END
    + N',' + CHAR(13) + CHAR(10)
FROM sys.columns c
INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID(@full)
  AND c.is_computed = 0
ORDER BY c.column_id;

IF @cols = N''
BEGIN
    RAISERROR('Could not read the column list.', 16, 1);
    RETURN;
END

/* ------------------------------------------------------------- the DDL --- */
DECLARE @ddl NVARCHAR(MAX) =
      CASE WHEN @fkDrop <> N'' THEN @fkDrop + CHAR(13) + CHAR(10) ELSE N'' END
    + N'CREATE TABLE dbo.' + QUOTENAME(@tbl + '_New') + N' (' + CHAR(13) + CHAR(10)
    + @cols
    + N'    CONSTRAINT ' + QUOTENAME('PK_' + @tbl) + N' PRIMARY KEY CLUSTERED (' + QUOTENAME(@idc) + N')'
    + CHAR(13) + CHAR(10) + N');' + CHAR(13) + CHAR(10) + CHAR(13) + CHAR(10)
    + N'DROP TABLE ' + @full + N';' + CHAR(13) + CHAR(10)
    + N'EXEC sp_rename ''dbo.' + @tbl + '_New'', ''' + @tbl + ''';' + CHAR(13) + CHAR(10);

PRINT '================ DDL ================';
PRINT @ddl;
PRINT '=====================================';

IF @Execute = 0
BEGIN
    PRINT '';
    PRINT 'Nothing was changed. Read the DDL above, take a backup, then set';
    PRINT '@Execute = 1 and run again.';
    RETURN;
END

/* ------------------------------------------------------------- execute --- */
BEGIN TRY
    BEGIN TRANSACTION;
    EXEC sp_executesql @ddl;
    COMMIT TRANSACTION;

    PRINT '';
    PRINT 'Rebuilt. ' + @idc + ' is now IDENTITY(1,1).';
    PRINT 'Next: run 001_schema_fixes.sql for UX_FGQCMain_Lot, then 002_verify.sql.';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    PRINT 'FAILED, rolled back: ' + ERROR_MESSAGE();
END CATCH
GO

/* -------------------------------------------------------------- verify --- */
SELECT name, is_identity
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.FinishGoodsQCInspectionMain')
  AND name = 'FinishGoodsQCInspectionMainID';
GO
