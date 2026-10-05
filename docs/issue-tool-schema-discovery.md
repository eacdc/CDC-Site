# Stock Issue Tool — schema discovery report

Generated 2026-10-05T07:02:01.325Z by `scripts/issue-tool-discover.js` against site **KOL**, CompanyID **2**, current FYear **2026-2027**. Read-only.

Values are shown quoted so `""` (empty), `" "` (one space) and `NULL` can be told apart.

## 0. Server

| DatabaseName | CompatibilityLevel | ReadCommittedSnapshot | SnapshotIsolation | ProductVersion | Edition | ServerNow |
| --- | --- | --- | --- | --- | --- | --- |
| "IndusEnterprise" | 150 | true | "ON" | "16.0.1000.6" | "Standard Edition (64-bit)" | "2026-10-05T12:32:01" |

- OPENJSON / FOR JSON need CompatibilityLevel ≥ 130; `CREATE OR ALTER` needs SQL Server 2016 SP1 (13.0.4001) or later.
- With ReadCommittedSnapshot = 1, an ERP save that reads MAX(MaxVoucherNo) does not wait for our uncommitted header, which widens the duplicate-number window the post-insert check covers.
- ServerNow should be IST; compare with 2026-10-05 in Asia/Kolkata.

## 1. Every column the module references

All referenced tables and columns exist.

## 2. ItemTransactionMain: columns, nullability, defaults

| ColumnName | DataType | MaxLength | Precision | Scale | Nullable | IsIdentity | DefaultValue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| "TransactionID" | "bigint" | 8 | 19 | 0 | false | true | NULL |
| "VoucherPrefix" | "nvarchar" | 20 | 0 | 0 | true | false | "(N' ')" |
| "MaxVoucherNo" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "VoucherID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "VoucherNo" | "nvarchar" | 100 | 0 | 0 | true | false | "(N' ')" |
| "VoucherDate" | "datetime" | 8 | 23 | 3 | true | false | "(getdate())" |
| "LedgerID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "DealerID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "DepartmentID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "JobBookingID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "JobBookingJobCardContentsID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "MachineID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "OperationID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "ContactPersonID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "SourceWarehouseID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "DestinationWarehouseID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "TotalQuantity" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "TotalBasicAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalDiscountAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalCGSTTaxAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalSGSTTaxAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalIGSTTaxAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalTaxAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "NetAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TotalOverheadAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "Particular" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "DeliveryNoteNo" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "DeliveryNoteDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "Transporter" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "GateEntryNo" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "GateEntryDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "LRNoVehicleNo" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "AmountInWords" | "nvarchar" | 1028 | 0 | 0 | true | false | "(N' ')" |
| "CurrencyCode" | "nvarchar" | 32 | 0 | 0 | true | false | "(N' ')" |
| "ConversionRate" | "numeric" | 9 | 18 | 10 | true | false | "((0))" |
| "PurchaseDivision" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "ModeOfTransport" | "nvarchar" | 200 | 0 | 0 | true | false | "(N' ')" |
| "PurchaseReferenceRemark" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "DeliveryAddress" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "TermsOfPayment" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "TermsOfDelivery" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "ReceivedBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "Narration" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "IsPurchaseInvoiceCreated" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "VoucherApprovalByEmployeeID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "WorkOrderNarration" | "nvarchar" | 2048 | 0 | 0 | true | false | NULL |
| "JobReference" | "nvarchar" | 2048 | 0 | 0 | true | false | NULL |
| "NatureOfwork" | "nvarchar" | 2048 | 0 | 0 | true | false | NULL |
| "PlanContName" | "nvarchar" | 2048 | 0 | 0 | true | false | NULL |
| "PlanContentType" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |
| "IsPostedInTally" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "EWayBillNumber" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |
| "EWayBillDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsMailSent" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "CompanyID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "BranchID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "UserID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "IsDeleted" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "IsBlocked" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "FYear" | "nvarchar" | 100 | 0 | 0 | true | false | "(N' ')" |
| "IsLocked" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "CreatedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "CreatedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "ModifiedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "ModifiedDate" | "datetime" | 8 | 23 | 3 | true | false | "(getdate())" |
| "DeletedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "DeletedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsDeletedTransaction" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "RefVoucherNo" | "nvarchar" | 64 | 0 | 0 | true | false | NULL |
| "IsIntegrated" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "ProductionUnitID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "GateEntryTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "VehicleNo" | "nvarchar" | 100 | 0 | 0 | true | false | NULL |
| "VoucherVerifiedByEmployeeID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "LoadingPort" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |
| "DischargePort" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |
| "ProformaNo" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |
| "ProformaDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "ProductionUpdateID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "SalesEmployeeID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "PONo" | "nvarchar" | 512 | 0 | 0 | true | false | NULL |
| "PODate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "JobCoordinatorID" | "int" | 4 | 10 | 0 | true | false | NULL |
| "DestinationProductionID" | "int" | 4 | 10 | 0 | true | false | NULL |

## 2. ItemTransactionDetail: columns, nullability, defaults

| ColumnName | DataType | MaxLength | Precision | Scale | Nullable | IsIdentity | DefaultValue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| "TransactionDetailID" | "bigint" | 8 | 19 | 0 | false | true | NULL |
| "TransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "ParentTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "TransID" | "int" | 4 | 10 | 0 | true | false | "((1))" |
| "ItemGroupID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "ItemID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "JobBookingID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "JobBookingJobCardContentsID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "MachineID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "DepartmentID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "ProcessID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "RequiredNoOfPacks" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "QuantityPerPack" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "RequiredQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "PurchaseOrderQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "PurchaseUnit" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "ChallanQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "ReceiptQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "IssueQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "ApprovedQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "RejectedQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "QCApprovalNo" | "nvarchar" | 256 | 0 | 0 | true | false | "(N' ')" |
| "OldStockQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "NewStockQuantity" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "ChallanWeight" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "BatchNo" | "nvarchar" | 256 | 0 | 0 | true | false | "(N' ')" |
| "BatchID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "SupplierBatchNo" | "nvarchar" | 128 | 0 | 0 | true | false | "(N'')" |
| "MfgDate" | "date" | 3 | 10 | 0 | true | false | NULL |
| "ExpiryDate" | "date" | 3 | 10 | 0 | true | false | NULL |
| "PurchaseRate" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "PalletNo" | "nvarchar" | 256 | 0 | 0 | true | false | "(N' ')" |
| "StockUnit" | "nvarchar" | 128 | 0 | 0 | true | false | "(N' ')" |
| "PurchaseTolerance" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "GrossAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "DiscountPercentage" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "DiscountAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "BasicAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "TaxableAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "GSTPercentage" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "CGSTPercentage" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "SGSTPercentage" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "IGSTPercentage" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "CGSTAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "SGSTAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "IGSTAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "NetAmount" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "LandedRate" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "GrsRate" | "real" | 4 | 24 | 0 | true | false | NULL |
| "QCApprovedNarration" | "nvarchar" | 2048 | 0 | 0 | true | false | NULL |
| "ItemNarration" | "nvarchar" | 2048 | 0 | 0 | true | false | "(N' ')" |
| "WarehouseID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "FloorWarehouseID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "DestinationWarehouseID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "RequisitionItemID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "RequisitionTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "PurchaseTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "PicklistTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "IssueTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "PicklistReleaseTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "IsVoucherItemApproved" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "VoucherItemApprovedBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "VoucherItemApprovedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "ReceiptWtPerPacking" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "RefJobBookingJobCardContentsID" | "nvarchar" | 512 | 0 | 0 | true | false | "((0))" |
| "RefJobCardContentNo" | "nvarchar" | 512 | 0 | 0 | true | false | NULL |
| "CurrentStockInStockUnit" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "CurrentStockInPurchaseUnit" | "float" | 8 | 53 | 0 | true | false | "((0))" |
| "IsReleased" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "ReleasedBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "ReleasedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsCompleted" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "CompletedBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "CompletedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsCancelled" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "CancelledBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "CancelledDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsAuditApproved" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "AuditApprovedBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "AuditApprovedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsAuditCancelled" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "AuditCancelledBy" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "AuditCancelledDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "QtyInKg" | "real" | 4 | 24 | 0 | true | false | "((0))" |
| "WoTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "WoIdentityID" | "tinyint" | 1 | 3 | 0 | true | false | "((0))" |
| "JumboRollSlittingTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "InvoiceTransactionID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "CompanyID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "BranchID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "UserID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "ExpectedDeliveryDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "HSNCode" | "nvarchar" | 128 | 0 | 0 | true | false | NULL |
| "ProductHSNID" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "IsDeleted" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "IsBlocked" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "FYear" | "nvarchar" | 100 | 0 | 0 | true | false | "(N' ')" |
| "IsLocked" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "CreatedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "CreatedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "ModifiedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "ModifiedDate" | "datetime" | 8 | 23 | 3 | true | false | "(getdate())" |
| "DeletedBy" | "int" | 4 | 10 | 0 | true | false | "((0))" |
| "DeletedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "IsDeletedTransaction" | "bit" | 1 | 1 | 0 | true | false | "((0))" |
| "RefBatchNo" | "nvarchar" | 256 | 0 | 0 | true | false | "('')" |
| "ProductionUnitID" | "bigint" | 8 | 19 | 0 | true | false | "((0))" |
| "IsRejected" | "bit" | 1 | 1 | 0 | true | false | NULL |
| "RejectedBy" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "RejectedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "ConversionRate" | "float" | 8 | 53 | 0 | true | false | NULL |
| "ProductionUpdateID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "IsVoucherItemVerified" | "bit" | 1 | 1 | 0 | true | false | NULL |
| "VoucherItemVerifiedBy" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "VoucherItemVerifiedDate" | "datetime" | 8 | 23 | 3 | true | false | NULL |
| "Remark" | "nvarchar" | 1024 | 0 | 0 | true | false | NULL |
| "BasicAmountINR" | "real" | 4 | 24 | 0 | true | false | NULL |
| "HoldQuantity" | "float" | 8 | 53 | 0 | true | false | NULL |
| "ItemDescription" | "nvarchar" | 1024 | 0 | 0 | true | false | NULL |
| "RejectStock" | "nvarchar" | 1024 | 0 | 0 | true | false | NULL |
| "ClientID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "DestinationProductionID" | "int" | 4 | 10 | 0 | true | false | NULL |
| "ClientTransactionID" | "bigint" | 8 | 19 | 0 | true | false | NULL |
| "RefClientBatchNo" | "nvarchar" | 256 | 0 | 0 | true | false | NULL |

