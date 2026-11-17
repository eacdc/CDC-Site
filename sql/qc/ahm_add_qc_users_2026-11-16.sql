/*
  Add QC Tool users in Ahmedabad (IndusEnterprise2): Priyaranjan Bar, Kingshuk Sarkar.

  Each person gets the same four pieces the ERP created for Suvojit Das (UserID 102, ledger 7328):
    1. LedgerMaster          Employees ledger, department PRINTING (100), next E-code
    2. LedgerMasterDetails   the 18 field rows the ledger screen keeps
    3. UserMaster            ERP user, production unit 1, linked to the ledger
    4. UserOperatorAllocation + UserModuleAuthentication (same rights as Suvojit: view
       JobQCPacking and QCVerificationReport only)

  Run it once with @DryRun = 1: everything is inserted, checked (GetMachinesForUser must
  return machines), then rolled back. Set @DryRun = 0 and run again to keep it.
  The ERP password is copied from Suvojit Das; change it in User Master if needed.
*/
USE IndusEnterprise2;
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 1;
DECLARE @TemplateUserID INT = 102, @TemplateLedgerID BIGINT = 7328;
DECLARE @FYear NVARCHAR(10) = N'2026-2027';

DECLARE @New TABLE (Seq INT IDENTITY(1, 1), Name NVARCHAR(100), LedgerID BIGINT NULL, UserID INT NULL);
INSERT @New (Name) VALUES (N'Priyaranjan Bar'), (N'Kingshuk Sarkar');

IF EXISTS (SELECT 1 FROM dbo.UserMaster um JOIN @New n ON um.UserName = n.Name OR um.LoginUserName = n.Name)
   OR EXISTS (SELECT 1 FROM dbo.LedgerMaster lm JOIN @New n ON lm.LedgerName = n.Name
              WHERE lm.LedgerType = N'Employees' AND ISNULL(lm.IsDeletedTransaction, 0) = 0)
BEGIN
    RAISERROR (N'A user or Employees ledger with one of these names already exists. Nothing was changed.', 16, 1);
    RETURN;
END;

BEGIN TRAN;

DECLARE @i INT = 1, @Name NVARCHAR(100), @No BIGINT, @LedgerID BIGINT, @UserID INT,
        @Now DATETIME = GETDATE(), @Today NVARCHAR(10) = CONVERT(NVARCHAR(10), GETDATE(), 23);

