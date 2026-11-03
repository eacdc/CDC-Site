/*
 * Mixed boxes: one carton barcode for several jobs of the same client.
 *
 * A mixed box is stored as one PackingSlipBarcodeEntry row per job, all with
 * the same BarcodeNo. The GPN and delivery-note scans then write one detail
 * row per job under that barcode, so stock and dispatch stay correct per job.
 *
 * What this script does:
 *   1. Unique rule on PackingSlipBarcodeEntry changes from BarcodeNo to
 *      (BarcodeNo, JobBookingID). The new one is created before the old one is
 *      dropped, so the table is never without a unique rule.
 *   2. InsertPackingSlipBarcodeMixed_Manu  - creates mixed-box barcodes.
 *   3. SaveFinishGoodsByBarcode_Manu_v4    - GPN scan (replaces v3).
 *   4. DeleteFinishGoodsByBarcode_Manu_v2  - GPN delete.
 *   5. SaveDeliveryNoteByBarcode_Manu_v3   - delivery-note scan (replaces v2).
 *   6. DeleteDeliveryNoteByBarcode_Manu_v2 - delivery-note delete.
 * The old procs are left as they are. The backend uses the new ones as soon as
 * they exist and the old ones until then. For a one-job barcode the new procs
 * give the same result as the old ones.
 *
 * Numbers stay unique: every proc that creates a barcode (the web tool's
 * batch and mixed procs, and the exe's InsertPackingSlipBarcodeAuto) takes
 * MAX(BarcodeNo) + 1 under an exclusive table lock, so two creators never see
 * the same MAX. The old InsertPackingSlipBarcode (number passed in, no lock)
 * still refuses a number that already exists.
 *
 * Cartons: on a mixed box only the first job's GPN / DN row carries
 * OuterCarton = 1, so carton totals count the box once.
 *
 * Run in BOTH IndusEnterprise (Kolkata) and IndusEnterprise2 (Ahmedabad).
 * Step 1 rebuilds a unique index on ~1.2M rows (a few seconds, table locked):
 * run it when nobody is printing labels.
 */

/* ===================== 1. Unique rule ===================== */
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('dbo.PackingSlipBarcodeEntry')
                 AND name = 'UQ_PackingSlipBarcodeEntry_BarcodeNo_Job')
    ALTER TABLE dbo.PackingSlipBarcodeEntry
        ADD CONSTRAINT UQ_PackingSlipBarcodeEntry_BarcodeNo_Job UNIQUE (BarcodeNo, JobBookingID);

IF EXISTS (SELECT 1 FROM sys.indexes
           WHERE object_id = OBJECT_ID('dbo.PackingSlipBarcodeEntry')
             AND name = 'UQ_PackingSlipBarcodeEntry_BarcodeNo')
    ALTER TABLE dbo.PackingSlipBarcodeEntry
        DROP CONSTRAINT UQ_PackingSlipBarcodeEntry_BarcodeNo;

COMMIT TRANSACTION;
GO

/* ===================== 2. Create mixed-box barcodes ===================== */
/*
 * @Items is JSON: [{"jobBookingId":1,"qty":500,"netWt":0,"grossWt":0}, ...]
 * Every job gets a row under each new barcode. @Copies identical boxes get
 * @Copies new barcodes. All jobs must belong to the same client.
 */
CREATE OR ALTER PROCEDURE dbo.InsertPackingSlipBarcodeMixed_Manu
(
    @Items   NVARCHAR(MAX),
    @Copies  INT = 1
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
        GrossWt      DECIMAL(18,2) NOT NULL
    );

    BEGIN TRY
        INSERT INTO @Jobs (JobBookingID, LedgerID, Qty, NetWt, GrossWt)
        SELECT i.JobBookingID, j.LedgerID, i.Qty, ISNULL(i.NetWt, 0), ISNULL(i.GrossWt, 0)
        FROM OPENJSON(@Items)
             WITH (JobBookingID INT '$.jobBookingId',
                   Qty          DECIMAL(18,2) '$.qty',
                   NetWt        DECIMAL(18,2) '$.netWt',
                   GrossWt      DECIMAL(18,2) '$.grossWt') AS i
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
            FYear, [DateTime], LedgerID, QuantityPerBox, NetWt, GrossWt
        )
        OUTPUT inserted.BarcodeNo INTO @New (BarcodeNo)
        SELECT 0, J.JobBookingID, @Start + N.i,
               @FY, @Now, J.LedgerID, J.Qty, J.NetWt, J.GrossWt
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
END
GO

/* ===================== 3. GPN scan ===================== */
/*
 * Same as SaveFinishGoodsByBarcode_Manu_v3, but writes one detail row per job
 * on the barcode. The result has the same columns; on a mixed box JobName and
 * JobBookingNo list every job (comma separated) and the quantities are the
 * totals of those jobs. Cartons are counted as distinct barcodes.
 *
 * 'update' adds the barcode to an open GPN when that GPN's job is one of the
 * barcode's jobs, or the GPN already holds one of them (from a mixed box).
 */
