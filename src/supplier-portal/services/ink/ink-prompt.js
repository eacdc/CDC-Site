/**
 * What the model is told before it reads an ink quote.
 *
 * The rules below are not general advice. Each one is a mistake that a real
 * document in CDC's July 2026 set invites, written so the model does not have
 * to rediscover it: DIC calling coatings "ink", pack size masquerading as the
 * rate unit, a plate cleaner that is not a plate.
 *
 * The canonical vocabulary is INJECTED rather than offered as a tool call. It
 * is small, it is needed on every single line, and a tool round trip to fetch
 * a list of twenty colours would cost more than sending it.
 */

import {
  MATERIAL_CLASSES, CHEMISTRIES, INK_ROLES, COLOURS, COATING_FINISHES,
  CHEMICAL_FUNCTIONS, RATE_UOMS,
} from '../../config/ink-vocabulary.js';

export const INK_SYSTEM_PROMPT = `You read supplier quotations for printing ink, coating, press chemicals, plates and pressroom consumables for CDC Printers, a Kolkata carton printer.

Your job is not to fill in a form. It is to understand the document, say plainly what you understood, and be honest about what you could not determine. Something you cannot tell is a question, never a guess: a wrong value here merges two products into one price comparison and nothing in the result will ever show that it happened.

Reply with JSON only, in the shape you are given.`;

/** The payload shape, described once and shown to the model verbatim. */
export const INK_PAYLOAD_SHAPE = `{
  "understanding": "two or three sentences: whose quote this is, what it covers, how it is laid out",
  "notes": ["anything worth a reviewer's attention"],
  "rowsSeen": 21,
  "payload": {
    "supplierName": "as printed on the letterhead",
    "supplierGstin": null,
    "supplierIsDealer": true,
    "listContext": "the document's own description of itself",
    "plant": "KOLKATA" | "AHMEDABAD" | null,
    "effectiveFrom": "YYYY-MM-DD or as printed",
    "effectiveTo": null,
    "commercialTerms": { "creditDays": null, "freightTerms": null, "insurance": null, "gstNote": null, "paymentTerms": null },
    "statedRules": [{ "kind": "GST", "text": "GST will be charged extra as applicable", "value": null }],
    "lines": [{
      "lineNo": 1,
      "productName": "exactly as printed",
      "productCode": "the maker's code, if the document prints one",
      "section": "the heading this row sits under, verbatim",
      "materialClass": "INK | COATING | PRESS_CHEMICAL | PLATE | CONSUMABLE, or null",
      "chemistry": "UV | CONVENTIONAL | WEB | ADDITIVE | WATER_BASED, or null",
      "role": "PRESS_READY | MIXING_BASE | EXTENDER | MEDIUM, or null",
      "colour": "canonical colour for ink, else null",
      "baseNumber": "the Pantone base number for a mixing base, else null",
      "finish": "canonical finish for a coating, else null",
      "chemicalFunction": "canonical function for a press chemical, else null",
      "manufacturer": "who makes it, often only in a section heading",
      "family": "the product range: Sicura Plast 770HS, Vega Sprint, Radicure Intense 9000",
      "rateText": "the price exactly as printed",
      "rate": 830,
      "rateUom": "KG | LTR | PC | M2 | UNIT, or null",
      "pack": { "size": 20, "uom": "LTR" },
      "plate": { "lengthMm": 790, "widthMm": 1030, "thicknessMm": 0.28, "ratePerSqm": 470 },
      "previousRate": null,
      "confidence": 0.9
    }]
  }
}`;

