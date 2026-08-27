# Finished Goods QC — Application Specification

**System:** Finished Goods QC module for CDC
**Stack:** React (frontend) · Node.js/Express (API) · SQL Server (IndusEnterprise)
**Built in:** Cursor
**Status:** Spec v1 — database layer partially complete, application layer not started

---

## 1. What this application does

A QC inspector on the shop floor opens the app, sees every pending GPN (Goods Production Note) that has not yet been inspected, picks one, fills in a defect count sheet, and submits. The system decides Accepted or Rejected against Carter's AQL table — the inspector does not decide. Management sees the resulting pass/fail picture on a dashboard.

The single most important behaviour: **the verdict is computed by the database, not by the person and not by the browser.** The same lot inspected by two people with the same counts must produce the same status.

---

## 2. Vocabulary

"Pending" appears in two unrelated senses. Keep them separate in code, in the UI and in the database.

| Term | Meaning |
|---|---|
| **Lot** | One job on one GPN. `(JobBookingID, FGTransactionID)` is the key. A job packed over three GPNs is three independent lots, each with its own lot size, sample size and verdict. |
| **Pending lot** | A lot still needing inspection: never started, sample short of what the plan requires, or rejected and awaiting rework. A *queue state*, not a stored value. |
| **`QCStatus = 'In Progress'`** | Stored. Nothing has crossed a reject number but fewer cartons were inspected than the plan requires. |
| **`QCStatus = 'Pending'`** | Stored. No sampling plan covered the lot size, so no verdict could be computed. Needs a human decision — not the same as a pending lot. |

In the UI, prefer "Awaiting inspection" for the queue and "Pending review" for the `Pending` verdict.

---

## 3. Acceptance logic (read this before writing any code)

CDC follows **Carter's AQL Table** — single sampling plan, normal inspection level II — for every product and every customer.

| AQL class | Level | Rule |
|---|---|---|
| Critical | Not allowed | Accept number is **0**. One critical defect rejects the lot. |
| Major | 1.5 | Accept number varies by lot size. |
| Minor | 2.5 | Accept number varies by lot size. |

**The unit of measurement throughout the AQL logic is the INNER CARTON — not pieces.**

Lot size, sample size, and the "Total Count" column on the inspection form all count inner cartons. A lot of 5,000 means five thousand inner cartons, not five thousand books. Getting this wrong pushes almost every job into the wrong lot band and produces the wrong sample size, so it is worth stating in the code as well as here.

**A lot is one job on one GPN.** Lot size is the actual inner cartons of that GPN for that job — `SUM(outercarton × innercarton)` on its detail lines. Planned or ordered quantity is never used.

Lot size selects the row from `FinishGoodsQCSamplingPlan`, which returns the sample size (again, in inner cartons) and the three accept numbers.

Inner cartons are derived from the GPN detail as `outercarton × innercarton`. The `quantityperpack` multiplier converts to pieces and is **not** used anywhere in the AQL path.

The rule is `found <= accept` passes; `found >= accept + 1` rejects. A lot is **Accepted** only if Critical, Major and Minor all pass. Any one class failing rejects the whole lot.

A lot may be submitted more than once — a rejected lot is reworked and re-inspected. **The verdict is computed from the latest submission alone.** Earlier defect counts are history and are not carried forward, so a reworked lot starts clean. Carrying them forward would make a rejected lot mathematically impossible to pass.

Worked example — lot of 5,000:

```
Plan row: 3201–10000 → sample size 200, accept C=0, M=7, Mi=10

Inspector finds: 0 critical, 6 major, 12 minor
  Critical 0  <= 0   pass
  Major    6  <= 7   pass
  Minor   12  <= 10  FAIL
  → Rejected
```

The figures printed on the current paper form (Critical 0.1%, Major 1.00%, Minor 4%) are a **different standard and are not used.** Do not implement percentage thresholds. The defect percentage is displayed for information only.

---

## 4. Data layer

### 4.1 Storage model

`FinishGoodsQCInspectionMain` holds **one row per lot**, enforced by a unique index on `(JobBookingID, FGTransactionID)`. Each submission **replaces** that row — latest date, status and counts overwrite the previous ones. `FGQCNo` is assigned on the first submission and never changes, so a lot keeps one QC number for its whole life.

`FinishGoodsQCInspectionDetail` **appends**. Every submission inserts a fresh set of rows against the same `FinishGoodsQCInspectionMainID`, so the inspection history survives replacement. Rows from one submission share a `CreatedDate`, which is what separates one submission from the next.

Column meanings on the main row — no new lot-size column is needed, the existing ones carry it:

| Column | Meaning |
|---|---|
| `TotalBox` | Lot size — inner cartons in that GPN for that job |
| `PackedQuantity` | Pieces in that lot (`× quantityperpack`), display only |
| `SampleSize` | Inner cartons inspected in the latest submission |
| `ReferenceAQLCritical / Major / Minor` | Accept numbers from the plan, snapshotted |

On the detail rows, `SampleSize` carries the same number as the main row — the form's total count — repeated on every parameter line.

### 4.2 Tables

| Table | Role |
|---|---|
| `FinishGoodsQCParameterSetting` | Master list of defect characteristics per product category. Each row is one line on the inspection sheet. |
| `FinishGoodsQCSamplingPlan` | Carter's AQL table. Lot-size bands → sample size + accept numbers. Rows with `CategoryID = NULL` apply to all products. |
| `FinishGoodsQCInspectionMain` | One row per inspection. Holds the verdict and a snapshot of the AQL numbers used. |
| `FinishGoodsQCInspectionDetail` | One row per defect characteristic, with the counts found in each class. |

`FinishGoodsQCInspectionMain.ReferenceAQLCritical / Major / Minor / Total` are a **snapshot** of the plan numbers at the moment of inspection. If the sampling plan is later changed, historical verdicts stay explainable. Never recompute an old verdict from the current plan.

### 4.3 Stored procedures (already written)

**`GetFinishGoodsQCTemplate`**
`@CategoryID, @LotSize, @SamplingMethodType = 'Carter', @CompanyID, @IncludeDeleted`
`@LotSize` is the lot's inner carton count, taken from the pending row — not pieces, not the order quantity.
Returns a single JSON document: the resolved sampling plan (sample size, accept numbers, `planFound` flag) plus `items[]` — the defect characteristics with a `severity` field of `Critical` / `Major` / `Minor` for grouping the form.

**`SaveFinishGoodsQCInspection`**
`@UserID, @InspectionJson, @CompanyID, @FYear, @Prefix = 'FGQC', @AllowNoPlan = 1`
Computes lot size itself from the GPN lines for `(jobBookingID, fgTransactionID)` — the client cannot supply a size that would change the sampling plan. Resolves the plan, computes the verdict from this submission's counts, then **upserts** the main row and **appends** the detail rows, all in one transaction.

Returns `success`, `fgqcNo`, `mainID`, `qcStatus`, `isResubmission`, `lotSize`, `requiredSample`, `inspected`, the found-vs-accept numbers and `defectPercent`.

`qcStatus` is one of `Accepted`, `Rejected`, `In Progress` (clean so far but sample short of the requirement) or `Pending` (no plan matched).

Server-side validations already inside the save SP — the frontend should mirror them for immediate feedback but must not rely on doing so:
- `CompanyID`, `CategoryID`, `LotSize` are required
- `items[]` cannot be empty
- Total defects cannot exceed the sample size
- If no plan matches the lot size, status is saved as `Pending` (with `@AllowNoPlan = 1`)
- `sampleSize` must be greater than zero and cannot exceed the lot size
- Defective cartons cannot exceed the cartons inspected

**`GetPendingFGQCList`**
`@Search, @FromGPNDate, @ToGPNDate, @CompanyID, @ProductionUnitID, @IncludeClosed, @Page, @PageSize`
Drives the home screen. One row per lot — per job per GPN.

A lot is pending when the GPN exists and any of:

```
- no QC row raised yet                       -> "Not started"
- QC row's SampleSize < required sample       -> "Sample incomplete"
- QC row's verdict is Rejected                -> "Rejected - awaiting rework"
- no sampling plan covers the lot size        -> "No sampling plan"
```

The result carries `PendingReason` with exactly those labels, plus `LotSize`, `RequiredSample`, `InspectedQty`, `FoundCritical/Major/Minor` and `SubmissionCount`, so the row can explain itself without a second call.

Source mapping:

| Field | Source |
|---|---|
| Lot key | `FinishGoodsTransactionDetail.JobBookingID` + `.FGTransactionID` |
| **Lot size** | `SUM(outercarton × innercarton)` for that job on that GPN — inner cartons |
| Required sample | `FinishGoodsQCSamplingPlan.SampleSize` for that lot band, `SamplingMethodType = 'Carter'` |
| Inspected | `FinishGoodsQCInspectionMain.SampleSize` on the lot's single row |
| Found defects | `SUM(Critical/Major/Minor)` from the detail rows of the most recent submission |
| Job No / Job Name | `JobBookingJobCard.JobBookingNo` / `.JobName` |
| Client | `ISNULL(JobBookingJobCard.ClientName, LedgerMaster.LedgerName)` via `JobOrderBooking` |
| Category | `JobBookingJobCard.CategoryID` → `CategoryMaster.CategoryName` |
| Pieces (context only) | `SUM(outercarton × innercarton × quantityperpack)` |