### Indexes on ItemTransactionMain

| IndexName | Type | IsUnique | HasFilter | KeyColumns | IncludedColumns |
| --- | --- | --- | --- | --- | --- |
| "PK_ItemTransactionMain" | "CLUSTERED" | true | false | "TransactionID DESC" | NULL |
| "NonClusteredIndex-20201118-155906" | "NONCLUSTERED" | false | false | "LedgerID, JobBookingID DESC, JobBookingJobCardContentsID DESC, DepartmentID, CompanyID, IsDeletedTransaction" | NULL |
| "NonClusteredIndex-20210704-155615" | "NONCLUSTERED" | false | false | "VoucherID, CompanyID" | NULL |
| "NonClusteredIndex-20210709-100257" | "NONCLUSTERED" | false | false | "VoucherID, JobBookingJobCardContentsID DESC, CompanyID, IsDeletedTransaction" | "VoucherNo" |
| "NonClusteredIndex-20210906-191122" | "NONCLUSTERED" | false | false | "VoucherID, CompanyID, FYear DESC, IsDeletedTransaction" | "VoucherNo, VoucherDate, DepartmentID, CreatedBy" |
| "NonClusteredIndex-20211129-104524" | "NONCLUSTERED" | false | false | "VoucherPrefix, VoucherID, CompanyID, FYear, IsDeletedTransaction" | "MaxVoucherNo" |
| "IX_ITM_Voucher_Deleted" | "NONCLUSTERED" | false | false | "VoucherID, IsDeletedTransaction, TransactionID" | NULL |
| "IX_ITM_TxnVoucher" | "NONCLUSTERED" | false | false | "TransactionID, VoucherID, CompanyID" | "IsDeletedTransaction" |
| "IX_ITM_VoucherID_Deleted" | "NONCLUSTERED" | false | false | "VoucherID, IsDeletedTransaction" | "TransactionID, VoucherNo, VoucherDate" |

## 3. WarehouseMaster (discovery item 2)

Columns: `WarehouseID`, `WarehouseBinName`, `WarehouseName`, `BinName`, `City`, `Address`, `UnderCompany`, `LocationX`, `LocationY`, `MatrixSizeRows`, `MatrixSizeColumns`, `TallyWarehouseName`, `CompanyID`, `BranchID`, `UserID`, `IsDeleted`, `IsBlocked`, `FYear`, `IsLocked`, `CreatedBy`, `CreatedDate`, `ModifiedBy`, `ModifiedDate`, `DeletedBy`, `DeletedDate`, `IsDeletedTransaction`, `WarehousePrefix`, `MaxWarehouseCode`, `WarehouseCode`, `WarehouseRefCode`, `ProductionUnitID`, `RefWarehouseCode`, `IsFloorWarehouse`

Known: 13 and 17 are store bins in Panchla; 16 is Floor-Panchla / Paper.
| WarehouseID | WarehouseBinName | WarehouseName | BinName | City | Address | UnderCompany | LocationX | LocationY | MatrixSizeRows | MatrixSizeColumns | TallyWarehouseName | CompanyID | BranchID | UserID | IsDeleted | IsBlocked | FYear | IsLocked | CreatedBy | CreatedDate | ModifiedBy | ModifiedDate | DeletedBy | DeletedDate | IsDeletedTransaction | WarehousePrefix | MaxWarehouseCode | WarehouseCode | WarehouseRefCode | ProductionUnitID | RefWarehouseCode | IsFloorWarehouse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "13" | "Panchla-Paper warehouse " | "Panchla" | "Paper warehouse " | "Howrah" | "Unit II - Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist : Howrah, PIN : 711322, India" | " " | 0 | 0 | 0 | 0 | " " | 2 | 1 | 2 | false | false | "2024-2025" | false | 2 | 2024-11-12T15:19:07.440Z | 2 | 2025-12-08T11:43:33.843Z | 0 | NULL | false | "WH" | 1 | "WH00001" | NULL | "2" | "" | false |
| "16" | "Floor-Panchla-Paper" | "Floor-Panchla" | "Paper" | "Howrah" | "Unit II - Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist : Howrah, PIN : 711322, India" | " " | 0 | 0 | 0 | 0 | " " | 2 | 1 | 2 | false | false | "2025-2026" | false | 2 | 2025-05-13T16:04:32.257Z | 2 | 2025-10-31T18:56:23.657Z | 0 | NULL | false | "WH" | 4 | "WH00004" | NULL | "2" | "" | true |
| "17" | "Panchla-Outside 1" | "Panchla" | "Outside 1" | "Howrah" | "Unit II - Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist : Howrah, PIN : 711322, India" | " " | 0 | 0 | 0 | 0 | " " | 2 | 1 | 2 | false | false | "" | false | 2 | 2025-11-27T17:25:18.290Z | 2 | 2025-12-08T11:43:33.843Z | 0 | NULL | false | "" | 0 | "" | NULL | "2" | "" | false |

Every warehouse flagged as a floor warehouse:
| WarehouseID | WarehouseName | BinName | IsFloorWarehouse | IsDeleted | IsDeletedTransaction |
| --- | --- | --- | --- | --- | --- |
| "16" | "Floor-Panchla" | "Paper" | true | false | false |
| "14" | "Floor-Tangra" | "Floor" | true | false | false |

## 4. Master name columns (discovery item 3)

