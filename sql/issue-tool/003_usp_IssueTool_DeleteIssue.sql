/*
================================================================================
  usp_IssueTool_DeleteIssue  —  soft-deletes one stock issue (VoucherID -19)
================================================================================
  Called by POST /api/issue-tool/issues/:id/delete. Brief section 6.2.

  Captured ERP behaviour (IS17252 / IS17254, deleted 3 Oct 2026):
    - issue header and every line: IsDeletedTransaction = 1, DeletedBy = user,
      DeletedDate = GETDATE(); ModifiedBy / ModifiedDate untouched.
    - the floor receipt written with the issue (ItemConsumptionMain VoucherID
      -53 "RFS", ReturnTransactionID = the issue): header gets the same three
      columns, ModifiedDate untouched; its lines get them too and ALSO
      ModifiedBy = user, ModifiedDate = the delete time.

  Allowed only on a -19 voucher of this company that is not already deleted and
  whose material has not been used. Every issue has consumption-detail rows
  (its own RFS lines, ReceivedQuantity only), so those do not block. What
  blocks is a live ItemConsumptionDetail row for the issue that consumed,
  returned or wasted anything, or that belongs to any voucher other than the
  issue's own RFS. This matches the ERP's floor-stock formula, which counts
  ConsumeQuantity + ReturnQuantity against the issue.

  It does NOT call dbo.UPDATE_ITEM_STOCK_VALUES. It returns the distinct ItemIDs
  on the voucher, and the API recalculates stock for each one after this has
  committed (ASSUMPTION, brief 7: @TransactionID = 0, @DeletedItemID = item).

  @DryRun = 1 makes the same updates, returns the rows as they would be, then
  rolls back.

  Result sets
  -----------
    1. Status  one row: Status (DELETED | DRY_RUN), TransactionID, VoucherNo,
               DryRunHeaderJson, DryRunLinesJson, DryRunRfsHeaderJson,
               DryRunRfsLinesJson
    2. Items   ItemID — one row per distinct item on the voucher

  Hard errors: THROW 51xxx, message "CODE: text".

  Idempotent: CREATE OR ALTER (SQL Server 2016 SP1+).
================================================================================
*/

