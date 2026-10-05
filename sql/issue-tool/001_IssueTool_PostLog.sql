/*
================================================================================
  IssueTool_PostLog  —  idempotency key and audit trail for the Stock Issue Tool
================================================================================
  One row per real post, keyed by the client's request ID. A request ID that is
  already here with IsDryRun = 0 is answered with the voucher it produced, which
  is what makes a double click or a retried request harmless (brief 6.1 step 1).

  Dry runs are logged as well, after their transaction has rolled back, with
  IsDryRun = 1 and no TransactionID. They never block a later real post with the
  same request ID: the unique key is (RequestId, IsDryRun), and the idempotency
  check only looks at IsDryRun = 0.

  Only usp_IssueTool_PostIssue writes to this table.

  Idempotent: safe to run more than once. Creates the table if it is missing and
  never drops or alters an existing one.
================================================================================
*/

IF OBJECT_ID('dbo.IssueTool_PostLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.IssueTool_PostLog (
        PostLogID            BIGINT IDENTITY(1,1) NOT NULL
                             CONSTRAINT PK_IssueTool_PostLog PRIMARY KEY CLUSTERED,
        RequestId            UNIQUEIDENTIFIER     NOT NULL,
        IsDryRun             BIT                  NOT NULL,
        CompanyID            INT                  NOT NULL,
        UserID               INT                  NOT NULL,
        CreatedAt            DATETIME             NOT NULL
                             CONSTRAINT DF_IssueTool_PostLog_CreatedAt DEFAULT (GETDATE()),
        Mode                 VARCHAR(10)          NOT NULL,   -- ALLOCATED | DIRECT
        Payload              NVARCHAR(MAX)        NOT NULL,   -- the full request body as JSON
        TransactionID        BIGINT               NULL,       -- NULL for dry runs (ITM.TransactionID is BIGINT)
        VoucherNo            NVARCHAR(50)         NULL,       -- NULL for dry runs
        WarningsAcknowledged BIT                  NOT NULL
                             CONSTRAINT DF_IssueTool_PostLog_WarningsAck DEFAULT (0),
        Warnings             NVARCHAR(MAX)        NULL,       -- JSON array of the warnings acknowledged
        DryRunCount          INT                  NOT NULL
                             CONSTRAINT DF_IssueTool_PostLog_DryRunCount DEFAULT (1),
        CONSTRAINT UQ_IssueTool_PostLog_Request UNIQUE (RequestId, IsDryRun)
    );

    -- Deliberately not a filtered index: inserts into a table with a filtered
    -- index fail unless the session has six SET options exactly right, and
    -- this table is written from more than one client.
    CREATE INDEX IX_IssueTool_PostLog_Transaction
        ON dbo.IssueTool_PostLog (TransactionID);
END
GO