- **DepartmentMaster**: `ID`, `DepartmentID`, `DepartmentName`, `Press`, `IsBlocked`, `DepartmentPicture`, `IsShow`, `BranchID`, `CompanyID`, `SequenceNo`, `UserID`, `ModifiedDate`, `IsLocked`, `CreatedBy`, `CreatedDate`, `ModifiedBy`, `DeletedBy`, `DeletedDate`, `IsDeletedTransaction`, `FYear`, `ProductionUnitID`, `DeletedRemark`, `BottleneckForProduction`
- **ProcessMaster**: `ProcessID`, `ProcessName`, `TypeofCharges`, `SizeToBeConsidered`, `Rate`, `MinimumCharges`, `DepartmentID`, `PrePress`, `ProductionMode`, `SetupCharges`, `IsDisplay`, `IsDisplayOnline`, `ChargeApplyOnSheets`, `DisplayProcessName`, `ProcessGroupID`, `StartUnit`, `EndUnit`, `UnitConversion`, `MinimumL`, `MinimumW`, `MaximumL`, `MaximumW`, `PowerConsumption`, `Speed`, `IsBlocked`, `IsDefaultProcess`, `MasterProcessID`, `CompanyID`, `IsGang`, `ModifiedDate`, `IsFormWiseProduction`, `IsCombineContents_Binding`, `IsGathering`, `MakeReadyTime`, `AvgMachineSpeed`, `ToolRequired`, `ToolCategory`, `UserID`, `IsLocked`, `CreatedBy`, `CreatedDate`, `ModifiedBy`, `DeletedBy`, `DeletedDate`, `IsDeletedTransaction`, `FYear`, `AllocattedMachineID`, `AllocatedContentID`, `ProcessProductionType`, `ProcessPurpose`, `IsEditToBeProduceQty`, `IsOnlineProcess`, `ProcessModuleType`, `MinimumQuantityToBeCharged`, `ToolGroupID`, `ProductionUnitID`, `ProcessFlatWastageValue`, `ProcessWastagePercentage`, `DeletedRemark`, `RefProcessID`, `ProcessCategory`
- **MachineMaster**: `MachineId`, `MachineName`, `MinimumSheet`, `Gripper`, `MaxLength`, `MaxWidth`, `MinLength`, `MinWidth`, `MaxPrintL`, `MaxPrintW`, `MinPrintL`, `MinPrintW`, `Colors`, `MakeReadyCharges`, `MakeReadyWastageSheet`, `DepartmentID`, `MachineType`, `MakeReadyTime`, `ElectricConsumption`, `PrintingMargin`, `WebCutOffSize`, `MinReelSize`, `MaxReelSize`, `MachineSpeed`, `LabourCharges`, `WebCutOffSizeMin`, `ChargesType`, `RoundofImpressionsWith`, `IsPerfectaMachine`, `BasicPrintingCharges`, `JobChangeOverTime`, `PlateLength`, `PlateWidth`, `OtherCharges`, `BoardThicknessMin`, `BoardThicknessMax`, `RadiusMax`, `RadiusMin`, `WastageType`, `WastageCalculationOn`, `PrintingUnitID`, `IsBlocked`, `PerHourCost`, `CostPerHour`, `ShowInSchedule`, `ElectricConsumptionUnitPerMinute`, `AverageSpeedPerHour`, `CurrentStatus`, `MachineCode`, `MinRollWidth`, `MaxRollWidth`, `DelamOrRelam`, `MakeReadyWastageRunningMeter`, `AvgBreakDownTime`, `RollChangeTime`, `AvgBreakDownRunningMeters`, `MachinePaperLength`, `MachineWidth`, `AverageRollChangeWastage`, `AverageRollLength`, `WebCutOffSizeMax`, `MinCircumference`, `MaxCircumference`, `SpeedRunningMeters`, `BranchID`, `CompanyID`, `IsLocked`, `CreatedBy`, `CreatedDate`, `ModifiedBy`, `DeletedBy`, `DeletedDate`, `IsDeletedTransaction`, `UserID`, `ModifiedDate`, `FYear`, `MachineProductionStatus`, `IsPlanningMachine`, `IsVariableCutOff`, `IsSpecialMachine`, `ProductionUnitID`, `RefMachineCode`, `MaxMachineNo`, `DeletedRemark`, `RefMachineID`
- **LedgerMaster**: `LedgerID`, `LedgerCode`, `MaxLedgerNo`, `LedgerCodePrefix`, `LedgerName`, `LedgerDescription`, `LedgerUnitID`, `LedgerType`, `LedgerGroupID`, `ISLedgerActive`, `CompanyID`, `UserID`, `CreatedDate`, `ModifiedDate`, `IsDeleted`, `IsBlocked`, `FYear`, `IsLocked`, `CreatedBy`, `ModifiedBy`, `DeletedBy`, `DeletedDate`, `IsDeletedTransaction`, `Password`, `ExLedgerName`, `TallyCode`, `DepartmentID`, `MailingName`, `MailingAddress`, `Address1`, `Address2`, `Address3`, `City`, `District`, `State`, `Country`, `Pincode`, `MobileNo`, `GSTNo`, `PANNo`, `GSTApplicable`, `Email`, `TaxType`, `GSTLedgerType`, `TaxPercentage`, `GSTCalculationOn`, `RefClientID`, `RefSalesRepresentativeID`, `TelephoneNo`, `Website`, `Designation`, `FAX`, `InventoryEffect`, `IsTaxType`, `MaintainBillWise`, `CurrencyCode`, `DateOfBirth`, `LegalName`, `TradeName`, `SupplyTypeCode`, `Remarks`, `TaxRatePer`, `InAmount`, `IsCumulative`, `TallyLedgerName`, `LedgerRefCode`, `LedgerRefName`, `IsIntegrated`, `Target`, `ProductionUnitID`, `RefLedgerID`, `MaxCreditLimit`, `MaxCreditPeriod`, `FixedLimit`, `Status`, `CustomerType`, `CustomerCategory`, `NaturalAccount`, `LedgerCodeString`
- **UserMaster**: `UserID`, `UserName`, `UnderUserID`, `Password`, `ProfilePicHref`, `City`, `State`, `Country`, `Details`, `IsAdmin`, `IsCreateUser`, `CreationDate`, `LastModiDate`, `UserLevel`, `CurrentEntryDate`, `FromDate`, `ToDate`, `FYear`, `FlagCaseSetting`, `ContactNo`, `EmailID`, `smtpUserName`, `smtpUserPassword`, `smtpServer`, `smtpServerPort`, `smtpAuthenticate`, `smtpUseSSL`, `IsEditableProductionDate`, `SalesProfileID`, `EmailMessage`, `HeaderText`, `FooterText`, `IsExtraPaperIssue`, `ISChooseAnotherPaper`, `IsBlocked`, `IsCahangeGsmJobcard`, `Designation`, `SignatureImage`, `EmployeeId`, `IsHidden`, `IsUserViewOtherQuotation`, `SignPicHref`, `UserWiseOperatorsIDStr`, `IsCreateDirectInvoice`, `ExportHeaderText`, `ExportFooterText`, `IsModifyScheduleProcess`, `IsDeleteProductionEntry`, `IsSaveEditClosedJobProcess`, `POEmailMessage`, `POHeaderText`, `POFooterText`, `AllowAccessTallyInterface`, `IsUserCannotViewCostingDetail`, `IsSendSMS`, `IsSendEmail`, `IsNeedSMS`, `IsNeedEmail`, `CompanyID`, `BranchID`, `IsDeletedUser`, `CreatedBy`, `ModifiedBy`, `DeletedBy`, `DeletedDate`, `AllowDuplicatePONoInSO`, `AcceptSOLessThanEstimatedQty`, `CanDeleteQuotation`, `CanReviseQuotation`, `CanCopyQuotation`, `CanPrintQuotation`, `CanReviewQuotation`, `CanSendQuotationForSO`, `CanRejectQuotation`, `CanCheckEstimatedJobDetails`, `CanCheckEstimatedDetailCosting`, `CanChangePODate`, `CanEditPOQuantityAndRate`, `CanEditProductionDate`, `CanPackMoreThanSOQty`, `CanCreateDirectPacking`, `CanEditApprovedCostInPriceApproval`, `CanEditRateInSO`, `LoginUserName`, `ProductionUnitID`, `CanAccessMultipleProductionUnitData`, `CanAccessMultipleBranchData`, `AllowToChangeFYear`, `ProductionUnitIDStr`, `CanReceiveExcessMaterial`, `DeletedRemark`, `CanUpdateSODetails`, `IsInvoiceBlockFeatureRequired`, `InvoiceEmailMessage`, `InvoiceHeaderText`, `InvoiceFooterText`, `InvoiceExportHeaderText`, `InvoiceExportFooterText`, `CanAddAdditionalProcessesInPWO`, `CanIReplanthePWOorProductCatalog`, `CanEditMaterialCostParameter`, `ProductID`, `ApiKey`, `PhoneID`