Cancelled jobs are excluded; closed jobs are excluded unless `@IncludeClosed = 1`.

`@FromGPNDate` is the go-live cutoff. Without it every historical GPN in the database appears in the queue on day one. Set it in app config, not per request.

`VoucherNo`, `VoucherDate`, `CompanyID` and `ProductionUnitID` on `FinishGoodsTransactionMain` are assumed and not proven by the job-card search query. They are marked `[VERIFY]` in the SQL.

### 4.4 Procedures still to be written

**`GetFGQCDashboardKPIs`** — aggregates for the dashboard (section 8).

**`GetFGQCInspectionByID`** — full main + detail for the read-only view of a submitted inspection.

### 4.5 Schema issues to resolve before go-live

These are not optional. Each one produces silent wrong behaviour rather than an error.

1. **`FinishGoodsQCInspectionMain` needs one new column and a unique index:**

   ```sql
   ALTER TABLE dbo.FinishGoodsQCInspectionMain ADD JobBookingID BIGINT NULL;

   CREATE UNIQUE INDEX UX_FGQCMain_Lot
       ON dbo.FinishGoodsQCInspectionMain (JobBookingID, FGTransactionID)
       WHERE ISNULL(IsDeletedTransaction, 0) = 0;
   ```

   A GPN can span several jobs, so `FGTransactionID` alone cannot identify a lot. The unique index is what makes "one row per lot" actually true rather than merely intended — without it, a double submit creates two rows and the queue silently misreports.

2. **`FinishGoodsQCInspectionMainID` must be an IDENTITY column.** The save procedure links detail rows using `SCOPE_IDENTITY()`. If the column is not an identity, `@MainID` comes back NULL and every detail row is orphaned with no error raised. Verify with `sp_help` before anything else.

3. **`FGQCSamplingPlanID` is not an identity** and existing seeded rows have NULL. Backfill it and add a unique index on `(CompanyID, SamplingMethodType, CategoryID, LotRangeFrom)` so overlapping lot bands cannot be inserted. Two rows matching the same lot size makes plan selection non-deterministic.

4. **Column widths truncate.** `FinishGoodsQCInspectionDetail.Characterstics` is `nvarchar(64)` while the master is `nvarchar(512)`. `Remark` is `nvarchar(64)` in both main and detail — too short for a rejection reason. The save procedure currently guards with `LEFT()` so nothing fails, but data is lost. Widen these columns and remove the guards.

5. **Type mismatches.** `SampleSize` is `nvarchar(128)` in the plan, `real` in main, `nvarchar(250)` in detail. `IsDeletedTransaction` is `bigint` in the transaction tables and `bit` in the settings tables. Normalise before data accumulates.

6. **Job number is not on the QC tables.** `FinishGoodsQCInspectionMain` holds `FGTransactionID` only. Dashboard search by job number requires a join back through the FG transaction to job booking. Confirm the join path before building the search.

---

## 5. Open questions

Answer these before the corresponding screen is built.

1. **How is severity stored on the master?** `GetFinishGoodsQCTemplate` currently reads `MasterFieldType` for `Critical` / `Major` / `Minor`, falling back to whichever of `CriticalCriteria` / `MajorCriteria` / `MinorCriteria` is populated. Confirm which is authoritative — if this is wrong, defects appear in the wrong section of the form and are counted in the wrong class.

2. **Rework loop.** A rejected lot stays in the queue and is re-inspected against the same `(JobBookingID, FGTransactionID)`, replacing the main row. That means the previous rejection survives only in the detail history — the main row no longer shows that the lot ever failed. If rejection history needs to be visible on the lot itself (for a buyer audit, or to spot lots that failed twice), add an attempt counter or a "was ever rejected" flag to the main row before go-live.

3. **Who can override a `Pending` verdict?** When no sampling plan covers the lot size, the SP saves as `Pending`. Someone has to resolve it. Define the role and whether the override is recorded.

---

## 6. API design

Node/Express, `mssql` package with a connection pool. Every route calls a stored procedure — **no business logic in JavaScript.**

