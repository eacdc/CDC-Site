/*
================================================================================
  In-process QC — remarks on "Not OK" parameters
================================================================================
  The QC Tool now asks for a remark whenever a parameter is marked Not OK
  (typed or spoken; the backend converts it to English before saving).

  1. Adds a nullable Remarks column to ProductionEntryProcessInspectionDetail.
  2. Creates SaveProcessInspection_v2: identical to SaveProcessInspection,
     plus it reads items[].remarks and stores it in that column.
     SaveProcessInspection itself is left untouched.

  Idempotent. Run on BOTH databases, before deploying the backend that calls
  SaveProcessInspection_v2:
      USE IndusEnterprise;   -- Kolkata
      USE IndusEnterprise2;  -- Ahmedabad
================================================================================
*/

SET NOCOUNT ON;
GO

IF COL_LENGTH('dbo.ProductionEntryProcessInspectionDetail', 'Remarks') IS NULL
BEGIN
    ALTER TABLE dbo.ProductionEntryProcessInspectionDetail ADD Remarks NVARCHAR(1000) NULL;
    PRINT 'Added ProductionEntryProcessInspectionDetail.Remarks';
END
ELSE
    PRINT 'ProductionEntryProcessInspectionDetail.Remarks already exists';
GO

CREATE OR ALTER PROCEDURE dbo.SaveProcessInspection_v2
    @UserID          INT,
    @ProductionID    INT,
    @ProcessID       INT,
    @InspectionJson  NVARCHAR(MAX),

    -- Optional overrides / fallbacks
    @CompanyID       INT           = NULL,
    @BranchID        INT           = NULL,
    @VoucherPrefix   NVARCHAR(10)  = N'QC',
    @VoucherDate     DATETIME2(0)  = NULL,
    @FYear           NVARCHAR(9)   = NULL,
    @JobBookingJobCardContentsID INT = NULL,
    @JobBookingID    INT           = NULL,
    @ProductionUnitID INT          = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @TransactionID INT = NULL,
        @VoucherNo     NVARCHAR(20) = NULL;

    BEGIN TRY
        DECLARE @Now DATETIME2(0) = COALESCE(@VoucherDate, SYSDATETIME());
        DECLARE @StartYear INT, @EndYear INT;

        -- Financial Year (Apr–Mar)
        IF @FYear IS NULL
        BEGIN
            IF (DATEPART(MONTH, @Now) >= 4)
                SELECT @StartYear = DATEPART(YEAR, @Now), @EndYear = DATEPART(YEAR, @Now) + 1;
            ELSE
                SELECT @StartYear = DATEPART(YEAR, @Now) - 1, @EndYear = DATEPART(YEAR, @Now);
            SET @FYear = CAST(@StartYear AS NVARCHAR(4)) + N'-' + CAST(@EndYear AS NVARCHAR(4));
        END

        -- Read optional top-level JSON
        DECLARE
            @JsonCompanyID INT       = TRY_CAST(JSON_VALUE(@InspectionJson, '$.companyID') AS INT),
            @JsonBranchID INT        = TRY_CAST(JSON_VALUE(@InspectionJson, '$.branchID') AS INT),
            @JsonVoucherPrefix NVARCHAR(10) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@InspectionJson, '$.voucherPrefix'))), ''),
            @JsonFYear NVARCHAR(9)   = NULLIF(LTRIM(RTRIM(JSON_VALUE(@InspectionJson, '$.fyear'))), ''),
            @JsonJBJCCID INT         = TRY_CAST(JSON_VALUE(@InspectionJson, '$.jobBookingJobCardContentsID') AS INT),
            @JsonJBID INT            = TRY_CAST(JSON_VALUE(@InspectionJson, '$.jobBookingID') AS INT),
            @JsonProdUnitID INT      = TRY_CAST(JSON_VALUE(@InspectionJson, '$.productionUnitID') AS INT),
            @JsonVoucherDate DATETIME2(0) = TRY_CAST(JSON_VALUE(@InspectionJson, '$.voucherDate') AS DATETIME2(0));

        SET @CompanyID  = COALESCE(@CompanyID,  @JsonCompanyID);
        SET @BranchID   = COALESCE(@BranchID,   @JsonBranchID);
        SET @VoucherPrefix = COALESCE(@JsonVoucherPrefix, @VoucherPrefix);
        SET @FYear      = COALESCE(@JsonFYear, @FYear);
        SET @VoucherDate = COALESCE(@JsonVoucherDate, @Now);
        SET @JobBookingJobCardContentsID = COALESCE(@JobBookingJobCardContentsID, @JsonJBJCCID);
        SET @JobBookingID = COALESCE(@JobBookingID, @JsonJBID);
        SET @ProductionUnitID = COALESCE(@ProductionUnitID, @JsonProdUnitID);

        -- Infer Company if still NULL
        IF @CompanyID IS NULL
        BEGIN
            SELECT TOP (1) @CompanyID = pip.CompanyID
            FROM dbo.ProcessInspectionParameters pip
            WHERE pip.ProcessID = @ProcessID
            ORDER BY pip.TransactionID DESC;
        END

        IF @CompanyID IS NULL
        BEGIN
            SELECT 0 AS success, CAST(NULL AS NVARCHAR(20)) AS voucherNo,
                   CAST(NULL AS INT) AS transactionID,
                   N'CompanyID could not be determined. Provide CompanyID in parameters or JSON.' AS message;
            RETURN;
        END

        -- Parse items into temp table
        IF OBJECT_ID('tempdb..#Items') IS NOT NULL DROP TABLE #Items;
        CREATE TABLE #Items
        (
            RowNo           INT IDENTITY(1,1) PRIMARY KEY,
            ParameterName   NVARCHAR(200) NOT NULL,
            StandardValue   NVARCHAR(500) NULL,
            InputFieldType  NVARCHAR(50)  NULL,
            FieldDataType   NVARCHAR(50)  NULL,
            DefaultValue    NVARCHAR(1000) NULL,
            Result          NVARCHAR(2000) NULL,
            Remarks         NVARCHAR(1000) NULL
        );

        INSERT INTO #Items (ParameterName, StandardValue, InputFieldType, FieldDataType, DefaultValue, Result, Remarks)
        SELECT
            LTRIM(RTRIM(ISNULL(j.Parameter, j.parameter))) AS ParameterName,
            NULLIF(LTRIM(RTRIM(j.StandardValue)), '')      AS StandardValue,
            NULLIF(LTRIM(RTRIM(j.InputFieldType)), '')     AS InputFieldType,
            NULLIF(LTRIM(RTRIM(j.FieldDataType)), '')      AS FieldDataType,
            NULLIF(LTRIM(RTRIM(j.DefaultValue)), '')       AS DefaultValue,
            NULLIF(LTRIM(RTRIM(j.Result)), '')             AS Result,
            NULLIF(LTRIM(RTRIM(j.Remarks)), '')            AS Remarks
        FROM OPENJSON(@InspectionJson, '$.items')
        WITH
        (
            parameter       NVARCHAR(200) '$.parameter',
            Parameter       NVARCHAR(200) '$.parameter',
            StandardValue   NVARCHAR(500) '$.standardValue',
            InputFieldType  NVARCHAR(50)  '$.inputFieldType',
            FieldDataType   NVARCHAR(50)  '$.fieldDataType',
            DefaultValue    NVARCHAR(1000) '$.defaultValue',
            Result          NVARCHAR(2000) '$.result',
            Remarks         NVARCHAR(1000) '$.remarks'
        ) AS j;

        IF NOT EXISTS (SELECT 1 FROM #Items)
        BEGIN
            SELECT 0 AS success, CAST(NULL AS NVARCHAR(20)) AS voucherNo,
                   CAST(NULL AS INT) AS transactionID,
                   N'No inspection items were provided in JSON (items[] is empty).' AS message;
            RETURN;
        END

        -- Enrich from ProcessInspectionParameters
        ;WITH md AS
        (
            SELECT i.RowNo, i.ParameterName,
                   i.StandardValue,
                   i.InputFieldType,
                   i.FieldDataType,
                   i.DefaultValue,
                   i.Result,
                   pip.FieldType     AS PIP_FieldType,
                   pip.DefaultValue  AS PIP_DefaultValue,
                   pip.StandardValue AS PIP_StandardValue
            FROM #Items i
            LEFT JOIN dbo.ProcessInspectionParameters pip
              ON pip.ProcessID = @ProcessID
             AND pip.ParameterName = i.ParameterName
             AND ISNULL(pip.IsDeletedTransaction,0) = 0
        )
        UPDATE i
           SET i.InputFieldType = COALESCE(md.InputFieldType, md.PIP_FieldType, 'Text Field'),
               i.DefaultValue   = COALESCE(md.DefaultValue, md.PIP_DefaultValue),
               i.StandardValue  = COALESCE(md.StandardValue, md.PIP_StandardValue, i.StandardValue),
               i.FieldDataType  = COALESCE(md.FieldDataType,
                                           md.InputFieldType,
                                           md.PIP_FieldType,
                                           'Text Field')
        FROM #Items i
        JOIN md ON md.RowNo = i.RowNo;

        -- Ensure FieldDataType mirrors InputFieldType when not explicitly provided (safety)
        UPDATE i
           SET i.FieldDataType = i.InputFieldType
        FROM #Items i
        WHERE i.FieldDataType IS NULL OR i.FieldDataType <> i.InputFieldType;

        -- Validate Combo Field picks
        IF OBJECT_ID('tempdb..#ComboToValidate') IS NOT NULL DROP TABLE #ComboToValidate;
        SELECT i.RowNo, i.ParameterName, i.InputFieldType, i.DefaultValue, i.Result
        INTO #ComboToValidate
        FROM #Items i
        WHERE i.InputFieldType = 'Combo Field';

        IF EXISTS
        (
            SELECT 1
            FROM #ComboToValidate v
            WHERE v.Result IS NOT NULL
              AND EXISTS (SELECT 1 FROM STRING_SPLIT(ISNULL(v.DefaultValue,''), '|'))
              AND v.Result NOT IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(ISNULL(v.DefaultValue,''), '|'))
        )
        BEGIN
            DECLARE @Bad NVARCHAR(MAX) = N'';
            ;WITH bad AS
            (
                SELECT v.RowNo, v.ParameterName, v.Result, ISNULL(v.DefaultValue, '(none)') AS OptionsCSV
                FROM #ComboToValidate v
                WHERE v.Result IS NOT NULL
                  AND EXISTS (SELECT 1 FROM STRING_SPLIT(ISNULL(v.DefaultValue,''), '|'))
                  AND v.Result NOT IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(ISNULL(v.DefaultValue,''), '|'))
            )
            SELECT @Bad = @Bad +
                   N'[' + CAST(b.RowNo AS NVARCHAR(10)) + N'] ' +
                   b.ParameterName + N' -> "' + ISNULL(b.Result,N'') +
                   N'" not in options: ' + ISNULL(b.OptionsCSV,N'') + CHAR(10)
            FROM bad b;

            SELECT 0 AS success, CAST(NULL AS NVARCHAR(20)) AS voucherNo,
                   CAST(NULL AS INT) AS transactionID,
                   N'Combo field validation failed:' + CHAR(10) + @Bad AS message;
            RETURN;
        END

        -- Next voucher number (per Company/Branch/Prefix/FY)
        DECLARE @NextMaxVoucherNo INT;
        SELECT @NextMaxVoucherNo = ISNULL(MAX(m.MaxVoucherNo), 0) + 1
        FROM dbo.ProductionEntryProcessInspectionMain m
        WHERE m.CompanyID = @CompanyID
          AND ISNULL(m.BranchID, -1) = ISNULL(@BranchID, -1)
          AND m.VoucherPrefix = @VoucherPrefix
          AND ISNULL(m.FYear, @FYear) = @FYear;

        SET @VoucherNo = @VoucherPrefix +
                         RIGHT(REPLICATE('0', 5) + CAST(@NextMaxVoucherNo AS VARCHAR(10)), 5);

        -- MAIN
        INSERT INTO dbo.ProductionEntryProcessInspectionMain
        (
            ProcessID, VoucherPrefix, MaxVoucherNo, VoucherNo, VoucherDate,
            ProductionID, JobBookingJobCardContentsID, JobBookingID,
            CompanyID, BranchID, UserID, FYear, IsLocked,
            CreatedBy, CreatedDate, ModifiedBy, ModifiedDate,
            DeletedBy, DeletedDate, IsDeletedTransaction, ProductionUnitID
        )
        VALUES
        (
            @ProcessID, @VoucherPrefix, @NextMaxVoucherNo, @VoucherNo, @VoucherDate,
            @ProductionID, @JobBookingJobCardContentsID, @JobBookingID,
            @CompanyID, @BranchID, @UserID, @FYear, NULL,
            @UserID, @Now, @UserID, @Now,
            NULL, NULL, NULL, @ProductionUnitID
        );

        SET @TransactionID = SCOPE_IDENTITY();

        -- DETAILS
        INSERT INTO dbo.ProductionEntryProcessInspectionDetail
        (
            TransactionID, ParameterName, StandardValue,
            InputFieldType, FieldDataType, DefaultValue, Result, Remarks,
            CompanyID, UserID, FYear, IsLocked,
            CreatedBy, CreatedDate, ModifiedBy, ModifiedDate,
            DeletedBy, DeletedDate, IsDeletedTransaction, ProductionUnitID
        )
        SELECT
            @TransactionID,
            i.ParameterName,
            i.StandardValue,
            i.InputFieldType,
            i.FieldDataType,
            i.DefaultValue,
            i.Result,
            i.Remarks,
            @CompanyID,
            @UserID,
            @FYear,
            NULL,
            @UserID,
            @Now,
            @UserID,
            @Now,
            NULL,
            NULL,
            NULL,
            @ProductionUnitID
        FROM #Items i
        ORDER BY i.RowNo;

        -- Success row
        SELECT 1 AS success,
               @VoucherNo AS voucherNo,
               @TransactionID AS transactionID,
               N'Saved' AS message;

    END TRY
    BEGIN CATCH
        -- Failure row (no throw)
        SELECT 0 AS success,
               CAST(NULL AS NVARCHAR(20)) AS voucherNo,
               CAST(NULL AS INT) AS transactionID,
               N'SaveProcessInspection_v2 failed: ' + ERROR_MESSAGE() AS message;
        RETURN;
    END CATCH
END
GO

PRINT 'SaveProcessInspection_v2 ready';
GO
