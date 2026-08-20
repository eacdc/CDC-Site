/**
 * Extraction prompts.
 *
 * Shared by every provider. These encode CDC's document rules, not any one
 * vendor's quirks, so letting two providers keep their own copies would mean
 * two different extractors wearing the same name.
 *
 * They are long on purpose: every paragraph corresponds to a real document
 * from the August 2026 batch that broke a shorter prompt. The alternative to
 * stating a rule is a plausible wrong number that nobody catches.
 */

export const QUOTE_PROMPT = `You are reading a supplier price quotation sent to CDC Printers, a printing
company in Kolkata, India. Extract every priced line and the document's terms.

Return JSON only, matching this shape:
{
  "supplierName": string|null,
  "supplierGstin": string|null,
  "supplier": {"name":string|null,"gstin":string|null,"phone":string|null,
               "email":string|null,"address":string|null,"signatory":string|null,
               "foundIn":string|null},
  "addressedTo": {"company":string|null,"address":string|null,"gstin":string|null,
                  "attention":string|null},
  "subjectLine": string|null,
  "documentDate": string|null,
  "effectiveFrom": string|null,
  "effectiveTo": string|null,
  "isSoftQuote": boolean|null,
  "materialClass": "PAPER_BOARD"|"INK"|"FILM"|"ADHESIVE"|"PLATE"|"CHEMICAL"|"CONSUMABLE"|"OTHER"|null,
  "softQuoteEvidence": string|null,
  "plantMentions": string[]|null,
  "entityScope": string|null,
  "commercialTerms": {"creditDays":string|null,"freightTerms":string|null,"insurance":string|null,"gstNote":string|null,"paymentTerms":string|null}|null,
  "statedRules": [{"kind":string,"text":string,"value":string|null}]|null,
  "plantBlocks": [{"plant":string,"lineNos":number[]}]|null,
  "rateBasisNote": string|null,
  "lines": [{"lineNo":number,"productName":string|null,"productCode":string|null,
             "packSize":string|null,"uom":string|null,"rate":string|null,
             "gstNote":string|null,"gsmFrom":string|null,"gsmTo":string|null,
             "productForm":string|null,"width":string|null,"micron":string|null,
             "mill":string|null,"brand":string|null,"grade":string|null,
             "shade":string|null,"bulk":string|null,"brightness":string|null,
             "plant":string|null,
             "notes":string|null,"text":string|null,"confidence":number|null}]
}

RULES — these override any instinct to tidy the data:

0. FIRST DECIDE WHAT IS BEING BOUGHT, and put it in "materialClass". It changes
   which fields on a line carry the identity:

     PAPER_BOARD  board, paper, kraft, duplex — identified by mill, grade and a
                  GSM band, NOT by a product name. See rule 4a.
     INK          offset, UV, flexo inks and additives — colour and pack size.
     FILM         BOPP, PET, lamination and shrink films — type, micron, width.
     ADHESIVE     glues, gum, pasting compounds.
     PLATE        CTP plates, chemistry — size and gauge.
     CHEMICAL     fount, wash, varnish, coating.
     CONSUMABLE   tape, strapping, stretch film, stitching wire, cartons.
     OTHER        anything else, or a mixed quote covering several classes.

   Choose OTHER rather than guessing. A wrong class sends every line down the
   wrong reading rules, which is worse than no class at all.

A. IF YOU ARE GIVEN BOTH PAGE IMAGES AND A TEXT LAYER, USE BOTH, FOR DIFFERENT
   THINGS. The text layer has the exact characters — trust it for spelling and
   for digits. The IMAGE has the layout — trust it for which column a value is
   in, which heading a row belongs under, and where a table starts and stops.

   A PDF's text layer comes out in drawing order, not reading order, so a
   priced table arrives shuffled and with adjacent cells run together:

       QUALITY GSM SHADE BULK
       230-249 76112              <- this is GSM "230-249" and rate "76112",
                                     two columns, not one value
       NR POWER FOLD - FBB ...    <- the product for that row, printed far
                                     away in the stream

   Reading the text layer alone here produces nine lines all named
   "QUALITY GSM SHADE BULK" — the column headings mistaken for a product.
   NEVER take a product name from a heading row. If the only name you can
   find for a row is a column heading, look at the image again.

0. WHO SENT THIS, AND WHO IS IT ADDRESSED TO? Nobody will tell you — you must
   read it off the page. Both matter and they are easy to confuse.

   "supplier" is the company that WROTE the quote. Look at the letterhead, the
   footer, the signature block and any GSTIN that is not CDC's. A quote often
   names the sender only once, at the very bottom, above a phone number:

       Thanks and Best Regards
       Rina Das
       PRINT SALES PRIVATE LIMITED
       +91-7596986452

   That is supplier.name "PRINT SALES PRIVATE LIMITED", supplier.signatory
   "Rina Das", supplier.phone "+91-7596986452". Put a short note of where you
   found the name in "foundIn" — e.g. "signature block, page 3".

   "addressedTo" is CDC — the RECIPIENT. It usually appears near the top after
   "To". Copy the address exactly; it identifies which CDC plant the quote is
   for, so do not paraphrase or drop the street line:

       To
       CDC PRINTERS (P). LTD.
       45, Radhanath Chowdhuri Road
       Kolkata - 700015

   NEVER put CDC in "supplier". If the only company you can find is CDC, leave
   supplier.name null rather than guessing — a wrong supplier silently files
   the rates against the wrong company.

   A QUOTE NEED NOT HAVE A LETTERHEAD. Some arrive as a bare working sheet
   whose only sender marking is a title box at the top:

       ┌──────────────────────────┐
       │        SUDARSHAN         │
       └──────────────────────────┘
       Please find below the revised NR mill FBB rate for Ahmedabad

   "SUDARSHAN" is the supplier — foundIn "title box, page 1". A short trading
   name like this is normal and is enough; do not discard it for being
   incomplete, and do not expand it into a guessed legal name.

   DO NOT CONFUSE THE MILL WITH THE SUPPLIER. A trader quotes another
   company's product: "NR mill FBB rate" names the MANUFACTURER, not the
   sender. The mill belongs in each line's "mill" field. If the only name on
   the page is a mill named inside a sentence about the goods, leave
   supplier.name null.

1. EVERY NUMBER IS A STRING, copied exactly as printed. Do not convert
   "74,342" to 74342, do not turn "131.00/UNIT" into 131. Keep the currency
   symbol out but keep the digits, separators and any trailing unit text in
   "rate" if they are printed together.

2. NEVER TAKE THE UNIT FROM A COLUMN HEADER. A column headed "RATE PER LTR"
   frequently contains rows reading "131.00/UNIT", "160.00/PC" and "375.00/KG".
   Read the unit off each individual row. If a row states no unit at all, set
   "uom" to null — do not copy the header into it.

3. PACK SIZE OFTEN HIDES INSIDE THE PRODUCT NAME, not in a separate column:
   "Technomelt Q 970 - 26kg", "GI Wire 26(15 kg Spool)", "SKT XUV-225 RC (20)",
   "IPA 205 LTR", "UNI GUM (5 LTR)", "DEEP KLEEN SHAMPOO (500 ML)".
   Put the whole product name in "productName" AND repeat just the pack part
   in "packSize".

4. BAND PRICING. Some quotes price a GSM range rather than an item:
   separate "GSM FROM"/"GSM TO" columns, or text like "100-300", "115 & ABOVE",
   "54-55", "90+AB". Put the low end in "gsmFrom" and the high end in "gsmTo",
   exactly as printed. "115 & ABOVE" means gsmFrom "115", gsmTo null.

4a. PAPER AND BOARD QUOTES have their own vocabulary, and one row carries
   several independent facts. A typical board table:

       QUALITY              GSM      SHADE        BULK        RATE FOR 90 DAYS
       NR POWER FOLD - FBB  230-249  NATURAL FBB  1.40 - 1.45 76112
                            250-284                           75109
                            285-400                           74106
       NR PEARL PAC - SBS   230-249  BLUISH CBB   1.6         80124

   Read each of those into its own field:
     - "brand"   the trade name of the board: "POWER FOLD", "PEARL PAC".
     - "mill"    the manufacturer, often a prefix or a separate note: "NR".
     - "grade"   the board type: FBB, SBS, CBB, SBB, kraft, duplex, art paper,
                 maplitho. Take it from the quality name or the shade column.
     - "shade"   "NATURAL", "BLUISH", "WHITE".
     - "bulk"    the bulk figure, exactly as printed: "1.40 - 1.45", "1.6".
     - "brightness" the ISO brightness as printed: "84B", "88B", "90B". It is
                 part of the identity, not a note — NR MAXIMA 84B and NR SHINE
                 90B are different boards at different prices, and on some
                 quotes the brightness is the ONLY thing separating the blocks.
     - gsmFrom / gsmTo from the GSM band, per rule 4.
   Put the full quality string in "productName" as well: "NR POWER FOLD - FBB".

   MILL ORDER AND EX-STOCK ARE TWO PRICES, NOT ONE. Many board quotes price
   every item twice — "Devpriya PGB (Mill order) -> 48.25" against a "from
   stock" column reading 48.75. Emit a separate line for each and set
   "supplyMode" to what the document says ("Mill order", "from stock"). The
   heading often sits above a whole block; it applies to every row under it.
   Merging the two, or reporting only one, loses a real price.

   THE HEADING BAND IS NOT A PRODUCT. A block is often introduced by a line
   above or below the table — "NR MAXIMA SS (REEL) - 84B", "FOR KOLKATA -
   REEL" — and the table itself then shows only GSM and rate. Those headings
   are the brand, form and plant for every row of that block. Copy them onto
   each row. Never emit "QUALITY GSM SHADE BULK" or "RATE FOR 90 DAYS" as a
   product: those are column headings, and a row whose name is a heading means
   the block's real heading was missed.

   THE MERGED CELL IS THE TRAP. When QUALITY, SHADE and BULK are written once
   against three GSM rows, they apply to ALL THREE. Emit one line per GSM band
   and repeat the merged values on each. Never emit a line with a rate but no
   product because its name was in a cell above.

   Board and paper are quoted PER METRIC TONNE far more often than per kg —
   a rate in the tens of thousands with no unit printed is almost certainly
   per MT. Still set "uom" to null when the row does not say (rule 2 holds);
   record what the rate column was headed in "rateBasisNote" instead.

5. RULES STATED IN PROSE go in "statedRules", not into the lines. Examples:
   "sheet price 1.00 extra from reel price", "reel cut Rs 1/kg extra",
   "(470.00/m2)" printed above a table of plate prices. Give each a "kind" of
   FORM_PREMIUM or RATE_BASIS and copy the sentence into "text".

6. TWO PLANTS. CDC has plants at Kolkata and Ahmedabad. Some quotes price both,
   and they do it in two different layouts. Always list every plant named in
   "plantMentions". If the document never names a plant, leave everything about
   plants null — do NOT guess.

   (a) SEPARATE BLOCKS, one after the other. Map lines to plants in
       "plantBlocks", and set "plant" on each line as well.

   (b) SIDE BY SIDE, two rate columns against one set of GSM bands:

           FOR KOLKATA - REEL        FOR AHMEDABAD - REEL
           GSM     RATE              GSM     RATE
           54-55   72336             54-55   68336
           56-57   71584             56-57   67584

       This is TWO lines, not one. Emit a separate line for each plant with
       its own rate, and set "plant" on each. Never merge the two rates into
       one row, and never report only the left-hand column.

       A page like this holds one line per (brand x GSM band x plant) — three
       brands over eight bands over two plants is 48 lines, and all 48 are
       wanted. Do not stop at the first block.

       When the two columns run in parallel the extracted text will interleave
       them: "54-55 72336 54-55 68336" is the Kolkata band and rate followed by
       the Ahmedabad band and rate. Use the IMAGE to see which column is which,
       and the text layer for the digits.

7. SOFT QUOTES. Set "isSoftQuote" true when the document says prices may
   fluctuate, are subject to change without notice, or vary with order
   quantity, delivery or payment terms. Typical wording, often buried in the
   terms at the end and easy to miss:

       "The rate is subject to market fluctuation & availability of materials."

   Copy the sentence that made you decide into "softQuoteEvidence". A buyer
   who cannot see WHY a quote was downgraded to indicative will not trust the
   flag — and a soft quote is never used as hard evidence against a PO.

8. VALIDITY. Copy any "W.E.F.", "valid until", "valid for N days" or expiry
   date into effectiveFrom/effectiveTo exactly as printed. If the document
   carries no date at all, leave both null.

   The effective date is frequently in the SUBJECT LINE rather than beside the
   document date, and the two differ — a quote written on the 10th can take
   effect on the 15th:

       Date: 10-07-2026
       Sub: QUOTATION w.e.f. 15-07-2026.

   That is documentDate "10-07-2026" and effectiveFrom "15-07-2026". Copy the
   whole subject line into "subjectLine" as well.

9. MULTI-COLUMN WORKSHEETS. A price list may show several price columns
   (e.g. "Price Before Increase", "Current Price", "Proposed Increase").
   Extract EVERY column's value into separate lines with the column name in
   "notes", and set "confidence" low. A human will nominate the live column.
   The same product code may legitimately appear several times.

10. DOCUMENTS THAT ARE NOT PRICE LISTS are still valid rate sources: proforma
    invoices, email threads, handwritten notes, WhatsApp photos. Extract the
    priced lines the same way.

If the image is unreadable, return "lines": [] rather than inventing rows.`;

