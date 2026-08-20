# CDC Supplier Portal — backend

Rate capture, supplier-item matching, quote comparison, PO checking and
receiving. Mounted at `/api/supplier-portal` in this backend; the frontend
lives in its own repository.

## What is built

| Module | Status |
|---|---|
| M1 · Rate module — upload, extract, review, approve | Built |
| M2 · Matching engine — tiers 0–5, mapping queue | Built |
| M3 · Quote comparator — search, item detail, six reports | Built |
| M4 · PO checker — on demand and nightly sweep | Built |
| M5 · Invoice → GRN → PI | Built, **posting gated behind a flag** (see below) |
| M6 · PO creation | Not built — Phase 4, explicitly lowest priority |
| M7 · Supplier portal | Data layer and auth built; screens not built |

## The two rules that shape everything

1. **The ERP is the single source of truth and is never cached.** Item masters,
   ledgers, warehouses, HSN, stock and PO status are read live from MSSQL on
   every request. The masters grow constantly; a nightly sync would be wrong
   within hours.
2. **Mongo holds only what the ERP does not have** — quotes, extracted lines,
   supplier-item identities, mappings, rate history, queue state, audit.

## Two databases, one per site

| Site | Database | Plant |
|---|---|---|
| `KOL` | `IndusEnterprise` | KOLKATA (Tangra + Panchla) |
| `AHM` | `IndusEnterprise2` | AHMEDABAD |

Separate databases with separate ID spaces. `ItemID`, `LedgerID`,
`WarehouseID`, `UserID`, `ProductHSNID` and voucher sequences all differ.

- **No bare ERP id is stored in Mongo.** Every reference is `{site, itemId}` or
  `{site, ledgerId}`.
- **`site` never defaults.** `assertSite()` throws on a missing site rather than
  falling back to Kolkata — a silent default writes an Ahmedabad GRN into the
  wrong database and nothing downstream notices.
- Send the site as the `X-SP-Site` header or a `site` parameter on every request.

`CompanyID = 2` in both databases.

## Plant is a first-class dimension

Rates differ materially by plant and a supplier will often quote only one.
`rateHistory.plant` holds **one** plant; a document covering both writes two
rows per line at different rates. **Nothing falls back across plants.**

Three display states are kept distinct, because only one is actionable:

| State | Meaning | Shown as |
|---|---|---|
| `QUOTED` | a current rate exists here | the rate |
| `NOT_AT_PLANT` | quoted, but only at the other plant | "— not quoted (Kolkata only)" |
| `NOT_QUOTED` | never quoted this item | blank |

`NOT_AT_PLANT` feeds *"ask this supplier for an Ahmedabad rate"*, which is a
different request from *"your quote has expired"*.

## Environment

```sh
# Mongo — its own database, separate from the rest of the backend
MONGODB_URI_SupplierPortal=mongodb+srv://...

# MSSQL — reuses the backend's existing connection settings
DB_SERVER=...            # or DB_HOST
DB_PORT=1433
DB_USER=...              # read login
DB_PASSWORD=...
DB_NAME_KOL=IndusEnterprise
DB_NAME_AHM=IndusEnterprise2

# MSSQL write login — separate credentials, insert/update on the receiving
# tables only. Without these the portal refuses to write at all.
SP_DB_WRITE_USER=...
SP_DB_WRITE_PASSWORD=...

# ERP writes are OFF unless this is exactly "true".
SP_ENABLE_ERP_WRITES=false

# Extraction
EXTRACTION_PROVIDER=openai         # or "anthropic"
OPENAI_API_KEY=...
SP_EXTRACTION_MODEL=gpt-4o
ANTHROPIC_API_KEY=...              # only if using the anthropic provider

# Optional
SP_SESSION_DAYS=7
SP_DISABLE_JOBS=false
```

## Before Phase 3 (receiving) goes live

Posting is deliberately gated. To turn it on:

1. Get the MSSQL **write** credentials for both databases and set
   `SP_DB_WRITE_USER` / `SP_DB_WRITE_PASSWORD`. The write login should have
   insert/update on `ItemTransactionMain`, `ItemTransactionDetail`,
   `ItemPurchaseInvoiceMain`, `ItemPurchaseInvoiceDetail`,
   `ItemPurchaseInvoiceTaxes` and execute on `UPDATE_ITEM_STOCK_VALUES` —
   nothing else.
2. Run a post with `?dryRun=true`. It returns the exact rows that would be
   written, including the batch-number format and every zeroed column. Check
   them against a recent GRN in the ERP's own screens.