```
GET  /api/qc/pending
     ?search=&fromGPNDate=&toGPNDate=&page=1&pageSize=25&unitId=
     → { rows: [...], total }

GET  /api/qc/template
     ?categoryId=&lotSize=
     → { lotSize, sampleSize, planFound, referenceAQL: {...}, items: [...] }

POST /api/qc/inspections
     body: inspection JSON (section 7.3)
     → { success, fgqcNo, mainID, qcStatus, criticalFound, criticalAccept, ... }

GET  /api/qc/inspections
     ?from=&to=&jobNo=&status=&page=&pageSize=
     → { rows: [...], total }

GET  /api/qc/inspections/:id
     → { main: {...}, detail: [...] }

GET  /api/qc/dashboard
     ?from=&to=&unitId=
     → { kpis: {...}, trend: [...], topDefects: [...] }
```

Implementation notes:

- Use a single shared pool created at startup. Do not open a connection per request.
- Pass parameters with `request.input(name, sql.Type, value)` — never string-concatenate SQL.
- The save procedure returns a result set with `success = 0` on business-rule failures rather than throwing. Check `success` explicitly; do not treat a 200 response as a successful save.
- Return the SP's `message` field to the client on failure so the inspector sees the actual reason.
- `POST /api/qc/inspections` must be idempotent-safe against double submits: disable the button on the client and, server-side, reject a second submission for the same `FGTransactionID` within a short window.

---

## 7. Screens

### 7.1 Home — pending inspections

A table, one row per GPN awaiting QC.

One list. Columns: GPN No · GPN Date · Job No · Job Name · Client · Category · Lot Size (inner cartons) · Required Sample · Status · **Start QC**

Every row carries a `PendingReason` — "Not started", "Sample incomplete", "Rejected - awaiting rework", "No sampling plan". Show it as the Status column rather than leaving the inspector to work out why a lot is in the list. A rejected lot in particular must be visually distinct: the inspector needs to know they are looking at a rework, not a fresh lot.

Where a lot has been submitted before, label the button **Re-inspect** rather than Start QC, and show the previous verdict and counts on the form when it opens.

Behaviour:
- Search box filters on GPN number, job number, job name and client, server-side.
- Sort by GPN date, oldest first, by default — the oldest waiting lot is the one holding up dispatch.
- Show the waiting time per row. A lot that has been pending more than a shift should be visually distinct.
- **Start QC** navigates to the form. Pass `jobBookingId`, `fgTransactionId`, `categoryId` and `lotSize` through, then let the form fetch its own template so a bookmarked or refreshed URL still works.
- Empty state: "No lots waiting for inspection." Not an error, not an illustration.

### 7.2 QC form

On open, call `GET /api/qc/template`. The response drives the entire form — do not hardcode defect names in the frontend.

**Header (read-only, from the pending row):**
GPN No · Job No · Job Name · Client · GPN Date · Shift · Inspector

**Cartons inspected** is an editable field, defaulting to the plan's required sample. It is the one number the inspector must enter besides the defect counts, and the verdict depends on it. It maps to `SampleSize` on both the main row and every detail row.

**Plan band (prominent, top of form):**

```
Lot 5,000 inner cartons  →  Required sample 200
Accept:  Critical 0  ·  Major 7  ·  Minor 10
```

Every number on this band is inner cartons. Say so on screen — the inspector counting pieces instead of cartons is the single most likely way this system produces a wrong verdict.

If `planFound` is false, show a clear banner: no sampling plan covers this lot size; the inspection will be saved as Pending for review. Still allow the form to be filled.

**Three sections, in order: Critical, Major, Minor.** Group `items[]` by the `severity` field. Each row: defect name, a numeric input for the count, and an optional remark.

Number entry must be usable on a tablet with a gloved hand: large tap targets, numeric keypad, stepper buttons alongside the field. Default every count to 0, not blank — the inspector should be confirming zeros, not filling an empty grid.

**Live limit flagging (required behaviour):**

As the inspector types, maintain running totals per class and compare against the accept numbers from the template. Only this submission's counts matter — a previous rejection does not carry forward. The moment a class crosses its limit:

- The section header turns to the alert state and shows `7 / 7 — at limit` or `8 / 7 — over limit`.
- The offending row is marked so the inspector can see which defect pushed it over.
- A persistent banner at the top of the form states the lot will be rejected and why.
- **Critical is special:** the accept number is 0, so the first critical defect entered triggers the flag immediately. The banner should say that plainly — one critical defect rejects the lot.

The flag is a warning, not a block. The inspector must still be able to complete and submit a failing inspection — a rejected lot is a result the system needs recorded, not an error to prevent. Do not disable the submit button on a flagged form.

