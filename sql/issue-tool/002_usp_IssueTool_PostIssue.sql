/*
================================================================================
  usp_IssueTool_PostIssue  —  posts one stock issue (VoucherID -19) atomically
================================================================================
  Called by POST /api/issue-tool/issues. Brief sections 5, 6.1, 6.3 and 6.6.

  Writes exactly one ItemTransactionMain row and one ItemTransactionDetail row
  per batch line, plus one IssueTool_PostLog row. Nothing else is inserted or
  updated, and no ERP procedure is called from here.

  It does NOT call dbo.UPDATE_ITEM_STOCK_VALUES. The API runs that as a separate
  call after this procedure has committed and returned, so a slow or failing
  stock refresh can never hold the numbering lock and can never cost the client
  the voucher number it just got (brief 6.1 step 4).

  Order of work
  -------------
    1. Idempotency: a RequestId already posted is answered with its voucher.
    2. Re-read every referenced row (picklist line, job content, item, batch,
       floor warehouse) and take IDs from the database, not from the client.
       Hard errors are raised with THROW 51xxx, message "CODE: text".
    3. Warnings (over-issue). If there are any and @AcknowledgeWarnings = 0,
       return them without writing anything and without taking a number.
    4. Transaction: applock, number = MAX + 1 (deleted vouchers included),
       insert header, check no other header took the same number, insert
       lines, write the log. A clash with the ERP is rolled back and retried,
       up to 3 attempts.
    5. @DryRun = 1: snapshot the inserted rows as JSON, then roll back.

  Result sets (always all three, in this order)
  ---------------------------------------------
    1. Status    one row: Status (POSTED | REPLAYED | DRY_RUN | WARNINGS),
                 TransactionID, VoucherNo, MaxVoucherNo, FYear, VoucherDate,
                 Attempts, DryRunHeaderJson, DryRunLinesJson
    2. Warnings  Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message
    3. Lines     TransID, TransactionDetailID

  Template columns
  ----------------
  Only the columns the brief confirms (section 5) are written; every other
  column takes its table default. Discovery on 5 Oct 2026 compared this list
  with ERP-created vouchers IS17300_26_27 (allocated) and IS17302_26_27
  (direct): no other column differs from its default, so nothing is missing.
  Re-run scripts/issue-tool-discover.js after an ERP upgrade.

  Note: the ERP's own -19 numbering already produces the odd duplicate
  (discovery section 6), and the database runs READ_COMMITTED_SNAPSHOT. The
  locking reads below narrow the window in which an ERP save and this
  procedure can pick the same number; they cannot close it, because the ERP
  does not take any lock of its own.

  Idempotent: CREATE OR ALTER (SQL Server 2016 SP1+). OPENJSON and FOR JSON need
  database compatibility level 130 or higher; the discovery script reports it.
================================================================================
*/