Department 100 (used by both captured issues) and the processes on the captured picklist line:
| ID | DepartmentID | DepartmentName | Press | IsBlocked | DepartmentPicture | IsShow | BranchID | CompanyID | SequenceNo | UserID | ModifiedDate | IsLocked | CreatedBy | CreatedDate | ModifiedBy | DeletedBy | DeletedDate | IsDeletedTransaction | FYear | ProductionUnitID | DeletedRemark | BottleneckForProduction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 47 | 100 | "PRINTING" | "Post" | NULL | NULL | true | NULL | "2" | 3 | 2 | 2025-09-01T11:31:53.243Z | NULL | NULL | NULL | 2 | NULL | NULL | false | "2018-2019" | NULL | NULL | true |
| ProcessID | ProcessName | TypeofCharges | SizeToBeConsidered | Rate | MinimumCharges | DepartmentID | PrePress | ProductionMode | SetupCharges | IsDisplay | IsDisplayOnline | ChargeApplyOnSheets | DisplayProcessName | ProcessGroupID | StartUnit | EndUnit | UnitConversion | MinimumL | MinimumW | MaximumL | MaximumW | PowerConsumption | Speed | IsBlocked | IsDefaultProcess | MasterProcessID | CompanyID | IsGang | ModifiedDate | IsFormWiseProduction | IsCombineContents_Binding | IsGathering | MakeReadyTime | AvgMachineSpeed | ToolRequired | ToolCategory | UserID | IsLocked | CreatedBy | CreatedDate | ModifiedBy | DeletedBy | DeletedDate | IsDeletedTransaction | FYear | AllocattedMachineID | AllocatedContentID | ProcessProductionType | ProcessPurpose | IsEditToBeProduceQty | IsOnlineProcess | ProcessModuleType | MinimumQuantityToBeCharged | ToolGroupID | ProductionUnitID | ProcessFlatWastageValue | ProcessWastagePercentage | DeletedRemark | RefProcessID | ProcessCategory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "10337" | "Printing Front Side" | "Rate/1000 Sheets" | "None" | 0.00001 | 0 | "100" | "Post" | " " | 0 | true | false | "" | "Printing Front Side" | "0" | "SHEET" | "SHEET" | "None" | 0 | 0 | 0 | 0 | 0 | 0 | false | false | "0" | "2" | false | 2025-11-07T20:46:21.173Z | false | false | false | 0 | "0" | false | " " | 2 | false | 2 | 2022-09-29T15:13:33.000Z | 2 | 0 | NULL | false | "2022-2023" | "14,58,48,20,9,60,54,57,15,74,59,7,56,73,67" | "" | "Form Wise Production" | "Production" | true | false | "Universal" | "0" | NULL | NULL | 0 | 0 | NULL | NULL | "Book Pages" |

## 5. Job tables (discovery items 4 and 5)

- **JobBookingJobCard**: `JobBookingID`, `OrderBookingID`, `ProductMasterID`, `BookingID`, `JobBookingPrefix`, `MaxJobBookingNo`, `JobBookingDate`, `JobBookingNo`, `OrderBookingDetailsID`, `PONo`, `PODate`, `ProductCode`, `JobName`, `JobPriority`, `ProductHSNID`, `CategoryID`, `ClientName`, `Address`, `ContactNo`, `Email`, `OrderQuantity`, `ApprovedBy`, `Remark`, `LedgerID`, `ApprovalNo`, `IsProcessDocket`, `DeliveryDate`, `JobStart`, `IsCompletePacked`, `IsCompleteDelivered`, `IsGang`, `IsClose`, `IsCancel`, `IsHold`, `IsApproveJobClose`, `CoordinatorLedgerID`, `ConsigneeID`, `ConsigneeName`, `QualityCheck`, `JobApprovedRemark`, `IsProofingJobCard`, `CreatedBy`, `CreatedDate`, `ModifiedBy`, `ModifiedDate`, `IsDeletedTransaction`, `DeletedDate`, `DeletedBy`, `CompanyID`, `BranchID`, `FYear`, `CriticalInstructions`, `ActualBookingNo`, `JobClosedBy`, `JobClosedDate`, `ActualBookingID`, `IsReleasedForSchedule`, `ReleasedForScheduleBy`, `ReleasedForScheduleDate`, `IsJobConvertToMaterial`, `SalesEmployeeID`, `RefProductMasterCode`, `EstimationUnit`, `IsIntegrated`, `FileNo`, `ProductionUnitID`, `WarehouseID`, `ClosedJobSize`, `ProjectEngineerID`, `ItemFloorWarehouseID`, `JobCloseRemark`, `JobCancelledDate`, `JobCancelledRemark`, `JobCancelledBy`, `RefJobBookingNo`, `IsBOMCreated`, `AttachedFileName`, `JobCardProductImg`, `JobType`, `JobReference`, `ArtworkApproved`, `ArtworkFile`, `ArtworkRemark`, `ArtworkApprovedBy`, `ArtworkApprovalDate`, `PrimaryJobBookingID`, `ArtWorkCode`
- **JobBookingJobCardContents**: `JobBookingJobCardContentsID`, `ProductMasterContentsID`, `ProductMasterID`, `ProductMasterContentNo`, `JobContentsID`, `BookingID`, `JobBookingID`, `JobCardContentNo`, `MachineID`, `MachineName`, `Gripper`, `GripperSide`, `MachineColors`, `PaperID`, `PaperSize`, `CutSize`, `CutL`, `CutW`, `UpsL`, `UpsW`, `TotalUps`, `BalPiece`, `BalSide`, `WasteArea`, `WastePerc`, `WastageKg`, `GrainDirection`, `PlateQty`, `PlateRate`, `PlateAmount`, `MakeReadyWastageSheet`, `ActualSheets`, `WastageSheets`, `TotalPaperWeightInKg`, `FullSheets`, `PaperRate`, `PaperAmount`, `PrintingImpressions`, `ImpressionsToBeCharged`, `PrintingRate`, `PrintingAmount`, `TotalMakeReadies`, `MakeReadyRate`, `MakeReadyAmount`, `FinalQuantity`, `TotalColors`, `TotalAmount`, `CutLH`, `CutHL`, `PrintingStyle`, `PrintingChargesType`, `ExpectedExecutionTime`, `TotalExecutionTime`, `MainPaperName`, `PlanType`, `PaperRateType`, `DieCutSize`, `InterlockStyle`, `NoOfSets`, `OldGrantAmount`, `GrantAmount`, `UnitPrice`, `Packing`, `UnitPerPacking`, `RoundofImpressionsWith`, `SpeColorFCharges`, `SpeColorBCharges`, `SpeColorFAmt`, `SpeColorBAmt`, `OpAmt`, `PlanID`, `PlanContQty`, `PlanContentType`, `PlanContName`, `SequenceNo`, `ContentSizeValues`, `CoatingCharges`, `CoatingAmount`, `PaperGroup`, `CoordinatorLedgerID`, `CoordinatorLedgerName`, `ConsigneeLedgerID`, `PONo`, `JobType`, `JobReference`, `JobPriority`, `JobDetailsRemark`, `IsPlate`, `Email`, `JobSize`, `Tolerence`, `QCInstruction`, `DieID`, `CreatedDate`, `CompanyID`, `BranchID`, `FYear`, `IsIndentSent`, `IndentSentBy`, `IsDeletedTransaction`, `DeletedBy`, `DeletedDate`, `JobCloseSize`, `UpsLayout`, `SheetLayout`, `UserAttachedPicture`, `AttachedFileName`, `IsRelease`, `ReleasedBy`, `ReleasedDate`, `IsJobStarted`, `PlateType`, `PurchaseUnit`, `IsLastProcessComplete`, `SpecialInstructions`, `ModifiedBy`, `ModifiedDate`, `ActualTotalUps`, `MachineType`, `CylinderToolID`, `CylinderToolCode`, `CylinderCircumferenceInch`, `CylinderCircumferenceMM`, `CylinderWidth`, `CylinderNoOfTeeth`, `FeedValue`, `AcrossGap`, `AroundGap`, `WastageStrip`, `RequiredRunningMeter`, `MakeReadyWastageRunningMeter`, `AvgBreakDownRunningMeter`, `WastageRunningMeter`, `TotalRequiredRunningMeter`, `RequiredSquareMeter`, `TotalRequiredSquareMeter`, `WastageSquareMeter`, `ScrapSquareMeter`, `MachineSpeed`, `MachinePerHourRate`, `PaperTotalGSM`, `RequiredPaperWeightKg`, `RollChangeWastageMeter`, `AverageRollLength`, `RollType`, `TotalProcessCost`, `TotalMaterialCost`, `TotalMachineCost`, `WindingDirection`, `WindingDirectionID`, `LabelType`, `OutputType`, `PcsPerRoll`, `PaperFaceGSM`, `PaperReleaseGSM`, `PaperAdhesiveGSM`, `PaperMill`, `DieType`, `CoreInnerDia`, `CoreOuterDia`, `EstimationQuantityUnit`, `FinalQuantityInPcs`, `RefProductMasterCode`, `EstimationSvgSheetImage`, `EstimationSvgUpsImage`, `ConvertToSemiFinishGood`, `ReportRemark`, `CorrugationAmount`, `CorrugationQuantity`, `ProductionUnitID`, `ProcessWastageSheets`, `ProcessWastageRunningMeter`, `CostingHeadGridSettingStr`, `PlanOtherMaterialGSM`, `PlanOtherMaterialGSMSettingJSON`, `IsReleasedForSchedule`, `ReleasedForScheduleBy`, `ReleasedForScheduleDate`, `IsChangeQuantityReplanFlag`, `OrderBookingID`, `OrderBookingDetailsID`, `IsAllocationClosed`
- **JobBookingJobCardProcessMaterialRequirement**: `JobCardProcessMaterialRequirementID`, `BookingID`, `JobBookingID`, `MachineID`, `ProcessID`, `SequenceNo`, `JobBookingJobCardContentsID`, `ItemID`, `ItemGroupID`, `ItemGroupNameID`, `PlanContName`, `PlanContentType`, `PlanContQty`, `NoOfCuts`, `BookedQtyInPurchaseUnit`, `PurchaseUnit`, `NoOfUps`, `EstimatedQuantity`, `Rate`, `Amount`, `RequiredQty`, `WasteQty`, `RequiredQtyUnit`, `StockUnit`, `CompanyID`, `FYear`, `CreatedBy`, `CreatedDate`, `IsBlocked`, `IsLocked`, `IsDeletedTransaction`, `DeletedDate`, `DeletedBy`, `RateFactor`, `IsCreateIndent`, `IsCreatePickList`, `EstimationUnit`, `IsPlannedItem`, `EstimationRate`, `EstimatedAmount`, `RequiredQuantityInStockUnit`, `ProductionUnitID`

