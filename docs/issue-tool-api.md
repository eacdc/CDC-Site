# CDC Stock Issue Tool — API contract

This file is the single source of truth for the frontend. It is kept in sync with `src/issue-tool/routes.js`. If something you need is not here, ask; do not invent endpoints or fields.

- **Base path:** `{API}/api/issue-tool` — every path below is relative to it.
- **Format:** JSON in and out. Dates are `YYYY-MM-DD` strings. Timestamps are IST wall-clock strings without a zone, e.g. `2026-10-03T11:42:10`.
- **Quantities** are numbers in the item's **stock unit**, which is always returned next to them (`stockUnit`: `Kg`, `KG`, `Sheet`, … casing varies, show it as given). Values are rounded to 3 decimals.

---

## 1. Authentication

The tool reuses the backend's existing internal login (the Supplier Portal's). There is no separate issue-tool login.

### `POST /api/supplier-portal/auth/login` (note: not under `/api/issue-tool`)

```json
{ "email": "store1@cdcprinters.com", "password": "••••••••", "site": "KOL" }
```

`site` is `KOL` (Kolkata) or `AHM` (Ahmedabad) and picks the database. Response `200`:

```json
{
  "token": "4f0c9e…64 hex chars…",
  "expiresAt": "2026-10-12T05:30:00.000Z",
  "user": { "id": "66f…", "email": "store1@cdcprinters.com", "displayName": "Store 1", "roles": ["STORE"], "allowedSites": ["KOL"] },
  "context": { "site": "KOL", "erpUserId": 24, "employeeLedgerId": null, "warehouseId": null }
}
```

`401 { "error": "Email or password is incorrect." }` on bad credentials; `403` if the site is not allowed for the user.

### Every `/api/issue-tool` request

```
Authorization: Bearer <token>
```

| Status | Body | Meaning / what to do |
|---|---|---|
| `401` | `{ "error": "Not signed in." }` or `{ "error": "Session has expired. Sign in again." }` | Show the login, keep the form, retry after sign-in. |
| `403` | `{ "error": "This action needs one of: STORE." }` | The account lacks the `STORE` role (`ADMIN` also passes). |
| `403` | `{ "error": "…", "code": "ERP_USER_NOT_MAPPED" }` | Only on posting and deleting: the login has no ERP UserID. Reads still work. `GET /session` tells you in advance (`canPost`). |

### `POST /api/supplier-portal/auth/logout`

Header `Authorization: Bearer <token>`. Response `{ "ok": true }`.

---

## 2. Errors

Every error from `/api/issue-tool` has this shape:

```json
{ "error": "Human-readable message, safe to show", "code": "MACHINE_CODE" }
```

Some codes add fields (`details`, `warnings`). The `401`/`403` responses from the login layer carry only `error`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body or query failed validation. `details: [{ "path": "lines.0.quantity", "message": "Quantity must be greater than zero." }]` |
| 400 | `SITE_REQUIRED` | The session has no site. Sign in again. |
| 400 | `VOUCHER_DATE_IN_FUTURE` | Voucher date is after today (IST). |
| 400 | `NO_LINES` | No batch lines. |
| 400 | `INVALID_QUANTITY` | A quantity is zero or negative. |
| 400 | `FLOOR_WAREHOUSE_REQUIRED` / `UNKNOWN_FLOOR_WAREHOUSE` | Floor warehouse missing, unknown, or not a floor warehouse. |
| 400 | `UNKNOWN_ITEM` | An item does not exist. |
| 400 | `BATCH_NOT_OF_ITEM` | A line's batch does not belong to its item. |
| 400 | `UNKNOWN_PICKLIST_LINE` | Picklist line missing or deleted. |
| 400 | `PICKLIST_LINE_CLOSED` | Picklist line is closed (`IsCompleted`). |
| 400 | `ITEM_NOT_ON_PICKLIST` | An allocated issue tried to issue an item other than the picklist line's. Use a direct issue for a substitute. |
| 400 | `UNKNOWN_JOB_CONTENT` | Job content missing or deleted. |
| 400 | `UNKNOWN_DEPARTMENT` | Department does not exist. |
| 400 | `NOT_AN_ISSUE` | Delete: the voucher is not an issue (`-19`). |
| 400 | `MISSING_FIELD` / `INVALID_MODE` | Defensive checks inside the procedure; the validator normally catches these first. |
| 403 | `ERP_USER_NOT_MAPPED` | See section 1. |
| 404 | `UNKNOWN_ITEM` / `UNKNOWN_ISSUE` | Item or issue voucher not found. |
| 409 | `WARNINGS_NOT_ACKNOWLEDGED` | The issue has warnings; see section 5.8. Body has `warnings`. |
| 409 | `VOUCHER_NUMBER_CONFLICT` | The ERP took the same voucher number three times running. Nothing was saved. Save again with the same `requestId`. |
| 409 | `ALREADY_DELETED` / `ISSUE_CONSUMED` | Delete refused. |
| 502 | `STOCK_REFRESH_FAILED` | Only from `refresh-stock`: the retry failed again. The issue itself is saved. |
| 503 | `LOCK_TIMEOUT` | Another save held the numbering lock for 15 s. Nothing was saved. Save again with the same `requestId`. |
| 500 | `INTERNAL_ERROR` | Unexpected. If it happened on a save, saving again with the same `requestId` is always safe. |

