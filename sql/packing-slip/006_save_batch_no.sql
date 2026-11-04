/*
 * Save the label's batch, as the ERP's own packing slip does.
 *
 * The GPN and delivery-note scans (SaveFinishGoodsByBarcode_Manu_v4,
 * SaveDeliveryNoteByBarcode_Manu_v3) read PackingSlipBarcodeEntry.BatchNo and
 * show it as the carton's batch. The ERP's packing slip fills BatchNo and
 * JobBookingJobCardBatchID when the job has batches entered in the ERP
 * (JobBookingJobCardBatch); it never saves a batch that is not in that list.
 *
 * This script changes the web tool's two save procs the same way:
 *   1. InsertPackingSlipBarcodeBatch_Manu  - new optional @BatchNo.
 *   2. InsertPackingSlipBarcodeMixed_Manu  - optional "batchNo" per PWO in @Items.
 * The proc looks the typed batch up in the job's ERP batches (trimmed, any
 * case). A match saves the ERP's batch text and its JobBookingJobCardBatchID;
 * anything else is printed on the label only and BatchNo stays NULL.
 *
 * Both procs now return a second result set: JobBookingID, BatchNo,
 * JobBookingJobCardBatchID as saved (NULLs when no batch was saved). The first
 * result set (the new barcode numbers) is unchanged, so the backend in use
 * before this script keeps working.
 *
 * Run in BOTH IndusEnterprise (Kolkata) and IndusEnterprise2 (Ahmedabad).
 * Run 001 and 003 first. Nothing else changes; existing rows are not touched.
 */

/* ===================== 1. One PWO per box ===================== */
CREATE OR ALTER PROCEDURE dbo.InsertPackingSlipBarcodeBatch_Manu
(
    @JobBookingID                INT,
    @LedgerID                    INT,
    @Qty                         DECIMAL(18,2),
    @NetWt                       DECIMAL(18,2),
    @GrossWt                     DECIMAL(18,2),
    @Copies                      INT,
    @JobBookingJobcardContentsID INT = 0,
    @BatchNo                     NVARCHAR(100) = NULL,  -- saved only when it is one of the job's ERP batches
    @CompanyID                   INT = 2
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
    DECLARE @SavedBatchNo VARCHAR(50) = NULL;
    DECLARE @SavedBatchID INT = NULL;

    -- The job's ERP batch with this text, first entered first.
    IF LTRIM(RTRIM(ISNULL(@BatchNo, N''))) <> N''
        SELECT TOP (1)
               @SavedBatchNo = CAST(LTRIM(RTRIM(B.BatchNo)) AS VARCHAR(50)),
               @SavedBatchID = CAST(B.JobBookingJobCardBatchID AS INT)
        FROM dbo.JobBookingJobCardBatch AS B
        WHERE B.JobBookingID = @JobBookingID
          AND B.CompanyID = @CompanyID
          AND LTRIM(RTRIM(B.BatchNo)) = LTRIM(RTRIM(@BatchNo))
        ORDER BY B.JobBookingJobCardBatchID;

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
            FYear, [DateTime], LedgerID, QuantityPerBox, NetWt, GrossWt,
            BatchNo, JobBookingJobCardBatchID
        )
        OUTPUT inserted.BarcodeNo INTO @New (BarcodeNo)
        SELECT @JobBookingJobcardContentsID, @JobBookingID, @Start + N.i,
               @FY, @Now, @LedgerID, @Qty, @NetWt, @GrossWt,
               @SavedBatchNo, @SavedBatchID
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
    SELECT @JobBookingID AS JobBookingID, @SavedBatchNo AS BatchNo, @SavedBatchID AS JobBookingJobCardBatchID;
END
GO

/* ===================== 2. Mixed box ===================== */
/*
 * @Items is JSON: [{"jobBookingId":1,"qty":500,"netWt":0,"grossWt":0,"batchNo":"B1"}, ...]
 * "batchNo" is optional. Every job gets a row under each new barcode. @Copies
 * identical boxes get @Copies new barcodes. All jobs must belong to the same client.
 */
