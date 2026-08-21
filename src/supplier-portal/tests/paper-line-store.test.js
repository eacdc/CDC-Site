/**
 * Turning an interpreted line into a stored quote line.
 *
 * These exist because the step did not. `checkHandoff` returning READY was
 * treated as the end of the job; it is permission to begin. The payload sat in
 * `interpretation.payload`, nothing read it, and the table under the panel went
 * on showing the old one-shot extraction — so a reviewer answered seven
 * questions about paper types and watched nothing change.
 *
 * That is worse than an error. An error says something went wrong; this said
 * the answers were ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { paperLineToQuoteLine } from '../services/paper/paper-quotes.js';

/** A Sudarshan virgin-list line, as it looks once a brand has been taught. */
const TAUGHT = {
  lineNo: 1,
  productName: 'CENTURY PRIMA FOLD RBD',
  paperType: 'FBB',
  paperTypeBasis: 'TAUGHT',
  gsmText: '190 400',
  gsmFrom: 190,
  gsmTo: 400,
  form: 'SHEET',
  rateText: '77.50',
  rate: 77.5,
  rateUom: 'KGS',
  mill: 'CENTURY',
  brand: 'PRIMA FOLD',
};

test('the paper type reaches the field the table reads', () => {
  // `raw.grade` is what PaperSpec renders and what the board search matches on.
  // Writing it anywhere else is the same as not writing it.
  const line = paperLineToQuoteLine('doc1', TAUGHT);
  assert.equal(line.raw.grade, 'FBB');
});

test('the printed text survives beside the interpreted value', () => {
  // A rate that cannot be traced back to a line on the page is not auditable.
  const line = paperLineToQuoteLine('doc1', TAUGHT);
  assert.equal(line.raw.rate, '77.50');
  assert.equal(line.normalised.rate, 77.5);
});

test('a rate quoted per tonne stays per tonne', () => {
  // Silently dividing by 1000 produces a number nobody can check against the
  // document. NR's board list is per MT and Sudarshan's is per kg.
  const line = paperLineToQuoteLine('doc1', { ...TAUGHT, rate: 72336, rateUom: 'MT' });
  assert.equal(line.normalised.uom, 'MT');
  assert.equal(line.normalised.rate, 72336);
});

test('form, mill and brand all carry through', () => {
  const line = paperLineToQuoteLine('doc1', TAUGHT);
  assert.equal(line.raw.productForm, 'SHEET');
  assert.equal(line.raw.mill, 'CENTURY');
  assert.equal(line.raw.brand, 'PRIMA FOLD');
});

test('a taught type is flagged as taught', () => {
  // A value that came from an answer months ago should not look like one read
  // off the page today.
  assert.ok(paperLineToQuoteLine('doc1', TAUGHT).flags.includes('type taught'));
  assert.ok(!paperLineToQuoteLine('doc1', { ...TAUGHT, paperTypeBasis: 'STATED' })
    .flags.includes('type taught'));
});

test('a line with no GSM band says so', () => {
  // AKT's handwritten note carries no GSM at all. Its rate applies to the grade
  // at large, which is a weaker claim than a banded one.
  const line = paperLineToQuoteLine('doc1', {
    ...TAUGHT, gsmFrom: null, gsmTo: null, productName: 'Devpriya PGB',
  });
  assert.ok(line.flags.includes('no gsm band'));
  assert.equal(line.raw.gsmFrom, null);
});

test('an open-topped band keeps its null', () => {
  const line = paperLineToQuoteLine('doc1', { ...TAUGHT, gsmFrom: 115, gsmTo: null });
  assert.equal(line.raw.gsmFrom, '115');
  assert.equal(line.raw.gsmTo, null);
});

test('a derived rate shows its arithmetic in the notes', () => {
  // About thirty kraft rows are computed rather than printed. A number that
  // cannot show where it came from is one nobody can check.
  const line = paperLineToQuoteLine('doc1', {
    lineNo: 1,
    productName: 'KRAFT 18 BF 120 GSM',
    paperType: 'KRAFT',
    bf: 18,
    rate: 31.05,
    rateUom: 'KGS',
    derivation: { base: 30.8, baseNote: '18 BF', adjustments: [{ amount: 0.25, reason: '120 gsm' }] },
  });

  assert.match(line.raw.notes, /30\.8/);
  assert.match(line.raw.notes, /\+0\.25 120 gsm/);
  assert.match(line.raw.notes, /18 BF/);
  assert.ok(line.flags.includes('derived rate'));
  assert.equal(line.normalised.conversionNote, 'derived — see notes');
});

test('shade and supply mode are readable in the notes', () => {
  const line = paperLineToQuoteLine('doc1', {
    ...TAUGHT, shade: 'NATURAL', supplyMode: 'MILL_ORDER',
  });
  assert.match(line.raw.notes, /natural shade/);
  assert.match(line.raw.notes, /mill order/);
});

test('a line number is supplied when the document has none', () => {
  const line = paperLineToQuoteLine('doc1', { ...TAUGHT, lineNo: null }, 4);
  assert.equal(line.lineNo, 5);
});

test('every line points at its document', () => {
  assert.equal(paperLineToQuoteLine('doc99', TAUGHT).quoteDocumentId, 'doc99');
});