---

## 3. Warning codes

Over-issue is allowed (as in the ERP) but must be acknowledged. Warnings are computed by the server **at save time**, from current stock.

| `code` | Meaning |
|---|---|
| `OVER_PICKLIST_PENDING` | Allocated issue: the total is more than the picklist line's pending quantity. |
| `OVER_JOB_PENDING` | Direct issue: the total for an item group + stock unit is more than the job content's pending requirement for that group and unit. A substitute counts against the planned item of the same group and unit. If nothing is planned in that group, the whole quantity is over-issue. |
| `OVER_BATCH_STOCK` | A batch would go negative (several lines on one batch are summed). The message is deliberately strong: a negative batch silently drops out of physical stock. |

Warning object:

```json
{
  "code": "OVER_BATCH_STOCK",
  "lineNo": 1,
  "itemId": 9681,
  "quantity": 152,
  "limit": 140.5,
  "stockUnit": "Kg",
  "message": "Line 1 takes 152 Kg from batch 52873_PO01565_26_27_9681_1.00, which holds only 140.5 Kg. This drives the batch negative, and a negative batch silently drops out of physical stock. Check the batch and the quantity before you continue."
}
```

`lineNo` is 1-based in the order the lines were sent; it is `null` for whole-issue warnings. `limit` is the pending quantity or batch stock it was compared with (can be negative or zero).

---

## 4. Read endpoints

All need the bearer token. All are read-only.

### 4.1 `GET /session`

Who is signed in, and whether saves really write. Call it on load and show the **dry-run banner** whenever `writesEnabled` is `false`.

```json
{
  "user": { "email": "store1@cdcprinters.com", "displayName": "Store 1", "roles": ["STORE"] },
  "site": "KOL",
  "companyId": 2,
  "erpUserId": 24,
  "canPost": true,
  "writesEnabled": false,
  "today": "2026-10-05"
}
```

`today` is today's date in India; use it as the default voucher date. `canPost` is `false` when the login has no ERP UserID.

### 4.2 `GET /picklists?search=&page=&pageSize=&showFullyIssued=`

Open picklist lines (against-picklist tab). Server-side search and paging.

| Param | Default | Notes |
|---|---|---|
| `search` | `""` | Matches picklist no., job card no., content no., job name, content name, client, item code, item name. |
| `page` | `1` | 1-based. |
| `pageSize` | `50` | 1–200. |
| `showFullyIssued` | `false` | `true` / `false`. When false only lines with `pending > 0`. Closed lines (`IsCompleted`) never appear. |

Response:

```json
{
  "rows": [
    {
      "picklistDetailId": 109873,
      "picklistTransactionId": 64534,
      "picklistNo": "IPIC03454_26_27",
      "picklistDate": "2026-10-01",
      "clientName": "ACME FOODS PVT LTD",
      "jobBookingId": 16077,
      "jobContentId": 24188,
      "jobCardNo": "J06601_26_27",
      "jobContentNo": "J06601_26_27[1_1]",
      "jobName": "ACME BISCUIT CARTON 200G",
      "contentName": "Carton",
      "item": {
        "itemId": 9409,
        "itemCode": "P02621",
        "itemName": "SBS BOARD 300GSM",
        "itemGroupId": 14,
        "itemGroupName": "PAPER",
        "quality": "SBS",
        "gsm": 300,
        "size": "1020 x 720",
        "manufacturer": "ITC",
        "stockUnit": "Sheet",
        "physicalStock": 40756
      },
      "required": 2958,
      "issued": 0,
      "pending": 2958
    }
  ],
  "page": 1,
  "pageSize": 50,
  "total": 412
}
```