3. Only then set `SP_ENABLE_ERP_WRITES=true`.

**Also still needed for Ahmedabad**: the profiling queries in the build spec
have only been run against Kolkata. Re-run them against `IndusEnterprise2` and
record the warehouse list, employee ledgers, supplier ledger IDs and the
purchased-item universe. The code loads every ID at runtime, so nothing needs
changing — but supplier grouping needs seeding and the Ahmedabad mapping pass
needs sizing.

## Layout

```
src/supplier-portal/
  config/
    constants.js        ERP conventions, tolerances, ranking defaults
    validations.js      the check catalogue (EXT/MAP/PO/INV codes)
    uom-seed.js         every observed unit spelling
  db/
    mongo.js            own connection, model registry
    mssql.js            site-scoped read/write pools; site never defaults
  models/schemas.js     the 15 collections
  lib/
    uom.js              unit normalisation, pack parsing, magnitude guard
    text.js             name normalisation, token-set similarity
    spec.js             attribute tuples, GSM bands, spec keys
    invoice-math.js     freight apportionment, sheet↔kg
  services/
    erp-items.js        candidate universe, last-paid rate
    erp-ledgers.js      suppliers, employees, charge ledgers, warehouses
    erp-po.js           open POs, pending qty, delivery performance
    erp-voucher.js      MAX+1 allocation with UPDLOCK/HOLDLOCK
    erp-receiving.js    GRN + PI + PO closure (the only ERP writer)
    supplier-groups.js  many ledgers → one supplier
    quotes.js           upload → extract → review → approve
    matching.js         tiers 0–5
    comparator.js       search and item detail
    reports.js          the six reports
    po-check.js         M4
    invoice-checks.js   INV001–INV019
    extraction/         provider interface, OpenAI, Anthropic, XLSX
  routes/               one router per area, mounted in index.js
  jobs/index.js         delivery-date snapshot, nightly refresh
  tests/                84 tests over the pure logic
```

## Traps encoded in the code

Each of these is enforced or commented where it matters:

1. `ItemTransactionMain` has **no** `IsCancelled` column — referencing it throws.
2. GRN rate lives in `GrsRate`; `PurchaseRate` is 0 on GRN lines.
3. `ItemSubGroupMaster` joins on `ItemGroupNameID`, not `ItemGroupID`.
4. `ManufecturerItemCode` is always blank; `Manufecturer` means three different
   things by group.
5. `ItemType` and group-8 `Quality` carry no information.
6. `InkColour` and `PantoneCode` are frequently swapped — Pantone is extracted
   by regex over all three fields.
7. `BatchID` is the row's own `TransactionDetailID`, set after insert.
8. PI line `NetAmount` excludes apportioned freight. This is correct.
9. `MAX+1` numbering takes `UPDLOCK, HOLDLOCK` inside the insert transaction.
10. `UPDATE_ITEM_STOCK_VALUES` runs outside the transaction, best-effort.
11. Foil and film rates are stored per spec key, not per item.
12. `CDC Printers Pvt.Ltd.(Ahmedabad)` is an internal transfer, excluded from
    every benchmark.
13. Plant rates never fall back to the other plant.
14. Last-paid rate comes from PO lines only — GRN lines carry 0.
15. `ItemMaster` stock and rate columns are never read.

## One correction to the build spec

§12.6 gives the supplier-side sheet weight for 5500 × 585 × 915 × 90 gsm as
**264.41 kg**. Recomputing `5500 × 584.2 × 914.4 × 90 / 1e9` gives **264.425**.
The difference is 15 grams and changes no decision — both readings sit within
0.01% of the billed 264.44 — but the code implements the arithmetic rather than
the printed figure. Everything else in Part 2 reproduced exactly, including the
full freight trace (629.38 / 21,520.14 / 1,936.81 / 24,764.39).

## Tests

```sh
npm run test:supplier-portal    # 84 tests
npm test                        # the above plus the existing sql-guard tests
```

They cover the pure logic only — UOM and pack arithmetic, freight
apportionment against the verified reference invoice, the sheet↔kg
reconciliation, the full INV catalogue, the ten verified rate anchors, spec
keys and band containment, the PO checker, and worksheet column detection.

**Not covered**: anything requiring a live MongoDB or MSSQL connection. The
route layer, the Mongo writes and every ERP query are untested against a real
database — no MongoDB was available in the environment where this was written.
