/**
 * Every table and column the Stock Issue Tool reads or writes, for
 * scripts/issue-tool-discover.js to check against a live database before the
 * procedures are deployed. Keep in sync with the SQL in queries/ and in
 * sql/issue-tool/. Columns marked ASSUMPTION in the code are listed here too,
 * so discovery confirms or refutes them.
 */

export const REFERENCED_COLUMNS = {
	ItemTransactionMain: [
		'TransactionID', 'VoucherID', 'VoucherPrefix', 'MaxVoucherNo', 'VoucherNo', 'VoucherDate',
		'DepartmentID', 'JobBookingID', 'JobBookingJobCardContentsID', 'TotalQuantity', 'DeliveryNoteNo',
		'Narration', 'CompanyID', 'FYear', 'UserID', 'CreatedBy', 'ModifiedBy', 'CreatedDate', 'ModifiedDate',
		'IsDeletedTransaction', 'DeletedBy', 'DeletedDate',
	],
	ItemTransactionDetail: [
		'TransactionDetailID', 'TransactionID', 'TransID', 'ItemGroupID', 'ItemID', 'StockUnit',
		'IssueQuantity', 'ReceiptQuantity', 'RejectedQuantity', 'RequiredQuantity',
		'ParentTransactionID', 'BatchID', 'BatchNo', 'WarehouseID', 'FloorWarehouseID',
		'JobBookingID', 'JobBookingJobCardContentsID', 'PicklistTransactionID', 'MachineID', 'DepartmentID',
		'ProcessID', 'PicklistReleaseTransactionID', 'IsCompleted', 'CompletedBy', 'CompletedDate', 'SupplierBatchNo', 'CompanyID', 'FYear', 'UserID',
		'CreatedBy', 'ModifiedBy', 'CreatedDate', 'ModifiedDate', 'IsDeletedTransaction', 'IsCancelled',
		'DeletedBy', 'DeletedDate',
	],
	ItemMaster: [
		'ItemID', 'CompanyID', 'ItemCode', 'ItemName', 'ItemGroupID', 'Quality', 'GSM', 'SizeW', 'SizeL',
		'Manufecturer', 'CertificationType', 'ItemSubGroupID', 'StockUnit', 'PhysicalStock', 'AllocatedStock', 'IsDeletedTransaction',
	],
	ItemGroupMaster: ['ItemGroupID', 'CompanyID', 'ItemGroupName'],
	ItemSubGroupMaster: ['ItemSubGroupID', 'CompanyID', 'ItemSubGroupName'],
	MachineMaster: ['MachineId', 'CompanyID', 'MachineName'],
	WarehouseMaster: ['WarehouseID', 'CompanyID', 'WarehouseName', 'BinName', 'IsFloorWarehouse', 'IsDeleted', 'IsDeletedTransaction'],
	DepartmentMaster: ['DepartmentID', 'DepartmentName', 'CompanyID'],
	ProcessMaster: ['ProcessID', 'CompanyID', 'DepartmentID'],
	JobBookingJobCard: [
		'JobBookingID', 'CompanyID', 'JobBookingNo', 'JobName', 'ClientName', 'OrderBookingID', 'CategoryID', 'LedgerID',
		'SalesEmployeeID', 'JobBookingDate', 'OrderQuantity', 'IsClose', 'IsCancel', 'IsDeletedTransaction',
	],
	FinishGoodsTransactionMain: ['FGTransactionID', 'VoucherID', 'VoucherPrefix', 'IsDeletedTransaction'],
	FinishGoodsTransactionDetail: ['FGTransactionID', 'JobBookingID', 'InnerCarton', 'QuantityPerPack', 'IsDeletedTransaction'],
	CategoryMaster: ['CategoryID', 'SegmentID'],
	SegmentMaster: ['SegmentID', 'SegmentName'],
	JobBookingJobCardContents: ['JobBookingJobCardContentsID', 'JobBookingID', 'CompanyID', 'JobCardContentNo', 'PlanContName', 'ReleasedDate', 'IsDeletedTransaction'],
	JobBookingJobCardProcessMaterialRequirement: [
		'JobBookingJobCardContentsID', 'ItemID', 'CompanyID', 'RequiredQuantityInStockUnit', 'ProcessID', 'SequenceNo', 'IsDeletedTransaction',
	],
	JobOrderBooking: ['OrderBookingID', 'LedgerID'],
	LedgerMaster: ['LedgerID', 'LedgerName', 'Designation'],
	UserMaster: ['UserID', 'UserName'],
	ItemConsumptionMain: [
		'ConsumptionTransactionID', 'VoucherPrefix', 'MaxVoucherNo', 'VoucherID', 'VoucherNo', 'VoucherDate',
		'DepartmentID', 'JobBookingID', 'OutsourceProductionID', 'ProductionID', 'JobBookingJobCardContentsID',
		'ReturnTransactionID', 'TotalQuantity', 'Particular', 'Narration', 'CompanyID', 'BranchID', 'UserID',
		'IsBlocked', 'FYear', 'IsLocked', 'CreatedBy', 'CreatedDate', 'ModifiedBy', 'ModifiedDate', 'DeletedBy',
		'DeletedDate', 'IsDeletedTransaction', 'ProductionUnitID', 'IsIntegrated', 'IsJobWiseConsumption',
		'ItemConversionTransactionID',
	],
	ItemConsumptionDetail: [
		'ConsumptionTransactionDetailID', 'ConsumptionTransactionID', 'TransID', 'ParentTransactionID',
		'IssueTransactionID', 'DepartmentID', 'ItemID', 'ItemGroupID', 'JobBookingID', 'JobBookingJobCardContentsID',
		'MachineID', 'ProcessID', 'ConsumeQuantity', 'ReturnQuantity', 'IssueQuantity', 'ReceivedQuantity',
		'WasteQuantity', 'StockUnit', 'BatchNo', 'BatchID', 'ItemRate', 'WarehouseID', 'FloorWarehouseID',
		'ReturnTransactionID', 'ReelToSheetCuttingTransactionID', 'Remark', 'ProcessingQty', 'WIPUnit', 'CompanyID',
		'BranchID', 'UserID', 'IsBlocked', 'FYear', 'IsLocked', 'CreatedBy', 'CreatedDate', 'ModifiedBy',
		'ModifiedDate', 'DeletedBy', 'DeletedDate', 'IsDeletedTransaction', 'ProductionUnitID', 'PlyNo', 'Joints',
		'ItemConversionTransactionID', 'JobCardFormNo', 'PackingWaste', 'TearOff', 'ReelEndWaste', 'Core',
		'PackingWasteRemark', 'TearOffRemark', 'ReelEndWasteRemark', 'CoreRemark',
	],
};