`picklistDetailId` is the line's identity: it is what you send to post, and what a future "close line" action will take. `total` is the number of matching lines across all pages (`0` when none; `null` only when a page past the end is requested).

### 4.3 `GET /job-contents?search=`

Job contents for a direct issue, by job card number or content number. `search` needs at least 3 characters. Up to 25 contents, newest job first.

```json
{
  "rows": [
    {
      "jobContentId": 23524,
      "jobBookingId": 15607,
      "jobCardNo": "J06482_26_27",
      "jobContentNo": "J06482_26_27[1_1]",
      "jobName": "BETA TEA 100G CARTON",
      "contentName": "Outer",
      "clientName": "BETA TEA CO",
      "suggestedDepartmentId": 100,
      "suggestedDepartmentName": "PRINTING",
      "plannedItems": [
        {
          "itemId": 9101,
          "itemCode": "R01312",
          "itemName": "KRAFT REEL 120GSM",
          "itemGroupId": 2,
          "itemGroupName": "REEL",
          "quality": "Kraft",
          "gsm": 120,
          "size": "1000",
          "manufacturer": "Mill A",
          "stockUnit": "Kg",
          "physicalStock": 5120,
          "required": 68.84,
          "issued": 0,
          "pending": 68.84
        }
      ],
      "requirementGroups": [
        { "itemGroupId": 2, "stockUnit": "Kg", "required": 68.84, "issued": 0, "pending": 68.84 }
      ]
    }
  ]
}
```

- `plannedItems[].issued` counts only that exact item; `requirementGroups[].issued` also counts substitutes of the same group and unit. Over-issue warnings use the group figure.
- `suggestedDepartmentId` may be `null`; the user can always choose another department.

### 4.4 `GET /items?search=&jobContentId=`

Item search. Needs `search` of at least 2 characters, or `jobContentId`, or both. Every word in `search` must match one of: code, name, group, quality, manufacturer, GSM, width, length. Up to 50 hits.

With `jobContentId`, that content's planned items come first (`planned: true`, with `required`/`issued`/`pending`), followed by search hits. Every row then carries `pendingForJob`: the pending requirement of its group + unit on that content — prefill the quantity with it.

```json
{
  "rows": [
    {
      "itemId": 9101, "itemCode": "R01312", "itemName": "KRAFT REEL 120GSM", "itemGroupId": 2, "itemGroupName": "REEL",
      "quality": "Kraft", "gsm": 120, "size": "1000", "manufacturer": "Mill A", "stockUnit": "Kg", "physicalStock": 5120,
      "required": 68.84, "issued": 0, "pending": 68.84, "planned": true, "pendingForJob": 68.84
    },
    {
      "itemId": 9681, "itemCode": "R01175", "itemName": "KRAFT REEL 120GSM", "itemGroupId": 2, "itemGroupName": "REEL",
      "quality": "Kraft", "gsm": 120, "size": "1000", "manufacturer": "Mill B", "stockUnit": "Kg", "physicalStock": 3310,
      "planned": false, "pendingForJob": 68.84
    }
  ]
}
```

Without `jobContentId`, rows have `planned: false` and no `pendingForJob`.

### 4.5 `GET /items/:itemId/batches`

Batches with stock above zero, oldest GRN first. The batch total equals `ItemMaster.PhysicalStock` when stock is consistent; both are returned.

```json
{
  "item": {
    "itemId": 9409, "itemCode": "P02621", "itemName": "SBS BOARD 300GSM", "itemGroupId": 14, "itemGroupName": "PAPER",
    "quality": "SBS", "gsm": 300, "size": "1020 x 720", "manufacturer": "ITC", "stockUnit": "Sheet", "physicalStock": 40756
  },
  "batches": [
    {
      "batchKey": { "parentTransactionId": 60325, "warehouseId": 17, "batchNo": "60325_PO02095_26_27_9409_1.00" },
      "batchId": 101864,
      "batchStock": 20000,
      "grnNo": "REC03101_26_27",
      "grnDate": "2026-08-14",
      "grnVoucherId": -14,
      "warehouseName": "Panchla",
      "binName": "Paper Rack 2"
    }
  ],
  "batchTotal": 40756,
  "physicalStock": 40756
}
```