Job content J06482_26_27[1_1] (test B) and its material requirement:
| JobBookingJobCardContentsID | JobBookingID | JobCardContentNo | PlanContName | JobBookingNo | JobName | ClientName | OrderBookingID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| "23524" | "15607" | "J06482_26_27[1_1]" | "Reverse Tuck In" | "J06482_26_27" | "ROSEKANDY GREEN TEA MONO CTN" | "COSMOCRAFT FINE ARTS PRIVATE LIMITED" | "12979" |
| JobBookingID | JobBookingJobCardContentsID | ProcessID | MachineID | ItemID | ItemCode | StockUnit | RequiredQuantityInStockUnit | RequiredQty | SequenceNo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "15607" | "23524" | "10337" | "58" | "10148" | "R01312" | "Kg" | 137.69 | 0 | 0 |
| "15607" | "23524" | "10421" | "14" | "5202" | "I00379" | "Kg" | 1.43 | 0 | 2 |
| "15607" | "23524" | "10337" | "58" | "6023" | "I00437" | "Kg" | 1.43 | 0 | 3 |
| "15607" | "23524" | "10421" | "14" | "3636" | "V00029" | "Kg" | 1.43 | 0 | 1 |

## 6. Voucher numbering scope (discovery item 6)

FYear values on -19 vouchers (confirms the stored format):
| FYear | Vouchers | MinNo | MaxNo |
| --- | --- | --- | --- |
| "2026-2027" | 17416 | "1" | "17302" |
| "2025-2026" | 19039 | "1" | "18950" |

Per company in 2026-2027:
| CompanyID | Vouchers | MinNo | MaxNo | Deleted |
| --- | --- | --- | --- | --- |
| 2 | 17416 | "1" | "17302" | 514 |

(a) The same MaxVoucherNo in more than one CompanyID:
_(no rows)_

(b) The same MaxVoucherNo on both a deleted and a live voucher (same company):
| CompanyID | MaxVoucherNo | Vouchers |
| --- | --- | --- |
| 2 | "17293" | 2 |
| 2 | "17198" | 2 |
| 2 | "16997" | 2 |
| 2 | "16530" | 2 |
| 2 | "15094" | 2 |
| 2 | "15071" | 2 |
| 2 | "14646" | 2 |
| 2 | "13524" | 2 |
| 2 | "13079" | 2 |
| 2 | "12428" | 2 |
| 2 | "10781" | 2 |
| 2 | "10418" | 2 |
| 2 | "10241" | 2 |
| 2 | "9879" | 2 |
| 2 | "9634" | 2 |
| 2 | "8976" | 2 |
| 2 | "7735" | 2 |
| 2 | "7167" | 2 |
| 2 | "6758" | 2 |
| 2 | "5785" | 2 |

Any duplicate MaxVoucherNo at all within one company (should be none):
| CompanyID | MaxVoucherNo | Vouchers |
| --- | --- | --- |
| 2 | "17293" | 2 |
| 2 | "17198" | 2 |
| 2 | "16997" | 2 |
| 2 | "16984" | 2 |
| 2 | "16888" | 3 |
| 2 | "16882" | 2 |
| 2 | "16530" | 2 |
| 2 | "16459" | 2 |
| 2 | "16422" | 2 |
| 2 | "16380" | 2 |
| 2 | "16366" | 2 |
| 2 | "16144" | 2 |
| 2 | "15885" | 2 |
| 2 | "15376" | 2 |
| 2 | "15125" | 2 |
| 2 | "15094" | 2 |
| 2 | "15071" | 2 |
| 2 | "14827" | 2 |
| 2 | "14646" | 2 |
| 2 | "14641" | 2 |

Decision: if (a) has rows, numbering is shared across companies — keep `@NumberPerCompany = 0`. If there is only one company, or (a) is empty while several companies have overlapping ranges, numbering is per company — set `@NumberPerCompany = 1` in `002_usp_IssueTool_PostIssue.sql`. (b) having rows would mean the ERP reuses deleted numbers; the procedure assumes it does not.

## 7. Template vouchers (discovery item 7)


### Allocated (lines carry PicklistTransactionID)

TransactionID **66933**, "IS17300_26_27", 1 line(s).

**Header**, every column:
| column | value | written |
| --- | --- | --- |
| "TransactionID" | "66933" | "" |
| "VoucherPrefix" | "IS" | "yes" |
| "MaxVoucherNo" | "17300" | "yes" |
| "VoucherID" | "-19" | "yes" |
| "VoucherNo" | "IS17300_26_27" | "yes" |
| "VoucherDate" | 2026-10-05T00:00:00.000Z | "yes" |
| "LedgerID" | "0" | "" |
| "DealerID" | "0" | "" |
| "DepartmentID" | "100" | "yes" |
| "JobBookingID" | "16316" | "yes" |
| "JobBookingJobCardContentsID" | "24550" | "yes" |
| "MachineID" | "0" | "" |
| "OperationID" | "0" | "" |
| "ContactPersonID" | "0" | "" |
| "SourceWarehouseID" | "0" | "" |
| "DestinationWarehouseID" | "0" | "" |
| "TotalQuantity" | 363 | "yes" |
| "TotalBasicAmount" | 0 | "" |
| "TotalDiscountAmount" | 0 | "" |
| "TotalCGSTTaxAmount" | 0 | "" |
| "TotalSGSTTaxAmount" | 0 | "" |
| "TotalIGSTTaxAmount" | 0 | "" |
| "TotalTaxAmount" | 0 | "" |
| "NetAmount" | 0 | "" |
| "TotalOverheadAmount" | 0 | "" |
| "Particular" | " " | "" |
| "DeliveryNoteNo" | " " | "yes" |
| "DeliveryNoteDate" | NULL | "" |
| "Transporter" | " " | "" |
| "GateEntryNo" | " " | "" |
| "GateEntryDate" | NULL | "" |
| "LRNoVehicleNo" | " " | "" |
| "AmountInWords" | " " | "" |
| "CurrencyCode" | " " | "" |
| "ConversionRate" | 0 | "" |
| "PurchaseDivision" | " " | "" |
| "ModeOfTransport" | " " | "" |
| "PurchaseReferenceRemark" | " " | "" |
| "DeliveryAddress" | " " | "" |
| "TermsOfPayment" | " " | "" |
| "TermsOfDelivery" | " " | "" |
| "ReceivedBy" | "0" | "" |
| "Narration" | "" | "yes" |
| "IsPurchaseInvoiceCreated" | false | "" |
| "VoucherApprovalByEmployeeID" | 0 | "" |
| "WorkOrderNarration" | NULL | "" |
| "JobReference" | NULL | "" |
| "NatureOfwork" | NULL | "" |
| "PlanContName" | NULL | "" |
| "PlanContentType" | NULL | "" |
| "IsPostedInTally" | false | "" |
| "EWayBillNumber" | NULL | "" |
| "EWayBillDate" | NULL | "" |
| "IsMailSent" | false | "" |
| "CompanyID" | 2 | "yes" |
| "BranchID" | 0 | "" |
| "UserID" | 24 | "yes" |
| "IsDeleted" | false | "" |
| "IsBlocked" | false | "" |
| "FYear" | "2026-2027" | "yes" |
| "IsLocked" | false | "" |
| "CreatedBy" | 24 | "yes" |
| "CreatedDate" | 2026-10-05T12:19:06.323Z | "yes" |
| "ModifiedBy" | 24 | "yes" |
| "ModifiedDate" | 2026-10-05T12:19:06.323Z | "yes" |
| "DeletedBy" | 0 | "" |
| "DeletedDate" | NULL | "" |
| "IsDeletedTransaction" | false | "yes" |
| "RefVoucherNo" | NULL | "" |
| "IsIntegrated" | 0 | "" |
| "ProductionUnitID" | "0" | "" |
| "GateEntryTransactionID" | "0" | "" |
| "VehicleNo" | NULL | "" |
| "VoucherVerifiedByEmployeeID" | NULL | "" |
| "LoadingPort" | NULL | "" |
| "DischargePort" | NULL | "" |
| "ProformaNo" | NULL | "" |
| "ProformaDate" | NULL | "" |
| "ProductionUpdateID" | NULL | "" |
| "SalesEmployeeID" | NULL | "" |
| "PONo" | NULL | "" |
| "PODate" | NULL | "" |
| "JobCoordinatorID" | NULL | "" |
| "DestinationProductionID" | NULL | "" |

