-- Add ValidationStatus to RawMaterialQCDetail (run in KOL and AHM databases)
-- ValidationStatus: 'Ok' | 'Not Ok' | 'NA' or dropdown option value
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('RawMaterialQCDetail') AND name = 'ValidationStatus'
)
BEGIN
  ALTER TABLE RawMaterialQCDetail ADD ValidationStatus NVARCHAR(50) NULL;
END
GO