`batchKey` identifies the batch. Send its three fields back unchanged on each issue line. `batchNo` may be `null`. `grnNo`/`grnDate` may be `null` for opening stock.

### 4.6 `GET /lookups/floor-warehouses`

Each warehouse + bin pair is one `warehouseId`; choose a warehouse, then a bin.

```json
{
  "warehouses": [
    { "warehouseName": "Floor-Panchla", "bins": [ { "warehouseId": 16, "binName": "Paper" }, { "warehouseId": 18, "binName": "Board" } ] }
  ]
}
```

### 4.7 `GET /lookups/departments`

```json
{ "departments": [ { "departmentId": 100, "departmentName": "PRINTING" } ] }
```

### 4.8 `GET /issues?from=&to=`

Recent live issue vouchers (`-19`) with lines, whether created by this tool or by the ERP. Defaults: `to` = today (IST), `from` = `to` − 3 days. At most 62 days; at most 500 vouchers, newest first.

```json
{
  "from": "2026-10-02",
  "to": "2026-10-05",
  "rows": [
    {
      "transactionId": 70011,
      "voucherNo": "IS17260_26_27",
      "voucherDate": "2026-10-05",
      "mode": "ALLOCATED",
      "jobCardNo": "J06601_26_27",
      "jobContentNo": "J06601_26_27[1_1]",
      "jobName": "ACME BISCUIT CARTON 200G",
      "contentName": "Carton",
      "departmentId": 100,
      "departmentName": "PRINTING",
      "slipNo": null,
      "remark": null,
      "totalQuantity": 2958,
      "createdBy": { "userId": 24, "userName": "STORE1" },
      "createdDate": "2026-10-05T11:42:10",
      "createdByIssueTool": true,
      "canDelete": true,
      "deleteBlockedReason": null,
      "lines": [
        {
          "transactionDetailId": 120501,
          "transId": 1,
          "item": { "itemId": 9409, "itemCode": "P02621", "itemName": "SBS BOARD 300GSM", "itemGroupId": 14, "itemGroupName": "PAPER", "quality": "SBS", "gsm": 300, "size": "1020 x 720", "manufacturer": "ITC", "stockUnit": "Sheet", "physicalStock": 37798 },
          "stockUnit": "Sheet",
          "issueQuantity": 1500,
          "batchNo": "60325_PO02095_26_27_9409_1.00",
          "warehouseName": "Panchla",
          "binName": "Paper Rack 2",
          "floorWarehouseId": 16,
          "floorWarehouseName": "Floor-Panchla",
          "floorBinName": "Paper",
          "picklistTransactionId": 64534,
          "picklistNo": "IPIC03454_26_27"
        }
      ]
    }
  ]
}
```

`mode` is `ALLOCATED` when any line carries a picklist. `canDelete` is `false` once material from the issue has been consumed (`deleteBlockedReason` says why).

---

## 5. Write endpoints

### 5.1 Dry run

Until the backend sets `ISSUE_TOOL_ALLOW_WRITES=true`, **every** post and delete is a dry run: the server writes everything inside a transaction, reads the rows back, and rolls back. Nothing is saved and no voucher number is used. The response says so with `"dryRun": true` and `"dryRunReason": "WRITES_DISABLED"`. The client may also ask for a dry run with `"dryRun": true` (`"dryRunReason": "REQUESTED"`).

**Never present a dry run as a saved issue.** Do not show a voucher number for it.

### 5.2 `POST /issues`

Needs `canPost` (an ERP UserID).

Request:

| Field | Type | Required | Notes |
|---|---|---|---|
| `mode` | `"ALLOCATED"` \| `"DIRECT"` | yes | |
| `requestId` | UUID string | yes | Generated when the form opens. **Reuse it for every retry of the same form**, including the resend after acknowledging warnings. The server makes one voucher per `requestId`. |
| `voucherDate` | `YYYY-MM-DD` | yes | Not later than today (IST). |
| `picklistDetailId` | integer | ALLOCATED | From `GET /picklists`. |
| `jobContentId` | integer | DIRECT | From `GET /job-contents`. |
| `departmentId` | integer | DIRECT | |
| `slipNo` | string ≤ 100 | no | DIRECT only. Left empty, the server stores the voucher number in it. Ignored for ALLOCATED. |
| `floorWarehouseId` | integer | yes | The floor warehouse + bin, from `GET /lookups/floor-warehouses`. Same on every line. |
| `remark` | string ≤ 500 | no | |
| `lines` | array, 1–50 | yes | In the order the user added them; that order becomes `TransID` 1, 2, 3… |
| `lines[].itemId` | integer | yes | ALLOCATED: must be the picklist line's item. |
| `lines[].parentTransactionId` | integer ≥ 0 | yes | From `batchKey`. |
| `lines[].warehouseId` | integer ≥ 0 | yes | From `batchKey`. |
| `lines[].batchNo` | string \| null | yes | From `batchKey`. |
| `lines[].quantity` | number > 0 | yes | In the item's stock unit. A JSON number, not a string. |
| `dryRun` | boolean | no | Default `false`. |
| `acknowledgeWarnings` | boolean | no | Default `false`. Send `true` only after the user ticked the acknowledgement. |

The server re-reads every ID from the database; it never trusts the client for job, machine, department, process, batch ID or stock unit.

Example — allocated issue split across two batches:

```json
{
  "mode": "ALLOCATED",
  "requestId": "3f2b8a52-6c1d-4a8e-9f0b-1d2c3e4f5a6b",
  "voucherDate": "2026-10-05",
  "picklistDetailId": 109873,
  "floorWarehouseId": 16,
  "remark": null,
  "lines": [
    { "itemId": 9409, "parentTransactionId": 60325, "warehouseId": 17, "batchNo": "60325_PO02095_26_27_9409_1.00", "quantity": 1500 },
    { "itemId": 9409, "parentTransactionId": 61902, "warehouseId": 17, "batchNo": "61902_PO02095_26_27_9409_2.00", "quantity": 1458 }
  ],
  "acknowledgeWarnings": false
}
```

Example — direct issue of a substitute:

```json
{
  "mode": "DIRECT",
  "requestId": "9b1f6c0e-2d7a-4c5b-8e3f-0a1b2c3d4e5f",
  "voucherDate": "2026-10-05",
  "jobContentId": 23524,
  "departmentId": 100,
  "slipNo": "",
  "floorWarehouseId": 16,
  "lines": [
    { "itemId": 9681, "parentTransactionId": 52873, "warehouseId": 13, "batchNo": "52873_PO01565_26_27_9681_1.00", "quantity": 152 }
  ],
  "acknowledgeWarnings": false
}
```

### 5.3 Response: saved — `200`

```json
{
  "status": "POSTED",
  "dryRun": false,
  "replayed": false,
  "transactionId": 70011,
  "voucherNo": "IS17260_26_27",
  "voucherDate": "2026-10-05",
  "fYear": "2026-2027",
  "lines": [ { "transId": 1, "transactionDetailId": 120501 }, { "transId": 2, "transactionDetailId": 120502 } ],
  "warnings": [],
  "stockRefreshFailed": false
}
```

- Show `voucherNo` prominently with a "New issue" button. This is the first moment a number may be shown.
- `replayed: true` means this `requestId` had already been saved (double click, network retry). Same voucher, nothing new written. Treat as success.
- `warnings` lists the warnings that were acknowledged, if any.

### 5.4 Response: saved, but stock refresh failed — `200`

```json
{
  "status": "POSTED",
  "dryRun": false,
  "replayed": false,
  "transactionId": 70011,
  "voucherNo": "IS17260_26_27",
  "voucherDate": "2026-10-05",
  "fYear": "2026-2027",
  "lines": [ { "transId": 1, "transactionDetailId": 120501 } ],
  "warnings": [],
  "stockRefreshFailed": true,
  "stockRefreshError": "Execution Timeout Expired."
}
```

The issue **is saved**. Say so plainly, and offer `POST /issues/{transactionId}/refresh-stock` (5.7). Until it succeeds, the summary stock on the item master (physical / floor stock) is stale; batch stock in this tool is unaffected.