export const INK_RULES = [
  `1. NEVER GUESS. A field you cannot determine from the document is null. Someone at CDC will be asked, and their answer is kept forever, so an honest null costs one question once. A confident wrong answer costs a comparison nobody knows is broken.`,

  `2. THE PRICE IS PER SOMETHING, AND THE PACK IS SOMETHING ELSE. "ECNO WASH KR (20 LTR)" priced at 220 under a heading reading "RATE PER LTR." is 220 per litre. The can holds 20 litres and costs 4,400. Put 220 in "rate", "LTR" in "rateUom", and { "size": 20, "uom": "LTR" } in "pack". Never put 20 in rateUom and never divide the rate by the pack.`,

  `3. A SECTION HEADING APPLIES TO EVERY ROW UNDER IT, until the next heading. On a dealer's quotation the maker and the rate unit appear ONLY there — "DIC UV INK / RATE PER KGS", then twenty rows that say neither. Copy the heading into each row's "section" field verbatim, and also fill in what it tells you.`,

  `4. A ROW BEATS ITS HEADING. "ANTI SET OFF VERN POWDER 375.00/KG" sits under a per-litre heading and says otherwise. The row is right.`,

  `5. SOME COATINGS ARE CALLED INK. DIC names its aqueous overprint coatings "OP INK" — "AQUATIC ECO SMART OP INK", "NEUTRAL SEALER AQUATIC OP INK". OP means overprint. These are COATING with chemistry WATER_BASED, not ink.`,

  `6. WATER-BASED INK IS CONVENTIONAL INK. CDC compares it that way. Use WATER_BASED only for coatings. A water-based ink such as "WB CDC SPL BLACK" is materialClass INK, chemistry CONVENTIONAL.`,

  `7. A PLATE CLEANER IS NOT A PLATE. "PLATE CLEANER GP (5 LTR)" is a PRESS_CHEMICAL. A plate is the thing you print from, priced per piece by its dimensions.`,

  `8. A PASTE IS USUALLY A MIXING BASE, BUT NOT ALWAYS. "VEGA PRIME PROCESS BLACK PASTE 706" is a Pantone mixing base — role MIXING_BASE, baseNumber "706". "SICURA ANTI SCUMMING PASTE" is an additive that happens to be a paste — chemistry ADDITIVE, role PRESS_READY. A mixing base and a press-ready ink of the same colour are never alternatives to each other, so this distinction changes what gets compared.`,

  `9. A TACK REDUCER GOES INTO THE INK. "UV LIQUID TACK REDUCER" is materialClass INK, chemistry ADDITIVE — not a solvent. A plain "REDUCER" listed among the press chemicals is a PRESS_CHEMICAL with function SOLVENT.`,

  `10. PLATES ARE PRICED BY AREA. A heading like "(470.00/m²)" and rows reading "790 x 1030 x 0.28mm  382.44" means the rate per piece is the area times the rate per m². Record both: the piece rate in "rate" with rateUom "PC", and the dimensions and rate per m² in "plate".`,

  `11. WHERE A DOCUMENT ANNOUNCES A FUTURE PRICE, quote the one CDC will pay. A sheet with "Current Price" and "Price after increase" columns: use the post-increase figure as "rate" and put the current one in "previousRate". If the post-increase column is empty for a row, the current price is the rate. A rate of 0 is not a price — leave "rate" null and say so in notes.`,

  `12. THE MAKER IS NOT THE SUPPLIER. Print Sales is a dealer selling DIC, Boettcher and Capri products. "supplierName" is who sent the quote; "manufacturer" is who makes the row. Set "supplierIsDealer" accordingly.`,

  `13. READ EVERY PRICED ROW. A price list with sixty rows produces sixty lines. Do not summarise, sample, or collapse rows that look similar — two rows with the same product name and different prices are two rows, and a reviewer needs to see both to know something is odd.`,

  `14. COUNT THE PRICED ROWS FIRST, before you transcribe any of them, and put that number in "rowsSeen". Then return one line per row. If the two numbers do not match, the difference is reported to a person, so an honest count that exposes a short reading is far more useful than one that agrees with what you wrote.`,
];

/**
 * Assemble the message for one turn.
 *
 * Everything the model needs and nothing it does not: the canonical vocabulary,
 * what CDC has already taught about this supplier, how their last quote was
 * read, the answers just given, and — on a repair round — exactly what failed.
 */
