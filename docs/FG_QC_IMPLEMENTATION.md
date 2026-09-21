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

Environment: `FGQC_COMPANY_ID` (default 2) and `FGQC_FROM_GPN_DATE` (default
`2026-04-01`, the start of the financial year). The second is the go-live
cutoff from spec section 4.3 — without it every historical GPN in the database
appears in the queue on day one. The frontend carries the same value in
`config.js`; keep the two in step.

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

The fallback now also catches a procedure that is *deployed but out of date* —
SQL Server errors 8144 and 8145, raised when a route sends a parameter the
procedure does not declare. That is what happens when the API is deployed and
the matching `sql/fgqc/*.sql` is not re-run. Before this the route returned a
500 and the screen went blank; now it falls back and logs a warning that says
which procedure to re-run.

**The inspections table filters per column.** A filter row sits under the
headers: FGQC no, inspector, job no and GPN no match on any part of the value,
lot size, sample and the three defect counts take a "≥ this many" threshold,
and status is a dropdown that shares its state with the KPI tiles above, so the
two controls cannot disagree. Date has no box — the From / To fields in the
toolbar are that filter.

Every one of them is applied in SQL, not over the fetched page. The table is
paged twenty-five rows at a time, so filtering in the browser would hide
matches sitting on page two while the count in the panel heading went on
quoting the unfiltered total. `GetFGQCInspectionList` gained the matching
parameters, all defaulting to NULL — **re-run `sql/fgqc/010_GetFGQCInspectionList.sql`
after deploying this**, or the route falls back to inline SQL as described
above.

**A summary row sits under the table.** Distinct inspectors, jobs and GPNs;
lot size and sample size totalled. Like the filters these describe the whole
filtered set, not the twenty-five rows on screen — adding up the visible page
would put a number under a heading that counts every matching lot, and the two
would disagree.

They come back from the procedure's second result set, beside `Total`, so the
pager and the summary are one pass over one filtered set and cannot drift
apart. That query groups by the lot before aggregating: a GPN spanning several
jobs fans out across the joins, and a straight `SUM` over that would count the
same lot's cartons twice.

**Lot size is the GPN's quantity, not the job's.** `GetPendingFGQCList` reports
a `LotSize` that is the job quantity, so the sampling plan was being matched
against the whole order while the inspector stood in front of one delivery. A
GPN of 100 pieces was asked for a sample of 315 — drawn from a lot of 100.

`/api/qc/pending` now replaces that figure with
`SUM(outercarton x innercarton x quantityperpack)` over the GPN's own detail
lines, which is how `GPNAgg` in `src/job-card-queries.js` has always read a
GPN, and re-reads the required sample from the plan for that size. It is done
in the route rather than the procedure because the arithmetic is already the
repo's, and does not depend on procedure source this API cannot see. If the
lookup fails the queue still renders, marked, rather than quietly serving the
job-sized numbers again.

**A GPN under `FGQC_MIN_LOT_QTY` pieces (default 50) does not need QC.** The
queue dims the row and labels the button "No QC needed"; pressing it explains
why instead of opening the form. The form refuses the same lot when reached by
its URL, and `POST /api/qc/inspections` refuses to save it — a rule only the
browser enforces is not a rule. The save's check does not block on a failed
lookup: refusing to record an inspection someone has already carried out, over
a supporting query, loses real work to protect a threshold.

**CDC's Carter table has nine bands, not the textbook fifteen.** The sheet at
Panchla starts at "0 To 150" and asks for a sample of 20, so the small bands a
full Z1.4 table carries (2-8, 9-15, 16-25, 26-50, 51-90) do not exist here: a
lot of 60 is sampled at 20, not 13. `sql/fgqc/022_sampling_plan_from_paper.sql`
compares `FinishGoodsQCSamplingPlan` against that sheet and corrects it.

The stored number is the ACCEPT figure — the left half of each printed pair.
Storing the reject figure would let one more defect through per class, quietly.

Because the first band starts at 0 and asks for 20, a lot under 20 cannot
supply its own sample. `FGQC_MIN_LOT_QTY` is what keeps those out of the queue,
and a test fails if anyone sets it below the smallest band's sample size.

**Verdicts already saved were computed against the wrong band.** The error runs
one way: a job is never smaller than one of its deliveries, so the band used
was always at or above the right one, and a higher band always accepts more
defects. Everything affected was judged more leniently than the table allows.
`sql/fgqc/023_recheck_saved_verdicts.sql` lists which verdicts change. It
reports and does not rewrite — goods have shipped against those verdicts, so
each one is a decision, not a data fix.

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