**Lines**, every column:
| column | TransID 1 | written |
| --- | --- | --- |
| "TransactionDetailID" | "114417" | "" |
| "TransactionID" | "66933" | "yes" |
| "ParentTransactionID" | "58277" | "yes" |
| "TransID" | 1 | "yes" |
| "ItemGroupID" | "2" | "yes" |
| "ItemID" | "6848" | "yes" |
| "JobBookingID" | "16316" | "yes" |
| "JobBookingJobCardContentsID" | "24550" | "yes" |
| "MachineID" | "14" | "yes" |
| "DepartmentID" | "100" | "yes" |
| "ProcessID" | "15" | "yes" |
| "RequiredNoOfPacks" | 0 | "" |
| "QuantityPerPack" | 0 | "" |
| "RequiredQuantity" | 0 | "" |
| "PurchaseOrderQuantity" | 0 | "" |
| "PurchaseUnit" | " " | "" |
| "ChallanQuantity" | 0 | "" |
| "ReceiptQuantity" | 0 | "" |
| "IssueQuantity" | 363 | "yes" |
| "ApprovedQuantity" | 0 | "" |
| "RejectedQuantity" | 0 | "" |
| "QCApprovalNo" | " " | "" |
| "OldStockQuantity" | 0 | "" |
| "NewStockQuantity" | 0 | "" |
| "ChallanWeight" | 0 | "" |
| "BatchNo" | "58277_PO01999_26_27_6848_2.00" | "yes" |
| "BatchID" | "98130" | "yes" |
| "SupplierBatchNo" | "" | "" |
| "MfgDate" | NULL | "" |
| "ExpiryDate" | NULL | "" |
| "PurchaseRate" | 0 | "" |
| "PalletNo" | " " | "" |
| "StockUnit" | "Kg" | "yes" |
| "PurchaseTolerance" | 0 | "" |
| "GrossAmount" | 0 | "" |
| "DiscountPercentage" | 0 | "" |
| "DiscountAmount" | 0 | "" |
| "BasicAmount" | 0 | "" |
| "TaxableAmount" | 0 | "" |
| "GSTPercentage" | 0 | "" |
| "CGSTPercentage" | 0 | "" |
| "SGSTPercentage" | 0 | "" |
| "IGSTPercentage" | 0 | "" |
| "CGSTAmount" | 0 | "" |
| "SGSTAmount" | 0 | "" |
| "IGSTAmount" | 0 | "" |
| "NetAmount" | 0 | "" |
| "LandedRate" | 0 | "" |
| "GrsRate" | NULL | "" |
| "QCApprovedNarration" | NULL | "" |
| "ItemNarration" | " " | "" |
| "WarehouseID" | "13" | "yes" |
| "FloorWarehouseID" | "16" | "yes" |
| "DestinationWarehouseID" | "0" | "" |
| "RequisitionItemID" | "0" | "" |
| "RequisitionTransactionID" | "0" | "" |
| "PurchaseTransactionID" | "0" | "" |
| "PicklistTransactionID" | "65445" | "yes" |
| "IssueTransactionID" | "0" | "" |
| "PicklistReleaseTransactionID" | "0" | "yes" |
| "IsVoucherItemApproved" | false | "" |
| "VoucherItemApprovedBy" | "0" | "" |
| "VoucherItemApprovedDate" | NULL | "" |
| "ReceiptWtPerPacking" | 0 | "" |
| "RefJobBookingJobCardContentsID" | "0" | "" |
| "RefJobCardContentNo" | NULL | "" |
| "CurrentStockInStockUnit" | 0 | "" |
| "CurrentStockInPurchaseUnit" | 0 | "" |
| "IsReleased" | false | "" |
| "ReleasedBy" | "0" | "" |
| "ReleasedDate" | NULL | "" |
| "IsCompleted" | false | "" |
| "CompletedBy" | "0" | "" |
| "CompletedDate" | NULL | "" |
| "IsCancelled" | false | "yes" |
| "CancelledBy" | "0" | "" |
| "CancelledDate" | NULL | "" |
| "IsAuditApproved" | false | "" |
| "AuditApprovedBy" | "0" | "" |
| "AuditApprovedDate" | NULL | "" |
| "IsAuditCancelled" | false | "" |
| "AuditCancelledBy" | "0" | "" |
| "AuditCancelledDate" | NULL | "" |
| "QtyInKg" | 0 | "" |
| "WoTransactionID" | "0" | "" |
| "WoIdentityID" | 0 | "" |
| "JumboRollSlittingTransactionID" | "0" | "" |
| "InvoiceTransactionID" | "0" | "" |
| "CompanyID" | 2 | "yes" |
| "BranchID" | 0 | "" |
| "UserID" | 24 | "yes" |
| "ExpectedDeliveryDate" | NULL | "" |
| "HSNCode" | NULL | "" |
| "ProductHSNID" | 0 | "" |
| "IsDeleted" | false | "" |
| "IsBlocked" | false | "" |
| "FYear" | "2026-2027" | "yes" |
| "IsLocked" | false | "" |
| "CreatedBy" | 24 | "yes" |
| "CreatedDate" | 2026-10-05T12:19:06.323Z | "yes" |
| "ModifiedBy" | 24 | "yes" |
| "ModifiedDate" | 2026-10-05T12:19:06.323Z | "yes" |
| "DeletedBy" | 0 | "" |
| "DeletedDate" | NULL | "" |
| "IsDeletedTransaction" | false | "yes" |
| "RefBatchNo" | "" | "" |
| "ProductionUnitID" | "0" | "" |
| "IsRejected" | NULL | "" |
| "RejectedBy" | NULL | "" |
| "RejectedDate" | NULL | "" |
| "ConversionRate" | NULL | "" |
| "ProductionUpdateID" | NULL | "" |
| "IsVoucherItemVerified" | NULL | "" |
| "VoucherItemVerifiedBy" | NULL | "" |
| "VoucherItemVerifiedDate" | NULL | "" |
| "Remark" | NULL | "" |
| "BasicAmountINR" | NULL | "" |
| "HoldQuantity" | NULL | "" |
| "ItemDescription" | NULL | "" |
| "RejectStock" | NULL | "" |
| "ClientID" | NULL | "" |
| "DestinationProductionID" | NULL | "" |
| "ClientTransactionID" | NULL | "" |
| "RefClientBatchNo" | NULL | "" |

