/**
 * Reading a paper/board price list.
 *
 * These come from a Sudarshan FBB quote that the portal got comprehensively
 * wrong: nine lines all named "QUALITY GSM SHADE BULK", no brand, no grade, no
 * shade, no bulk, no unit, and eleven blocking errors. Three separate causes,
 * and none of them was the extractor being careless:
 *
 *   1. The PDF had a text layer, so we sent text and no image. A PDF's text
 *      layer is in drawing order, so the table arrived with its columns fused
 *      ("230-249 76112") and the product names fifteen lines away from their
 *      rows. The column headings were the only product-shaped string in it.
 *   2. The document states no unit anywhere — board is sold by the tonne and
 *      the column just says "RATE FOR 90 DAYS" — so every row failed
 *      separately, asking one question nine times.
 *   3. "SUDARSHAN" scored 0.80 against its own ledger, "Sudarshan Paper &
 *      Board Pvt Ltd" — under the auto-accept bar, so the right answer sat
 *      unselected while the reviewer wondered why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLine } from '../services/quotes.js';
import { nameScore, suggestGroups } from '../services/supplier-groups.js';
import { ExtractedQuoteSchema } from '../services/extraction/provider.js';

// ── The document-level unit ─────────────────────────────────────────────────

/** One row of the Sudarshan table: a rate, a GSM band, and no unit at all. */
const BOARD_ROW = {
  productName: 'NR POWER FOLD - FBB',
  rate: '76112',
  uom: null,
  gsmFrom: '230',
  gsmTo: '249',
};

test('a board rate with no unit does not normalise on its own', () => {
  const out = normaliseLine(BOARD_ROW, new Map());
  assert.equal(out.uom, null);
  assert.ok(out.flags.includes('NO_UOM_ON_LINE'));
});

test('a document unit resolves it, and converts per-tonne to per-kg', () => {
  // The conversion is the reason this re-normalises rather than just recording
  // the answer: ₹76,112 per tonne is ₹76.11 per kg, and a comparison fed the
  // raw figure would be out by a factor of a thousand.
  const out = normaliseLine(BOARD_ROW, new Map(), { documentUom: 'MT' });
  assert.equal(out.uom, 'KG');
  // `rate` keeps the figure as printed and `ratePerBaseUom` carries the
  // converted one, so the review screen can always show both and a reviewer
  // can trace ₹76.11 back to the ₹76,112 on the page.
  assert.equal(out.rate, 76112, 'the printed figure survives');
  assert.ok(Math.abs(out.ratePerBaseUom - 76.112) < 0.001, `got ${out.ratePerBaseUom}`);
  assert.match(out.conversionNote, /76112 per MT = 76\.112 per KG/);
});

test('the converted rate is marked as coming from an answer, not the page', () => {
  const out = normaliseLine(BOARD_ROW, new Map(), { documentUom: 'MT' });
  assert.ok(out.flags.includes('UOM_FROM_DOCUMENT'));
  assert.ok(out.flags.includes('NO_UOM_ON_LINE'), 'still true that the row printed none');
});

test('a unit printed on the row beats the document unit', () => {
  // The safeguard that lets one answer be applied to a mixed document: it can
  // only ever fill a gap, never overwrite what the supplier printed.
  const out = normaliseLine({ ...BOARD_ROW, uom: 'KG', rate: '76.11' }, new Map(), { documentUom: 'MT' });
  assert.equal(out.uom, 'KG');
  // Not converted: had the document unit won, this would be 0.07611.
  assert.ok(Math.abs(out.ratePerBaseUom - 76.11) < 0.001, `got ${out.ratePerBaseUom}`);
  assert.ok(!out.flags.includes('UOM_FROM_DOCUMENT'));
});

test('a unit inside the rate cell also beats the document unit', () => {
  const out = normaliseLine({ ...BOARD_ROW, rate: '82.50/KG' }, new Map(), { documentUom: 'MT' });
  assert.equal(out.uom, 'KG');
  assert.ok(Math.abs(out.ratePerBaseUom - 82.5) < 0.001, `got ${out.ratePerBaseUom}`);
});

// ── Supplier identity from a bare title box ─────────────────────────────────

const LEDGERS = [
  { _id: 'a', name: 'Sudarshan Paper & Board Pvt Ltd' },
  { _id: 'b', name: 'Graphic Sales' },
  { _id: 'c', name: 'Print Sales Pvt Ltd' },
  { _id: 'd', name: 'Print India Solution' },
  { _id: 'e', name: 'India Sales Agency' },
];

