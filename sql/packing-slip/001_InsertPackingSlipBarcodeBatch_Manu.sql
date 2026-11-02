/*
 * InsertPackingSlipBarcodeBatch_Manu
 *
 * Creates @Copies carton barcodes for one job in a single locked transaction
 * and returns the new numbers. Used by the Packing Slip Barcode web tool
 * (backend/src/routes-packing-slip.js), which falls back to the vendor proc
 * InsertPackingSlipBarcodeAuto while this one is not deployed.
 *
 * Why a new proc. InsertPackingSlipBarcodeAuto takes MAX(BarcodeNo) within one
 * FYear, but UQ_PackingSlipBarcodeEntry_BarcodeNo makes BarcodeNo unique across
 * all years. A new FYear therefore restarts at 100001 and collides with numbers
 * already used (it did on 1-2 April 2026), which is why the old exe still
 * passes '2025-2026' in November 2026. This proc numbers across all years and
 * stores the real Apr-Mar year. The GPN and delivery-note procs look a carton
 * up by BarcodeNo only, so the FYear value does not affect them.
 *
 * It also inserts the whole batch under one lock instead of one lock per label.
 *
 * Deploy to BOTH databases: run once in IndusEnterprise (Kolkata) and once in
 * IndusEnterprise2 (Ahmedabad).
 *
 * If the old VB6 exe is still used anywhere after this is deployed, also run
 * 002_patch_InsertPackingSlipBarcodeAuto.sql, or the exe's next number (taken
 * within '2025-2026' only) can hit one this proc already used.
 */
CREATE OR ALTER PROCEDURE dbo.InsertPackingSlipBarcodeBatch_Manu
(
    @JobBookingID                INT,
    @LedgerID                    INT,
    @Qty                         DECIMAL(18,2),
    @NetWt                       DECIMAL(18,2),
    @GrossWt                     DECIMAL(18,2),
    @Copies                      INT,
    @JobBookingJobcardContentsID INT = 0
)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @Copies IS NULL OR @Copies < 1 OR @Copies > 1000
    BEGIN
        RAISERROR('Copies must be between 1 and 1000.', 16, 1);
        RETURN;
    END

    IF @Qty IS NULL OR @Qty <= 0
    BEGIN
        RAISERROR('Quantity per box must be more than zero.', 16, 1);
        RETURN;
    END

    DECLARE @Now DATETIME = GETDATE();
    DECLARE @FYStartYear INT = YEAR(@Now) - CASE WHEN MONTH(@Now) < 4 THEN 1 ELSE 0 END;
    DECLARE @FY NVARCHAR(100) = CONCAT(@FYStartYear, '-', @FYStartYear + 1);
    DECLARE @Start BIGINT;
    DECLARE @New TABLE (BarcodeNo BIGINT NOT NULL);

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Same table lock as the vendor proc, so this and the old exe never
        -- read the same MAX at the same time. No FYear filter: numbers are
        -- unique across all years.
        SELECT @Start = ISNULL(MAX(BarcodeNo), 100000) + 1
        FROM dbo.PackingSlipBarcodeEntry WITH (TABLOCKX, HOLDLOCK);

        ;WITH N AS (
            SELECT TOP (@Copies)
                   CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS BIGINT) AS i
            FROM sys.all_objects a
            CROSS JOIN sys.all_objects b
        )
        INSERT INTO dbo.PackingSlipBarcodeEntry
        (
            JobBookingJobcardContentsID, JobBookingID, BarcodeNo,
            FYear, [DateTime], LedgerID, QuantityPerBox, NetWt, GrossWt
        )
        OUTPUT inserted.BarcodeNo INTO @New (BarcodeNo)
        SELECT @JobBookingJobcardContentsID, @JobBookingID, @Start + N.i,
               @FY, @Now, @LedgerID, @Qty, @NetWt, @GrossWt
        FROM N;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @ErrorNumber INT = ERROR_NUMBER();
        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
        IF @ErrorNumber IN (2627, 2601)
        BEGIN
            RAISERROR('Duplicate barcode detected. Please try again.', 16, 1);
            RETURN;
        END
        RAISERROR(@ErrorMessage, 16, 1);
        RETURN;
    END CATCH

    SELECT BarcodeNo FROM @New ORDER BY BarcodeNo;
END
GO

/* Check: should return one row with the proc name. */
SELECT name, create_date, modify_date
FROM sys.procedures
WHERE name = 'InsertPackingSlipBarcodeBatch_Manu';
