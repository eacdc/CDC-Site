# Paper and board

How CDC's paper quotes are read, normalised and compared. Written down because
the rules in it are CDC's domain knowledge, not the code's, and because the
architecture note (`docs/SUPPLIER_PORTAL.md`) covers the portal's shape and says
nothing about paper.

Everything here was derived from CDC's active item master and eight quotes
received in August 2026. Every example is verbatim from a real document.

---

## The goal, in one sentence

Read a supplier's quote, work out what it is in CDC's terms, and put it beside
the other suppliers' quotes for the same paper.

That last part is the whole difficulty. Four suppliers quoting the same grey
back write it four different ways, and no two of the spellings share a substring.

---

## Why paper needed its own treatment

The general extraction path flattened a board line into a product name —
`NR MAXIMA SS (REEL) - 84B` — and then tried to recover the specification by
fuzzy-matching that string. Nothing can be searched or compared that way, and
every fix made the prompt longer while still missing the next document.

A board is not a product with a name. It is a mill, a grade, a form, a shade and
a GSM band, and each of those is a field.

---

## The evidence base

| Document | Shape | What it taught |
|---|---|---|
| Sudarshan Recycled | enumerated rows | states type in the name (`GB`, `WB`) |
| Sudarshan Virgin | enumerated rows | states type **nowhere**, ~28 products |
| Sudarshan Maplitho | enumerated rows | `NS` priced at +₹2.00/kg |
| Sudarshan Coated | enumerated rows | `C2S GLOSS` / `C2S MATT` |
| Krishna Vanijya | section headings | headings orphan their rows in the text layer |
| AKT | handwritten photo | mill-order vs ex-stock, no GSM at all |
| NR mill sheet | side-by-side plants | two rate columns, one set of bands |
| Natraj / Madhubati | base + rules | four stated prices, ~30 real ones |

Four distinct document shapes. Any design that only handles one of them is
wrong, and the fourth — base plus derivation rules — is the one that breaks a
row-by-row reader entirely.

---

## What is priced

Established from the documents, not assumed. Each of these was confirmed by
finding the same product quoted two ways with a consistent gap:

| Attribute | Evidence |
|---|---|
| **Form** — sheet vs reel | +₹3.00/kg on eleven Sudarshan pairs; +₹3.50 AKT; NR states +1.00 |
| **Shade** — natural vs default | +₹2.00/kg across every band of Century Dazzle |
| **BF** — kraft only | Natraj +₹1.25 for 2 points; Madhubati +₹0.50 |
| **Back** — grey vs white | ₹6.00/kg, Bahl, same section of the same list |
| **Supply mode** — mill order vs ex-stock | ₹0.50/kg, AKT, every product priced twice |
| **Bulk** — high vs default | separate products on Sudarshan's lists |

Explicitly **not** priced, confirmed by CDC:

- **Width / sheet size** — no effect on rate
- **FSC certification** — no effect on rate
- **Surface sizing** — SS and non-SS are interchangeable for CDC

Surface sizing is still recorded, because a row reading `NON SS` should not be
filed as though the document said nothing. It is simply not part of the
comparison key.

---

## The vocabulary

Three kinds of knowledge, deliberately kept apart. Collapsing them would make
"Prima" mean FBB on a maplitho list.

### 1. Type synonyms — words that *mean* the type

Universal and permanent. `offset` is maplitho for every supplier, forever.

| Canonical | Written as |
|---|---|
| `MAPLITHO` | maplitho, offset, woodfree, uncoated, SSP, MAP |
| `FBB` | FBB, GC1, GC2, folding box board |
| `CBB` | CBB, SBS |
| `GREY_BACK` | grey back, GB, PGB, duplex¹ |
| `WHITE_BACK` | white back, WB, DSWB |
| `GLOSS_ART` | gloss art, C2S gloss, ABG |
| `MATTE_ART` | matte art, C2S matt |
| `CHROMO` | chromo, C1S |
| `KRAFT` | kraft |

Plus `KRAFT_BOARD`, `MILL_BOARD`, `MG_BOARD`, `NEWSPRINT`, `BIBLE_PAPER`,
`CARRY_BAG`, `GUMMING_SHEET`, `SPECIALTY`.