### 5.5 Response: dry run — `200`

```json
{
  "status": "DRY_RUN",
  "dryRun": true,
  "dryRunReason": "WRITES_DISABLED",
  "voucherDate": "2026-10-05",
  "fYear": "2026-2027",
  "warnings": [],
  "wouldWrite": {
    "header": { "TransactionID": 70011, "VoucherID": -19, "VoucherPrefix": "IS", "MaxVoucherNo": 17260, "VoucherNo": "IS17260_26_27", "VoucherDate": "2026-10-05T00:00:00", "DepartmentID": 100, "JobBookingID": 16077, "JobBookingJobCardContentsID": 24188, "TotalQuantity": 2958, "DeliveryNoteNo": "", "CompanyID": 2, "FYear": "2026-2027", "UserID": 24, "…": "every column of ItemTransactionMain" },
    "lines": [
      { "TransactionDetailID": 120501, "TransID": 1, "ItemID": 9409, "IssueQuantity": 1500, "BatchNo": "60325_PO02095_26_27_9409_1.00", "…": "every column of ItemTransactionDetail" }
    ]
  }
}
```

No `transactionId` and no `voucherNo` at the top level: nothing was saved. `wouldWrite` holds the raw rows, with ERP column names, for inspection. Its IDs and number were rolled back, so don't display them as if they were real.

### 5.6 `POST /issues/:id/delete`

Needs `canPost`. No body. `:id` is `transactionId`. Soft-deletes the voucher (ERP behaviour), then recalculates stock for each item on it.

`200` deleted:

```json
{ "status": "DELETED", "dryRun": false, "transactionId": 70011, "voucherNo": "IS17260_26_27", "itemIds": [9409], "stockRefreshFailed": false }
```

`200` dry run (writes disabled):

```json
{ "status": "DRY_RUN", "dryRun": true, "dryRunReason": "WRITES_DISABLED", "transactionId": 70011, "voucherNo": "IS17260_26_27", "itemIds": [9409], "wouldWrite": { "header": { "…": "…" }, "lines": [] } }
```

Errors: `404 UNKNOWN_ISSUE`, `400 NOT_AN_ISSUE`, `409 ALREADY_DELETED`, `409 ISSUE_CONSUMED`. `stockRefreshFailed: true` (with `stockRefreshError`) means deleted but not recalculated; offer 5.7.

### 5.7 `POST /issues/:id/refresh-stock`

Retries the stock recalculation for an issue (live: by voucher; deleted: per item). No body. Safe to repeat.

`200`:

```json
{ "ok": true, "transactionId": 70011, "mode": "TRANSACTION", "itemIds": [9409] }
```

`502 { "error": "The stock refresh failed again: … The issue itself is saved.", "code": "STOCK_REFRESH_FAILED" }`

### 5.8 Warnings flow

1. Save with `acknowledgeWarnings: false`.
2. If the response is `409` with `code: "WARNINGS_NOT_ACKNOWLEDGED"`, nothing was written and no number was taken:

   ```json
   {
     "error": "This issue has warnings. Read them, tick to acknowledge, and save again with the same request ID.",
     "code": "WARNINGS_NOT_ACKNOWLEDGED",
     "warnings": [
       { "code": "OVER_JOB_PENDING", "lineNo": null, "itemId": null, "quantity": 152, "limit": 68.84, "stockUnit": "Kg", "message": "Total 152 Kg is more than the job's pending requirement of 68.84 Kg." }
     ]
   }
   ```

3. Show the warnings in the confirmation dialog with an acknowledgement tick-box. When ticked, resend the **same body** (same `requestId`) with `acknowledgeWarnings: true`.

Warnings are recomputed on every save. If stock changed in between, the acknowledged save can still succeed with a different warning list (returned in `warnings`). Nothing is blocked once acknowledged.

### 5.9 Retrying

A save may be retried at any time with the same `requestId`: after a timeout, a network error, a `500`, `409 VOUCHER_NUMBER_CONFLICT` or `503 LOCK_TIMEOUT`. It produces at most one voucher; a retry of a save that did go through returns it with `replayed: true`. Generate a new `requestId` only when the user starts a new issue ("New issue").