CREATE OR ALTER PROCEDURE dbo.InsertPackingSlipBarcodeMixed_Manu
(
    @Items     NVARCHAR(MAX),
    @Copies    INT = 1,
    @CompanyID INT = 2
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

    IF ISJSON(@Items) <> 1
    BEGIN
        RAISERROR('Items must be a JSON list of jobs.', 16, 1);
        RETURN;
    END

    DECLARE @Jobs TABLE
    (
        JobBookingID INT PRIMARY KEY,
        LedgerID     INT NULL,
        Qty          DECIMAL(18,2) NOT NULL,
        NetWt        DECIMAL(18,2) NOT NULL,
        GrossWt      DECIMAL(18,2) NOT NULL,
        TypedBatchNo NVARCHAR(100) NULL,
        BatchNo      VARCHAR(50) NULL,
        BatchID      INT NULL
    );

    BEGIN TRY
        INSERT INTO @Jobs (JobBookingID, LedgerID, Qty, NetWt, GrossWt, TypedBatchNo)
        SELECT i.JobBookingID, j.LedgerID, i.Qty, ISNULL(i.NetWt, 0), ISNULL(i.GrossWt, 0),
               NULLIF(LTRIM(RTRIM(i.BatchNo)), N'')
        FROM OPENJSON(@Items)
             WITH (JobBookingID INT           '$.jobBookingId',
                   Qty          DECIMAL(18,2) '$.qty',
                   NetWt        DECIMAL(18,2) '$.netWt',
                   GrossWt      DECIMAL(18,2) '$.grossWt',
                   BatchNo      NVARCHAR(100) '$.batchNo') AS i
        LEFT JOIN dbo.JobBookingJobCard AS j ON j.JobBookingID = i.JobBookingID;
    END TRY
    BEGIN CATCH
        IF ERROR_NUMBER() IN (2627, 2601)
            RAISERROR('The same PWO is in the box twice.', 16, 1);
        ELSE
            RAISERROR('The list of PWOs could not be read.', 16, 1);
        RETURN;
    END CATCH

    IF NOT EXISTS (SELECT 1 FROM @Jobs)
    BEGIN
        RAISERROR('Add at least one PWO to the box.', 16, 1);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM @Jobs WHERE LedgerID IS NULL)
    BEGIN
        RAISERROR('A PWO in the box was not found.', 16, 1);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM @Jobs WHERE Qty <= 0)
    BEGIN
        RAISERROR('Every PWO needs a quantity of more than zero.', 16, 1);
        RETURN;
    END

    IF (SELECT COUNT(DISTINCT LedgerID) FROM @Jobs) > 1
    BEGIN
        RAISERROR('All PWOs in one box must be for the same client.', 16, 1);
        RETURN;
    END

    -- Each PWO's ERP batch with the typed text, first entered first.
    UPDATE J
    SET BatchNo = b.BatchNo,
        BatchID = b.BatchID
    FROM @Jobs AS J
    CROSS APPLY (
        SELECT TOP (1)
               CAST(LTRIM(RTRIM(B.BatchNo)) AS VARCHAR(50)) AS BatchNo,
               CAST(B.JobBookingJobCardBatchID AS INT) AS BatchID
        FROM dbo.JobBookingJobCardBatch AS B
        WHERE B.JobBookingID = J.JobBookingID
          AND B.CompanyID = @CompanyID
          AND LTRIM(RTRIM(B.BatchNo)) = J.TypedBatchNo
        ORDER BY B.JobBookingJobCardBatchID
    ) AS b
    WHERE J.TypedBatchNo IS NOT NULL;

    DECLARE @Now DATETIME = GETDATE();
    DECLARE @FYStartYear INT = YEAR(@Now) - CASE WHEN MONTH(@Now) < 4 THEN 1 ELSE 0 END;
    DECLARE @FY NVARCHAR(100) = CONCAT(@FYStartYear, '-', @FYStartYear + 1);
    DECLARE @Start BIGINT;
    DECLARE @New TABLE (BarcodeNo BIGINT NOT NULL);

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Same table lock as the batch proc and the exe's proc.
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
            FYear, [DateTime], LedgerID, QuantityPerBox, NetWt, GrossWt,
            BatchNo, JobBookingJobCardBatchID
        )
        OUTPUT inserted.BarcodeNo INTO @New (BarcodeNo)
        SELECT 0, J.JobBookingID, @Start + N.i,
               @FY, @Now, J.LedgerID, J.Qty, J.NetWt, J.GrossWt,
               J.BatchNo, J.BatchID
        FROM N
        CROSS JOIN @Jobs AS J;

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

    SELECT DISTINCT BarcodeNo FROM @New ORDER BY BarcodeNo;
    SELECT JobBookingID, BatchNo, BatchID AS JobBookingJobCardBatchID FROM @Jobs ORDER BY JobBookingID;
END
GO

/* Check: both procs should list @BatchNo / @CompanyID, and the mixed proc '$.batchNo'. */
SELECT OBJECT_NAME(object_id) AS proc_name, name AS parameter
FROM sys.parameters
WHERE object_id IN (OBJECT_ID('dbo.InsertPackingSlipBarcodeBatch_Manu'), OBJECT_ID('dbo.InsertPackingSlipBarcodeMixed_Manu'))
ORDER BY proc_name, parameter_id;