¹ **Duplex is not a plain synonym.** It is the trade's casual word for
*recycled*, and both backs are duplex. It narrows rather than decides:

```
duplex, and nothing else       -> grey back
duplex alongside "white back"  -> white back
```

KV's list is the shape that punishes getting this wrong: one section headed
`DUPLEX BOARD` holding `BAHL GREY BACK 1000` at 49.50 beside
`BAHL WHITE BACK 1000` at 55.50.

### 2. Brand mappings — products that *happen to be* that type

Facts about products, confirmed one at a time. `ITC CARTE LUMINA` is CBB because
ITC makes it that way, not because the words mean anything.

Only three are seeded — the ITC products sold through both Sudarshan and KV,
which are the first real cross-supplier comparison available. Everything else is
learned through the conversation, because Sudarshan's Virgin list states a type
for none of its ~28 products and that is a conversation to have once rather than
a table to write blind.

### 3. Attribute markers — modifiers that change price, not type

**The collision that shapes the implementation:**

```
NS    natural shade         CENTURY DAZZLE PRINT NS        +Rs 2.00/kg
NSS   non surface sized     SIRPUR NSS MAPLITHO (NON SS)   -Rs 1.00/kg
```

One letter apart, opposite kinds of thing, opposite price directions. Everything
is matched as a **whole word** after punctuation is stripped, longest needle
first, and surface sizing resolves before shade so `NSS` is claimed before `NS`
can reach it.

Also: `RBD` = sheet, `RLS` = reel — CDC's own ERP vocabulary, printed directly
by suppliers. `HB` / `HI-BULK` = high bulk.

### Mills need their own table

This was the surprise, and the inconsistency is inside CDC's ERP rather than in
supplier documents:

```
Dev Priya / Devpriya        SAHOTA / SAHUTA         Bhal / BAHL
Silvertone / Silverton      BILT / Ballarpur        Sidhartha / SIDHARTH
AprilFine / Imported (April Fine) / Importet - April
```

`Importet` is a typo entered hundreds of times. `Local` and `Imported` are kept
**out** — they are origins, not mills, and treating them as mills would pool
every importer's stock into one supplier.

Khanna is one mill; `OGB` and `GSP` are its grades.

---

## What we refuse to guess

`DCB` · `LWC` · `PDB` · `HI KOTE` · `DIGIEDGE ABG`

These appear in real data and resolve to `null`. `DCB` is priced a rupee below
`PGB` on the same handwritten note, which makes "grey back variant" plausible —
and plausible is exactly when guessing is most tempting and most dangerous,
because **a wrong mapping merges two different papers into one comparison and
nothing in the result shows it happened.** An unrecognised grade is visible; a
wrongly recognised one is not.

The list is meant to shrink. `PGB` and `DSWB` started on it and moved into the
tables when CDC said what they meant. That is the intended workflow.

---

## How a quote is read

```
upload -> INTERPRETING -> NEEDS_INPUT <-> INTERPRETING -> INTERPRETED -> pipeline
```

The interpreting layer is a conversation, not a form. It reads the document,
says what it understood, asks about what it could not determine, and repeats.
A form asks the same fixed questions of every supplier; a conversation asks the
question that actually matters for this document.

### Three exits, one of them the model's

| Stage | Meaning | Action |
|---|---|---|
| `INVALID` | doesn't fit the schema | model told exactly what failed; repairs, max twice |
| `INCOMPLETE` | fits, something unknown | **a person's question** — no model call |
| `READY` | both pass | hands off to storage |

Spending a model call on `INCOMPLETE` would be asking it to invent what it
correctly declined to guess.

### Most answers never reach the model

The commonest question is *"what paper type is this brand?"*, and its answer is
a fact, not a judgement. Folding it in is a loop over lines — no round trip, no
cost, and no opportunity for the model to revise a line nobody asked about.

**A second round with structured answers costs zero model calls.** Only
free-form answers ("all the Century ones are FBB") go back for another reading.

