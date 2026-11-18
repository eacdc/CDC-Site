# Supplier quote run — instructions for the scheduled session

You are the hourly scheduled run for CDC Printers' supplier portal. You read
new supplier quotes, propose the Indus item each quoted line is, and send the
proposals to the portal. A person approves or rejects every one on the review
page. Follow this file exactly; it is the only standing instruction you have.

## Places

| What | Where |
|---|---|
| Quotes folder | `C:/CDC Quotes/Inbox` → `Done` / `Failed`; working files in `Work` |
| Runner checkout (run everything from here) | `C:/CDC Quotes/runner` — a git worktree of the backend repo (`eacdc/CDC-Site`), detached at `origin/main` |
| Scripts | `C:/CDC Quotes/runner/scripts/supplier-portal-run/` |
| Env | `node --env-file="C:/Users/User/Desktop/CDC Site/backend/.env" --env-file="C:/CDC Quotes/run.env" …` (run.env holds `SP_API_BASE`, `SP_AUTOMATION_KEY`) |
| Rule-change worktrees | `C:/CDC Quotes/changes/<branch>` |

Below, `RUN` means `node --env-file=… --env-file=…` with both env files.

## Hard rules — never break these

1. **Never write to MongoDB yourself**, by any route — no MCP, no script, no
   driver. The only writes are `submit.mjs` calls to `/automation/quotes`.
2. **Never call a model API** (Anthropic, OpenAI or any other) and never add
   code that does. Reading and judging are your own work in this session.
3. **Never approve, reject or change a proposal.** Decisions are people's,
   on the review page.
4. **Indus is read-only.** Use the `indus` read-only tools or the scripts.
5. **Never print secrets** or the contents of the env files.
6. **Git:** never push to `main` directly, never force-push, never rewrite
   history. `main` changes only by merging an `sp-auto` PR (step 7).
7. **Never change these yourself** — they need CDC: this "Hard rules"
   section; `models/proposals.js` (the append-only guard); the automation key
   check; `/proposals` decision routes; `review/`; `regression.mjs`. A pattern
   that seems to need one of them becomes a note in your report.
8. When unsure, propose nothing for that line and ask (a `question`). An
   unmapped line costs a reviewer seconds; a confident wrong item corrupts the
   price comparison.

## Each run

### 0. Bring the runner up to date

```
git -C "C:/CDC Quotes/runner" fetch origin
git -C "C:/CDC Quotes/runner" checkout --detach origin/main
```
If `package-lock.json` changed since the last run, run `npm ci` in the
runner's backend folder.

### 1. Merge rule changes that were not rejected (see step 7 for how they are made)

```
gh pr list -R eacdc/CDC-Site --label sp-auto --state open --json number,title,createdAt,labels,headRefName
```
For each open `sp-auto` PR **opened more than 3 hours ago** and **without a
`reject` label**: check it out into its change worktree, rebase onto
`origin/main`, run `npm test` and the regression check (step 7c). If all
pass, `gh pr merge <n> -R eacdc/CDC-Site --squash --delete-branch`. If any
fail, comment the failure on the PR and leave it. A closed PR is a rejection:
never reopen it. Then repeat step 0.

### 2. Find new quotes

```
RUN prepare.mjs
```
It prints `NEW <sha8> <file> dir=…` for each new quote, or `NOTHING NEW`.
Portal uploads are included. If nothing is new and step 1 merged nothing,
stop here and report "nothing new".

### 3. Read each quote

For each NEW item, open the files in its `dir`: `page-N.jpg` (look at every
page), `text.txt` (exact characters: trust it for digits and spelling),
`sheet.json` (worksheet rows). Then write `dir/reading.json`:

```json
{
  "sha256": "<from manifest>", "fileName": "<from manifest>",
  "source": { "inbox": "…" } | { "portalDocumentId": "…" },
  "site": "KOL" | "AHM" | null,
  "supplier": { "name": "…", "gstin": "…" },
  "documentDate": "…", "effectiveFrom": "…",
  "materialClass": "PAPER_BOARD|INK|FILM|ADHESIVE|PLATE|CHEMICAL|CONSUMABLE|OTHER",
  "terms": { "freight": "…", "gst": "…", "credit": "…" },
  "questions": [{ "kind": "PLANT|PAPER_TYPE|UNIT|OTHER", "text": "…", "lineNos": [3, 4] }],
  "lines": [{ "lineNo": 1, "site": "KOL", "productName": "…", "productCode": null,
              "brand": null, "grade": null, "gsmFrom": 250, "gsmTo": 284,
              "sizeText": null, "packSize": null, "rate": "2400", "uom": null,
              "notes": "was 207" }]
}
```

How to read — these are CDC's rules, learned from real quotes; the full text
is in the portal source and you must follow it:

- `src/supplier-portal/services/extraction/prompts.js` → `QUOTE_PROMPT`
  (supplier vs addressee, merged cells, heading bands, mill-order vs
  ex-stock, two plants, multi-column price lists, the old/new price rule,
  soft quotes, validity).
- `src/supplier-portal/services/paper/paper-prompt.js` for paper and board.
- `src/supplier-portal/services/ink/ink-prompt.js` for inks and coatings.
- Units: copy the unit only if the row or its column states it. Never guess
  one from a heading that names several ("kgs/liters/nos").
- `rate` is the text as printed. One line per price: per GSM band, per plant,
  per supply mode.
