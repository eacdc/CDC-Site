# CDC Supplier Portal — frontend

React + Vite + Tailwind. Talks to the Supplier Portal API mounted at
`/api/supplier-portal` in the CDC backend (`eacdc/CDC-Site`).

## Running it

```sh
npm install
npm run dev          # http://localhost:5174, proxying /api to localhost:3001
```

Point the proxy elsewhere with `VITE_API_TARGET`. For a deployed build, set
`VITE_API_BASE` to the backend origin.

Without a backend to hand, `node .mock/server.mjs` serves enough fixture data
to render every screen.

```sh
npm run build        # static files in dist/
npm run lint
```

## Screens

| Route | What it is for |
|---|---|
| `/items` | Search, then the item detail — the centrepiece |
| `/quotes` | Upload, and the review screen where rates are approved |
| `/mapping` | The keyboard-driven mapping queue |
| `/suppliers` | Grouping ERP ledgers into suppliers |
| `/po-check` | POs needing attention, and POs overtaken by newer quotes |
| `/receiving` | Tablet capture through to a posted voucher |
| `/reports` | The seven reports, all exportable |

## Three things that shape the interface

**Plant is never implicit.** Rates differ materially between Kolkata and
Ahmedabad — NR Agarwal quotes them about ₹4,000/MT apart for the same grade —
and a supplier will often quote only one. Every screen showing a rate names its
plant, and three states are kept visibly distinct:

| State | Shown as | Means |
|---|---|---|
| Quoted | the rate | a current rate exists here |
| Not at this plant | "— not quoted (Kolkata only)" | ask this supplier for a rate here |
| Not quoted | blank | this supplier has never quoted it |

Only the middle one is actionable, and collapsing it into a blank would lose
the one row worth chasing.

**Red is BLOCK, amber is WARN, and nothing else uses either.** No colour-coding
by supplier or category — it would drown the one signal that has to be seen. A
blocking check says on its face that it cannot be overridden; a warning takes a
typed reason, because the point of an override is the sentence, not the click.

**Density over whitespace.** 13px base, tabular figures, sticky headers, CSV on
every table. This is a tool used all day by people who already know what they
are looking at. The exception is Receiving, which is a separate tablet layout:
large targets, camera first, one decision per screen.

## Conventions

- Currency `₹1,23,456.78`, dates `DD-MMM-YYYY`, both fixed rather than
  locale-driven — one office reading one set of numbers.
- The API client sends `X-SP-Site` on every request. The backend refuses
  anything that does not say which database it means, and switching site
  reloads rather than re-rendering: every ItemID and LedgerID on screen belongs
  to the old one.
- API errors carry their validation checks through to the UI, so a blocked
  action can say which check blocked it.

## Not built yet

- **M6 PO creation** — Phase 4, explicitly the lowest priority. A wrong PO is a
  commitment to a vendor with money attached.
- **M7 supplier-facing screens** — the backend's separate identity space and
  auth exist; the supplier's own views do not.
- Receiving covers capture, extraction, matching, checks and posting. The post
  itself is gated server-side behind `SP_ENABLE_ERP_WRITES`; until that is on,
  "Preview what would be written" returns the exact rows for review.

## Status

Every screen has been rendered and walked through against fixture data. Nothing
here has been exercised against a live backend, a real MongoDB or the ERP — see
`docs/SUPPLIER_PORTAL.md` in the backend repo for what still needs verifying
before Phase 3 goes live.
