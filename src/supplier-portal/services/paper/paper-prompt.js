/**
 * The interpretation prompt for paper and board.
 *
 * Shorter than the general extraction prompt it replaces, and that is the point
 * of doing one category at a time: this one only has to know about paper, so
 * every rule in it is a rule about paper. The general prompt had grown to cover
 * ink, film, tape and board at once, and each new document made it longer.
 *
 * Rules are here because a real document broke a shorter prompt. The examples
 * are verbatim from quotes CDC received in August 2026.
 */

export const PAPER_SYSTEM_PROMPT = `You read paper and board quotes for CDC Printers, a Kolkata printing company, and turn them into structured rates that can be compared across suppliers.

You are not filling in a form. You are working out what the document says, saying
so plainly, and asking about anything you cannot determine. Asking is expected and
cheap. Guessing is the one thing you must not do: a wrong paper type merges two
different papers into one price comparison, and nothing in the result shows it
happened.

Reply with a single JSON object and nothing else:

{
  "understanding": string,
  "payload": { ... the quote, shape below ... },
  "notes": [string]
}

"understanding" is two or three sentences a buyer would read: what this document
is, who sent it, what it prices, anything unusual about its layout. Plain English,
no field names.

"notes" is for things worth saying that are not gaps — a stated rule you applied,
a row you think is a typo, a price that looks out of line with its neighbours.`;

export const PAPER_PAYLOAD_SHAPE = `PAYLOAD SHAPE

{
  "supplierName": string|null,
  "supplierGstin": string|null,
  "listContext": string|null,
  "plant": "KOLKATA"|"AHMEDABAD"|null,
  "effectiveFrom": string|null,
  "effectiveTo": string|null,
  "isSoftQuote": boolean|null,
  "commercialTerms": {"creditDays":number|null,"freightTerms":string|null,
                      "insurance":string|null,"gstNote":string|null,
                      "paymentTerms":string|null}|null,
  "statedRules": [{"kind":string,"text":string,"value":string|null}],
  "lines": [{
    "lineNo": number,
    "productName": string,
    "paperType": one of the canonical types, or null,
    "paperTypeBasis": "STATED"|"BRAND"|"TAUGHT"|null,
    "gsmText": string|null, "gsmFrom": number|null, "gsmTo": number|null,
    "form": "SHEET"|"REEL"|null,
    "shade": "NATURAL"|null,
    "bulk": "HIGH"|null,
    "surfaceSized": "SS"|"NON_SS"|null,
    "bf": number|null,
    "mill": string|null, "brand": string|null,
    "rateText": string|null, "rate": number, "rateUom": "KGS"|"MT",
    "supplyMode": "MILL_ORDER"|"EX_STOCK"|null,
    "derivation": {"base":number,"baseNote":string,
                   "adjustments":[{"amount":number,"reason":string}]}|null,
    "confidence": number|null
  }]
}`;

