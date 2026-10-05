# Stock Issue Tool — schema notes

Brief section 4 asks for read-only discovery before any code that writes. **This environment had no access to the database**, so discovery has not been run yet. This file records:

1. what is already known, and where it comes from;
2. what the code currently assumes for each open item, and where in the code that assumption lives;
3. how to run discovery and what each finding decides.

Run `npm run issue-tool:discover` against Kolkata (and later Ahmedabad with `--site AHM`). It writes `docs/issue-tool-schema-discovery.md`. Then update the "Status" column below and adjust the code where a finding contradicts an assumption.

## Known

| Fact | Source |
|---|---|
| ITM / ITD column names for vouchers, items, batches, picklist links, job links, audit (section 5 of the brief) | Before/after snapshots of 3 Oct 2026 |
| `FYear` is stored as `2026-2027`; the voucher suffix is `_26_27` | Brief 5.1. Also `routes-concern-person.js` writes `2026-2027` into an ERP table. **Note:** `src/supplier-portal/services/erp-voucher.js` uses `26_27` for FYear; one of the two is wrong for ITM, and discovery section 6 shows which. |
| Voucher prefix `IS`, number padded to 5 digits (`IS17252_26_27`, `IPIC03454_26_27`) | Brief section 8 |
| `WarehouseMaster` has `WarehouseName`, `BinName`, `IsFloorWarehouse`, `IsDeleted`, `IsDeletedTransaction` | `src/supplier-portal/services/erp-ledgers.js` already queries them |
| `JobBookingJobCard`: `JobBookingNo`, `JobName`, `ClientName`, `OrderBookingID`; client fallback via `JobOrderBooking.LedgerID` → `LedgerMaster.LedgerName` | `src/job-card-queries.js`, `src/routes-fg-qc.js` |
| `JobBookingJobCardContents`: `JobCardContentNo`, `PlanContName` | `src/job-card-queries.js` |
| `JobBookingJobCardProcessMaterialRequirement.RequiredQuantityInStockUnit` (`RequiredQty` reads 0); key JobBookingID + JobBookingJobCardContentsID + ProcessID + MachineID + CompanyID | Brief 4.5; `src/job-card-queries.js` |
| `ItemMaster`: `ItemCode`, `ItemName`, `ItemGroupID`, `Quality`, `GSM`, `SizeW`, `SizeL`, `Manufecturer` (sic), `StockUnit`, `PhysicalStock` | Existing queries in this repo; brief 3 |
| `ItemGroupMaster.ItemGroupName` | `src/routes*.js` |
| `UPDATE_ITEM_STOCK_VALUES @CompanyID, @TransactionID, @DeletedItemID` | Brief 5.3; `src/supplier-portal/services/erp-receiving.js` |
| `UserMaster(UserID, UserName)` | `src/supplier-portal/services/erp-ledgers.js` |

## Open items and current assumptions

| # | Item (brief §4) | Current assumption | Where in code | Status |
|---|---|---|---|---|
| 1 | Full ITM / ITD columns, defaults, ITM indexes | Only the columns in brief §5 are written; all others take their default | `TEMPLATE` markers in `sql/issue-tool/002_usp_IssueTool_PostIssue.sql`; lists in `src/issue-tool/schema-manifest.js` | Discovery §2 |
| 2 | How a floor warehouse is distinguished | `WarehouseMaster.IsFloorWarehouse = 1` | `002_…PostIssue.sql` (floor check), `queries/lookups.js` | Discovery §3 |
| 3 | Department / process / machine / ledger name columns | `DepartmentMaster(DepartmentID, DepartmentName, CompanyID)`; `ProcessMaster.DepartmentID` for the suggested department | `002_…PostIssue.sql`, `queries/lookups.js`, `queries/job-contents.js`, `queries/issues.js` | Discovery §1, §4 |
| 4 | Job card / content number, names, client, release date | As in "Known". Release date is not used | `queries/job-contents.js`, `queries/picklists.js` | Discovery §5 |
| 5 | Requirement column | `RequiredQuantityInStockUnit` | `queries/job-contents.js`, `002_…PostIssue.sql` | Known |
| 6 | Numbering scope | One sequence per VoucherID + FYear **across companies** (`@NumberPerCompany = 0`), deleted vouchers included. If numbering is really per company, this can only leave a gap, never reuse a number | `002_…PostIssue.sql`, top of procedure | Discovery §6 |
| 7 | Template vouchers; blank as `''`, `' '` or `NULL` | Blank string columns written as `''` (`@Blank`) | `002_…PostIssue.sql` | Discovery §7 |
| — | Remark column | `ItemTransactionMain.Narration` (brief §7) | `002_…PostIssue.sql`, `queries/issues.js` | Discovery §1 |
| — | Picklist line required quantity | `ItemTransactionDetail.RequiredQuantity` on the -17 line (brief 6.4) | `queries/picklists.js`, `002_…PostIssue.sql` | Discovery §1 |
| — | Consumption link for the delete guard | `ItemConsumptionDetail.IssueTransactionID` (brief 6.2) | `003_…DeleteIssue.sql`, `queries/issues.js` | Discovery §1 |
| — | Server compatibility | SQL Server 2016 SP1+, compatibility level ≥ 130 (OPENJSON, FOR JSON, CREATE OR ALTER) | all three SQL scripts | Discovery §0 |

A missing column breaks deployment loudly rather than silently: `CREATE OR ALTER PROCEDURE` fails on a column that does not exist in an existing table, and the read endpoints return a 500 naming the column. Discovery §1 lists every referenced column so this is found before deploying.

## Decisions taken without discovery (review these)

- **Batch stock** is `ReceiptQuantity − IssueQuantity − RejectedQuantity` over live, not-cancelled ITD rows (vouchers not in -8, -9, -11), grouped by `ISNULL(ParentTransactionID,0)`, `ISNULL(WarehouseID,0)`, `NULLIF(BatchNo,'')`. The brief says this is the exact grouping `UPDATE_ITEM_STOCK_VALUES` uses. The `IsCancelled` filter follows the brief's general convention. Discovery §8 compares the batch total with `PhysicalStock` for the two test items; if they differ, look at this first.
- **BatchID** of a batch is taken from the receipt row that created it (`TransactionID = ParentTransactionID`, same item, warehouse and batch no.), falling back to the highest BatchID in the group.
- **Substitutes in a direct issue** count against the content's requirement for the same item group and stock unit. That is how test B (planned R01312, issued R01175, both group 2, Kg) gets its over-issue warning.
- **Allocated issues** can only issue the picklist line's item (`ITEM_NOT_ON_PICKLIST`). A closed picklist line (`IsCompleted = 1`) is refused (`PICKLIST_LINE_CLOSED`). Future voucher dates are refused (`VOUCHER_DATE_IN_FUTURE`). These three are hard errors the brief did not list; they are in the frontend flow anyway.
