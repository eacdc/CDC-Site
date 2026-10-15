/*
================================================================================
  usp_IssueTool_ClosePicklistLine  —  closes one picklist line (VoucherID -17)
================================================================================
  Called by POST /api/issue-tool/picklists/:picklistDetailId/close. This is the
  "Close" button on the ERP's picklist screen: the line leaves the open list
  (and shows under "Closed Allocation Picklist") whatever is still pending.

  What it writes, on the picklist's ItemTransactionDetail row only:
      IsCompleted = 1, CompletedBy = user, CompletedDate = GETDATE()
  Nothing else: no header, no other line, no stock, ModifiedBy / ModifiedDate
  untouched.

  ASSUMPTION, to confirm against a line the ERP closed (query in
  docs/issue-tool-schema-notes.md, "Closing a picklist line"): that the ERP
  sets exactly these three columns, and does not also stamp ModifiedBy /
  ModifiedDate or close the whole picklist.

  Allowed only on a live, not cancelled, still open -17 line of this company.

  @DryRun = 1 makes the same update, returns the row as it would be, then rolls
  back.

  Result set
  ----------
    1. Status  one row: Status (CLOSED | DRY_RUN), PicklistDetailID,
               PicklistNo, DryRunLineJson

  Hard errors: THROW 51xxx, message "CODE: text".

  Idempotent: CREATE OR ALTER (SQL Server 2016 SP1+).
================================================================================
*/

CREATE OR ALTER PROCEDURE dbo.usp_IssueTool_ClosePicklistLine
    @CompanyID        INT,
    @UserID           INT,
    @PicklistDetailID BIGINT,
    @DryRun           BIT = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @PicklistNo NVARCHAR(50), @VoucherID BIGINT, @IsDeleted BIT, @IsCancelled BIT, @IsCompleted BIT;
    DECLARE @Now DATETIME = GETDATE();
    DECLARE @DryRunLineJson NVARCHAR(MAX);

    IF @UserID IS NULL OR @UserID <= 0
        THROW 51012, N'MISSING_FIELD: UserID is required.', 1;

    SELECT @PicklistNo  = M.VoucherNo,
           @VoucherID   = M.VoucherID,
           @IsDeleted   = CASE WHEN ISNULL(M.IsDeletedTransaction, 0) = 1 OR ISNULL(D.IsDeletedTransaction, 0) = 1 THEN 1 ELSE 0 END,
           @IsCancelled = ISNULL(D.IsCancelled, 0),
           @IsCompleted = ISNULL(D.IsCompleted, 0)
    FROM dbo.ItemTransactionDetail D
    JOIN dbo.ItemTransactionMain M ON M.TransactionID = D.TransactionID
    WHERE D.TransactionDetailID = @PicklistDetailID
      AND M.CompanyID = @CompanyID;

    IF @VoucherID IS NULL OR @VoucherID <> -17
        THROW 51040, N'UNKNOWN_PICKLIST_LINE: The picklist line does not exist.', 1;
    IF @IsDeleted = 1
        THROW 51041, N'PICKLIST_LINE_DELETED: The picklist has been deleted.', 1;
    IF @IsCancelled = 1
        THROW 51042, N'PICKLIST_LINE_CANCELLED: The picklist line has been cancelled.', 1;
    IF @IsCompleted = 1
        THROW 51043, N'PICKLIST_LINE_CLOSED: The picklist line is already closed.', 1;

    BEGIN TRANSACTION;

    UPDATE dbo.ItemTransactionDetail
    SET IsCompleted = 1,
        CompletedBy = @UserID,
        CompletedDate = @Now
    WHERE TransactionDetailID = @PicklistDetailID
      AND ISNULL(IsCompleted, 0) = 0;

    IF @@ROWCOUNT <> 1
    BEGIN
        ROLLBACK TRANSACTION;
        THROW 51043, N'PICKLIST_LINE_CLOSED: The picklist line is already closed.', 1;
    END;

    IF @DryRun = 1
    BEGIN
        SET @DryRunLineJson = (
            SELECT * FROM dbo.ItemTransactionDetail
            WHERE TransactionDetailID = @PicklistDetailID
            FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER
        );
        ROLLBACK TRANSACTION;
    END
    ELSE
        COMMIT TRANSACTION;

    SELECT CASE WHEN @DryRun = 1 THEN N'DRY_RUN' ELSE N'CLOSED' END AS Status,
           @PicklistDetailID AS PicklistDetailID,
           @PicklistNo AS PicklistNo,
           @DryRunLineJson AS DryRunLineJson;
END;
GO