/** The columns usp_IssueTool_PostIssue writes. Everything else takes its default. */
export const POST_HEADER_COLUMNS = [
	'VoucherID', 'VoucherPrefix', 'MaxVoucherNo', 'VoucherNo', 'VoucherDate', 'DepartmentID', 'JobBookingID',
	'JobBookingJobCardContentsID', 'TotalQuantity', 'DeliveryNoteNo', 'Narration', 'CompanyID', 'FYear', 'UserID',
	'CreatedBy', 'ModifiedBy', 'CreatedDate', 'ModifiedDate', 'IsDeletedTransaction',
];

export const POST_LINE_COLUMNS = [
	'TransactionID', 'TransID', 'ItemGroupID', 'ItemID', 'StockUnit', 'IssueQuantity', 'ParentTransactionID',
	'BatchID', 'BatchNo', 'WarehouseID', 'FloorWarehouseID', 'JobBookingID', 'JobBookingJobCardContentsID',
	'PicklistTransactionID', 'MachineID', 'DepartmentID', 'ProcessID', 'PicklistReleaseTransactionID', 'CompanyID',
	'FYear', 'UserID', 'CreatedBy', 'ModifiedBy', 'CreatedDate', 'ModifiedDate', 'IsDeletedTransaction', 'IsCancelled',
];
