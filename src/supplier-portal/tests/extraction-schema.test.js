/**
 * What the extraction schema accepts.
 *
 * These exist because of a failure that cost two model calls and five minutes
 * before reporting itself. A blanket "stringify every number in the response"
 * pass ran before validation, so a perfectly good extraction of 47 lines had
 * every `lineNo: 1` turned into `"1"` — and was then rejected 47 times over by
 * the schema that requires a number. The model was right; we broke its answer
 * on the way in, and the error blamed the model.
 *
 * The rule that follows: coercion has to know which field it is looking at.
 * A field printed on the page is text, whatever JSON type it arrives as. A
 * field that counts something is a number, whatever JSON type it arrives as.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtractedQuoteSchema, ExtractedInvoiceSchema } from '../services/extraction/provider.js';
import { describeIssues } from '../services/extraction/openai-provider.js';

/** A minimal well-formed quote, as a model actually replies. */
function quote(lines) {
  return {
    supplierName: 'PRINT SALES PRIVATE LIMITED',
    supplierGstin: null,
    documentDate: '10-07-2026',
    effectiveFrom: '15-07-2026',
    effectiveTo: null,
    isSoftQuote: true,
    plantMentions: null,
    entityScope: null,
    commercialTerms: null,
    statedRules: null,
    plantBlocks: null,
    lines,
  };
}

const LINE = {
  lineNo: 1,
  productName: '790 x 1030 x 0.28mm',
  productCode: null,
  packSize: null,
  uom: 'PC',
  rate: '382.44',
  gstNote: null,
  gsmFrom: null,
  gsmTo: null,
  productForm: null,
  width: null,
  micron: null,
  notes: null,
  text: null,
  confidence: 0.9,
};

test('a numeric lineNo is accepted — the case that failed in production', () => {
  const parsed = ExtractedQuoteSchema.safeParse(quote([LINE]));
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines[0].lineNo, 1);
});

test('a stringified lineNo is accepted too, and comes back a number', () => {
  // Leniency in both directions. A model returning "1" for line one is not
  // wrong about anything that matters, and rejecting the document over it
  // would be the same mistake in reverse.
  const parsed = ExtractedQuoteSchema.safeParse(quote([{ ...LINE, lineNo: '3', confidence: '0.8' }]));
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines[0].lineNo, 3);
  assert.equal(parsed.data.lines[0].confidence, 0.8);
});

test('a rate returned as a number keeps every digit as text', () => {
  // The reason rates are text: 74,342 must not silently become 74342 through
  // a rounding path nobody can audit. If the model sends a number anyway,
  // String() preserves the digits exactly.
  const parsed = ExtractedQuoteSchema.safeParse(quote([{ ...LINE, rate: 382.44, micron: 12 }]));
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines[0].rate, '382.44');
  assert.equal(parsed.data.lines[0].micron, '12');
});

test('an empty string becomes null rather than a blank rate', () => {
  const parsed = ExtractedQuoteSchema.safeParse(quote([{ ...LINE, rate: '', uom: '   ' }]));
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines[0].rate, null);
  assert.equal(parsed.data.lines[0].uom, null);
});

test('a lineNo that is not a number at all still fails', () => {
  // Leniency has a floor. "one" is not a line index, and quietly accepting it
  // would put an unusable value into storage.
  const parsed = ExtractedQuoteSchema.safeParse(quote([{ ...LINE, lineNo: 'one' }]));
  assert.equal(parsed.success, false);
});

test('the whole Print Sales shape parses, 47 lines and all', () => {
  const lines = Array.from({ length: 47 }, (_, i) => ({ ...LINE, lineNo: i + 1 }));
  const parsed = ExtractedQuoteSchema.safeParse({
    ...quote(lines),
    supplier: {
      name: 'PRINT SALES PRIVATE LIMITED',
      gstin: null,
      phone: '+91-7596986452',
      email: null,
      address: null,
      signatory: 'Rina Das',
      foundIn: 'signature block, page 3',
    },
    addressedTo: {
      company: 'CDC PRINTERS (P). LTD.',
      address: '45, Radhanath Chowdhuri Road, Kolkata - 700015',
      gstin: null,
      attention: null,
    },
    subjectLine: 'QUOTATION w.e.f. 15-07-2026.',
    softQuoteEvidence: 'The rate is subject to market fluctuation & availability of materials.',
    commercialTerms: {
      creditDays: null,
      freightTerms: 'Free to your work.',
      insurance: null,
      gstNote: 'GST will be charged extra as applicable',
      paymentTerms: 'As per agreed terms.',
    },
  });
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines.length, 47);
  assert.equal(parsed.data.supplier.signatory, 'Rina Das');
});

test('invoice lines are lenient in the same two directions', () => {
  const parsed = ExtractedInvoiceSchema.safeParse({
    invoiceNo: 'KV/2026/1182', invoiceDate: '02-08-2026',
    supplierName: 'Krishna Vanijya', supplierGstin: null, supplierState: null,
    buyerGstin: null, shipToGstin: null, shipToAddress: null,
    eWayBillNo: null, vehicleNo: null, poNumbers: null, taxType: 'CGST_SGST',
    subTotal: 21520.14, freight: '629.38', taxable: null,
    cgst: null, sgst: null, igst: null, roundOff: null, grandTotal: '24,764.39',
    lines: [{
      lineNo: '1', description: 'Kraft Paper', hsn: 48041100, gsm: 90,
      size: null, unitWt: null, bundles: null, totalUnits: null,
      qty: '264.425', uom: 'KG', rate: 81.4, amount: '21520.14',
    }],
  });
  assert.ok(parsed.success, parsed.success ? '' : describeIssues(parsed.error.issues));
  assert.equal(parsed.data.lines[0].lineNo, 1);
  assert.equal(parsed.data.lines[0].hsn, '48041100');
  assert.equal(parsed.data.grandTotal, '24,764.39', 'separators survive');
  assert.equal(parsed.data.subTotal, '21520.14');
});

// ── The error message itself ────────────────────────────────────────────────

test('one repeated fault is reported once, with a count', () => {
  // The production error was 47 copies of one sentence. Whatever it said was
  // buried under its own repetition, and the message ran past the width of
  // any screen it was shown on.
  const parsed = ExtractedQuoteSchema.safeParse(
    quote(Array.from({ length: 47 }, () => ({ ...LINE, lineNo: 'one' }))),
  );
  assert.equal(parsed.success, false);

  const text = describeIssues(parsed.error.issues);
  assert.match(text, /lines\.#\.lineNo/);
  assert.match(text, /\(47 rows\)/);
  // One field, one clause — not forty-seven.
  assert.equal(text.split(';').length, 1);
  assert.ok(text.length < 200, `still too long: ${text.length} chars`);
});