WHILE @i <= (SELECT MAX(Seq) FROM @New)
BEGIN
    SELECT @Name = Name FROM @New WHERE Seq = @i;

    -- 1. Employees ledger, next number in the E series (E00079 is the latest today)
    SELECT @No = MAX(MaxLedgerNo) + 1
    FROM dbo.LedgerMaster WITH (UPDLOCK, HOLDLOCK)
    WHERE LedgerType = N'Employees' AND LedgerCodePrefix = N'E';

    INSERT dbo.LedgerMaster (LedgerCode, MaxLedgerNo, LedgerCodePrefix, LedgerName, LedgerDescription, LedgerUnitID,
        LedgerType, LedgerGroupID, ISLedgerActive, CompanyID, UserID, CreatedDate, ModifiedDate, IsDeleted, IsBlocked,
        FYear, IsLocked, CreatedBy, ModifiedBy, DeletedBy, DeletedDate, IsDeletedTransaction, Password, ExLedgerName,
        TallyCode, DepartmentID, MailingName, MailingAddress, Address1, Address2, Address3, City, District, State,
        Country, Pincode, MobileNo, GSTNo, PANNo, GSTApplicable, Email, TaxType, GSTLedgerType, TaxPercentage,
        GSTCalculationOn, RefClientID, RefSalesRepresentativeID, TelephoneNo, Website, Designation, FAX,
        InventoryEffect, IsTaxType, MaintainBillWise, CurrencyCode, DateOfBirth, LegalName, TradeName, SupplyTypeCode,
        Remarks, TaxRatePer, InAmount, IsCumulative, TallyLedgerName, LedgerRefCode, LedgerRefName, IsIntegrated,
        Target, ProductionUnitID, RefLedgerID, MaxCreditLimit, MaxCreditPeriod, FixedLimit, Status, CustomerType,
        CustomerCategory, NaturalAccount, ledgercodestring)
    SELECT N'E' + RIGHT(N'00000' + CAST(@No AS NVARCHAR(10)), 5), @No, LedgerCodePrefix, @Name, LedgerDescription,
        LedgerUnitID, LedgerType, LedgerGroupID, ISLedgerActive, CompanyID, UserID, @Now, @Now, IsDeleted, IsBlocked,
        @FYear, IsLocked, CreatedBy, ModifiedBy, DeletedBy, DeletedDate, IsDeletedTransaction, Password, ExLedgerName,
        TallyCode, DepartmentID, @Name, MailingAddress, Address1, Address2, Address3, City, District, State,
        Country, Pincode, MobileNo, GSTNo, PANNo, GSTApplicable, Email, TaxType, GSTLedgerType, TaxPercentage,
        GSTCalculationOn, RefClientID, RefSalesRepresentativeID, TelephoneNo, Website, Designation, FAX,
        InventoryEffect, IsTaxType, MaintainBillWise, CurrencyCode, CAST(@Now AS DATE), LegalName, TradeName,
        SupplyTypeCode, Remarks, TaxRatePer, InAmount, IsCumulative, TallyLedgerName, LedgerRefCode, LedgerRefName,
        IsIntegrated, Target, ProductionUnitID, RefLedgerID, MaxCreditLimit, MaxCreditPeriod, FixedLimit, Status,
        CustomerType, CustomerCategory, NaturalAccount,
        RIGHT(N'000000' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR(6)), 6)
    FROM dbo.LedgerMaster
    WHERE LedgerID = @TemplateLedgerID;

    SET @LedgerID = SCOPE_IDENTITY();

    -- 2. Ledger field rows, with this person's name and date
    INSERT dbo.LedgerMasterDetails (ParentLedgerID, ParentFieldName, ParentFieldValue, LedgerID, FieldID, FieldName,
        FieldValue, SequenceNo, LedgerGroupID, CompanyID, UserID, CreatedDate, ModifiedDate, IsDeleted, IsBlocked,
        FYear, IsLocked, CreatedBy, ModifiedBy, DeletedBy, DeletedDate, IsActive, IsDeletedTransaction, ProductionUnitID)
    SELECT ParentLedgerID, ParentFieldName,
        CASE FieldName WHEN N'LedgerName' THEN @Name WHEN N'MailingName' THEN @Name WHEN N'DateOfBirth' THEN @Today
                       ELSE ParentFieldValue END,
        @LedgerID, FieldID, FieldName,
        CASE FieldName WHEN N'LedgerName' THEN @Name WHEN N'MailingName' THEN @Name WHEN N'DateOfBirth' THEN @Today
                       ELSE FieldValue END,
        SequenceNo, LedgerGroupID, CompanyID, UserID, @Now, @Now, IsDeleted, IsBlocked,
        @FYear, IsLocked, CreatedBy, ModifiedBy, DeletedBy, DeletedDate, IsActive, IsDeletedTransaction, ProductionUnitID
    FROM dbo.LedgerMasterDetails
    WHERE LedgerID = @TemplateLedgerID;

    -- 3. ERP user linked to the ledger
    INSERT dbo.UserMaster (UserName, UnderUserID, Password, ProfilePicHref, City, State, Country, Details, IsAdmin,
        IsCreateUser, CreationDate, LastModiDate, UserLevel, CurrentEntryDate, FromDate, ToDate, FYear, FlagCaseSetting,
        ContactNo, EmailID, smtpUserName, smtpUserPassword, smtpServer, smtpServerPort, smtpAuthenticate, smtpUseSSL,
        IsEditableProductionDate, SalesProfileID, EmailMessage, HeaderText, FooterText, IsExtraPaperIssue,
        ISChooseAnotherPaper, IsBlocked, IsCahangeGsmJobcard, Designation, SignatureImage, EmployeeId, IsHidden,
        IsUserViewOtherQuotation, SignPicHref, UserWiseOperatorsIDStr, IsCreateDirectInvoice, ExportHeaderText,
        ExportFooterText, IsModifyScheduleProcess, IsDeleteProductionEntry, IsSaveEditClosedJobProcess, POEmailMessage,
        POHeaderText, POFooterText, AllowAccessTallyInterface, IsUserCannotViewCostingDetail, IsSendSMS, IsSendEmail,
        IsNeedSMS, IsNeedEmail, CompanyID, BranchID, IsDeletedUser, CreatedBy, ModifiedBy, DeletedBy, DeletedDate,
        AllowDuplicatePONoInSO, AcceptSOLessThanEstimatedQty, CanDeleteQuotation, CanReviseQuotation, CanCopyQuotation,
        CanPrintQuotation, CanReviewQuotation, CanSendQuotationForSO, CanRejectQuotation, CanCheckEstimatedJobDetails,
        CanCheckEstimatedDetailCosting, CanChangePODate, CanEditPOQuantityAndRate, CanEditProductionDate,
        CanPackMoreThanSOQty, CanCreateDirectPacking, CanEditApprovedCostInPriceApproval, CanEditRateInSO,
        LoginUserName, ProductionUnitID, CanAccessMultipleProductionUnitData, CanAccessMultipleBranchData,
        AllowToChangeFYear, ProductionUnitIDStr, CanReceiveExcessMaterial, DeletedRemark, CanUpdateSODetails,
        IsInvoiceBlockFeatureRequired, InvoiceEmailMessage, InvoiceHeaderText, InvoiceFooterText,
        InvoiceExportHeaderText, InvoiceExportFooterText, CanAddAdditionalProcessesInPWO,
        CanIReplanthePWOorProductCatalog, CanEditMaterialCostParameter, ProductID, ApiKey, PhoneID)
    SELECT @Name, UnderUserID, Password, ProfilePicHref, City, State, Country, Details, IsAdmin,
        IsCreateUser, @Now, @Now, UserLevel, CurrentEntryDate, FromDate, ToDate, @FYear, FlagCaseSetting,
        ContactNo, EmailID, smtpUserName, smtpUserPassword, smtpServer, smtpServerPort, smtpAuthenticate, smtpUseSSL,
        IsEditableProductionDate, SalesProfileID, EmailMessage, HeaderText, FooterText, IsExtraPaperIssue,
        ISChooseAnotherPaper, IsBlocked, IsCahangeGsmJobcard, Designation, SignatureImage, EmployeeId, IsHidden,
        IsUserViewOtherQuotation, SignPicHref, CAST(@LedgerID AS NVARCHAR(20)), IsCreateDirectInvoice, ExportHeaderText,
        ExportFooterText, IsModifyScheduleProcess, IsDeleteProductionEntry, IsSaveEditClosedJobProcess, POEmailMessage,
        POHeaderText, POFooterText, AllowAccessTallyInterface, IsUserCannotViewCostingDetail, IsSendSMS, IsSendEmail,
        IsNeedSMS, IsNeedEmail, CompanyID, BranchID, IsDeletedUser, CreatedBy, ModifiedBy, DeletedBy, DeletedDate,
        AllowDuplicatePONoInSO, AcceptSOLessThanEstimatedQty, CanDeleteQuotation, CanReviseQuotation, CanCopyQuotation,
        CanPrintQuotation, CanReviewQuotation, CanSendQuotationForSO, CanRejectQuotation, CanCheckEstimatedJobDetails,
        CanCheckEstimatedDetailCosting, CanChangePODate, CanEditPOQuantityAndRate, CanEditProductionDate,
        CanPackMoreThanSOQty, CanCreateDirectPacking, CanEditApprovedCostInPriceApproval, CanEditRateInSO,
        @Name, ProductionUnitID, CanAccessMultipleProductionUnitData, CanAccessMultipleBranchData,
        AllowToChangeFYear, ProductionUnitIDStr, CanReceiveExcessMaterial, DeletedRemark, CanUpdateSODetails,
        IsInvoiceBlockFeatureRequired, InvoiceEmailMessage, InvoiceHeaderText, InvoiceFooterText,
        InvoiceExportHeaderText, InvoiceExportFooterText, CanAddAdditionalProcessesInPWO,
        CanIReplanthePWOorProductCatalog, CanEditMaterialCostParameter, ProductID, NULL, NULL
    FROM dbo.UserMaster
    WHERE UserID = @TemplateUserID;

    SET @UserID = SCOPE_IDENTITY();

    -- 4a. Operator allocation (what the User Master screen saves for the operator list)
    INSERT dbo.UserOperatorAllocation (OperatorID, OperatorName, DepartmentID, MachineID, MachineName, UserID,
        CompanyID, ModifiedDate, IsLocked, CreatedBy, CreatedDate, ModifiedBy, DeletedBy, DeletedDate,
        IsDeletedTransaction, MachineIDString, FYear, ProductionUnitID)
    SELECT @LedgerID, @Name, DepartmentID, MachineID, MachineName, @UserID,
        CompanyID, @Now, IsLocked, CreatedBy, @Now, CreatedBy, DeletedBy, DeletedDate,
        IsDeletedTransaction, MachineIDString, @FYear, ProductionUnitID
    FROM dbo.UserOperatorAllocation
    WHERE UserID = @TemplateUserID AND ISNULL(IsDeletedTransaction, 0) = 0;

    -- 4b. Module rights, same as Suvojit Das
    INSERT dbo.UserModuleAuthentication (UserID, ModuleID, CanView, CanSave, CanEdit, CanDelete, CanPrint, CanExport,
        ModuleName, IsHomePage, CompanyID, FYear, IsLocked, CreatedBy, CreatedDate, ModifiedBy, ModifiedDate,
        DeletedBy, DeletedDate, IsDeletedTransaction, ProductionUnitID)
    SELECT @UserID, ModuleID, CanView, CanSave, CanEdit, CanDelete, CanPrint, CanExport,
        ModuleName, IsHomePage, CompanyID, FYear, IsLocked, CreatedBy, @Now, ModifiedBy, ModifiedDate,
        DeletedBy, DeletedDate, IsDeletedTransaction, ProductionUnitID
    FROM dbo.UserModuleAuthentication
    WHERE UserID = @TemplateUserID;

    UPDATE @New SET LedgerID = @LedgerID, UserID = @UserID WHERE Seq = @i;
    SET @i += 1;
END;

-- Check: what was created, and that the QC Tool login finds machines for each user
SELECT n.Name, n.UserID, n.LedgerID, lm.LedgerCode, um.ProductionUnitID, um.UserWiseOperatorsIDStr,
    Rights = (SELECT COUNT(*) FROM dbo.UserModuleAuthentication a WHERE a.UserID = n.UserID),
    Machines = (SELECT COUNT(*) FROM dbo.MachineMaster mm
                WHERE mm.DepartmentID = lm.DepartmentID AND mm.ProductionUnitID = um.ProductionUnitID
                  AND ISNULL(mm.IsDeletedTransaction, 0) = 0)
FROM @New n
JOIN dbo.UserMaster um ON um.UserID = n.UserID
JOIN dbo.LedgerMaster lm ON lm.LedgerID = n.LedgerID;

EXEC dbo.GetMachinesForUser @UserName = N'Priyaranjan Bar';
EXEC dbo.GetMachinesForUser @UserName = N'Kingshuk Sarkar';

IF @DryRun = 1
BEGIN
    ROLLBACK;
    PRINT N'Dry run: rolled back. Set @DryRun = 0 to keep the users.';
END
ELSE
BEGIN
    COMMIT;
    PRINT N'Users created.';
END;
