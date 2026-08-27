# Finished Goods QC — implementation status

The specification is [`FG_QC_SPEC.md`](./FG_QC_SPEC.md) and it is the source of
truth. This file records what is built against it, what is waiting on the
database, and what is deliberately not built yet.

| Piece | Where |
|---|---|
| API | `src/routes-fg-qc.js`, mounted at `/api` in `src/server.js` |
| Stored procedures | `sql/fgqc/` |
| Tests | `src/routes-fg-qc.test.js` (`npm run test:fg-qc`) |
| Frontend | [`eacdc/fg-transaction-qc`](https://github.com/eacdc/fg-transaction-qc) — static HTML/JS, calls this API |

---

## Deploy order

The API and the database can be deployed independently, but the database work
is what makes the verdicts correct. Do it first.

```
1.  sql/fgqc/002_verify.sql        read the ACTION lines
2.  sql/fgqc/001_schema_fixes.sql  section 4.5, dry run first
3.  sql/fgqc/010..012              the three read procedures
4.  sql/fgqc/002_verify.sql        again — every line should read OK
5.  deploy the API                 nothing to configure beyond the env vars below
```

Environment: `FGQC_COMPANY_ID` (default 1) and `FGQC_FROM_GPN_DATE` (default
`2026-08-01`). The second is the go-live cutoff from spec section 4.3 — without
it every historical GPN in the database appears in the queue on day one. The
frontend carries the same value in `config.js`; keep the two in step.

---

## Built and matching the spec

**Acceptance logic (section 3).** Nothing in JavaScript computes a verdict.
`SaveFinishGoodsQCInspection` decides, the API forwards, the browser displays.
The form's live limit flagging is a warning only: the submit button is never
disabled on a flagged form, because a rejected lot is a result the system needs
recorded, not an error to prevent. The percentage figures on the paper form
(Critical 0.1%, Major 1.00%, Minor 4%) are not implemented anywhere;
`defectPercent` is displayed for information only.

**API (section 6).** All six documented routes, plus `/qc/inspectors` and
`/qc/units` which the screens need to fill their dropdowns. One shared pool,
every parameter bound with `request.input(name, sql.Type, value)`, and the save
route checks the procedure's `success` field explicitly rather than treating a
200 as a successful save — on failure it returns the procedure's own `message`
so the inspector sees the actual reason. Double submits are rejected for the
same lot within an eight-second window.

**Screens (section 7).** Pending queue, QC form, confirmation, read-only
detail, dashboard. The form renders entirely from `GET /api/qc/template` — no
defect name is hardcoded in the frontend.

---

## Changed to match the spec

**The plan band no longer lies about a missing plan.** The form used to take
the pending row's required sample when `planFound` came back false and flip the
flag to true. That hid the banner section 7.2 requires, and left the accept
numbers null, so the live limit flagging silently did nothing — the inspector
saw an ordinary form, entered counts, and got no warning at all. `planFound` is
now whatever the sampling plan said.

**An unresolved severity is no longer counted as Minor.** Section 5 question 1
is still open — which column on `FinishGoodsQCParameterSetting` is
authoritative. Until it is answered, a characteristic whose severity does not
resolve to Critical, Major or Minor is reported as `Unclassified`. The form
lists those in their own block, says plainly that they are not counted, and
refuses to submit while any of them carries a count. The old behaviour filed
them under Minor, which takes a Critical defect and judges it against the Minor
accept number.

This is a stop, not a silent pass, and it is the one place the form blocks the
inspector. The reasoning: an over-limit flag is a warning because the verdict it
predicts is correct, whereas counting a defect in the wrong class produces a
verdict that is wrong. Answering section 5 question 1 removes the block.

**First-pass acceptance now comes from the detail history.** Section 7.4 says
it has to: `FinishGoodsQCInspectionMain` holds only the latest verdict, so a lot
that failed and was reworked into an Accepted state was indistinguishable from
one that passed first time. `GetFGQCDashboardKPIs` judges each lot's earliest
submission against its AQL snapshot and returns `firstPassLots` alongside
`firstPassAccepted`, so the tile can show the count behind the percentage.

**The latest submission is selected by exact `CreatedDate`.** Rows from one
submission share a `CreatedDate` (section 4.1). The detail route used to group
them with a two-second window in JavaScript, which could merge two submissions
made in quick succession — the opposite of what the history is for.

**Rework history is visible on the lot.** Section 5 question 2 asks whether a
rejection needs to be visible after the main row is replaced. It is now, without
a schema change: `GET /api/qc/inspections/:id` returns every submission with its
per-class totals and whether it would have passed, and the detail screen renders
them oldest first with the first pass labelled. An attempt counter on the main
row would have been dead weight — `SaveFinishGoodsQCInspection` does not write
one, so it would never be filled.

**Rejections by production unit show unit names.** The chart was labelling bars
with raw `ProductionUnitID` values.

**The three read routes call stored procedures.** Section 6: every route calls
a stored procedure, no business logic in JavaScript. The inspections list,
inspection detail and dashboard were written before their procedures existed,
so they carried inline SQL. They now call `GetFGQCInspectionList`,
`GetFGQCInspectionByID` and `GetFGQCDashboardKPIs`.

Each of the three keeps an inline fallback that runs *only* when the procedure
is not deployed, and logs a warning naming the procedure the first time it
happens. The fallback is the same SQL, not a second implementation — it exists
so that deploying the API and deploying the database do not have to happen in
the same minute. `002_verify.sql` reports which procedures are still missing.
Once all three are deployed the fallbacks are unreachable and can be deleted.

---

## Waiting on the database

Everything in spec section 4.5. The scripts are written and idempotent, but
none of them has been run against a live database — running them is a DBA task,
and two of them need judgement:

**`FinishGoodsQCInspectionMainID` must be an IDENTITY column (4.5.2).** SQL
Server cannot add IDENTITY to an existing column; it needs a table rebuild.
`001_schema_fixes.sql` reports the state and carries the remediation steps
rather than attempting it unattended. This is the most damaging item on the
list: if the column is not an identity, `SCOPE_IDENTITY()` in the save procedure
returns NULL and every detail row is orphaned with **no error raised**.

**Type normalisation (4.5.5)** is behind `@ApplyTypeChanges`, off by default,
because it rewrites column types on tables that already hold rows. The script
counts the values that would not convert before it offers to run.

`IsDeletedTransaction` (bigint in the transaction tables, bit in the settings
tables) is reported rather than changed. Every FG QC query writes
`ISNULL(IsDeletedTransaction, 0) = 0`, which is correct against both, and
normalising it reaches well outside this module.

Until 4.5.1 has run, "one row per lot" is an intention rather than a guarantee —
the unique index is what enforces it. The API cannot substitute for that: the
double-submit guard is in-memory, so it does not survive a restart and does not
span instances.

---

## Not built

**Roles and permissions (section 8).** No authentication exists on these routes
— the inspector is a dropdown of `UserMaster` names kept in browser storage, so
anyone can submit as anyone. Section 10 puts roles at step 8 and says to ship
steps 1–6 first, so this is on plan rather than overlooked, but it should be
understood plainly: the QC record is not attributable until it is built, and
attributability is most of what makes the record defensible in a buyer audit.

The rest of `/api` has no auth either, so building it here means either
inventing a scheme for this module alone or doing it across the application.
That is a decision, not a gap to quietly fill.

**Resolving a `Pending` verdict (section 5 question 3).** No override exists,
because the spec has not yet said who may do it or whether the override is
recorded. Lots with no matching sampling plan accumulate in the queue with the
reason "No sampling plan" until someone adds the missing plan band.

---

## Open questions still open

These are business decisions, not code, and each one is named in section 5.

1. **Which column on the parameter master is authoritative for severity?**
   Until this is answered the form refuses to count characteristics it cannot
   classify. Run the severity distribution query at the end of
   `002_verify.sql` and compare it against what QC believes is set.

2. **Does rejection history need to live on the lot itself?** It is now visible
   through the detail history, which is enough for an audit trail. A stored flag
   would additionally let the pending queue and the dashboard filter on "failed
   before" without reading detail rows. That needs a column *and* a change to
   `SaveFinishGoodsQCInspection`.

3. **Who resolves a `Pending` verdict, and is the override recorded?**