test('a short trading name matches its full legal name — the case that failed', () => {
  const [best] = suggestGroups('SUDARSHAN', LEDGERS);
  assert.equal(best.group.name, 'Sudarshan Paper & Board Pvt Ltd');
  assert.ok(best.score >= 0.82, `scored ${best.score}, needs to clear auto-accept`);
});

test('nothing else is offered alongside it', () => {
  // The value of the boost is that it produces one answer, not a shortlist
  // headed by the right one.
  assert.equal(suggestGroups('SUDARSHAN', LEDGERS).length, 1);
});

test('a trailing subset is NOT boosted — the wrong-supplier trap', () => {
  // Indian firm names lead with the distinctive word and trail into the
  // generic one, so a shared FIRST token means something and a shared last
  // token does not. Boosting any subset would score this pair at 0.95.
  assert.ok(nameScore('sales', 'graphic sales') < 0.9);
});

test('a fragment too short to identify anyone is not boosted', () => {
  // "SALES" leads "Sales Agency" once "India" is stripped as a corporate word,
  // and without a length floor it scored 0.95 — clear of the field, so it
  // would have been accepted outright with nobody asked.
  const ranked = suggestGroups('SALES', LEDGERS);
  assert.ok(ranked.every((r) => r.score < 0.9), ranked.map((r) => `${r.group.name} ${r.score}`).join(', '));
});

test('an ambiguous lead ties rather than picking one', () => {
  // "PRINT" leads two suppliers. A tie fails the caller's clear-of-the-field
  // test and a person is asked, which is the correct output.
  const [first, second] = suggestGroups('PRINT', LEDGERS);
  assert.ok(second, 'both candidates are offered');
  assert.ok(Math.abs(first.score - second.score) < 0.08, 'too close to call');
});

test('the mill is not mistaken for the supplier', () => {
  // "NR mill FBB rate" names the manufacturer. Nothing on file is NR, and
  // inventing a match would file Sudarshan's rates against someone else.
  assert.deepEqual(suggestGroups('NR', LEDGERS), []);
});

// ── The extracted shape ─────────────────────────────────────────────────────

test('a board line carries mill, brand, grade, shade and bulk separately', () => {
  const parsed = ExtractedQuoteSchema.safeParse({
    supplierName: 'SUDARSHAN',
    supplierGstin: null,
    documentDate: '18/08/2026',
    effectiveFrom: '18/08/2026',
    effectiveTo: null,
    isSoftQuote: false,
    plantMentions: ['Ahmedabad'],
    entityScope: null,
    commercialTerms: null,
    statedRules: null,
    plantBlocks: null,
    rateBasisNote: 'RATE FOR 90 DAYS',
    lines: [{
      lineNo: 1,
      productName: 'NR POWER FOLD - FBB',
      productCode: null, packSize: null, uom: null, rate: '76112',
      gstNote: null, gsmFrom: '230', gsmTo: '249',
      productForm: null, width: null, micron: null,
      mill: 'NR', brand: 'POWER FOLD', grade: 'FBB',
      shade: 'NATURAL', bulk: '1.40 - 1.45',
      notes: null, text: null, confidence: 0.9,
    }],
  });

  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  const line = parsed.data.lines[0];
  assert.equal(line.grade, 'FBB');
  assert.equal(line.bulk, '1.40 - 1.45');
  assert.equal(parsed.data.rateBasisNote, 'RATE FOR 90 DAYS');
});

test('an ink line omitting the paper fields is still valid', () => {
  // Only paper quotes have them. A model leaving the keys out on an ink quote
  // is correct, and rejecting it would break every non-paper document.
  const parsed = ExtractedQuoteSchema.safeParse({
    supplierName: 'Siegwerk', supplierGstin: null,
    documentDate: null, effectiveFrom: null, effectiveTo: null,
    isSoftQuote: null, plantMentions: null, entityScope: null,
    commercialTerms: null, statedRules: null, plantBlocks: null,
    lines: [{
      lineNo: 1, productName: 'SICURA PLAST CYAN', productCode: null,
      packSize: null, uom: 'KG', rate: '810', gstNote: null,
      gsmFrom: null, gsmTo: null, productForm: null, width: null,
      micron: null, notes: null, text: null, confidence: 0.95,
    }],
  });
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
});