export function buildInkMessage({
  knownTerms = [],
  previousSummary = null,
  answers = [],
  textLayer = null,
  repairErrors = [],
  page = null,
  pageCount = null,
  sectionInForce = null,
} = {}) {
  const parts = [];

  /*
    A long price list is read one page at a time, and the model has to be told
    which page it is looking at or it will describe the whole document from a
    single image and quietly stop partway.
  */
  if (page && pageCount > 1) {
    parts.push(`THIS IS PAGE ${page} OF ${pageCount}. Read every priced row on THIS page and no others. Do not summarise, and do not stop early: if the page holds twenty rows, return twenty lines.`);

    /*
      A section heading does not stop at a page break. Print Sales' press
      chemicals run over two pages and the second page's rows carry no heading
      of their own — read alone, every one of them loses its rate unit.
    */
    if (sectionInForce) {
      parts.push(`The heading still in force from the previous page is "${sectionInForce}". Rows on this page that sit under no new heading belong to it.`);
    }
  }

  parts.push('CANONICAL VALUES. Use these exact strings. Anything outside them is rejected.');
  parts.push(`materialClass: ${MATERIAL_CLASSES.map((c) => c.canonical).join(', ')}`);
  parts.push(`chemistry: ${CHEMISTRIES.map((c) => c.canonical).join(', ')}`);
  parts.push(`role: ${INK_ROLES.map((r) => r.canonical).join(', ')}`);
  parts.push(`colour: ${COLOURS.map((c) => c.canonical).join(', ')}`);
  parts.push(`finish: ${COATING_FINISHES.map((f) => f.canonical).join(', ')}`);
  parts.push(`chemicalFunction: ${CHEMICAL_FUNCTIONS.map((f) => f.canonical).join(', ')}`);
  parts.push(`rateUom: ${RATE_UOMS.join(', ')}`);

  if (knownTerms.length) {
    parts.push('\nWHAT CDC HAS ALREADY CONFIRMED for this supplier. Treat these as settled facts.');
    for (const t of knownTerms) {
      parts.push(`  ${t.subject} -> ${t.field}: ${t.value}`);
    }
  }

  if (previousSummary) {
    parts.push('\nHOW THIS SUPPLIER\'S LAST QUOTE WAS READ. Their format rarely changes; this is usually the same document with new prices.');
    parts.push(previousSummary);
  }

  if (answers.length) {
    parts.push('\nANSWERS JUST GIVEN by someone at CDC. These are authoritative — do not revisit them.');
    for (const a of answers) {
      parts.push(`  ${a.subject || a.token}: ${a.value ?? a.text ?? ''}`);
    }
  }

  if (repairErrors.length) {
    /*
      A repair round is not a fresh reading. Say what failed and where, so the
      model changes the field that broke rather than re-reading the document and
      quietly revising rows that were already right.
    */
    parts.push('\nYOUR LAST REPLY DID NOT VALIDATE. Fix exactly these and change nothing else:');
    for (const e of repairErrors) parts.push(`  ${e.path}: ${e.message}`);
  }

  parts.push(`\nRULES.\n${INK_RULES.join('\n\n')}`);

  /*
    A STRING, and it has to be one.

    This was handed the whole `pdfPageTexts` result — an object — and pushed
    straight into the message, where it rendered as "[object Object]". So the
    reading had no text layer at all and worked from the page images alone,
    which is exactly the condition under which rows get missed.
  */
  const layer = typeof textLayer === 'string' ? textLayer : textLayer?.text;
  if (layer) {
    parts.push('\nTHE TEXT LAYER FOR THIS PAGE, exact characters. The image shows the layout; this shows the spelling. Where they disagree about a character, trust this; where they disagree about which heading a row sits under, trust the image.');
    parts.push(layer);
  }

  parts.push(`\nREPLY IN THIS SHAPE:\n${INK_PAYLOAD_SHAPE}`);

  return parts.join('\n');
}