CREATE OR ALTER PROCEDURE dbo.usp_IssueTool_PostIssue
    @CompanyID           INT,
    @UserID              INT,
    @VoucherDate         DATE,
    @Mode                VARCHAR(10),            -- ALLOCATED | DIRECT
    @PicklistDetailID    BIGINT         = NULL,  -- ALLOCATED: ItemTransactionDetail.TransactionDetailID of the -17 line
    @JobContentID        BIGINT         = NULL,  -- DIRECT: JobBookingJobCardContentsID
    @DepartmentID        BIGINT         = NULL,  -- DIRECT: chosen department
    @SlipNo              NVARCHAR(100)  = NULL,  -- DIRECT: Slip No.; voucher number when blank
    @FloorWarehouseID    BIGINT,
    @Remark              NVARCHAR(500)  = NULL,
    @LinesJson           NVARCHAR(MAX),          -- [{itemId, parentTransactionId, warehouseId, batchNo, quantity}]
    @RequestID           UNIQUEIDENTIFIER,
    @PayloadJson         NVARCHAR(MAX),
    @AcknowledgeWarnings BIT            = 0,
    @DryRun              BIT            = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    /* One -19 sequence per CompanyID + FYear. Discovery (5 Oct 2026): only
       CompanyID 2 has -19 vouchers and no number appears in two companies, so
       per-company and global give the same number today; per-company matches
       how every other ERP sequence is scoped and lets the MAX use the
       (VoucherID, CompanyID, FYear) index. */
    DECLARE @NumberPerCompany BIT = 1;

    DECLARE @VoucherID INT = -19;
    DECLARE @Prefix    NVARCHAR(10) = N'IS';
    /* Blank strings exactly as the ERP writes them on a -19 (discovery item 7,
       vouchers IS17300 and IS17302, and the captured IS17252): DeliveryNoteNo
       is one space (the column default), Narration is an empty string (NOT the
       column default, which is one space). */
    DECLARE @BlankDeliveryNoteNo NVARCHAR(10) = N' ';
    DECLARE @BlankNarration      NVARCHAR(10) = N'';

    DECLARE @StatusPosted   VARCHAR(10) = 'POSTED',
            @StatusReplayed VARCHAR(10) = 'REPLAYED',
            @StatusDryRun   VARCHAR(10) = 'DRY_RUN',
            @StatusWarnings VARCHAR(10) = 'WARNINGS';

    DECLARE @Warnings TABLE (
        Seq       INT IDENTITY(1,1) PRIMARY KEY,
        Code      VARCHAR(40)    NOT NULL,
        LineNum    INT            NULL,
        ItemID    BIGINT         NULL,
        Quantity  DECIMAL(18,4)  NULL,
        Limit     DECIMAL(18,4)  NULL,
        StockUnit NVARCHAR(50)   NULL,
        Message   NVARCHAR(1000) NOT NULL
    );
    DECLARE @LineIds TABLE (TransID INT NOT NULL, TransactionDetailID BIGINT NOT NULL);

    /* ── 1. Idempotency ──────────────────────────────────────────────────── */
    DECLARE @PrevTransactionID BIGINT, @PrevVoucherNo NVARCHAR(50);
    SELECT @PrevTransactionID = TransactionID, @PrevVoucherNo = VoucherNo
    FROM dbo.IssueTool_PostLog
    WHERE RequestId = @RequestID AND IsDryRun = 0;

    IF @PrevTransactionID IS NOT NULL
    BEGIN
        GOTO Replay;
    END

    /* ── 2. Inputs ───────────────────────────────────────────────────────── */
    IF @Mode NOT IN ('ALLOCATED', 'DIRECT')
        THROW 51011, N'INVALID_MODE: Mode must be ALLOCATED or DIRECT.', 1;
    IF @CompanyID IS NULL OR @UserID IS NULL OR @UserID <= 0
        THROW 51012, N'MISSING_FIELD: CompanyID and UserID are required.', 1;
    IF @VoucherDate IS NULL
        THROW 51012, N'MISSING_FIELD: Voucher date is required.', 1;
    IF @FloorWarehouseID IS NULL
        THROW 51003, N'FLOOR_WAREHOUSE_REQUIRED: Choose a floor warehouse and bin.', 1;

    DECLARE @Lines TABLE (
        LineNum              INT            NOT NULL PRIMARY KEY,
        ItemID              BIGINT         NULL,
        ParentTransactionID BIGINT         NULL,
        WarehouseID         BIGINT         NULL,
        BatchNo             NVARCHAR(200)  NULL,   -- normalised: NULLIF(batchNo, '')
        Quantity            DECIMAL(18,4)  NULL,
        -- resolved from the database
        ItemGroupID         BIGINT         NULL,
        StockUnit           NVARCHAR(50)   NULL,
        StockUnitKey        NVARCHAR(50)   NULL,   -- UPPER(LTRIM(RTRIM(StockUnit)))
        GroupRows           INT            NULL,
        BatchStock          DECIMAL(18,4)  NULL,
        BatchID             BIGINT         NULL,
        BatchNoStored       NVARCHAR(200)  NULL    -- BatchNo exactly as on the receipt row
    );

    INSERT INTO @Lines (LineNum, ItemID, ParentTransactionID, WarehouseID, BatchNo, Quantity)
    SELECT CAST(j.[key] AS INT) + 1,
           v.itemId,
           ISNULL(v.parentTransactionId, 0),
           ISNULL(v.warehouseId, 0),
           NULLIF(v.batchNo, N''),
           v.quantity
    FROM OPENJSON(@LinesJson) AS j
    CROSS APPLY OPENJSON(j.[value]) WITH (
        itemId              BIGINT         '$.itemId',
        parentTransactionId BIGINT         '$.parentTransactionId',
        warehouseId         BIGINT         '$.warehouseId',
        batchNo             NVARCHAR(200)  '$.batchNo',
        quantity            DECIMAL(18,4)  '$.quantity'
    ) AS v;

    IF NOT EXISTS (SELECT 1 FROM @Lines)
        THROW 51001, N'NO_LINES: Add at least one batch line.', 1;
    IF EXISTS (SELECT 1 FROM @Lines WHERE Quantity IS NULL OR Quantity <= 0)
        THROW 51002, N'INVALID_QUANTITY: Every quantity must be greater than zero.', 1;

    /* Floor warehouse + bin: WarehouseMaster.IsFloorWarehouse = 1 (confirmed by
       discovery: 16 Floor-Panchla / Paper and 14 Floor-Tangra / Floor). */
    IF NOT EXISTS (
        SELECT 1 FROM dbo.WarehouseMaster
        WHERE WarehouseID = @FloorWarehouseID AND CompanyID = @CompanyID
          AND ISNULL(IsFloorWarehouse, 0) = 1
          AND ISNULL(IsDeletedTransaction, 0) = 0
    )
        THROW 51003, N'UNKNOWN_FLOOR_WAREHOUSE: The floor warehouse does not exist or is not a floor warehouse.', 1;

    /* Items */
    UPDATE L
    SET ItemGroupID  = IM.ItemGroupID,
        StockUnit    = IM.StockUnit,
        StockUnitKey = UPPER(LTRIM(RTRIM(ISNULL(IM.StockUnit, N''))))
    FROM @Lines L
    JOIN dbo.ItemMaster IM ON IM.ItemID = L.ItemID AND IM.CompanyID = @CompanyID;

    IF EXISTS (SELECT 1 FROM @Lines WHERE ItemGroupID IS NULL)
    BEGIN
        DECLARE @BadItemLine INT = (SELECT MIN(LineNum) FROM @Lines WHERE ItemGroupID IS NULL);
        DECLARE @BadItemMsg NVARCHAR(400) = CONCAT(N'UNKNOWN_ITEM: Line ', @BadItemLine, N' refers to an item that does not exist.');
        THROW 51004, @BadItemMsg, 1;
    END

    /* Batches: the grouping UPDATE_ITEM_STOCK_VALUES uses (brief 6.4), so the
       stock here is the stock the ERP will compute. Recomputed at save time. */
    UPDATE L
    SET GroupRows  = G.GroupRows,
        BatchStock = G.BatchStock,
        BatchID    = COALESCE(R.BatchID, G.AnyBatchID),
        BatchNoStored = COALESCE(R.BatchNo, G.AnyBatchNo, L.BatchNo)
    FROM @Lines L
    OUTER APPLY (
        SELECT COUNT(*) AS GroupRows,
               SUM(ISNULL(D.ReceiptQuantity, 0) - ISNULL(D.IssueQuantity, 0) - ISNULL(D.RejectedQuantity, 0)) AS BatchStock,
               MAX(D.BatchID) AS AnyBatchID,
               MAX(D.BatchNo) AS AnyBatchNo
        FROM dbo.ItemTransactionDetail D
        JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
        WHERE D.ItemID = L.ItemID
          AND D.CompanyID = @CompanyID
          AND ISNULL(D.IsDeletedTransaction, 0) = 0
          AND ISNULL(D.IsCancelled, 0) = 0
          AND ISNULL(M.IsDeletedTransaction, 0) = 0
          AND M.VoucherID NOT IN (-8, -9, -11)
          AND ISNULL(D.ParentTransactionID, 0) = L.ParentTransactionID
          AND ISNULL(D.WarehouseID, 0) = L.WarehouseID
          AND ISNULL(NULLIF(D.BatchNo, N''), N'') = ISNULL(L.BatchNo, N'')
    ) G
    OUTER APPLY (
        -- The receipt line that created the batch.
        SELECT TOP (1) RD.BatchID, RD.BatchNo
        FROM dbo.ItemTransactionDetail RD
        WHERE RD.TransactionID = L.ParentTransactionID
          AND RD.ItemID = L.ItemID
          AND RD.CompanyID = @CompanyID
          AND ISNULL(RD.WarehouseID, 0) = L.WarehouseID
          AND ISNULL(NULLIF(RD.BatchNo, N''), N'') = ISNULL(L.BatchNo, N'')
          AND ISNULL(RD.IsDeletedTransaction, 0) = 0
        ORDER BY RD.TransactionDetailID
    ) R;

    IF EXISTS (SELECT 1 FROM @Lines WHERE ISNULL(GroupRows, 0) = 0)
    BEGIN
        DECLARE @BadBatchLine INT = (SELECT MIN(LineNum) FROM @Lines WHERE ISNULL(GroupRows, 0) = 0);
        DECLARE @BadBatchMsg NVARCHAR(400) = CONCAT(N'BATCH_NOT_OF_ITEM: Line ', @BadBatchLine, N' uses a batch that does not belong to its item.');
        THROW 51005, @BadBatchMsg, 1;
    END

    /* Mode-specific context */
    DECLARE @HdrDepartmentID BIGINT, @JobBookingID BIGINT, @ContentsID BIGINT,
            @PickTransactionID BIGINT, @PickItemID BIGINT, @PickRequired DECIMAL(18,4),
            @PickMachineID BIGINT, @PickDepartmentID BIGINT, @PickProcessID BIGINT,
            @PickCompleted BIT, @HdrDeliveryNoteNo NVARCHAR(100);

    IF @Mode = 'ALLOCATED'
    BEGIN
        IF @PicklistDetailID IS NULL
            THROW 51012, N'MISSING_FIELD: picklistDetailId is required for an allocated issue.', 1;

        SELECT @PickTransactionID = P.TransactionID,
               @PickItemID        = P.ItemID,
               @PickRequired      = ISNULL(P.RequiredQuantity, 0),
               @JobBookingID      = P.JobBookingID,
               @ContentsID        = P.JobBookingJobCardContentsID,
               @PickMachineID     = P.MachineID,
               @PickDepartmentID  = P.DepartmentID,
               @PickProcessID     = P.ProcessID,
               @PickCompleted     = ISNULL(P.IsCompleted, 0)
        FROM dbo.ItemTransactionDetail P
        JOIN dbo.ItemTransactionMain PM ON PM.TransactionID = P.TransactionID
        WHERE P.TransactionDetailID = @PicklistDetailID
          AND PM.VoucherID = -17
          AND PM.CompanyID = @CompanyID
          AND ISNULL(PM.IsDeletedTransaction, 0) = 0
          AND ISNULL(P.IsDeletedTransaction, 0) = 0
          AND ISNULL(P.IsCancelled, 0) = 0;

        IF @PickTransactionID IS NULL
            THROW 51006, N'UNKNOWN_PICKLIST_LINE: The picklist line does not exist or has been deleted.', 1;
        IF @PickCompleted = 1
            THROW 51007, N'PICKLIST_LINE_CLOSED: The picklist line is closed.', 1;
        IF EXISTS (SELECT 1 FROM @Lines WHERE ItemID <> @PickItemID)
            THROW 51008, N'ITEM_NOT_ON_PICKLIST: An allocated issue can only issue the picklist line''s item. Use Direct issue for a substitute.', 1;

        -- ASSUMPTION (brief 7): the header department comes from the picklist line.
        SET @HdrDepartmentID   = @PickDepartmentID;
        SET @HdrDeliveryNoteNo = @BlankDeliveryNoteNo;
    END
    ELSE
    BEGIN
        IF @JobContentID IS NULL
            THROW 51012, N'MISSING_FIELD: jobContentId is required for a direct issue.', 1;
        IF @DepartmentID IS NULL
            THROW 51012, N'MISSING_FIELD: departmentId is required for a direct issue.', 1;

        SELECT @ContentsID   = JC.JobBookingJobCardContentsID,
               @JobBookingID = JC.JobBookingID
        FROM dbo.JobBookingJobCardContents JC
        WHERE JC.JobBookingJobCardContentsID = @JobContentID
          AND JC.CompanyID = @CompanyID
          AND ISNULL(JC.IsDeletedTransaction, 0) = 0;

        IF @ContentsID IS NULL
            THROW 51009, N'UNKNOWN_JOB_CONTENT: The job content does not exist or has been deleted.', 1;

        -- DepartmentMaster.DepartmentID is the ID the ERP stores (100 = PRINTING);
        -- its own key column is ID, which is not used.
        IF NOT EXISTS (SELECT 1 FROM dbo.DepartmentMaster
                       WHERE DepartmentID = @DepartmentID AND CompanyID = @CompanyID
                         AND ISNULL(IsDeletedTransaction, 0) = 0)
            THROW 51010, N'UNKNOWN_DEPARTMENT: The department does not exist.', 1;

        SET @HdrDepartmentID   = @DepartmentID;
        SET @HdrDeliveryNoteNo = NULLIF(LTRIM(RTRIM(@SlipNo)), N'');   -- voucher number filled in below when blank
    END

    /* ── 3. Warnings ─────────────────────────────────────────────────────── */
    DECLARE @TotalQty DECIMAL(18,4) = (SELECT SUM(Quantity) FROM @Lines);

    IF @Mode = 'ALLOCATED'
    BEGIN
        DECLARE @PickIssued DECIMAL(18,4) = (
            SELECT ISNULL(SUM(ISNULL(D.IssueQuantity, 0)), 0)
            FROM dbo.ItemTransactionDetail D
            JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
            WHERE M.VoucherID = -19
              AND M.CompanyID = @CompanyID
              AND ISNULL(M.IsDeletedTransaction, 0) = 0
              AND ISNULL(D.IsDeletedTransaction, 0) = 0
              AND ISNULL(D.IsCancelled, 0) = 0
              AND D.PicklistTransactionID = @PickTransactionID
              AND D.ItemID = @PickItemID
              AND D.JobBookingJobCardContentsID = @ContentsID
        );
        DECLARE @PickPending DECIMAL(18,4) = @PickRequired - @PickIssued;
        IF @TotalQty > @PickPending
            INSERT INTO @Warnings (Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message)
            SELECT TOP (1) 'OVER_PICKLIST_PENDING', NULL, @PickItemID, @TotalQty, @PickPending, L.StockUnit,
                   CONCAT(N'Total ', FORMAT(@TotalQty, '0.###'), N' ', L.StockUnit,
                          N' is more than the picklist''s pending ', FORMAT(@PickPending, '0.###'), N' ', L.StockUnit, N'.')
            FROM @Lines L ORDER BY L.LineNum;
    END
    ELSE
    BEGIN
        /* ASSUMPTION: a substitute counts against the job's requirement for the
           same item group and stock unit (a substitute is the same spec from a
           different mill, so it shares the group). Issued includes every live
           -19 line to this content in that group and unit, allocated or not. */
        INSERT INTO @Warnings (Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message)
        SELECT 'OVER_JOB_PENDING', NULL, NULL, LG.Qty, ISNULL(RQ.Required, 0) - ISNULL(ISS.Issued, 0), LG.StockUnit,
               CASE WHEN ISNULL(RQ.Required, 0) = 0
                    THEN CONCAT(N'The job content has no planned requirement for this item group in ', LG.StockUnit,
                                N'. Issuing ', FORMAT(LG.Qty, '0.###'), N' ', LG.StockUnit, N' is all over-issue.')
                    ELSE CONCAT(N'Total ', FORMAT(LG.Qty, '0.###'), N' ', LG.StockUnit,
                                N' is more than the job''s pending requirement of ',
                                FORMAT(ISNULL(RQ.Required, 0) - ISNULL(ISS.Issued, 0), '0.###'), N' ', LG.StockUnit, N'.')
               END
        FROM (
            SELECT ItemGroupID, StockUnitKey, MIN(StockUnit) AS StockUnit, SUM(Quantity) AS Qty
            FROM @Lines GROUP BY ItemGroupID, StockUnitKey
        ) LG
        OUTER APPLY (
            SELECT SUM(ISNULL(JM.RequiredQuantityInStockUnit, 0)) AS Required
            FROM dbo.JobBookingJobCardProcessMaterialRequirement JM
            JOIN dbo.ItemMaster IM ON IM.ItemID = JM.ItemID AND IM.CompanyID = JM.CompanyID
            WHERE JM.JobBookingJobCardContentsID = @ContentsID
              AND JM.CompanyID = @CompanyID
              AND ISNULL(JM.IsDeletedTransaction, 0) = 0
              AND IM.ItemGroupID = LG.ItemGroupID
              AND UPPER(LTRIM(RTRIM(ISNULL(IM.StockUnit, N'')))) = LG.StockUnitKey
        ) RQ
        OUTER APPLY (
            SELECT SUM(ISNULL(D.IssueQuantity, 0)) AS Issued
            FROM dbo.ItemTransactionDetail D
            JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
            JOIN dbo.ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
            WHERE M.VoucherID = -19
              AND M.CompanyID = @CompanyID
              AND ISNULL(M.IsDeletedTransaction, 0) = 0
              AND ISNULL(D.IsDeletedTransaction, 0) = 0
              AND ISNULL(D.IsCancelled, 0) = 0
              AND D.JobBookingJobCardContentsID = @ContentsID
              AND IM.ItemGroupID = LG.ItemGroupID
              AND UPPER(LTRIM(RTRIM(ISNULL(IM.StockUnit, N'')))) = LG.StockUnitKey
        ) ISS
        WHERE LG.Qty > ISNULL(RQ.Required, 0) - ISNULL(ISS.Issued, 0);
    END

    -- Per batch: several lines may draw on the same batch, so compare the sum.
    INSERT INTO @Warnings (Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message)
    SELECT 'OVER_BATCH_STOCK', B.FirstLine, B.ItemID, B.Qty, B.BatchStock, B.StockUnit,
           CONCAT(N'Line ', B.FirstLine, N' takes ', FORMAT(B.Qty, '0.###'), N' ', B.StockUnit,
                  N' from batch ', ISNULL(B.BatchNo, N'(no batch no.)'), N', which holds only ',
                  FORMAT(B.BatchStock, '0.###'), N' ', B.StockUnit,
                  N'. This drives the batch negative, and a negative batch silently drops out of physical stock. ',
                  N'Check the batch and the quantity before you continue.')
    FROM (
        SELECT MIN(LineNum) AS FirstLine, ItemID, ParentTransactionID, WarehouseID, BatchNo,
               MIN(StockUnit) AS StockUnit, SUM(Quantity) AS Qty, MIN(BatchStock) AS BatchStock
        FROM @Lines
        GROUP BY ItemID, ParentTransactionID, WarehouseID, BatchNo
    ) B
    WHERE B.Qty > ISNULL(B.BatchStock, 0);

    IF EXISTS (SELECT 1 FROM @Warnings) AND ISNULL(@AcknowledgeWarnings, 0) = 0
    BEGIN
        SELECT @StatusWarnings AS Status, CAST(NULL AS BIGINT) AS TransactionID, CAST(NULL AS NVARCHAR(50)) AS VoucherNo,
               CAST(NULL AS BIGINT) AS MaxVoucherNo, CAST(NULL AS NVARCHAR(20)) AS FYear, @VoucherDate AS VoucherDate,
               0 AS Attempts, CAST(NULL AS NVARCHAR(MAX)) AS DryRunHeaderJson, CAST(NULL AS NVARCHAR(MAX)) AS DryRunLinesJson;
        SELECT Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message FROM @Warnings ORDER BY Seq;
        SELECT TransID, TransactionDetailID FROM @LineIds;
        RETURN;
    END

    DECLARE @WarningsJson NVARCHAR(MAX) = (
        SELECT Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message FROM @Warnings ORDER BY Seq
        FOR JSON PATH, INCLUDE_NULL_VALUES
    );

    /* ── 4. Number and write ─────────────────────────────────────────────── */
    DECLARE @StartYear INT = YEAR(@VoucherDate) - CASE WHEN MONTH(@VoucherDate) < 4 THEN 1 ELSE 0 END;
    DECLARE @FYear  NVARCHAR(20) = CONCAT(@StartYear, N'-', @StartYear + 1);                          -- 2026-2027
    DECLARE @Suffix NVARCHAR(10) = CONCAT(N'_', RIGHT(@StartYear, 2), N'_', RIGHT(@StartYear + 1, 2)); -- _26_27
    DECLARE @LockName NVARCHAR(255) = CONCAT(N'IssueTool_IS_', @CompanyID, N'_', @FYear);
    DECLARE @VoucherDateTime DATETIME = CAST(@VoucherDate AS DATETIME);   -- chosen date at 00:00

    DECLARE @Attempt INT = 0, @Done BIT = 0, @LockResult INT,
            @MaxNo BIGINT, @VoucherNo NVARCHAR(50), @NewID BIGINT, @Now DATETIME,
            @DryRunHeaderJson NVARCHAR(MAX), @DryRunLinesJson NVARCHAR(MAX);
    DECLARE @NewHeader TABLE (TransactionID BIGINT NOT NULL);

    BEGIN TRY
        WHILE @Done = 0
        BEGIN
            SET @Attempt += 1;
            DELETE FROM @NewHeader;
            DELETE FROM @LineIds;

            BEGIN TRANSACTION;

            EXEC @LockResult = sp_getapplock
                 @Resource = @LockName, @LockMode = 'Exclusive',
                 @LockOwner = 'Transaction', @LockTimeout = 15000;
            IF @LockResult < 0
                THROW 51090, N'LOCK_TIMEOUT: Another issue is being saved. Try again in a moment.', 1;

            -- A concurrent request with the same RequestId may have posted while
            -- this one waited for the lock.
            SELECT @PrevTransactionID = TransactionID, @PrevVoucherNo = VoucherNo
            FROM dbo.IssueTool_PostLog
            WHERE RequestId = @RequestID AND IsDryRun = 0;
            IF @PrevTransactionID IS NOT NULL
            BEGIN
                ROLLBACK TRANSACTION;
                GOTO Replay;
            END

            -- Deleted vouchers are included, so a number is never handed out
            -- twice even if the ERP itself skips deleted ones.
            --
            -- READCOMMITTEDLOCK: the database runs READ_COMMITTED_SNAPSHOT, so
            -- a plain read would see the last committed MAX and miss an ERP
            -- save that has inserted its header but not yet committed. With
            -- the hint this read waits for that save and sees its number.
            SELECT @MaxNo = ISNULL(MAX(MaxVoucherNo), 0) + 1
            FROM dbo.ItemTransactionMain WITH (READCOMMITTEDLOCK)
            WHERE VoucherID = @VoucherID
              AND FYear = @FYear
              AND (@NumberPerCompany = 0 OR CompanyID = @CompanyID);

            SET @VoucherNo = CONCAT(@Prefix, FORMAT(@MaxNo, '00000'), @Suffix);   -- IS17252_26_27
            SET @Now = GETDATE();

            INSERT INTO dbo.ItemTransactionMain (
                VoucherID, VoucherPrefix, MaxVoucherNo, VoucherNo, VoucherDate,
                DepartmentID, JobBookingID, JobBookingJobCardContentsID,
                TotalQuantity, DeliveryNoteNo,
                Narration,                       -- ASSUMPTION (brief 7): remark is stored in Narration
                CompanyID, FYear, UserID, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate,
                IsDeletedTransaction
                -- TEMPLATE: add the columns discovery item 7 shows the ERP sets.
            )
            OUTPUT INSERTED.TransactionID INTO @NewHeader (TransactionID)
            VALUES (
                @VoucherID, @Prefix, @MaxNo, @VoucherNo, @VoucherDateTime,
                @HdrDepartmentID,
                CASE WHEN @Mode = 'DIRECT' THEN 0 ELSE @JobBookingID END,   -- direct: 0 on the header, the job on the lines
                @ContentsID,
                @TotalQty,
                CASE WHEN @Mode = 'DIRECT' THEN ISNULL(@HdrDeliveryNoteNo, @VoucherNo) ELSE @HdrDeliveryNoteNo END,
                ISNULL(NULLIF(LTRIM(RTRIM(@Remark)), N''), @BlankNarration),
                @CompanyID, @FYear, @UserID, @UserID, @UserID, @Now, @Now,
                0
            );

            SET @NewID = (SELECT TransactionID FROM @NewHeader);

            -- The ERP does not take our applock, so it can grab the same number
            -- in the same instant. If it did, give the number back and retry.
            -- Locking read for the same reason as the MAX above.
            IF EXISTS (
                SELECT 1 FROM dbo.ItemTransactionMain WITH (READCOMMITTEDLOCK)
                WHERE VoucherID = @VoucherID
                  AND FYear = @FYear
                  AND MaxVoucherNo = @MaxNo
                  AND TransactionID <> @NewID
                  AND (@NumberPerCompany = 0 OR CompanyID = @CompanyID)
            )
            BEGIN
                ROLLBACK TRANSACTION;
                IF @Attempt >= 3
                    THROW 51091, N'VOUCHER_NUMBER_CONFLICT: The ERP took the same voucher number three times in a row. Nothing was saved; try again.', 1;
                CONTINUE;
            END

            INSERT INTO dbo.ItemTransactionDetail (
                TransactionID, TransID, ItemGroupID, ItemID, StockUnit, IssueQuantity,
                ParentTransactionID, BatchID, BatchNo, WarehouseID, FloorWarehouseID,
                JobBookingID, JobBookingJobCardContentsID,
                PicklistTransactionID, MachineID, DepartmentID, ProcessID,
                PicklistReleaseTransactionID,
                CompanyID, FYear, UserID, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate,
                IsDeletedTransaction, IsCancelled
                -- TEMPLATE: add the columns discovery item 7 shows the ERP sets.
            )
            OUTPUT INSERTED.TransID, INSERTED.TransactionDetailID INTO @LineIds (TransID, TransactionDetailID)
            SELECT
                @NewID, L.LineNum, L.ItemGroupID, L.ItemID, L.StockUnit, L.Quantity,
                L.ParentTransactionID, L.BatchID, L.BatchNoStored, L.WarehouseID, @FloorWarehouseID,
                @JobBookingID, @ContentsID,
                CASE WHEN @Mode = 'ALLOCATED' THEN @PickTransactionID ELSE 0 END,
                CASE WHEN @Mode = 'ALLOCATED' THEN @PickMachineID     ELSE 0 END,
                CASE WHEN @Mode = 'ALLOCATED' THEN @PickDepartmentID  ELSE 0 END,
                CASE WHEN @Mode = 'ALLOCATED' THEN @PickProcessID     ELSE 0 END,
                0,
                @CompanyID, @FYear, @UserID, @UserID, @UserID, @Now, @Now,
                0, 0
            FROM @Lines L
            ORDER BY L.LineNum;

            IF @DryRun = 1
            BEGIN
                -- Variables survive the rollback; the rows do not.
                SET @DryRunHeaderJson = (
                    SELECT * FROM dbo.ItemTransactionMain WHERE TransactionID = @NewID
                    FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
                );
                SET @DryRunLinesJson = (
                    SELECT * FROM dbo.ItemTransactionDetail WHERE TransactionID = @NewID ORDER BY TransID
                    FOR JSON PATH, INCLUDE_NULL_VALUES
                );
                ROLLBACK TRANSACTION;
            END
            ELSE
            BEGIN
                INSERT INTO dbo.IssueTool_PostLog (
                    RequestId, IsDryRun, CompanyID, UserID, CreatedAt, Mode, Payload,
                    TransactionID, VoucherNo, WarningsAcknowledged, Warnings, DryRunCount
                )
                VALUES (
                    @RequestID, 0, @CompanyID, @UserID, @Now, @Mode, @PayloadJson,
                    @NewID, @VoucherNo, CASE WHEN @WarningsJson IS NULL THEN 0 ELSE 1 END, @WarningsJson, 0
                );
                COMMIT TRANSACTION;
            END

            SET @Done = 1;
        END
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH

    IF @DryRun = 1
    BEGIN
        -- Audit the dry run outside the rolled-back transaction.
        IF EXISTS (SELECT 1 FROM dbo.IssueTool_PostLog WHERE RequestId = @RequestID AND IsDryRun = 1)
            UPDATE dbo.IssueTool_PostLog
            SET DryRunCount = DryRunCount + 1, CreatedAt = GETDATE(), Payload = @PayloadJson,
                WarningsAcknowledged = CASE WHEN @WarningsJson IS NULL THEN 0 ELSE 1 END, Warnings = @WarningsJson
            WHERE RequestId = @RequestID AND IsDryRun = 1;
        ELSE
            INSERT INTO dbo.IssueTool_PostLog (
                RequestId, IsDryRun, CompanyID, UserID, Mode, Payload, WarningsAcknowledged, Warnings, DryRunCount
            )
            VALUES (
                @RequestID, 1, @CompanyID, @UserID, @Mode, @PayloadJson,
                CASE WHEN @WarningsJson IS NULL THEN 0 ELSE 1 END, @WarningsJson, 1
            );
    END

    SELECT CASE WHEN @DryRun = 1 THEN @StatusDryRun ELSE @StatusPosted END AS Status,
           CASE WHEN @DryRun = 1 THEN NULL ELSE @NewID END AS TransactionID,
           @VoucherNo AS VoucherNo, @MaxNo AS MaxVoucherNo, @FYear AS FYear, @VoucherDate AS VoucherDate,
           @Attempt AS Attempts, @DryRunHeaderJson AS DryRunHeaderJson, @DryRunLinesJson AS DryRunLinesJson;
    SELECT Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message FROM @Warnings ORDER BY Seq;
    SELECT TransID, TransactionDetailID FROM @LineIds ORDER BY TransID;
    RETURN;

Replay:
    SELECT @StatusReplayed AS Status, M.TransactionID, M.VoucherNo, M.MaxVoucherNo, M.FYear,
           CAST(M.VoucherDate AS DATE) AS VoucherDate, 0 AS Attempts,
           CAST(NULL AS NVARCHAR(MAX)) AS DryRunHeaderJson, CAST(NULL AS NVARCHAR(MAX)) AS DryRunLinesJson
    FROM dbo.ItemTransactionMain M
    WHERE M.TransactionID = @PrevTransactionID;
    SELECT Code, LineNum, ItemID, Quantity, Limit, StockUnit, Message FROM @Warnings WHERE 1 = 0;
    SELECT D.TransID, D.TransactionDetailID
    FROM dbo.ItemTransactionDetail D
    WHERE D.TransactionID = @PrevTransactionID
    ORDER BY D.TransID;
END
GO
