# Stock Issue Tool — schema notes

Discovery (`npm run issue-tool:discover`) was run against Kolkata (`IndusEnterprise`, CompanyID 2) on **5 Oct 2026**. It regenerates `docs/issue-tool-schema-discovery.md`; this file records what it showed and what the code does about it. Re-run it against Ahmedabad (`-- --site AHM`) before going live there, and after any ERP upgrade.

## Server

| Finding | Consequence |
|---|---|
| SQL Server 2022 (16.0), compatibility level 150 | OPENJSON, FOR JSON and `CREATE OR ALTER` are all available. |
| `READ_COMMITTED_SNAPSHOT` **on** | A plain read does not wait for another session's uncommitted insert. The procedure's MAX read and duplicate check use `WITH (READCOMMITTEDLOCK)`, so they wait for an in-flight ERP save and see its number. |
| Server clock is IST | `GETDATE()` timestamps are correct as written. |

## Columns and types

- **Every column the module references exists** (section 1 of the report).
- **All IDs in ITM / ITD are BIGINT** (TransactionID, ItemID, JobBookingID, BatchID, WarehouseID, …). The procedures use BIGINT throughout. The `mssql` driver returns BIGINT as a string (`"66933"`), so `src/issue-tool/db.js` converts BIGINT columns back to numbers before anything compares or returns them.
- `TotalQuantity` is `real`, `IssueQuantity` / `RequiredQuantity` are `float`.
- `FYear` is stored as **`2026-2027`** on -19 vouchers (17,416 vouchers this year), as the brief said. **Note:** `src/supplier-portal/services/erp-voucher.js` builds FYear as `26_27`. That is wrong for this database: its voucher-number MAX would find nothing and restart at 1. It is outside this module, but it should be fixed before Supplier Portal GRN posting is switched on.

## What an ERP-made issue looks like (template vouchers)

Compared against IS17300_26_27 (allocated, TransactionID 66933) and IS17302_26_27 (direct, 66936), every column the procedure does not write holds its table default. **No template gaps.**

Blank strings, exactly as the ERP writes them:

| Column | ERP value | Column default | Procedure writes |
|---|---|---|---|
| `ITM.DeliveryNoteNo` (allocated) | `' '` (one space) | `' '` | `' '` |
| `ITM.DeliveryNoteNo` (direct, no slip) | the voucher number | `' '` | the voucher number |
| `ITM.Narration` | `''` (empty) | `' '` | `''` when no remark |
| other ITM text columns (Particular, Transporter, …) | `' '` | `' '` | not written → default |

Differences that do not matter:
- The ERP stamps each line with its own `GETDATE()` a few milliseconds apart; the procedure uses one timestamp for the header and all lines. Timestamps are excluded from the compare.
- IS17302 is a direct issue **without a job card** (job and content 0 on header and lines). That case is out of scope. The captured IS17254 is the template for a direct issue with a job.

## Warehouses, departments, job tables

| Item | Finding |
|---|---|
| Floor warehouse | `WarehouseMaster.IsFloorWarehouse = 1`. Two exist: 16 Floor-Panchla / Paper, 14 Floor-Tangra / Floor. |
| Warehouse / bin names | `WarehouseName`, `BinName` (13 = Panchla / Paper warehouse, 17 = Panchla / Outside 1). |
| Department | `DepartmentMaster.DepartmentID` (100 = PRINTING) is what vouchers store; the table's own key is `ID`. It has `CompanyID`, `IsDeletedTransaction`, `IsBlocked`. |
| Suggested department | `ProcessMaster.DepartmentID` exists; process 10337 "Printing Front Side" → 100. That the ERP suggests this way is still an inference. |
| Job card / content | `JobBookingJobCard.JobBookingNo`, `JobName`, `ClientName`; `JobBookingJobCardContents.JobCardContentNo`, `PlanContName`. |
| Requirement | `RequiredQuantityInStockUnit` (`RequiredQty` reads 0). For J06482_26_27[1_1] the planned R01312 now reads **137.69 Kg** (the brief had 68.84), plus inks and varnish in other groups. Test B still over-issues (152 > 137.69). |

## Voucher numbering

| Check | Result | Decision |
|---|---|---|
| Companies with -19 vouchers | Only CompanyID 2 | `@NumberPerCompany = 1`. Same number as global today, uses the (VoucherID, CompanyID, FYear) index. |
| Same number in two companies | None | — |
| Same number on a live and a deleted voucher | 20+ cases | Most likely duplicates the ERP made and someone later deleted one of. The procedure counts deleted vouchers in the MAX, so it can never reuse a number. If the ERP skips deleted ones, the worst case is a gap. |
| Duplicate numbers within the company | Yes, e.g. 16888 three times | **The ERP's own numbering already races.** The applock, the locking reads and the post-insert check keep this tool from adding duplicates of its own. They cannot stop an ERP save that read MAX before ours committed, because the ERP takes no lock. |