- **Site:** Kolkata = `KOL`, Ahmedabad = `AHM`. From the addressee, the plant
  column, or a portal upload's `plantScope`. If the document does not say,
  set `site` to null on the quote, add a `PLANT` question, and give each line
  the site CDC buys that supplier's goods at (check Indus: which plant's GRNs
  name this supplier). If neither tells you, put `"site": "KOL"` on the lines
  and say so in the PLANT question.

### 4. Apply the rules

```
RUN match.mjs "<dir>/reading.json"
```
It writes `payload.json` (lines the rules settled carry their item) and
`judge.json` (the lines they did not), and prints a table.

### 5. Judge the unsettled lines

For each entry in `judge.json`, decide like CDC's purchase coordinator would.
You have the candidates (with last-paid rate, last supplier and purchase
count), `billedAs` (this supplier's own bill wording for each candidate),
`specItems` (paper items with the same quality/GSM/size key),
`approvedElsewhere` (other suppliers' approved mappings of similar wording)
and `unapproved` (earlier proposals not yet decided). You may query Indus
(read-only) for more: the supplier's past GRN items and PO rates are often
decisive (e.g. HK Trading = Hare krishna Trading's tapes at ₹240 each).

- It must be the **same product**: same size, grade, colour, micron, GSM.
  A different size is a different item, however alike the names.
- Evidence, strongest first: an approved mapping (this supplier) → this
  supplier's bill wording → another supplier's approval → the supplier's
  past purchases in Indus → spec → name → rate. A matching rate supports;
  it never decides alone.
- Indus item names are often generic and brand-free ("INK, Maplitho -
  Process Ink-Black"); a branded quote can be that item if the type matches.
  A branded Indus item of a different product line is not.
- Duplex alone means grey back. A box "10 pcs (1 box)" is priced per box.
- Never choose an item the rules excluded (a reviewer rejected it for this
  wording).
- A paper line that prices a GSM band with no size is approved by a reviewer
  as a **band** (an Indus quality, mills, sheet/reel, GSM range), not as one
  item. Do not pick one item for it: leave it `NONE` and in the question
  name the likely Indus quality and mill, so the reviewer's band is quick.
  Once a band is approved, `match.mjs` proposes it again for the same
  wording (`proposal.band`, method `APPROVED_MAPPING`); never write a band
  yourself.

Edit that line in `payload.json` (`lines[index]`):
- If sure: `proposal.itemId`, `itemName`, `method: "JUDGEMENT"`,
  `confidence` (honest: would the coordinator agree?), `rationale` (one or
  two plain sentences: what decided it), and `evidence` entries
  (`{kind: "BILL|RATE|SPEC|NAME|APPROVED|UNAPPROVED|JUDGEMENT", text}`).
- If not sure: leave `itemId` null and `method: "NONE"`, and set
  `proposal.question` to what a reviewer must decide, naming the best
  candidates. If CDC does not stock it, say "Not in Indus — new item?".

### 6. Submit

```
RUN submit.mjs "<dir>/payload.json"
```
On `SUBMITTED` the Inbox file is moved to `Done`. On `FAILED`, fix the
payload if the error is yours, else leave the file for the next run and
report it. Never resubmit a file that was accepted.

### 7. Learn — change the rules when a pattern says so

When a run shows a **pattern** — the same kind of mistake by the rules or the
reading, across lines or quotes, that you can describe in general terms (not
"SKM's line 12") — you may change the rules. At most two changes per run.
Small, general, explained. Never to make one quote come out right.

a. **Make the change in its own worktree off `origin/main`:**
   ```
   git -C "C:/CDC Quotes/runner" worktree add -b sp-auto/<yyyymmdd-hhmm>-<slug> "C:/CDC Quotes/changes/<slug>" origin/main
   ```
   Change code under `src/supplier-portal/` (vocabulary, normalisation,
   matching rules) or the "Learned rules" section of this file. Add or update
   a test in `src/supplier-portal/tests/` that shows the pattern. Match the
   surrounding code's style and comments.
b. `npm test` in that worktree's backend must pass.
c. **The regression check — the change may not misidentify a decided line:**
   ```
   (runner)  RUN regression.mjs --out "C:/CDC Quotes/Work/before.json"
   (change)  RUN regression.mjs --out "C:/CDC Quotes/Work/after.json"
   node regression.mjs --compare "C:/CDC Quotes/Work/before.json" "C:/CDC Quotes/Work/after.json"
   ```
   Exit 1 means the change broke a line a reviewer decided: drop the change
   (`git worktree remove`), and put the pattern in your report instead. While
   there are no decided lines yet, the check passes trivially; the tests and
   your own care are the guard.
d. Commit (message: what pattern, what changed, the regression summary line,
   ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`),
   `git push -u origin <branch>`, then
   ```
   gh pr create -R eacdc/CDC-Site --base main --head <branch> --label sp-auto --title "<pattern, plainly>" --body-file <file>
   ```
   The body says: the pattern and the quotes it came from; the change; test
   and regression results; and, in bold, **"Close this PR or add the `reject`
   label within 3 hours to stop it. Otherwise the next run merges it into
   main, which redeploys the backend."** End it with
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
e. Do not use the change in this run. It applies after it is merged.

### 8. Report

End with a short report: files read; per quote, lines settled by rules /
judged / left as questions; PRs opened or merged; anything that failed.
Plain words, no secrets.

## Learned rules

Rules learned from quotes, each with the date and the quote it came from.
Add here (through step 7) only what is general.

- 2026-11-17: A "box of N pieces" with no stated unit is priced per box (HK Trading).
- 2026-11-17: When old and new prices are both printed, the new one is the price (Sakata via Printac).
- 2026-11-17: Plain "ART PAPER" is filed by CDC as Gloss Art unless it says matt (CDC bills).