CREATE OR ALTER PROCEDURE dbo.SaveFinishGoodsByBarcode_Manu_v4
    @BarcodeNo         BIGINT,
    @Status            VARCHAR(10),     -- 'new' | 'update'
    @UserID            INT,
    @FGTransactionID   INT = NULL,      -- required for 'update'
    @CompanyID         INT = 2,
    @BranchID          INT = 0,
    @VoucherID         INT = -50        -- FG = -50
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @StatusNorm        VARCHAR(10)   = UPPER(LTRIM(RTRIM(@Status))),
        @BarcodeStr        NVARCHAR(100) = CONVERT(NVARCHAR(100), @BarcodeNo),
        @JobBookingID      INT,
        @LedgerID          INT,
        @JobBookingNo      NVARCHAR(MAX) = N'',
        @JobName           NVARCHAR(MAX) = N'',
        @PS_BatchNo        NVARCHAR(100) = NULL,
        @Now               DATETIME      = GETDATE(),
        @FYStartYear       INT,
        @FY                NVARCHAR(9),
        @FYShort           NVARCHAR(5),
        @NextMaxVoucherNo  INT,
        @VoucherNo         NVARCHAR(50)  = N'',
        @NextTransID       INT,
        @LockResult        INT,
        @LockName          NVARCHAR(255),

        @OrderQty              INT = 0,
        @PackedQtyThisVoucher  INT = 0,
        @CartonQtyThisVoucher  INT = 0,
        @PackedQtyTotal        INT = 0,
        @CartonQtyTotal        INT = 0;

    DECLARE @Jobs TABLE
    (
        Seq          INT NOT NULL,
        JobBookingID INT NOT NULL PRIMARY KEY,
        QtyPerBox    INT NOT NULL,
        PS_BatchNo   NVARCHAR(100) NULL,
        JobBookingNo NVARCHAR(50)  NOT NULL,
        JobName      NVARCHAR(300) NOT NULL,
        OrderQty     INT NOT NULL,
        LedgerID     INT NOT NULL
    );

    SET @FYStartYear = YEAR(@Now) - CASE WHEN MONTH(@Now) < 4 THEN 1 ELSE 0 END;
    SET @FY      = CONCAT(@FYStartYear, '-', @FYStartYear + 1);
    SET @FYShort = RIGHT(CONVERT(VARCHAR(4), @FYStartYear), 2) + '_' + RIGHT(CONVERT(VARCHAR(4), @FYStartYear + 1), 2);

    /* Every job on the barcode, in PWO order */
    INSERT INTO @Jobs (Seq, JobBookingID, QtyPerBox, PS_BatchNo, JobBookingNo, JobName, OrderQty, LedgerID)
    SELECT ROW_NUMBER() OVER (ORDER BY psbe.JobBookingID),
           psbe.JobBookingID,
           TRY_CONVERT(INT, psbe.QuantityPerBox),
           psbe.BatchNo,
           ISNULL(jbjc.JobBookingNo, N''),
           ISNULL(jbjc.JobName, N''),
           ISNULL(TRY_CONVERT(INT, jbjc.OrderQuantity), 0),
           ISNULL(jbjc.LedgerID, 0)
    FROM dbo.PackingSlipBarcodeEntry AS psbe
    LEFT JOIN dbo.JobBookingJobCard AS jbjc ON jbjc.JobBookingID = psbe.JobBookingID
    WHERE psbe.BarcodeNo = @BarcodeNo
      AND psbe.JobBookingID IS NOT NULL
      AND TRY_CONVERT(INT, psbe.QuantityPerBox) IS NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM @Jobs)
    BEGIN
        SELECT 'Fail: False Barcode Num' AS [Status],
               CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
               CAST(0 AS INT) AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
               CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
               N'' AS JobName, CAST(0 AS INT) AS JobBookingID, N'' AS JobBookingNo, @PS_BatchNo AS BatchNo;
        RETURN;
    END

    SELECT @JobBookingID = JobBookingID, @LedgerID = LedgerID, @PS_BatchNo = PS_BatchNo
    FROM @Jobs WHERE Seq = 1;

    SELECT @JobBookingNo = STRING_AGG(CAST(JobBookingNo AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY Seq),
           @JobName      = STRING_AGG(CAST(JobName AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY Seq),
           @OrderQty     = SUM(OrderQty)
    FROM @Jobs;

    IF @StatusNorm NOT IN ('NEW', 'UPDATE')
    BEGIN
        SELECT 'Fail: Status must be NEW or UPDATE' AS [Status],
               CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
               @OrderQty AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
               CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
               @JobName AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
        RETURN;
    END

    IF @StatusNorm = 'UPDATE' AND ISNULL(@FGTransactionID, 0) = 0
    BEGIN
        SELECT 'Fail: FGTransactionID required for update' AS [Status],
               CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
               @OrderQty AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
               CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
               @JobName AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        /* Per-barcode lock: only two scans of the SAME barcode wait on each other */
        SET @LockName = N'FG_BC_' + @BarcodeStr;
        EXEC @LockResult = sp_getapplock
             @Resource    = @LockName,
             @LockMode    = 'Exclusive',
             @LockOwner   = 'Transaction',
             @LockTimeout = 5000;

        IF @LockResult < 0
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Could not acquire save lock, please retry' AS [Status],
                   CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
                   @OrderQty AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
                   CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
                   @JobName AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
            RETURN;
        END

        IF EXISTS (
            SELECT 1
            FROM dbo.FinishGoodsTransactionDetail AS d
            JOIN dbo.FinishGoodsTransactionMain  AS m ON m.FGTransactionID = d.FGTransactionID
            WHERE d.Barcode = @BarcodeStr
              AND m.VoucherID = @VoucherID
              AND ISNULL(m.IsDeletedTransaction, 0) = 0
              AND ISNULL(d.IsDeletedTransaction, 0) = 0
        )
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Barcode Repeat' AS [Status],
                   CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
                   @OrderQty AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
                   CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
                   @JobName AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
            RETURN;
        END

        IF @StatusNorm = 'NEW'
        BEGIN
            DECLARE @NextNo TABLE (NextNo INT);

            UPDATE vc WITH (UPDLOCK, ROWLOCK)
            SET LastNo = LastNo + 1
            OUTPUT inserted.LastNo INTO @NextNo(NextNo)
            FROM dbo.VoucherCounter vc
            WHERE vc.VoucherPrefix = N'FG' AND vc.FYear = @FY;

            IF @@ROWCOUNT = 0
            BEGIN
                INSERT dbo.VoucherCounter (VoucherPrefix, FYear, LastNo)
                OUTPUT inserted.LastNo INTO @NextNo(NextNo)
                SELECT N'FG', @FY, ISNULL(MAX(m.MaxVoucherNo), 0) + 1
                FROM dbo.FinishGoodsTransactionMain m WITH (UPDLOCK, HOLDLOCK)
                WHERE m.VoucherPrefix = 'FG' AND m.FYear = @FY;
            END

            SELECT @NextMaxVoucherNo = NextNo FROM @NextNo;
            SET @VoucherNo = CONCAT('FG', @NextMaxVoucherNo, '/', @FYShort);

            INSERT INTO dbo.FinishGoodsTransactionMain
            (
                VoucherID, MaxVoucherNo, VoucherPrefix, VoucherNo, VoucherDate,
                SemiPackingMainID, JobBookingID, JobBookingJobCardContentsID, ProductMasterID,
                BookingID, OrderBookingID, OrderBookingDetailsID, LedgerID, ConsigneeLedgerID,
                TotalOuterCarton, TotalInnerCarton, TotalQuantity,
                TotalBasicAmount, TotalDiscountAmount, TotalCGSTTaxAmount, TotalSGSTTaxAmount, TotalIGSTTaxAmount, TotalTaxAmount, NetAmount,
                AmountInWords, CurrencyCode, ConversionRate, ModeOfTransport, Transporter, VehicleNo, PODNo, Narration,
                DeliveryNoteNo, DeliveryNoteDate, DeliveryNoteTransactionID,
                CompanyID, BranchID, UserID, IsDeleted, IsBlocked, FYear, IsLocked,
                CreatedBy, CreatedDate, ModifiedBy, ModifiedDate, DeletedBy, DeletedDate, IsDeletedTransaction,
                CheckedBy, TransporterName, IsIntegrated, InvoiceTransactionID, ProductionUnitID, ResortingTransactionID,
                IsDespatchFreightEntryDone, ContainerNo, SealNo
            )
            VALUES
            (
                @VoucherID, @NextMaxVoucherNo, 'FG', @VoucherNo, @Now,
                0, @JobBookingID, 0, 0,
                @JobBookingID, 0, 0, @LedgerID, 0,
                0, 0, 0,
                0, 0, 0, 0, 0, 0, 0,
                N'', N'INR', 0, N'', N'', N'', N'', N'',
                N'', NULL, 0,
                @CompanyID, @BranchID, @UserID, 0, 0, @FY, 0,
                @UserID, @Now, NULL, NULL, NULL, NULL, 0,
                NULL, N'', 0, 0, 0, 0,
                0, N'', N''
            );

            SET @FGTransactionID = CAST(SCOPE_IDENTITY() AS INT);
            SET @NextTransID = 1;
        END
        ELSE  /* UPDATE */
        BEGIN
            SELECT @VoucherNo = m.VoucherNo
            FROM dbo.FinishGoodsTransactionMain AS m
            WHERE m.FGTransactionID = @FGTransactionID
              AND m.VoucherID = @VoucherID
              AND ISNULL(m.IsDeletedTransaction, 0) = 0
              AND (
                    m.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
                 OR EXISTS (
                        SELECT 1
                        FROM dbo.FinishGoodsTransactionDetail AS d
                        WHERE d.FGTransactionID = m.FGTransactionID
                          AND ISNULL(d.IsDeletedTransaction, 0) = 0
                          AND d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
                    )
              );

            IF @VoucherNo IS NULL
            BEGIN
                ROLLBACK TRAN;
                SELECT 'Fail: GPN does not exist for this JobBookingID / VoucherID' AS [Status],
                       CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
                       @OrderQty AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
                       CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
                       @JobName AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
                RETURN;
            END

            SELECT @NextTransID = ISNULL(MAX(d.TransID), 0) + 1
            FROM dbo.FinishGoodsTransactionDetail AS d WITH (UPDLOCK, HOLDLOCK)
            WHERE d.FGTransactionID = @FGTransactionID;
        END

        /* One row per job; only the first carries the carton */
        INSERT INTO dbo.FinishGoodsTransactionDetail
        (
            FGTransactionID, ParentFGTransactionID, ParentFGTransactionDetailID,
            TransID, SemiPackingMainID, SemiPackingDetailID,
            JobBookingID, JobBookingJobCardContentsID, ProductMasterID,
            BookingID, OrderBookingID, OrderBookingDetailsID,
            DeliveryOrderBookingID, DeliveryOrderBookingDetailsID,
            DeliveryJobBookingID, DeliveryJobBookingJobCardContentsID,
            ProductHSNID,
            ReceiptQuantity, IssueQuantity,
            ReceiptOuterCarton, IssueOuterCarton,
            OuterCarton, InnerCarton, QuantityPerPack, WeightPerOuterCarton,
            ReceiptTotalWeight, IssueTotalWeight, TotalWeight,
            Unit, Rate, GrossAmount, DiscountPercentage, DiscountAmount, BasicAmount, TaxableAmount,
            GSTPercentage, CGSTPercentage, SGSTPercentage, IGSTPercentage, CGSTAmount, SGSTAmount, IGSTAmount,
            NetAmount, LandedRate,
            BatchNo, WarehouseID, PackingDescription,
            ShipperLengthCM, ShipperWidthCM, ShipperHeightCM, CBCM, CFT, TotalCFT,
            CompanyID, BranchID, UserID, IsDeleted, IsBlocked, FYear, IsLocked,
            CreatedBy, CreatedDate, ModifiedBy, ModifiedDate, DeletedBy, DeletedDate, IsDeletedTransaction,
            ReturnQuantity, QCApprovedQuantity, QCRejectedQuantity, QCHoldQuantity,
            ProductionUnitID, GrossWeightPerOuterCarton, Barcode
        )
        SELECT
            @FGTransactionID, 0, 0,
            @NextTransID + J.Seq - 1, 0, 0,
            J.JobBookingID, 0, 0,
            0, 0, 0,
            0, 0,
            0, 0,
            0,
            J.QtyPerBox, 0,
            CASE WHEN J.Seq = 1 THEN 1 ELSE 0 END, 0,
            CASE WHEN J.Seq = 1 THEN 1 ELSE 0 END, 1, J.QtyPerBox, 0,
            0, 0, 0,
            N'', 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
            0, 0,
            J.JobBookingNo, 0, N'',
            0, 0, 0, 0, 0, 0,
            @CompanyID, @BranchID, @UserID, 0, 0, @FY, 0,
            @UserID, @Now, NULL, NULL, NULL, NULL, 0,
            0, 0, 0, 0,
            0, 0, @BarcodeStr
        FROM @Jobs AS J;

        COMMIT TRAN;

        /* Metrics for the barcode's jobs; cartons are distinct barcodes */
        SELECT
            @PackedQtyThisVoucher = CAST(ISNULL(SUM(d.ReceiptQuantity), 0) AS INT),
            @CartonQtyThisVoucher = CAST(COUNT(DISTINCT d.Barcode) AS INT)
        FROM dbo.FinishGoodsTransactionDetail AS d
        WHERE d.FGTransactionID = @FGTransactionID
          AND d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
          AND ISNULL(d.IsDeletedTransaction, 0) = 0;

        SELECT
            @PackedQtyTotal = CAST(ISNULL(SUM(d.ReceiptQuantity), 0) AS INT),
            @CartonQtyTotal = CAST(COUNT(DISTINCT d.Barcode) AS INT)
        FROM dbo.FinishGoodsTransactionDetail AS d
        JOIN dbo.FinishGoodsTransactionMain  AS m ON m.FGTransactionID = d.FGTransactionID
        WHERE d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
          AND m.VoucherID = @VoucherID
          AND ISNULL(m.IsDeletedTransaction, 0) = 0
          AND ISNULL(d.IsDeletedTransaction, 0) = 0;

        SELECT 'Success' AS [Status],
               @FGTransactionID AS FGTransactionID,
               @VoucherNo AS VoucherNo,
               @OrderQty AS OrderQty,
               @PackedQtyThisVoucher AS PackedQtyThisVoucher,
               @CartonQtyThisVoucher AS CartonQtyThisVoucher,
               @PackedQtyTotal AS PackedQtyTotal,
               @CartonQtyTotal AS CartonQtyTotal,
               @JobName AS JobName,
               @JobBookingID AS JobBookingID,
               @JobBookingNo AS JobBookingNo,
               @PS_BatchNo AS BatchNo;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        SELECT
            'Fail: ' + ERROR_MESSAGE() AS [Status],
            CAST(0 AS INT) AS FGTransactionID, CAST('' AS NVARCHAR(50)) AS VoucherNo,
            CAST(0 AS INT) AS OrderQty, CAST(0 AS INT) AS PackedQtyThisVoucher, CAST(0 AS INT) AS CartonQtyThisVoucher,
            CAST(0 AS INT) AS PackedQtyTotal, CAST(0 AS INT) AS CartonQtyTotal,
            N'' AS JobName, @JobBookingID AS JobBookingID, @JobBookingNo AS JobBookingNo, @PS_BatchNo AS BatchNo;
    END CATCH
END
GO

/* ===================== 4. GPN delete ===================== */
/*
 * Same as DeleteFinishGoodsByBarcode_Manu, but removes every job's row for the
 * barcode, compares the barcode as text (index seek) and locks per barcode.
 */
CREATE OR ALTER PROCEDURE dbo.DeleteFinishGoodsByBarcode_Manu_v2
    @BarcodeNo   BIGINT,
    @UserID      INT,
    @CompanyID   INT = 2,
    @BranchID    INT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Now                DATETIME      = GETDATE(),
        @BarcodeStr         NVARCHAR(100) = CONVERT(NVARCHAR(100), @BarcodeNo),
        @VoucherID_FG       INT           = -50,
        @VoucherID_DN       INT           = -51,
        @FGTransactionID    INT,
        @JobBookingID       INT,
        @VoucherNo          NVARCHAR(50),
        @JobBookingNo       NVARCHAR(MAX) = N'',
        @JobName            NVARCHAR(MAX) = N'',
        @LockResult         INT,
        @PackedQtyThisVoucher INT = 0,
        @CartonQtyThisVoucher INT = 0,
        @PackedQtyTotal       INT = 0,
        @CartonQtyTotal       INT = 0;

    DECLARE @Jobs TABLE (JobBookingID INT NOT NULL);

    BEGIN TRY
        BEGIN TRAN;

        DECLARE @LockName NVARCHAR(255) = N'FG_BC_' + @BarcodeStr;
        EXEC @LockResult = sp_getapplock
             @Resource = @LockName, @LockMode = 'Exclusive',
             @LockOwner = 'Transaction', @LockTimeout = 5000;
        IF @LockResult < 0
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Could not acquire lock, please retry' AS [Status];
            RETURN;
        END

        SELECT TOP (1) @FGTransactionID = d.FGTransactionID
        FROM dbo.FinishGoodsTransactionDetail d
        JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
        WHERE d.Barcode = @BarcodeStr
          AND m.VoucherID = @VoucherID_FG
          AND ISNULL(m.IsDeletedTransaction,0) = 0
          AND ISNULL(d.IsDeletedTransaction,0) = 0;

        IF @FGTransactionID IS NULL
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Barcode not found in active FG (GPN)' AS [Status];
            RETURN;
        END

        IF EXISTS (
            SELECT 1
            FROM dbo.FinishGoodsTransactionDetail d
            JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
            WHERE d.Barcode = @BarcodeStr
              AND m.VoucherID = @VoucherID_DN
              AND ISNULL(m.IsDeletedTransaction,0) = 0
              AND ISNULL(d.IsDeletedTransaction,0) = 0
        )
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Cannot delete FG. Delivery Note already exists for this barcode.' AS [Status];
            RETURN;
        END

        UPDATE dbo.FinishGoodsTransactionDetail
        SET IsDeletedTransaction = 1,
            DeletedBy            = @UserID,
            DeletedDate          = @Now,
            ModifiedBy           = @UserID,
            ModifiedDate         = @Now
        OUTPUT inserted.JobBookingID INTO @Jobs (JobBookingID)
        WHERE FGTransactionID = @FGTransactionID
          AND Barcode = @BarcodeStr
          AND ISNULL(IsDeletedTransaction,0) = 0;

        IF NOT EXISTS (
            SELECT 1
            FROM dbo.FinishGoodsTransactionDetail d
            WHERE d.FGTransactionID = @FGTransactionID
              AND ISNULL(d.IsDeletedTransaction,0) = 0
        )
        BEGIN
            UPDATE dbo.FinishGoodsTransactionMain
            SET IsDeletedTransaction = 1,
                DeletedBy            = @UserID,
                DeletedDate          = @Now,
                ModifiedBy           = @UserID,
                ModifiedDate         = @Now
            WHERE FGTransactionID = @FGTransactionID
              AND ISNULL(IsDeletedTransaction,0) = 0;
        END

        COMMIT TRAN;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        SELECT 'Fail: ' + ERROR_MESSAGE() AS [Status];
        RETURN;
    END CATCH

    SELECT @VoucherNo = m.VoucherNo
    FROM dbo.FinishGoodsTransactionMain m
    WHERE m.FGTransactionID = @FGTransactionID;

    SELECT @JobBookingID = MIN(x.JobBookingID),
           @JobBookingNo = STRING_AGG(CAST(ISNULL(j.JobBookingNo, N'') AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY x.JobBookingID),
           @JobName      = STRING_AGG(CAST(ISNULL(j.JobName, N'') AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY x.JobBookingID)
    FROM (SELECT DISTINCT JobBookingID FROM @Jobs) x
    LEFT JOIN dbo.JobBookingJobCard j ON j.JobBookingID = x.JobBookingID;

    SELECT
        @PackedQtyThisVoucher = CAST(ISNULL(SUM(CASE WHEN jx.JobBookingID IS NOT NULL THEN d.ReceiptQuantity END),0) AS INT),
        @CartonQtyThisVoucher = CAST(COUNT(DISTINCT d.Barcode) AS INT)
    FROM dbo.FinishGoodsTransactionDetail d
    LEFT JOIN (SELECT DISTINCT JobBookingID FROM @Jobs) jx ON jx.JobBookingID = d.JobBookingID
    WHERE d.FGTransactionID = @FGTransactionID
      AND ISNULL(d.IsDeletedTransaction,0) = 0;

    SELECT
        @PackedQtyTotal = CAST(ISNULL(SUM(d.ReceiptQuantity),0) AS INT),
        @CartonQtyTotal = CAST(COUNT(DISTINCT d.Barcode) AS INT)
    FROM dbo.FinishGoodsTransactionDetail d
    JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
    WHERE d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
      AND m.VoucherID = @VoucherID_FG
      AND ISNULL(m.IsDeletedTransaction,0) = 0
      AND ISNULL(d.IsDeletedTransaction,0) = 0;

    SELECT
        'Success'                 AS [Status],
        @FGTransactionID          AS FGTransactionID,
        ISNULL(@VoucherNo,'')     AS VoucherNo,
        @JobBookingID             AS JobBookingID,
        ISNULL(@JobBookingNo,N'') AS JobBookingNo,
        ISNULL(@JobName,N'')      AS JobName,
        @PackedQtyThisVoucher     AS PackedQtyThisVoucher,
        @CartonQtyThisVoucher     AS CartonQtyThisVoucher,
        @PackedQtyTotal           AS PackedQtyTotal,
        @CartonQtyTotal           AS CartonQtyTotal;
END
GO

/* ===================== 5. Delivery-note scan ===================== */
/*
 * Same as SaveDeliveryNoteByBarcode_Manu_v2, but writes one DN row per job on
 * the barcode, each linked to that job's GPN row. Same result columns; on a
 * mixed box JobName lists every job and the quantities are their totals.
 */
CREATE OR ALTER PROCEDURE dbo.SaveDeliveryNoteByBarcode_Manu_v3
    @BarcodeNo            BIGINT,
    @Status               VARCHAR(20),   -- 'new-check' | 'new-start' | 'update'
    @UserID               INT,
    @FGTransactionID      INT = NULL,    -- DN master ID for 'update'
    @CompanyID            INT = 2,
    @BranchID             INT = 0,
    @TransporterLedgerID  INT = NULL,
    @ModeOfTransport      NVARCHAR(100) = NULL,
    @VehicleNo            NVARCHAR(50)  = NULL,
    @ContainerNo          NVARCHAR(50)  = NULL,
    @SealNo               NVARCHAR(50)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @StatusNorm        VARCHAR(20)   = LOWER(LTRIM(RTRIM(@Status))),
        @BarcodeStr        NVARCHAR(100) = CONVERT(NVARCHAR(100), @BarcodeNo),
        @Now               DATETIME      = GETDATE(),
        @FYStartYear       INT,
        @FY                NVARCHAR(9),
        @FYShort           NVARCHAR(5),
        @VoucherPrefix     NVARCHAR(2)   = N'DN',
        @VoucherID_DN      INT = -51,
        @VoucherID_FG      INT = -50,
        @NextMaxVoucherNo  INT,
        @VoucherNo         NVARCHAR(50),
        @PS_JobBookingID   INT,
        @PS_BatchNo        NVARCHAR(100) = NULL,
        @JobLedgerID       INT,
        @JobLedgerName     NVARCHAR(200),
        @JobName           NVARCHAR(MAX),
        @OrderQty          INT = 0,
        @TransporterName   NVARCHAR(200),
        @DN_LedgerID       INT,
        @DN_VoucherNo      NVARCHAR(50),
        @GPNQty               INT = 0,
        @DeliveredThisVoucher INT = 0,
        @DeliveredTotal       INT = 0,
        @CartonCt             INT = 0,
        @ExistsDNMain      BIT = 0,
        @LockResult        INT,
        @LockName          NVARCHAR(255),
        @NextTransID       INT,
        @JobCount          INT;

    DECLARE @Jobs TABLE
    (
        Seq                   INT NOT NULL,
        JobBookingID          INT NOT NULL PRIMARY KEY,
        QtyPerBox             INT NOT NULL,
        PS_BatchNo            NVARCHAR(100) NULL,
        LedgerID              INT NULL,
        JobName               NVARCHAR(300) NULL,
        BatchNo               NVARCHAR(100) NULL,
        OrderQty              INT NOT NULL,
        OrderBookingID        INT NULL,
        OrderBookingDetailsID INT NULL,
        ParentFGID            INT NULL,
        ParentFGDetailID      INT NULL
    );

    SET @FYStartYear = YEAR(@Now) - CASE WHEN MONTH(@Now) < 4 THEN 1 ELSE 0 END;
    SET @FY      = CONCAT(@FYStartYear, '-', @FYStartYear + 1);
    SET @FYShort = RIGHT(CONVERT(VARCHAR(4), @FYStartYear), 2) + '_' + RIGHT(CONVERT(VARCHAR(4), @FYStartYear + 1), 2);

    /* ---------------- 1) Jobs on the barcode ---------------- */
    INSERT INTO @Jobs (Seq, JobBookingID, QtyPerBox, PS_BatchNo, LedgerID, JobName, BatchNo, OrderQty,
                       OrderBookingID, OrderBookingDetailsID)
    SELECT ROW_NUMBER() OVER (ORDER BY ps.JobBookingID),
           ps.JobBookingID,
           ISNULL(TRY_CONVERT(INT, ps.QuantityPerBox), 0),
           ps.BatchNo,
           j.LedgerID,
           j.JobName,
           j.JobBookingNo,
           ISNULL(TRY_CONVERT(INT, j.OrderQuantity), 0),
           j.OrderBookingID,
           j.OrderBookingDetailsID
    FROM dbo.PackingSlipBarcodeEntry ps
    JOIN dbo.JobBookingJobCard j ON j.JobBookingID = ps.JobBookingID
    WHERE ps.BarcodeNo = @BarcodeNo;

    SELECT @JobCount = COUNT(*) FROM @Jobs;

    IF @JobCount = 0
    BEGIN
        SELECT 'Fail: False Barcode Num' AS [Status];
        RETURN;
    END

    IF (SELECT COUNT(DISTINCT ISNULL(LedgerID, 0)) FROM @Jobs) > 1
    BEGIN
        SELECT 'Fail: Barcode has jobs of different clients' AS [Status];
        RETURN;
    END

    SELECT @PS_JobBookingID = JobBookingID, @PS_BatchNo = PS_BatchNo, @JobLedgerID = LedgerID
    FROM @Jobs WHERE Seq = 1;

    SELECT @JobName  = STRING_AGG(CAST(ISNULL(JobName, N'') AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY Seq),
           @OrderQty = SUM(OrderQty)
    FROM @Jobs;

    SELECT TOP (1) @JobLedgerName = lm.LedgerName
    FROM dbo.LedgerMaster lm
    WHERE lm.LedgerID = @JobLedgerID;

    /* ---------------- 2) Fast-path reject if already dispatched ---------------- */
    IF EXISTS (
        SELECT 1
        FROM dbo.FinishGoodsTransactionDetail d
        JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
        WHERE d.Barcode = @BarcodeStr
          AND d.IsDeletedTransaction = 0
          AND m.VoucherID = @VoucherID_DN
          AND m.IsDeletedTransaction = 0
    )
    BEGIN
        SELECT 'Fail: Barcode already dispatched' AS [Status];
        RETURN;
    END

    /* ---------------- 3) Each job's GPN line for this barcode ---------------- */
    UPDATE J
    SET ParentFGID = g.FGTransactionID,
        ParentFGDetailID = g.FGTransactionDetailID
    FROM @Jobs J
    CROSS APPLY (
        SELECT TOP (1) d_fg.FGTransactionID, d_fg.FGTransactionDetailID
        FROM dbo.FinishGoodsTransactionDetail d_fg
        JOIN dbo.FinishGoodsTransactionMain  m_fg ON m_fg.FGTransactionID = d_fg.FGTransactionID
        WHERE d_fg.Barcode = @BarcodeStr
          AND d_fg.IsDeletedTransaction = 0
          AND m_fg.VoucherID = @VoucherID_FG
          AND m_fg.IsDeletedTransaction = 0
          AND (d_fg.JobBookingID = J.JobBookingID OR @JobCount = 1)
        ORDER BY CASE WHEN d_fg.JobBookingID = J.JobBookingID THEN 0 ELSE 1 END
    ) g;

    IF EXISTS (SELECT 1 FROM @Jobs WHERE ParentFGID IS NULL)
    BEGIN
        SELECT 'Fail: FG/GPN not found for barcode' AS [Status];
        RETURN;
    END

    /* ---------------- new-check ---------------- */
    IF @StatusNorm = 'new-check'
    BEGIN
        SELECT
            @GPNQty         = CAST(ISNULL(SUM(CASE WHEN m.VoucherID = @VoucherID_FG THEN d.ReceiptQuantity END), 0) AS INT),
            @DeliveredTotal = CAST(ISNULL(SUM(CASE WHEN m.VoucherID = @VoucherID_DN THEN d.IssueQuantity END), 0) AS INT)
        FROM dbo.FinishGoodsTransactionDetail d
        JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
        WHERE d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
          AND d.IsDeletedTransaction = 0
          AND m.IsDeletedTransaction = 0
          AND m.VoucherID IN (@VoucherID_FG, @VoucherID_DN);

        SELECT 'Success' AS [Status],
               @JobLedgerID                AS LedgerID,
               @PS_JobBookingID            AS JobBookingID,
               ISNULL(@JobLedgerName, N'') AS LedgerName,
               ISNULL(@JobName, N'')       AS JobName,
               @PS_BatchNo                 AS BatchNo,
               @OrderQty                   AS OrderQty,
               @GPNQty                     AS GPNQty,
               CAST(0 AS INT)              AS DeliveredThisVoucher,
               @DeliveredTotal             AS DeliveredTotal;
        RETURN;
    END

    IF @StatusNorm NOT IN ('new-start', 'update')
    BEGIN
        SELECT 'Fail: Status must be new-check, new-start, or update' AS [Status];
        RETURN;
    END

    IF @StatusNorm = 'update'
    BEGIN
        IF ISNULL(@FGTransactionID, 0) = 0
        BEGIN
            SELECT 'Fail: FGTransactionID required for update' AS [Status];
            RETURN;
        END

        SELECT TOP (1)
            @ExistsDNMain = CASE WHEN m.IsDeletedTransaction = 0 AND m.VoucherID = @VoucherID_DN THEN 1 ELSE 0 END,
            @DN_LedgerID  = m.LedgerID,
            @DN_VoucherNo = m.VoucherNo
        FROM dbo.FinishGoodsTransactionMain m
        WHERE m.FGTransactionID = @FGTransactionID;

        IF ISNULL(@ExistsDNMain, 0) = 0
        BEGIN
            SELECT 'Fail: DN master not found' AS [Status];
            RETURN;
        END

        IF ISNULL(@DN_LedgerID, 0) <> ISNULL(@JobLedgerID, 0)
        BEGIN
            SELECT 'Fail: Ledger mismatch' AS [Status];
            RETURN;
        END
    END
    ELSE  /* new-start */
    BEGIN
        SET @TransporterLedgerID = ISNULL(@TransporterLedgerID, 0);

        SELECT @TransporterName = lm.LedgerName
        FROM dbo.LedgerMaster lm
        WHERE lm.LedgerID = @TransporterLedgerID;
    END

    BEGIN TRY
        BEGIN TRAN;

        SET @LockName = N'DN_BC_' + @BarcodeStr;
        EXEC @LockResult = sp_getapplock
             @Resource    = @LockName,
             @LockMode    = 'Exclusive',
             @LockOwner   = 'Transaction',
             @LockTimeout = 5000;

        IF @LockResult < 0
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Could not acquire save lock, please retry' AS [Status];
            RETURN;
        END

        IF EXISTS (
            SELECT 1
            FROM dbo.FinishGoodsTransactionDetail d
            JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
            WHERE d.Barcode = @BarcodeStr
              AND d.IsDeletedTransaction = 0
              AND m.VoucherID = @VoucherID_DN
              AND m.IsDeletedTransaction = 0
        )
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Barcode already dispatched' AS [Status];
            RETURN;
        END

        IF @StatusNorm = 'new-start'
        BEGIN
            DECLARE @NextNo TABLE (NextNo INT);

            UPDATE vc WITH (UPDLOCK, ROWLOCK)
            SET LastNo = LastNo + 1
            OUTPUT inserted.LastNo INTO @NextNo(NextNo)
            FROM dbo.VoucherCounter vc
            WHERE vc.VoucherPrefix = @VoucherPrefix
              AND vc.FYear = @FY;

            IF @@ROWCOUNT = 0
            BEGIN
                INSERT dbo.VoucherCounter (VoucherPrefix, FYear, LastNo)
                OUTPUT inserted.LastNo INTO @NextNo(NextNo)
                SELECT @VoucherPrefix, @FY, ISNULL(MAX(m.MaxVoucherNo), 0) + 1
                FROM dbo.FinishGoodsTransactionMain m WITH (UPDLOCK, HOLDLOCK)
                WHERE m.VoucherPrefix = @VoucherPrefix AND m.FYear = @FY;
            END

            SELECT @NextMaxVoucherNo = NextNo FROM @NextNo;
            SET @VoucherNo = CONCAT(@VoucherPrefix, @NextMaxVoucherNo, '/', @FYShort);

            INSERT INTO dbo.FinishGoodsTransactionMain
            (
                VoucherID, MaxVoucherNo, VoucherPrefix, VoucherNo, VoucherDate,
                SemiPackingMainID, JobBookingID, JobBookingJobCardContentsID, ProductMasterID,
                BookingID, OrderBookingID, OrderBookingDetailsID, LedgerID, ConsigneeLedgerID,
                TotalOuterCarton, TotalInnerCarton, TotalQuantity,
                TotalBasicAmount, TotalDiscountAmount, TotalCGSTTaxAmount, TotalSGSTTaxAmount, TotalIGSTTaxAmount, TotalTaxAmount, NetAmount,
                AmountInWords, CurrencyCode, ConversionRate, ModeOfTransport, Transporter, VehicleNo, PODNo, Narration,
                DeliveryNoteNo, DeliveryNoteDate, DeliveryNoteTransactionID,
                CompanyID, BranchID, UserID, IsDeleted, IsBlocked, FYear, IsLocked,
                CreatedBy, CreatedDate, ModifiedBy, ModifiedDate, DeletedBy, DeletedDate, IsDeletedTransaction,
                CheckedBy, TransporterName, IsIntegrated, InvoiceTransactionID, ProductionUnitID, ResortingTransactionID,
                IsDespatchFreightEntryDone, ContainerNo, SealNo
            )
            VALUES
            (
                @VoucherID_DN, @NextMaxVoucherNo, @VoucherPrefix, @VoucherNo, @Now,
                0, 0, 0, 0,
                0, 0, 0, @JobLedgerID, 0,
                0, 0, 0,
                0, 0, 0, 0, 0, 0, 0,
                N'', N'INR', 0, ISNULL(@ModeOfTransport, N''), CONVERT(NVARCHAR(50), @TransporterLedgerID), ISNULL(@VehicleNo, N''), N'', N'',
                N'', NULL, 0,
                @CompanyID, @BranchID, @UserID, 0, 0, @FY, 0,
                @UserID, @Now, NULL, NULL, NULL, NULL, 0,
                NULL, ISNULL(@TransporterName, N''), 0, 0, 0, 0,
                0, ISNULL(@ContainerNo, N''), ISNULL(@SealNo, N'')
            );

            SET @FGTransactionID = CAST(SCOPE_IDENTITY() AS INT);
            SET @DN_VoucherNo    = @VoucherNo;
            SET @NextTransID     = 1;
        END
        ELSE  /* update */
        BEGIN
            SELECT @NextTransID = ISNULL(MAX(d.TransID), 0) + 1
            FROM dbo.FinishGoodsTransactionDetail d WITH (UPDLOCK, HOLDLOCK)
            WHERE d.FGTransactionID = @FGTransactionID;
        END

        INSERT INTO dbo.FinishGoodsTransactionDetail
        (
            FGTransactionID, ParentFGTransactionID, ParentFGTransactionDetailID,
            TransID, SemiPackingMainID, SemiPackingDetailID,
            JobBookingID, JobBookingJobCardContentsID, ProductMasterID,
            BookingID, OrderBookingID, OrderBookingDetailsID,
            DeliveryOrderBookingID, DeliveryOrderBookingDetailsID,
            DeliveryJobBookingID, DeliveryJobBookingJobCardContentsID,
            ProductHSNID,
            ReceiptQuantity, IssueQuantity,
            ReceiptOuterCarton, IssueOuterCarton,
            OuterCarton, InnerCarton, QuantityPerPack, WeightPerOuterCarton,
            ReceiptTotalWeight, IssueTotalWeight, TotalWeight,
            Unit, Rate, GrossAmount, DiscountPercentage, DiscountAmount, BasicAmount, TaxableAmount,
            GSTPercentage, CGSTPercentage, SGSTPercentage, IGSTPercentage, CGSTAmount, SGSTAmount, IGSTAmount,
            NetAmount, LandedRate,
            BatchNo, WarehouseID, PackingDescription,
            ShipperLengthCM, ShipperWidthCM, ShipperHeightCM, CBCM, CFT, TotalCFT,
            CompanyID, BranchID, UserID, IsDeleted, IsBlocked, FYear, IsLocked,
            CreatedBy, CreatedDate, ModifiedBy, ModifiedDate, DeletedBy, DeletedDate, IsDeletedTransaction,
            ReturnQuantity, QCApprovedQuantity, QCRejectedQuantity, QCHoldQuantity,
            ProductionUnitID, GrossWeightPerOuterCarton, Barcode
        )
        SELECT
            @FGTransactionID, J.ParentFGID, J.ParentFGDetailID,
            @NextTransID + J.Seq - 1, 0, 0,
            J.JobBookingID, 0, 0,
            0, J.OrderBookingID, J.OrderBookingDetailsID,
            J.OrderBookingID, J.OrderBookingDetailsID,
            J.JobBookingID, 0,
            0,
            0, J.QtyPerBox,
            0, CASE WHEN J.Seq = 1 THEN 1 ELSE 0 END,
            CASE WHEN J.Seq = 1 THEN 1 ELSE 0 END, 1, J.QtyPerBox, 0,
            0, 0, 0,
            N'', 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
            0, 0,
            ISNULL(J.BatchNo, N''), 16, N'',
            0, 0, 0, 0, 0, 0,
            @CompanyID, @BranchID, @UserID, 0, 0, @FY, 0,
            @UserID, @Now, NULL, NULL, NULL, NULL, 0,
            0, 0, 0, 0,
            0, 0, @BarcodeStr
        FROM @Jobs AS J;

        COMMIT TRAN;

        SELECT
            @DeliveredThisVoucher = CAST(ISNULL(SUM(d.IssueQuantity), 0) AS INT),
            @CartonCt             = COUNT(DISTINCT d.Barcode)
        FROM dbo.FinishGoodsTransactionDetail d
        WHERE d.FGTransactionID = @FGTransactionID
          AND d.IsDeletedTransaction = 0;

        SELECT
            @GPNQty         = CAST(ISNULL(SUM(CASE WHEN m.VoucherID = @VoucherID_FG THEN d.ReceiptQuantity END), 0) AS INT),
            @DeliveredTotal = CAST(ISNULL(SUM(CASE WHEN m.VoucherID = @VoucherID_DN THEN d.IssueQuantity END), 0) AS INT)
        FROM dbo.FinishGoodsTransactionDetail d
        JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
        WHERE d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
          AND d.IsDeletedTransaction = 0
          AND m.IsDeletedTransaction = 0
          AND m.VoucherID IN (@VoucherID_FG, @VoucherID_DN);

        SELECT 'Success' AS [Status],
               @FGTransactionID      AS FGTransactionID,
               @DN_VoucherNo         AS VoucherNo,
               ISNULL(@JobName, N'') AS JobName,
               @PS_BatchNo           AS BatchNo,
               @OrderQty             AS OrderQty,
               @GPNQty               AS GPNQty,
               @DeliveredThisVoucher AS DeliveredThisVoucher,
               @DeliveredTotal       AS DeliveredTotal,
               @CartonCt             AS CartonCt;
        RETURN;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        SELECT 'Fail: ' + ERROR_MESSAGE() AS [Status];
        RETURN;
    END CATCH
END
GO

/* ===================== 6. Delivery-note delete ===================== */
/*
 * Same as DeleteDeliveryNoteByBarcode_Manu (including the 4-hour window), but
 * removes every job's row for the barcode and compares the barcode as text.
 */
CREATE OR ALTER PROCEDURE dbo.DeleteDeliveryNoteByBarcode_Manu_v2
    @BarcodeNo   BIGINT,
    @UserID      INT,
    @CompanyID   INT = 2,
    @BranchID    INT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Now                DATETIME      = GETDATE(),
        @BarcodeStr         NVARCHAR(100) = CONVERT(NVARCHAR(100), @BarcodeNo),
        @VoucherID_DN       INT           = -51,
        @DNTransactionID    INT,
        @JobBookingID       INT,
        @VoucherNo          NVARCHAR(50),
        @CreateDtDetail     DATETIME,
        @CreateDtMain       DATETIME,
        @EffectiveCreateDt  DATETIME,
        @JobName            NVARCHAR(MAX) = N'',
        @OrderQty           INT = 0,
        @LockResult         INT,
        @DeliveredThisVoucher INT = 0,
        @DeliveredTotal       INT = 0,
        @CartonCt             INT = 0;

    DECLARE @Jobs TABLE (JobBookingID INT NOT NULL);

    SELECT TOP (1)
        @DNTransactionID = d.FGTransactionID,
        @CreateDtDetail  = d.CreatedDate
    FROM dbo.FinishGoodsTransactionDetail d
    JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
    WHERE d.Barcode = @BarcodeStr
      AND m.VoucherID = @VoucherID_DN
      AND ISNULL(m.IsDeletedTransaction,0) = 0
      AND ISNULL(d.IsDeletedTransaction,0) = 0;

    IF @DNTransactionID IS NULL
    BEGIN
        SELECT 'Fail: Barcode not found in active Delivery Note' AS [Status];
        RETURN;
    END

    SELECT @VoucherNo = m.VoucherNo, @CreateDtMain = m.CreatedDate
    FROM dbo.FinishGoodsTransactionMain m
    WHERE m.FGTransactionID = @DNTransactionID;

    SET @EffectiveCreateDt = ISNULL(ISNULL(@CreateDtDetail, @CreateDtMain), @Now);

    IF DATEDIFF(HOUR, @EffectiveCreateDt, @Now) > 4
    BEGIN
        SELECT 'Fail: DN deletion window (4 hours) has elapsed' AS [Status],
               @VoucherNo AS VoucherNo;
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        DECLARE @LockName NVARCHAR(255) = N'DN_BC_' + @BarcodeStr;
        EXEC @LockResult = sp_getapplock
             @Resource = @LockName, @LockMode = 'Exclusive',
             @LockOwner = 'Transaction', @LockTimeout = 5000;
        IF @LockResult < 0
        BEGIN
            ROLLBACK TRAN;
            SELECT 'Fail: Could not acquire lock, please retry' AS [Status];
            RETURN;
        END

        UPDATE dbo.FinishGoodsTransactionDetail
        SET IsDeletedTransaction = 1,
            DeletedBy            = @UserID,
            DeletedDate          = @Now,
            ModifiedBy           = @UserID,
            ModifiedDate         = @Now
        OUTPUT inserted.JobBookingID INTO @Jobs (JobBookingID)
        WHERE FGTransactionID = @DNTransactionID
          AND Barcode = @BarcodeStr
          AND ISNULL(IsDeletedTransaction,0) = 0;

        IF NOT EXISTS (
            SELECT 1
            FROM dbo.FinishGoodsTransactionDetail d
            WHERE d.FGTransactionID = @DNTransactionID
              AND ISNULL(d.IsDeletedTransaction,0) = 0
        )
        BEGIN
            UPDATE dbo.FinishGoodsTransactionMain
            SET IsDeletedTransaction = 1,
                DeletedBy            = @UserID,
                DeletedDate          = @Now,
                ModifiedBy           = @UserID,
                ModifiedDate         = @Now
            WHERE FGTransactionID = @DNTransactionID
              AND ISNULL(IsDeletedTransaction,0) = 0;
        END

        COMMIT TRAN;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRAN;
        SELECT 'Fail: ' + ERROR_MESSAGE() AS [Status];
        RETURN;
    END CATCH

    SELECT @JobBookingID = MIN(x.JobBookingID),
           @JobName      = STRING_AGG(CAST(ISNULL(j.JobName, N'') AS NVARCHAR(MAX)), N', ') WITHIN GROUP (ORDER BY x.JobBookingID),
           @OrderQty     = SUM(ISNULL(TRY_CONVERT(INT, j.OrderQuantity), 0))
    FROM (SELECT DISTINCT JobBookingID FROM @Jobs) x
    LEFT JOIN dbo.JobBookingJobCard j ON j.JobBookingID = x.JobBookingID;

    SELECT
        @DeliveredThisVoucher = CAST(ISNULL(SUM(CASE WHEN jx.JobBookingID IS NOT NULL THEN d.IssueQuantity END),0) AS INT),
        @CartonCt             = COUNT(DISTINCT d.Barcode)
    FROM dbo.FinishGoodsTransactionDetail d
    LEFT JOIN (SELECT DISTINCT JobBookingID FROM @Jobs) jx ON jx.JobBookingID = d.JobBookingID
    WHERE d.FGTransactionID = @DNTransactionID
      AND ISNULL(d.IsDeletedTransaction,0) = 0;

    SELECT @DeliveredTotal = CAST(ISNULL(SUM(d.IssueQuantity),0) AS INT)
    FROM dbo.FinishGoodsTransactionDetail d
    JOIN dbo.FinishGoodsTransactionMain  m ON m.FGTransactionID = d.FGTransactionID
    WHERE d.JobBookingID IN (SELECT JobBookingID FROM @Jobs)
      AND m.VoucherID = @VoucherID_DN
      AND ISNULL(m.IsDeletedTransaction,0) = 0
      AND ISNULL(d.IsDeletedTransaction,0) = 0;

    SELECT
        'Success'              AS [Status],
        @DNTransactionID       AS FGTransactionID,
        ISNULL(@VoucherNo,'')  AS VoucherNo,
        @JobBookingID          AS JobBookingID,
        ISNULL(@JobName,N'')   AS JobName,
        ISNULL(@OrderQty,0)    AS OrderQty,
        @DeliveredThisVoucher  AS DeliveredThisVoucher,
        @DeliveredTotal        AS DeliveredTotal,
        @CartonCt              AS CartonCt;
END
GO

/* ===================== Check ===================== */
SELECT name, modify_date
FROM sys.procedures
WHERE name IN ('InsertPackingSlipBarcodeMixed_Manu', 'SaveFinishGoodsByBarcode_Manu_v4',
               'DeleteFinishGoodsByBarcode_Manu_v2', 'SaveDeliveryNoteByBarcode_Manu_v3',
               'DeleteDeliveryNoteByBarcode_Manu_v2');

SELECT i.name AS unique_rule
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID('dbo.PackingSlipBarcodeEntry') AND i.is_unique = 1;
