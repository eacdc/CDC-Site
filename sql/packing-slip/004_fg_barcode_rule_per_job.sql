/*
 * Mixed boxes, part 2: the one-line-per-barcode rule on GPN / delivery notes.
 *
 * FinishGoodsTransactionDetail has the unique index UIX_FGDetail_Barcode_Type
 * on (Barcode, BarcodeType), for rows not deleted. BarcodeType is 0 for a GPN
 * line and 1 for a delivery-note line, so a barcode can have only one active
 * GPN line and one active DN line. A mixed box needs one line per job, and the
 * first real test (barcode 1302174) was refused by this index. Nothing was
 * saved: the whole scan rolled back.
 *
 * The new index adds JobBookingID: one active GPN line and one active DN line
 * per barcode PER JOB. A one-job box behaves exactly as before, and scanning
 * any box twice is still refused, because the same barcode + job comes again.
 *
 * The new index is built before the old one is dropped, so the table is never
 * without the rule. It is built on ~2.0M rows (Kolkata) / ~1.1M (Ahmedabad);
 * Standard Edition cannot build it online, so GPN and DN scans wait while it
 * builds (expect under a minute). Run it when nobody is scanning.
 *
 * Run in BOTH IndusEnterprise (Kolkata) and IndusEnterprise2 (Ahmedabad).
 */
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('dbo.FinishGoodsTransactionDetail')
                 AND name = 'UIX_FGDetail_Barcode_Type_Job')
    CREATE UNIQUE NONCLUSTERED INDEX UIX_FGDetail_Barcode_Type_Job
        ON dbo.FinishGoodsTransactionDetail (Barcode, BarcodeType, JobBookingID)
        WHERE IsDeletedTransaction = 0;

IF EXISTS (SELECT 1 FROM sys.indexes
           WHERE object_id = OBJECT_ID('dbo.FinishGoodsTransactionDetail')
             AND name = 'UIX_FGDetail_Barcode_Type')
    DROP INDEX UIX_FGDetail_Barcode_Type ON dbo.FinishGoodsTransactionDetail;

COMMIT TRANSACTION;
GO

/* Check: should list UIX_FGDetail_Barcode_Type_Job with Barcode, BarcodeType, JobBookingID. */
SELECT i.name, i.filter_definition, c.name AS col, ic.key_ordinal
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID('dbo.FinishGoodsTransactionDetail') AND i.is_unique = 1
ORDER BY i.name, ic.key_ordinal;