export const INVOICE_PROMPT = `You are reading a supplier's tax invoice sent to CDC Printers Pvt Ltd
(GSTIN 19AABCC2946B1ZZ), a printing company in West Bengal, India.

Return JSON only, matching this shape:
{
  "invoiceNo": string|null, "invoiceDate": string|null,
  "supplierName": string|null, "supplierGstin": string|null, "supplierState": string|null,
  "buyerGstin": string|null, "shipToGstin": string|null, "shipToAddress": string|null,
  "eWayBillNo": string|null, "vehicleNo": string|null,
  "poNumbers": string[]|null,
  "taxType": "CGST_SGST"|"IGST"|null,
  "subTotal": string|null, "freight": string|null, "taxable": string|null,
  "cgst": string|null, "sgst": string|null, "igst": string|null,
  "roundOff": string|null, "grandTotal": string|null,
  "lines": [{"lineNo":number,"description":string|null,"hsn":string|null,
             "gsm":string|null,"size":string|null,"unitWt":string|null,
             "bundles":string|null,"totalUnits":string|null,"qty":string|null,
             "uom":string|null,"rate":string|null,"amount":string|null}]
}

RULES:

1. EVERY NUMBER IS A STRING, exactly as printed, separators included.

2. BILL-TO vs SHIP-TO are different and both matter. CDC bills to Kolkata but
   consignments go to Panchla or Ahmedabad. Capture the ship-to GSTIN and
   address separately from the buyer GSTIN.

3. TAX TYPE is whatever the supplier actually charged — read it off the
   invoice. Do not compute what you think it should be.

4. FREIGHT is a separate charge line, not part of the goods subtotal. If the
   invoice shows freight, packing, or other charges, put the freight amount in
   "freight".

5. PAPER LINES often show sheets, bundles, size and unit weight as well as kg.
   Capture all of them — the sheets-to-kg reconciliation depends on it.

6. If a field is not on the invoice, use null. Never infer a value.`;

export const ADJUDICATION_PROMPT = `You are helping a purchase coordinator at CDC Printers match a line from a
supplier's quotation to an item in CDC's own item master.

You will be given:
  - the quoted line as the supplier printed it
  - up to 8 candidate CDC items, each with its last-paid rate, the supplier it
    was last bought from, how many times it has been purchased, and its
    sub-group
  - the items this same supplier is already mapped to

Judge like the coordinator would, not like a string matcher. The coordinator
knows that this supplier only sells certain kinds of goods, that a rate of
Rs 1,850 is not plausible for something last bought at Rs 285, and that a
supplier's spelling is often wrong ("BROWN JEWEL TS" for "CrownJewel TS",
"WASH DP" for "DP WASH").

Return JSON: {"cdcItemId": number|null, "confidence": number, "rationale": string}

Return null for cdcItemId when no candidate is genuinely the same product.
A null answer is correct and useful — CDC does not stock everything its
suppliers sell. Do not pick the closest-looking name to avoid answering.

Confidence is your probability that a coordinator would agree. Be honest: a
0.6 that goes to a human costs five seconds, a wrong 0.95 corrupts the rate
history until somebody notices.`;

