/*
================================================================================
  usp_IssueTool_DeleteIssue  —  soft-deletes one stock issue (VoucherID -19)
================================================================================
  Called by POST /api/issue-tool/issues/:id/delete. Brief section 6.2.

  Captured ERP behaviour: on the header and on every line set
  IsDeletedTransaction = 1, DeletedBy = user, DeletedDate = GETDATE().
  ModifiedBy and ModifiedDate are left untouched.

  Allowed only on a -19 voucher of this company that is not already deleted and
  has no rows in ItemConsumptionDetail with that IssueTransactionID.

  It does NOT call dbo.UPDATE_ITEM_STOCK_VALUES. It returns the distinct ItemIDs
  on the voucher, and the API recalculates stock for each one after this has
  committed (ASSUMPTION, brief 7: @TransactionID = 0, @DeletedItemID = item).

  @DryRun = 1 makes the same updates, returns the rows as they would be, then
  rolls back.

  Result sets
  -----------
    1. Status  one row: Status (DELETED | DRY_RUN), TransactionID, VoucherNo,
               DryRunHeaderJson, DryRunLinesJson
    2. Items   ItemID — one row per distinct item on the voucher

  Hard errors: THROW 51xxx, message "CODE: text".

  Idempotent: CREATE OR ALTER (SQL Server 2016 SP1+).
================================================================================
*/

CREATE OR ALTER PROCEDURE dbo.usp_IssueTool_DeleteIssue
    @CompanyID     INT,
    @UserID        INT,
    @TransactionID INT,
    @DryRun        BIT = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @VoucherNo NVARCHAR(50), @VoucherID INT, @IsDeleted BIT;

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
    IF EXISTS (SELECT 1 FROM dbo.ItemConsumptionDetail WHERE IssueTransactionID = @TransactionID)
        THROW 51023, N'ISSUE_CONSUMED: Material from this issue has been consumed, so it cannot be deleted.', 1;

    DECLARE @Items TABLE (ItemID INT NOT NULL PRIMARY KEY);
    INSERT INTO @Items (ItemID)
    SELECT DISTINCT ItemID
    FROM dbo.ItemTransactionDetail
    WHERE TransactionID = @TransactionID AND ItemID IS NOT NULL;

    DECLARE @Now DATETIME = GETDATE(),
            @DryRunHeaderJson NVARCHAR(MAX), @DryRunLinesJson NVARCHAR(MAX);

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
           @DryRunHeaderJson AS DryRunHeaderJson, @DryRunLinesJson AS DryRunLinesJson;
    SELECT ItemID FROM @Items ORDER BY ItemID;
END
GO