**Client-side validation before submit:**
- Total defects across all classes cannot exceed the sample size (the SP enforces this too)
- Counts must be non-negative integers
- If any class is over its limit, require a remark before submitting

**On submit:** disable the button, POST, then show the returned verdict on a confirmation screen — FGQC number, status, and the found-vs-accept numbers for all three classes. On a rejection, show what to do next rather than only the failure.

### 7.3 Inspection JSON sent to the API

```json
{
  "companyID": 1,
  "categoryID": 5,
  "jobBookingID": 4471,
  "fgTransactionID": 101,
  "sampleSize": 200,
  "samplingMethodType": "Carter",
  "packingDescription": "",
  "remark": "",
  "productionUnitID": 1,
  "items": [
    {
      "fgqcParameterSettingID": 12,
      "characterstics": "TEXT PRINT MISSING",
      "critical": 0, "major": 0, "minor": 0,
      "remark": ""
    }
  ]
}
```

Each item carries counts in all three class columns, but only the column matching that defect's severity will be non-zero. Counts are **defective inner cartons** — an inner carton with any bad piece inside it counts as one defective carton in that class.

Lot size is deliberately absent from the JSON. The save procedure computes it from the GPN lines for `(jobBookingID, fgTransactionID)` so that the client cannot supply a value that would change the sampling plan. The API passes this JSON straight through as `@InspectionJson`.

### 7.4 Dashboard

A tab above the pending list. Filters: date range (default last 30 days), production unit, job number search.

**KPI tiles:**
- Lots inspected
- Acceptance rate (%)
- Lots rejected
- Pending verdicts (no plan matched)
- Average defect percentage
- Lots awaiting inspection right now

**Charts:**
- Acceptance rate over time (weekly or daily depending on range)
- Top defect characteristics by frequency, split by class — this is the chart that drives shop-floor action, so make it the largest element
- Rejection count by production unit
- Rejections by class (which class is actually failing lots)

**Job search result:** entering a job number returns every inspection against that job — FGQC No, date, inspector, lot size, sample size, found vs accept per class, status. Clicking a row opens the read-only inspection detail.

Rules for the dashboard:
- Every number must be traceable. Clicking a KPI filters the table below it.
- Show the record count behind each percentage. An acceptance rate of 100% from three lots is not the same claim as 100% from three hundred.
- Do not average defect percentages across different sample sizes without weighting.
- Count lots, not submissions. `FinishGoodsQCInspectionMain` has one row per lot, so counting it is correct — but a lot re-inspected after rework shows only its latest verdict there. First-pass acceptance rate has to come from the detail history, not the main row.

---

## 8. Roles

| Role | Can do |
|---|---|
| QC Inspector | View pending list, run inspections, view own submissions |
| QC In-charge | All of the above, plus resolve `Pending` verdicts, view all inspections |
| Management | Dashboard and read-only inspection history |

An inspection, once submitted, is not editable. Corrections are made by a new inspection against the same transaction, with the reason recorded. This keeps the QC record defensible in a buyer audit — which is the entire point of running AQL in the first place.

---

## 9. Interface direction

This is a tool used standing up, on a tablet, next to a running machine, by someone wearing gloves and possibly in poor light. Design for that, not for a desk.

- Verdict states carry meaning and must be distinguishable without relying on colour alone — pair every status with a word. Accepted, Rejected, Pending. Never a bare green or red dot.
- The count entry grid is the centre of the product. Everything else is navigation around it. Give it the space.
- Type at a size readable at arm's length. Numbers in the entry grid and the plan band should be the largest text on the screen.
- Avoid modal dialogs during entry. An inspector interrupted mid-count loses their place.
- Autosave the in-progress form to local state so a dropped connection or an accidental back-navigation does not lose twenty minutes of counting.

Copy rules: buttons say what happens — "Submit inspection", not "Submit". The status shown after submitting uses the same word the dashboard uses. Errors state what went wrong and what to do: "Total defects (250) exceed the sample size (200). Check the counts." not "Validation failed".

---

## 10. Suggested build order

1. Confirm the identity column on `FinishGoodsQCInspectionMain` and fix the schema issues in 4.4
2. Add `JobBookingID` and the unique lot index; verify the `[VERIFY]` columns in `GetPendingFGQCList`
3. Node API skeleton with pool, config, and the pending + template routes
4. Home screen table with search — usable against real data before anything else is built
5. QC form: render from template, entry grid, live flagging, submit
6. Confirmation screen and read-only inspection view
7. Dashboard SP and screen
8. Roles and permissions

Ship steps 1–6 first. The dashboard is worth building only once inspections are actually flowing into the tables.
