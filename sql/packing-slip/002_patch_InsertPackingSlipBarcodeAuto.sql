/*
 * Patch for the vendor proc InsertPackingSlipBarcodeAuto — OPTIONAL.
 *
 * Run this only if the old VB6 exe (IndusPackingSlipBarcodeGenerator) will
 * still be used after 001_InsertPackingSlipBarcodeBatch_Manu.sql is deployed.
 *
 * The exe passes FYear '2025-2026' and this proc takes MAX(BarcodeNo) within
 * that year only. Once the web tool saves numbers under '2026-2027', the exe
 * would no longer see them and would try to reuse them (the unique index
 * rejects that with "Duplicate barcode detected"). The only change below is
 * that the MAX is now taken across all years; everything else is as the vendor
 * wrote it, including storing whatever @FYear the caller passes.
 *
 * This changes a vendor proc. Step 1 keeps the original under a new name so it
 * can be put back. Run in BOTH IndusEnterprise and IndusEnterprise2.
 */

/* Step 1: keep the original definition, once. */
IF OBJECT_ID('dbo.InsertPackingSlipBarcodeAuto_orig_20261102', 'P') IS NULL
BEGIN
    DECLARE @def NVARCHAR(MAX) = OBJECT_DEFINITION(OBJECT_ID('dbo.InsertPackingSlipBarcodeAuto'));
    SET @def = STUFF(@def,
                     CHARINDEX('InsertPackingSlipBarcodeAuto', @def),
                     LEN('InsertPackingSlipBarcodeAuto'),
                     'InsertPackingSlipBarcodeAuto_orig_20261102');
    EXEC (@def);
END
GO

/* Step 2: number across all years. */
ALTER PROCEDURE dbo.InsertPackingSlipBarcodeAuto
(
    @JobBookingJobcardContentsID INT,
    @JobBookingID INT,
    @FYear VARCHAR(10),
    @LedgerID INT,
    @Qty DECIMAL(18,2),
    @NetWt DECIMAL(18,2),
    @GrossWt DECIMAL(18,2),
    @NewBarcode INT OUTPUT
)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;   -- auto rollback on errors
    DECLARE @Barcode INT;
    BEGIN TRY
        BEGIN TRANSACTION;
        -- Generate next barcode with table-level lock.
        -- 2026-11-02: no FYear filter. BarcodeNo is unique across all years
        -- (UQ_PackingSlipBarcodeEntry_BarcodeNo).
        SELECT @Barcode = ISNULL(MAX(BarcodeNo), 100000) + 1
        FROM PackingSlipBarcodeEntry WITH (TABLOCKX);
        -- Insert new record
        INSERT INTO PackingSlipBarcodeEntry
        (
            JobBookingJobcardContentsID, JobBookingID, BarcodeNo,
            FYear, DateTime, LedgerID, QuantityPerBox, NetWt, GrossWt
        )
        VALUES
        (
            @JobBookingJobcardContentsID, @JobBookingID, @Barcode,
            @FYear, GETDATE(), @LedgerID, @Qty, @NetWt, @GrossWt
        );
        SET @NewBarcode = @Barcode;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        DECLARE @ErrorNumber INT = ERROR_NUMBER();
        DECLARE @ErrorMessage VARCHAR(400) = ERROR_MESSAGE();
        -- Handle duplicate barcode
        IF @ErrorNumber IN (2627, 2601)
        BEGIN
            RAISERROR('Duplicate barcode detected. Please try again.', 16, 1);
            RETURN;
        END
        -- Raise original SQL error
        RAISERROR(@ErrorMessage, 16, 1);
    END CATCH
END
GO

/* Check: both procs present. */
SELECT name, modify_date
FROM sys.procedures
WHERE name IN ('InsertPackingSlipBarcodeAuto', 'InsertPackingSlipBarcodeAuto_orig_20261102');