**TEMPLATE gaps** — columns the procedure does not write where this ERP voucher holds something other than the column default. Each needs a decision before the first real post: add it to the INSERT in `002_usp_IssueTool_PostIssue.sql` with the ERP's value, or note why it differs.
_(no rows)_

**Blank strings** on this voucher (decides `@Blank` in the procedure):
| table | column | value |
| --- | --- | --- |
| "ITM" | "Particular" | " " |
| "ITM" | "DeliveryNoteNo" | " " |
| "ITM" | "Transporter" | " " |
| "ITM" | "GateEntryNo" | " " |
| "ITM" | "LRNoVehicleNo" | " " |
| "ITM" | "AmountInWords" | " " |
| "ITM" | "CurrencyCode" | " " |
| "ITM" | "PurchaseDivision" | " " |
| "ITM" | "ModeOfTransport" | " " |
| "ITM" | "PurchaseReferenceRemark" | " " |
| "ITM" | "DeliveryAddress" | " " |
| "ITM" | "TermsOfPayment" | " " |
| "ITM" | "TermsOfDelivery" | " " |
| "ITM" | "Narration" | "" |
| "ITM" | "WorkOrderNarration" | NULL |
| "ITM" | "JobReference" | NULL |
| "ITM" | "NatureOfwork" | NULL |
| "ITM" | "PlanContName" | NULL |
| "ITM" | "PlanContentType" | NULL |
| "ITM" | "EWayBillNumber" | NULL |
| "ITM" | "RefVoucherNo" | NULL |
| "ITM" | "VehicleNo" | NULL |
| "ITM" | "LoadingPort" | NULL |
| "ITM" | "DischargePort" | NULL |
| "ITM" | "ProformaNo" | NULL |
| "ITM" | "PONo" | NULL |

### Direct (no PicklistTransactionID)

TransactionID **66936**, "IS17302_26_27", 8 line(s).

**Header**, every column:
| column | value | written |
| --- | --- | --- |
| "TransactionID" | "66936" | "" |
| "VoucherPrefix" | "IS" | "yes" |
| "MaxVoucherNo" | "17302" | "yes" |
| "VoucherID" | "-19" | "yes" |
| "VoucherNo" | "IS17302_26_27" | "yes" |
| "VoucherDate" | 2026-10-05T00:00:00.000Z | "yes" |
| "LedgerID" | "0" | "" |
| "DealerID" | "0" | "" |
| "DepartmentID" | "100" | "yes" |
| "JobBookingID" | "0" | "yes" |
| "JobBookingJobCardContentsID" | "0" | "yes" |
| "MachineID" | "0" | "" |
| "OperationID" | "0" | "" |
| "ContactPersonID" | "0" | "" |
| "SourceWarehouseID" | "0" | "" |
| "DestinationWarehouseID" | "0" | "" |
| "TotalQuantity" | 249 | "yes" |
| "TotalBasicAmount" | 0 | "" |
| "TotalDiscountAmount" | 0 | "" |
| "TotalCGSTTaxAmount" | 0 | "" |
| "TotalSGSTTaxAmount" | 0 | "" |
| "TotalIGSTTaxAmount" | 0 | "" |
| "TotalTaxAmount" | 0 | "" |
| "NetAmount" | 0 | "" |
| "TotalOverheadAmount" | 0 | "" |
| "Particular" | " " | "" |
| "DeliveryNoteNo" | "IS17302_26_27" | "yes" |
| "DeliveryNoteDate" | NULL | "" |
| "Transporter" | " " | "" |
| "GateEntryNo" | " " | "" |
| "GateEntryDate" | NULL | "" |
| "LRNoVehicleNo" | " " | "" |
| "AmountInWords" | " " | "" |
| "CurrencyCode" | " " | "" |
| "ConversionRate" | 0 | "" |
| "PurchaseDivision" | " " | "" |
| "ModeOfTransport" | " " | "" |
| "PurchaseReferenceRemark" | " " | "" |
| "DeliveryAddress" | " " | "" |
| "TermsOfPayment" | " " | "" |
| "TermsOfDelivery" | " " | "" |
| "ReceivedBy" | "0" | "" |
| "Narration" | "" | "yes" |
| "IsPurchaseInvoiceCreated" | false | "" |
| "VoucherApprovalByEmployeeID" | 0 | "" |
| "WorkOrderNarration" | NULL | "" |
| "JobReference" | NULL | "" |
| "NatureOfwork" | NULL | "" |
| "PlanContName" | NULL | "" |
| "PlanContentType" | NULL | "" |
| "IsPostedInTally" | false | "" |
| "EWayBillNumber" | NULL | "" |
| "EWayBillDate" | NULL | "" |
| "IsMailSent" | false | "" |
| "CompanyID" | 2 | "yes" |
| "BranchID" | 0 | "" |
| "UserID" | 104 | "yes" |
| "IsDeleted" | false | "" |
| "IsBlocked" | false | "" |
| "FYear" | "2026-2027" | "yes" |
| "IsLocked" | false | "" |
| "CreatedBy" | 104 | "yes" |
| "CreatedDate" | 2026-10-05T12:30:24.270Z | "yes" |
| "ModifiedBy" | 104 | "yes" |
| "ModifiedDate" | 2026-10-05T12:30:24.270Z | "yes" |
| "DeletedBy" | 0 | "" |
| "DeletedDate" | NULL | "" |
| "IsDeletedTransaction" | false | "yes" |
| "RefVoucherNo" | NULL | "" |
| "IsIntegrated" | 0 | "" |
| "ProductionUnitID" | "0" | "" |
| "GateEntryTransactionID" | "0" | "" |
| "VehicleNo" | NULL | "" |
| "VoucherVerifiedByEmployeeID" | NULL | "" |
| "LoadingPort" | NULL | "" |
| "DischargePort" | NULL | "" |
| "ProformaNo" | NULL | "" |
| "ProformaDate" | NULL | "" |
| "ProductionUpdateID" | NULL | "" |
| "SalesEmployeeID" | NULL | "" |
| "PONo" | NULL | "" |
| "PODate" | NULL | "" |
| "JobCoordinatorID" | NULL | "" |
| "DestinationProductionID" | NULL | "" |