CREATE OR ALTER PROCEDURE dbo.usp_IssueTool_DeleteIssue
    @CompanyID     INT,
    @UserID        INT,
    @TransactionID BIGINT,
    @DryRun        BIT = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @VoucherNo NVARCHAR(50), @VoucherID BIGINT, @IsDeleted BIT;

    IF @UserID IS NULL OR @UserID <= 0
        THROW 51012, N'MISSING_FIELD: UserID is required.', 1;

    SELECT @VoucherNo = VoucherNo,
           @VoucherID = VoucherID,
           @IsDeleted = ISNULL(IsDeletedTransaction, 0)
    FROM dbo.ItemTransactionMain
    WHERE TransactionID = @TransactionID AND CompanyID = @CompanyID;

    IF @VoucherID IS NULL
        THROW 51020, N'UNKNOWN_ISSUE: The issue voucher does not exist.', 1;
    IF @VoucherID <> -19
        THROW 51021, N'NOT_AN_ISSUE: Only issue vouchers (-19) can be deleted here.', 1;
    IF @IsDeleted = 1
        THROW 51022, N'ALREADY_DELETED: The issue voucher is already deleted.', 1;
    -- The issue's own floor receipt(s).
    DECLARE @Rfs TABLE (ConsumptionTransactionID BIGINT NOT NULL PRIMARY KEY);
    INSERT INTO @Rfs (ConsumptionTransactionID)
    SELECT ConsumptionTransactionID
    FROM dbo.ItemConsumptionMain
    WHERE ReturnTransactionID = @TransactionID
      AND VoucherID = -53
      AND CompanyID = @CompanyID
      AND ISNULL(IsDeletedTransaction, 0) = 0;

    IF EXISTS (
        SELECT 1
        FROM dbo.ItemConsumptionDetail C
        WHERE C.IssueTransactionID = @TransactionID
          AND C.CompanyID = @CompanyID
          AND ISNULL(C.IsDeletedTransaction, 0) = 0
          AND (   ISNULL(C.ConsumeQuantity, 0) <> 0
               OR ISNULL(C.ReturnQuantity, 0) <> 0
               OR ISNULL(C.WasteQuantity, 0) <> 0
               OR C.ConsumptionTransactionID NOT IN (SELECT ConsumptionTransactionID FROM @Rfs))
    )
        THROW 51023, N'ISSUE_CONSUMED: Material from this issue has been consumed or returned, so it cannot be deleted.', 1;

    DECLARE @Items TABLE (ItemID BIGINT NOT NULL PRIMARY KEY);
    INSERT INTO @Items (ItemID)
    SELECT DISTINCT ItemID
    FROM dbo.ItemTransactionDetail
    WHERE TransactionID = @TransactionID AND ItemID IS NOT NULL;

    DECLARE @Now DATETIME = GETDATE(),
            @DryRunHeaderJson NVARCHAR(MAX), @DryRunLinesJson NVARCHAR(MAX),
            @DryRunRfsHeaderJson NVARCHAR(MAX), @DryRunRfsLinesJson NVARCHAR(MAX);

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE dbo.ItemTransactionMain
        SET IsDeletedTransaction = 1, DeletedBy = @UserID, DeletedDate = @Now
        WHERE TransactionID = @TransactionID
          AND ISNULL(IsDeletedTransaction, 0) = 0;

        IF @@ROWCOUNT <> 1
            THROW 51022, N'ALREADY_DELETED: The issue voucher was deleted by someone else just now.', 1;

        -- Lines deleted earlier keep their own DeletedBy / DeletedDate.
        UPDATE dbo.ItemTransactionDetail
        SET IsDeletedTransaction = 1, DeletedBy = @UserID, DeletedDate = @Now
        WHERE TransactionID = @TransactionID
          AND ISNULL(IsDeletedTransaction, 0) = 0;

        -- The floor receipt goes with the issue, as in the ERP.
        UPDATE dbo.ItemConsumptionMain
        SET IsDeletedTransaction = 1, DeletedBy = @UserID, DeletedDate = @Now
        WHERE ConsumptionTransactionID IN (SELECT ConsumptionTransactionID FROM @Rfs);

        UPDATE dbo.ItemConsumptionDetail
        SET IsDeletedTransaction = 1, DeletedBy = @UserID, DeletedDate = @Now,
            ModifiedBy = @UserID, ModifiedDate = @Now
        WHERE ConsumptionTransactionID IN (SELECT ConsumptionTransactionID FROM @Rfs)
          AND ISNULL(IsDeletedTransaction, 0) = 0;

        IF @DryRun = 1
        BEGIN
            SET @DryRunHeaderJson = (
                SELECT * FROM dbo.ItemTransactionMain WHERE TransactionID = @TransactionID
                FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
            );
            SET @DryRunLinesJson = (
                SELECT * FROM dbo.ItemTransactionDetail WHERE TransactionID = @TransactionID ORDER BY TransID
                FOR JSON PATH, INCLUDE_NULL_VALUES
            );
            SET @DryRunRfsHeaderJson = (
                SELECT * FROM dbo.ItemConsumptionMain
                WHERE ConsumptionTransactionID IN (SELECT ConsumptionTransactionID FROM @Rfs)
                FOR JSON PATH, INCLUDE_NULL_VALUES
            );
            SET @DryRunRfsLinesJson = (
                SELECT * FROM dbo.ItemConsumptionDetail
                WHERE ConsumptionTransactionID IN (SELECT ConsumptionTransactionID FROM @Rfs)
                ORDER BY ConsumptionTransactionID, TransID
                FOR JSON PATH, INCLUDE_NULL_VALUES
            );
            ROLLBACK TRANSACTION;
        END
        ELSE
            COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH

    SELECT CASE WHEN @DryRun = 1 THEN 'DRY_RUN' ELSE 'DELETED' END AS Status,
           @TransactionID AS TransactionID, @VoucherNo AS VoucherNo,
           @DryRunHeaderJson AS DryRunHeaderJson, @DryRunLinesJson AS DryRunLinesJson,
           @DryRunRfsHeaderJson AS DryRunRfsHeaderJson, @DryRunRfsLinesJson AS DryRunRfsLinesJson;
    SELECT ItemID FROM @Items ORDER BY ItemID;
END
GO