## Stock

- For items 9409 and 9681, the batch total from the module's grouping equals `ItemMaster.PhysicalStock` (40,756 Sheet and 235 Kg). The batch query (including the `IsCancelled` filter) matches `UPDATE_ITEM_STOCK_VALUES`.
- `UPDATE_ITEM_STOCK_VALUES(@CompanyID int, @TransactionID bigint, @DeletedItemID bigint)`.

## The floor receipt (RFS) written with every issue

Found 6 Oct 2026, after History showed every issue as "consumed". No trigger is involved (the only triggers on ITM / ITD are audit and history triggers, plus a disabled stock trigger). The ERP's issue screen writes, in the same save as each issue:

| | Header — `ItemConsumptionMain` | Lines — `ItemConsumptionDetail`, one per issue line |
|---|---|---|
| Voucher | VoucherID **-53**, prefix **RFS**, own MaxVoucherNo sequence per CompanyID + FYear (e.g. `RFS17362_26_27`) | `TransID` = the issue line's TransID |
| Link to the issue | `ReturnTransactionID` = issue TransactionID | `IssueTransactionID` = issue TransactionID |
| Job | `JobBookingID` **0**; `JobBookingJobCardContentsID` = issue's | `JobBookingID` and content = the issue line's |
| Department | issue header's | issue **header's** (100 also on a direct issue, whose ITD line has 0) |
| Machine / process | — | the issue line's (picklist values, or 0 on a direct issue) |
| Quantities | `TotalQuantity` = issue total | `ReceivedQuantity` = issued; Consume / Return / Issue / Waste = 0 |
| Batch | — | `ParentTransactionID`, `BatchNo`, `BatchID`, `WarehouseID`, `FloorWarehouseID`, `StockUnit` = the issue line's |
| Text | `Particular` NULL, `Narration` `''` | `Remark` NULL |
| Other | Outsource/Production IDs 0, BranchID 0, ProductionUnitID 0, IsIntegrated 0, IsJobWiseConsumption 0, ItemConversionTransactionID NULL | ItemRate 0, ProcessingQty 0, ReturnTransactionID 0, ReelToSheetCuttingTransactionID 0, waste fields 0, remarks / PlyNo / Joints / JobCardFormNo NULL |

On delete the ERP soft-deletes both: header and lines get `IsDeletedTransaction = 1`, `DeletedBy`, `DeletedDate`; the lines also get `ModifiedBy` / `ModifiedDate` set to the delete, the header keeps its `ModifiedDate`.

Every live -19 voucher this year (17,002) has one, and no consumption row this year has `ConsumeQuantity > 0`. The ERP's floor-stock formula subtracts `ConsumeQuantity + ReturnQuantity` per issue. So "consumed" for the delete check means a live consumption row for the issue with consumed / returned / wasted quantity, or one belonging to any voucher other than the issue's own RFS.

The procedures write and delete the RFS exactly as above, and the acceptance and compare scripts check it against the ERP's RFS17275 / RFS17277.

## Still assumptions

| Assumption | Why it is still open |
|---|---|
| The remark goes in `ITM.Narration` | The column exists and the ERP writes `''` there, but no capture had a remark typed in. |
| Allocated header `DepartmentID` comes from the picklist line | Consistent with every capture (100); not proven. |
| Delete recalculates stock with `@TransactionID = 0, @DeletedItemID = item` | Not captured. |
| RFS numbering is MAX + 1 per CompanyID + FYear, deleted included | Same pattern as every other ERP sequence; three RFS numbers seen, not proven. |
| RFS line MachineID / ProcessID copy the issue line's | True for both captured issues; IS17339 (direct) has machine 15 on its RFS line, so the ERP's direct screen may pass a chosen machine there. This tool has no machine choice (out of scope), so it writes 0 like the ITD line. |
| A substitute counts against the requirement of its item group + stock unit | A business rule, not a schema fact. Confirm it is what you want. |

## Decisions taken without discovery (review these)

- **BatchID** of a batch is taken from the receipt row that created it (`TransactionID = ParentTransactionID`, same item, warehouse and batch no.), falling back to the highest BatchID in the group.
- **Allocated issues** can only issue the picklist line's item (`ITEM_NOT_ON_PICKLIST`). A closed picklist line (`IsCompleted = 1`) is refused (`PICKLIST_LINE_CLOSED`). Future voucher dates are refused (`VOUCHER_DATE_IN_FUTURE`).