**Lines**, every column:
| column | TransID 1 | TransID 2 | TransID 3 | TransID 4 | TransID 5 | TransID 6 | TransID 7 | TransID 8 | written |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "TransactionDetailID" | "114426" | "114427" | "114428" | "114429" | "114430" | "114431" | "114432" | "114433" | "" |
| "TransactionID" | "66936" | "66936" | "66936" | "66936" | "66936" | "66936" | "66936" | "66936" | "yes" |
| "ParentTransactionID" | "66895" | "65910" | "66554" | "66554" | "66554" | "65195" | "66320" | "66147" | "yes" |
| "TransID" | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | "yes" |
| "ItemGroupID" | "8" | "8" | "4" | "4" | "4" | "8" | "8" | "8" | "yes" |
| "ItemID" | "5753" | "5766" | "3636" | "3630" | "3638" | "9962" | "5765" | "5794" | "yes" |
| "JobBookingID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "JobBookingJobCardContentsID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "MachineID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "DepartmentID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "ProcessID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "RequiredNoOfPacks" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "QuantityPerPack" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "RequiredQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "PurchaseOrderQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "PurchaseUnit" | " " | " " | " " | " " | " " | " " | " " | " " | "" |
| "ChallanQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "ReceiptQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "IssueQuantity" | 1 | 90 | 80 | 12 | 40 | 20 | 1 | 5 | "yes" |
| "ApprovedQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "RejectedQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "QCApprovalNo" | " " | " " | " " | " " | " " | " " | " " | " " | "" |
| "OldStockQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "NewStockQuantity" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "ChallanWeight" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "BatchNo" | "66895_PO03201_26_27_5753_5.00" | "65910_PO03022_26_27_5766_1.00" | "66554_PO03149_26_27_3636_8.00" | "66554_PO03149_26_27_3630_9.00" | "66554_PO03149_26_27_3638_7.00" | "65195_PO03013_26_27_9962_10.00" | "66320_PO03146_26_27_5765_4.00" | "66147_PO03150_26_27_5794_1.00" | "yes" |
| "BatchID" | "114316" | "112336" | "113656" | "113657" | "113655" | "111024" | "113239" | "112807" | "yes" |
| "SupplierBatchNo" | "" | "" | "" | "" | "" | "" | "" | "" | "" |
| "MfgDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ExpiryDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "PurchaseRate" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "PalletNo" | " " | " " | " " | " " | " " | " " | " " | " " | "" |
| "StockUnit" | "NOS" | "Liters" | "Kg" | "Kg" | "Kg" | "Kg" | "Liters" | "PCS" | "yes" |
| "PurchaseTolerance" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "GrossAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "DiscountPercentage" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "DiscountAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "BasicAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "TaxableAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "GSTPercentage" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "CGSTPercentage" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "SGSTPercentage" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "IGSTPercentage" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "CGSTAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "SGSTAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "IGSTAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "NetAmount" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "LandedRate" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "GrsRate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "QCApprovedNarration" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ItemNarration" | " " | " " | " " | " " | " " | " " | " " | " " | "" |
| "WarehouseID" | "13" | "13" | "13" | "13" | "13" | "13" | "13" | "13" | "yes" |
| "FloorWarehouseID" | "16" | "16" | "16" | "16" | "16" | "16" | "16" | "16" | "yes" |
| "DestinationWarehouseID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "RequisitionItemID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "RequisitionTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "PurchaseTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "PicklistTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "IssueTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "PicklistReleaseTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "yes" |
| "IsVoucherItemApproved" | false | false | false | false | false | false | false | false | "" |
| "VoucherItemApprovedBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "VoucherItemApprovedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ReceiptWtPerPacking" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "RefJobBookingJobCardContentsID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "RefJobCardContentNo" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "CurrentStockInStockUnit" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "CurrentStockInPurchaseUnit" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "IsReleased" | false | false | false | false | false | false | false | false | "" |
| "ReleasedBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "ReleasedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsCompleted" | false | false | false | false | false | false | false | false | "" |
| "CompletedBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "CompletedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsCancelled" | false | false | false | false | false | false | false | false | "yes" |
| "CancelledBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "CancelledDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsAuditApproved" | false | false | false | false | false | false | false | false | "" |
| "AuditApprovedBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "AuditApprovedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsAuditCancelled" | false | false | false | false | false | false | false | false | "" |
| "AuditCancelledBy" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "AuditCancelledDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "QtyInKg" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "WoTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "WoIdentityID" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "JumboRollSlittingTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "InvoiceTransactionID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "CompanyID" | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | "yes" |
| "BranchID" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "UserID" | 104 | 104 | 104 | 104 | 104 | 104 | 104 | 104 | "yes" |
| "ExpectedDeliveryDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "HSNCode" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ProductHSNID" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "IsDeleted" | false | false | false | false | false | false | false | false | "" |
| "IsBlocked" | false | false | false | false | false | false | false | false | "" |
| "FYear" | "2026-2027" | "2026-2027" | "2026-2027" | "2026-2027" | "2026-2027" | "2026-2027" | "2026-2027" | "2026-2027" | "yes" |
| "IsLocked" | false | false | false | false | false | false | false | false | "" |
| "CreatedBy" | 104 | 104 | 104 | 104 | 104 | 104 | 104 | 104 | "yes" |
| "CreatedDate" | 2026-10-05T12:30:24.300Z | 2026-10-05T12:30:24.310Z | 2026-10-05T12:30:24.317Z | 2026-10-05T12:30:24.327Z | 2026-10-05T12:30:24.333Z | 2026-10-05T12:30:24.340Z | 2026-10-05T12:30:24.350Z | 2026-10-05T12:30:24.360Z | "yes" |
| "ModifiedBy" | 104 | 104 | 104 | 104 | 104 | 104 | 104 | 104 | "yes" |
| "ModifiedDate" | 2026-10-05T12:30:24.300Z | 2026-10-05T12:30:24.310Z | 2026-10-05T12:30:24.317Z | 2026-10-05T12:30:24.327Z | 2026-10-05T12:30:24.333Z | 2026-10-05T12:30:24.340Z | 2026-10-05T12:30:24.350Z | 2026-10-05T12:30:24.360Z | "yes" |
| "DeletedBy" | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | "" |
| "DeletedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsDeletedTransaction" | false | false | false | false | false | false | false | false | "yes" |
| "RefBatchNo" | "" | "" | "" | "" | "" | "" | "" | "" | "" |
| "ProductionUnitID" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "0" | "" |
| "IsRejected" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "RejectedBy" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "RejectedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ConversionRate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ProductionUpdateID" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "IsVoucherItemVerified" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "VoucherItemVerifiedBy" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "VoucherItemVerifiedDate" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "Remark" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "BasicAmountINR" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "HoldQuantity" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ItemDescription" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "RejectStock" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ClientID" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "DestinationProductionID" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "ClientTransactionID" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |
| "RefClientBatchNo" | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | "" |

**TEMPLATE gaps** — columns the procedure does not write where this ERP voucher holds something other than the column default. Each needs a decision before the first real post: add it to the INSERT in `002_usp_IssueTool_PostIssue.sql` with the ERP's value, or note why it differs.
_(no rows)_

**Blank strings** on this voucher (decides `@Blank` in the procedure):
| table | column | value |
| --- | --- | --- |
| "ITM" | "Particular" | " " |
| "ITM" | "Transporter" | " " |
| "ITM" | "GateEntryNo" | " " |
| "ITM" | "LRNoVehicleNo" | " " |
| "ITM" | "AmountInWords" | " " |
| "ITM" | "CurrencyCode" | " " |
| "ITM" | "PurchaseDivision" | " " |
| "ITM" | "ModeOfTransport" | " " |
| "ITM" | "PurchaseReferenceRemark" | " " |
| "ITM" | "DeliveryAddress" | " " |
| "ITM" | "TermsOfPayment" | " " |
| "ITM" | "TermsOfDelivery" | " " |
| "ITM" | "Narration" | "" |
| "ITM" | "WorkOrderNarration" | NULL |
| "ITM" | "JobReference" | NULL |
| "ITM" | "NatureOfwork" | NULL |
| "ITM" | "PlanContName" | NULL |
| "ITM" | "PlanContentType" | NULL |
| "ITM" | "EWayBillNumber" | NULL |
| "ITM" | "RefVoucherNo" | NULL |
| "ITM" | "VehicleNo" | NULL |
| "ITM" | "LoadingPort" | NULL |
| "ITM" | "DischargePort" | NULL |
| "ITM" | "ProformaNo" | NULL |
| "ITM" | "PONo" | NULL |

## 8. Acceptance-test source rows (brief section 8)

| TransactionDetailID | TransactionID | VoucherNo | ItemID | RequiredQuantity | JobBookingID | JobBookingJobCardContentsID | MachineID | DepartmentID | ProcessID | IsCompleted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "109873" | "64534" | "IPIC03454_26_27" | "9409" | 2958 | "16077" | "24188" | "14" | "100" | "10337" | false |

The captured ERP test vouchers (deleted afterwards):
| TransactionID | VoucherNo | MaxVoucherNo | FYear | CompanyID | IsDeletedTransaction | DeletedBy | DeletedDate | DepartmentID | JobBookingID | JobBookingJobCardContentsID | TotalQuantity | DeliveryNoteNo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "66810" | "IS17254_26_27" | "17254" | "2026-2027" | 2 | true | 24 | 2026-10-03T14:31:32.173Z | "100" | "0" | "23524" | 152 | "IS17253_26_27" |
| "66807" | "IS17252_26_27" | "17252" | "2026-2027" | 2 | true | 24 | 2026-10-03T14:31:52.203Z | "100" | "16077" | "24188" | 2958 | " " |

Batch total against ItemMaster.PhysicalStock for the two test items (should be equal):
| ItemID | ItemCode | StockUnit | PhysicalStock | FloorStock | BatchTotal |
| --- | --- | --- | --- | --- | --- |
| "9681" | "R01175" | "Kg" | 235 | 819 | 235 |
| "9409" | "P02621" | "Sheet" | 40756 | 187704 | 40756 |

## 9. Procedures

Parameters of `dbo.UPDATE_ITEM_STOCK_VALUES`:
| Parameter | DataType | IsOutput |
| --- | --- | --- |
| "@CompanyID" | "int" | false |
| "@TransactionID" | "bigint" | false |
| "@DeletedItemID" | "bigint" | false |

This module's objects (deployed yet?):
| ObjectName | ObjectId |
| --- | --- |
| "IssueTool_PostLog" | NULL |
| "usp_IssueTool_PostIssue" | NULL |
| "usp_IssueTool_DeleteIssue" | NULL |
