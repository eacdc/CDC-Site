/*
================================================================================
  FG QC — fan the inspection sheet out to every product category
================================================================================
  Run this ONLY if 020_seed_parameter_master.sql has run and the QC form still
  shows no grid.

  020 seeds the 24 characteristics once, with CategoryID NULL, on the reading
  that NULL means "applies to every category" — the convention spec section 4.2
  records for the sampling plan. If GetFinishGoodsQCTemplate instead matches
  CategoryID exactly, those NULL rows never match a real category and the form
  stays empty.

  This script copies the characteristics to every category in CategoryMaster,
  so the exact-match path finds them. It skips any category that already has
  them, so it is safe to run after 020 and safe to run twice.

  Check first, so you know which problem you are solving:

      SELECT TOP 3 CategoryID, CompanyID, MasterFieldType, Characterstics
      FROM dbo.FinishGoodsQCParameterSetting;

      EXEC dbo.GetFinishGoodsQCTemplate
           @CategoryID = <the lot's category>, @LotSize = 1,
           @SamplingMethodType = 'Carter', @CompanyID = 2, @IncludeDeleted = 0;

  If the second returns items, the sheet is fine and the problem is elsewhere —
  do not run this.

  It writes 24 rows per category. With a large CategoryMaster that is a lot of
  rows for what is one list; if the exact-match reading turns out to be right,
  the tidier long-term fix is to teach GetFinishGoodsQCTemplate to accept
  CategoryID IS NULL as a wildcard, and delete these rows again.
================================================================================
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

DECLARE @CompanyID BIGINT = 2;

/* The rows 020 already wrote — reused verbatim so the two scripts cannot drift. */
IF NOT EXISTS (
    SELECT 1 FROM dbo.FinishGoodsQCParameterSetting
     WHERE ISNULL(CompanyID, -1) = ISNULL(@CompanyID, -1)
)
BEGIN
    PRINT 'STOP. No characteristics exist for this company yet. Run 020_seed_parameter_master.sql first.';
    RETURN;
END

DECLARE @copied INT = 0;

;WITH Template AS (
    /* One copy of each characteristic, whichever category it currently sits under. */
    SELECT
        Characterstics,
        MAX(MasterFieldType) AS MasterFieldType
    FROM dbo.FinishGoodsQCParameterSetting
    WHERE ISNULL(CompanyID, -1) = ISNULL(@CompanyID, -1)
      AND ISNULL(IsDeletedTransaction, 0) = 0
    GROUP BY Characterstics
)
INSERT INTO dbo.FinishGoodsQCParameterSetting
    (Characterstics, CategoryID, CompanyID, MasterFieldType,
     CriticalCriteria, MajorCriteria, MinorCriteria, IsDeletedTransaction)
SELECT
    t.Characterstics,
    c.CategoryID,
    @CompanyID,
    t.MasterFieldType,
    CASE WHEN t.MasterFieldType = 'Critical' THEN t.Characterstics END,
    CASE WHEN t.MasterFieldType = 'Major'    THEN t.Characterstics END,
    CASE WHEN t.MasterFieldType = 'Minor'    THEN t.Characterstics END,
    0
FROM Template t
CROSS JOIN dbo.CategoryMaster c
WHERE NOT EXISTS (
    SELECT 1
    FROM dbo.FinishGoodsQCParameterSetting p
    WHERE p.Characterstics = t.Characterstics
      AND p.CategoryID = c.CategoryID
      AND ISNULL(p.CompanyID, -1) = ISNULL(@CompanyID, -1)
);

SET @copied = @@ROWCOUNT;
PRINT 'Rows copied to categories: ' + CAST(@copied AS VARCHAR(10));
GO

PRINT '';
PRINT 'Characteristics per category (should be 24 each):';
SELECT
    p.CategoryID,
    c.CategoryName,
    COUNT(1) AS Lines
FROM dbo.FinishGoodsQCParameterSetting p
LEFT JOIN dbo.CategoryMaster c ON c.CategoryID = p.CategoryID
WHERE ISNULL(p.IsDeletedTransaction, 0) = 0
GROUP BY p.CategoryID, c.CategoryName
ORDER BY c.CategoryName;
GO