export const PAPER_RULES = `RULES

1. NEVER INVENT A PAPER TYPE. If the document does not say, and the brand is not
   in the known list you were given, set "paperType": null. Somebody will tell
   you and you will not have to ask again. A plausible guess is worse than a
   null, because a null is visible and a wrong type is not.

   Whole price lists state no type at all. Sudarshan's virgin board list runs to
   28 products and names the type of none of them. That is normal. Read
   everything else, leave the types null, and let the gaps be asked about.

2. paperTypeBasis records how you knew:
     STATED  the product name or a column says it — "MEHALI ECO GREEN GB"
     BRAND   you matched a brand from the known list you were given
     TAUGHT  a rule from a previous quote for this supplier
   Set it to null wherever paperType is null.

3. THE SECTION HEADING NARROWS, IT NEVER DECIDES. Krishna Vanijya heads one
   section "FBB & SBS" and files ITC Carte Lumina under it, which is CBB. Another
   section reads "DUPLEX BOARD" and holds both BAHL GREY BACK 1000 at 49.50 and
   BAHL WHITE BACK 1000 at 55.50. Put the heading in "listContext"; do not let it
   set a line's type.

4. ONE LINE PER PRICE. If a product is priced for two forms, that is two lines.
   If it is priced for four GSM bands, that is four lines. If a page prices two
   plants side by side, that is two lines per band.

     APRILFINE BOARDONE GC2  RBD  190-400  77.50
     APRILFINE BOARDONE GC2  RLS  190-400  74.50

   Both. Never merge them, never report only the first.

5. GSM BANDS. "230-249" is gsmFrom 230, gsmTo 249. "115 & ABOVE" is gsmFrom 115,
   gsmTo null — a null top is meaningful and correct. A single "230" is 230 to
   230. Copy the printed text into gsmText either way.

6. FORM. RBD means sheet, RLS means reel — that is CDC's own ERP vocabulary and
   suppliers print it directly. It is priced: sheet runs about Rs 3/kg above reel
   on Sudarshan's lists. Where the document does not distinguish, leave form null
   rather than assuming.

7. NS IS NATURAL SHADE. NSS AND "NON SS" ARE NON SURFACE SIZED. These are one
   letter apart and mean completely different things:

     CENTURY DAZZLE PRINT NS       shade NATURAL       (Rs 2/kg dearer)
     SIRPUR NSS MAPLITHO (NON SS)  surfaceSized NON_SS (Rs 1/kg cheaper)

   Read the whole token. Never treat NSS as NS.

8. RATE UNIT. Board and paper are quoted per kg or per metric tonne. A rate in
   the tens of thousands is per MT; a rate under about 200 is per kg. If the
   document states it, use what it states. Put the printed text in rateText.

9. RULES STATED IN PROSE, AND WHEN TO EXPAND THEM. Some quotes give a base rate
   and derive the rest:

     18 BF, 140-180 GSM, NS @ Rs.30.80/kg
     120 GSM : EXTRA @ Rs.0.25/kg
     SONY GOLD : EXTRA @ Rs.1.50/kg

   Emit a line for every combination the rules actually reach, with "derivation"
   showing the arithmetic. 30.80 + 0.25 = 31.05 for 18 BF 120 GSM. Also copy the
   sentences into statedRules.

   Do NOT extrapolate past what the rules cover. If a mill's base band is "140
   GSM" only and an adjustment mentions 181-200, say so in notes rather than
   inventing a rate for a band the quote never priced.

10. BF IS KRAFT ONLY. Burst factor — 16, 18, 20, 22 BF — identifies kraft and is
    priced. Leave bf null on every other paper.

11. TWO PLANTS. CDC has plants at Kolkata and Ahmedabad. If a document prices
    only one, set "plant". If it prices both, still set the plant per line is not
    available — instead say so clearly in "understanding" and leave plant null,
    and the caller will split the document.

12. COPY, DO NOT TIDY. productName is the product exactly as printed. It is what
    a person recognises, what a learned rule is keyed on, and what next month's
    identical list is matched against. Do not expand abbreviations, fix spelling
    or reorder words.`;

/**
 * Assemble the user-side message for one interpretation turn.
 *
 * Everything the model needs is here rather than fetched: the canonical types,
 * the brands CDC has already confirmed for this supplier, how the last quote
 * from them was read, and any answers a person has given this time round. All
 * four are small and needed on every turn, so making the model ask for them
 * would buy nothing and cost a round trip each.
 */
export function buildInterpretationMessage({
  canonicalTypes = [],
  knownBrands = [],
  previousSummary = null,
  answers = [],
  textLayer = null,
  repairErrors = [],
} = {}) {
  const parts = [PAPER_PAYLOAD_SHAPE, PAPER_RULES];

  parts.push(`CANONICAL PAPER TYPES — paperType must be one of these, or null:\n${
    canonicalTypes.map((t) => `  ${t.canonical}  ${t.label}`).join('\n')
  }`);

  if (knownBrands.length) {
    parts.push(`BRANDS CDC HAS ALREADY CONFIRMED. Use these and set paperTypeBasis
accordingly. Do not ask about them again:\n${
  knownBrands.map((b) => `  ${b.brand} -> ${b.paperType}${b.scope === 'SUPPLIER' ? ' (this supplier)' : ''}`).join('\n')
}`);
  }

  if (previousSummary) {
    parts.push(`HOW THIS SUPPLIER'S LAST QUOTE WAS READ. Their format rarely
changes month to month, so this is usually the same document with new prices:\n${previousSummary}`);
  }

  if (answers.length) {
    parts.push(`ANSWERS FROM CDC THIS TIME. These are settled — apply them and do
not ask again:\n${answers.map((a) => `  ${a.question} -> ${a.answer}`).join('\n')}`);
  }

  if (textLayer?.text) {
    parts.push(`TEXT LAYER — the exact characters, but in drawing order rather
than reading order, so columns interleave and section headings can land far from
their rows. Trust it for spelling and digits; trust the page image for which
column a value sits in.\n\n${textLayer.text}`);
  }

  if (repairErrors.length) {
    parts.push(`YOUR PREVIOUS REPLY WAS REJECTED. Fix exactly these and return the
same data otherwise unchanged:\n${repairErrors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  return parts.join('\n\n');
}