One brand answer settles every line of that brand: both forms, every GSM band,
this month and next. That is why questions are grouped by brand rather than
listed per row — eighteen untyped lines off the Virgin list become **seven**
questions.

### The gate

Two separate questions, and the separation is the design:

- `validatePaperQuote` — is this structurally sound?
- `assessReadiness` — is this finished?

**A line with no paper type is VALID and NOT READY.** A schema that rejected
Sudarshan's Virgin list outright would leave the agent nothing to show and
nothing to ask about. The payload survives so the gaps can be named.

Nothing reaches storage without passing both.

### What is printed is never discarded

Every interpreted value keeps the text it came from — `rate` beside `rateText`,
`gsmFrom`/`gsmTo` beside `gsmText`. A reviewer checking `115 & ABOVE` against
`115`/`null` can see both, and a misreading is visible rather than inferred.

---

## Derived rates

The kraft quote states four prices and implies about thirty:

```
Natraj    18 BF, 140-180 GSM, NS  @ 30.80
120 GSM      +0.25
100 GSM      +1.50 Natraj / +1.75 Madhubati    <- mill-specific
SONY GOLD    +1.50
```

These are **expanded into concrete rows at interpretation**, each carrying its
arithmetic:

```
31.05 = 30.8 (18 BF, 140-180 gsm) + 0.25 for 120 gsm
```

Search then stays a plain lookup with no rule engine at query time, comparison
against enumerated suppliers is like-for-like, and a mis-read rule is caught
once by a human at review rather than silently on every future search.

**Expansion never extrapolates past what the rules reach.** Madhubati's base
band is `140 GSM` only; whether `181-200 +0.50` applies to it is not stated, so
it is flagged rather than invented.

---

## The comparison this exists for

Sudarshan and Krishna Vanijya both sell the same ITC products. Neither list
calls any of them by a paper type:

| Product | Type | Sudarshan sheet | KV sheet |
|---|---|---|---|
| ITC Carte Lumina | CBB | 80.50 | 81.00 |
| ITC Cyber XL Pac | FBB | 79.50 | 80.00 |
| ITC Pearl XL Pac | FBB | 78.50 | 79.00 |

Fifty paise on ₹/kg is ₹500 a tonne. And within one Sudarshan list, grey back
at 280gsm ranges 42.00 to 54.00 — a 28% spread on the same paper at the same
weight.

---

## Files

| File | What it holds |
|---|---|
| `config/paper-vocabulary.js` | the three tables, mills, and the unconfirmed list |
| `services/paper/paper-quote-schema.js` | the gate — validity and readiness |
| `services/paper/paper-prompt.js` | the interpretation prompt and context builder |
| `services/paper/interpreter.js` | the loop, answer folding, learned rules |

Tests: `tests/paper-vocabulary.test.js`, `tests/paper-quote-schema.test.js`,
`tests/paper-interpreter.test.js`. The model is injected, so all of them run
without a key or a network.

---

## Extending it

**A new spelling of a known type** — add it to `synonyms` in
`config/paper-vocabulary.js`. Whole-word matched, so short abbreviations are
safe.

**A confirmed abbreviation** — move it out of `UNCONFIRMED` and into the table
it belongs to, with a comment naming who confirmed it.

**A new brand** — do not add it by hand. Answer the question when the portal
asks, and it becomes a supplier-scoped rule automatically.

**Rules are supplier-scoped by default.** "DO" means one thing on AKT's note and
could mean another elsewhere. Promoting a rule to global should be a deliberate
second act.

---

## Still open

- `DCB`, `LWC`, `PDB`, `HI KOTE`, `DIGIEDGE ABG` — meanings unconfirmed
- `Emami` / `Emami Solitaire` — one mill or two?
- `IK`, `NEVIA`, `GOLDEN COIN LUXE` — mills or brands? All three head KV sections
- KV states no form on its own products; CDC confirmed its prices are sheet, but
  the document does not say so and a future KV list might differ
- Madhubati's GSM coverage above 140

## Not yet built

The OpenAI adapter (`send`), conversation state on the document, the routes and
the review screen. The interpreting layer has never run against a live model —
every test stubs it.
