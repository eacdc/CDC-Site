/**
 * Rates on non-paper quote lines, from Unic Tech's August 2026 list.
 *
 * Each of these put a wrong figure into the price comparison with nothing on
 * the screen to show it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLine } from '../services/quotes.js';
import { quoteSpecTuple } from '../lib/spec.js';

test('a tape roll is not divided by its length', () => {
  const out = normaliseLine({
    productName: 'BOPP TAPE 48 mm X 42 Mic X 65 mtr', packSize: '65 mtr', rate: '34.5/-', uom: 'Roll',
  }, new Map());
  assert.equal(out.uom, 'ROLL');
  assert.equal(out.ratePerBaseUom, 34.5, 'Rs 34.50 a roll, not Rs 0.53');
  assert.ok(!out.flags.includes('RATE_TREATED_AS_PER_PACK'));
});

test('a drum priced per piece is still divided by its contents', () => {
  const out = normaliseLine({ productName: 'GUM (20 KG)', rate: '1500', uom: 'NOS' }, new Map());
  assert.ok(out.flags.includes('RATE_TREATED_AS_PER_PACK'));
  assert.equal(out.ratePerBaseUom, 75);
});

test('a box counted in pieces is priced per piece', () => {
  // HK Trading: "yellow | 10 pcs(1 box) | 2400" is CDC's Rs 240 tape.
  const out = normaliseLine({ productName: 'yellow', packSize: '10 pcs(1 box)', rate: '2400' }, new Map());
  assert.equal(out.ratePerBaseUom, 240);
  assert.ok(out.flags.includes('PACK_UOM_ASSUMED'), 'the unit was not printed, and the screen must say so');
  assert.ok(!out.flags.includes('UOM_UNRESOLVED'));
  // A stated unit wins, and a count in the name is not a pack.
  assert.equal(normaliseLine({ productName: 'x', packSize: '10 pcs', rate: '24', uom: 'PCS' }, new Map()).ratePerBaseUom, 24);
  assert.equal(normaliseLine({ productName: 'Litho PERF 12 Tooth', rate: '4500' }, new Map()).ratePerBaseUom, null);
});

test('a rate is not read as a GSM on a non-paper line', () => {
  // "PP BOX STRAPPING ROLL Economy" at "90/-" became a 90 GSM paper band, and
  // "48 mm" on a tape became GSM 48.
  const strap = quoteSpecTuple({ productName: 'PP BOX STRAPPING ROLL Economy', text: 'PP BOX STRAPPING ROLL Economy 6 KGS 90/-' });
  assert.equal(strap.gsmFrom, null);
  const tape = quoteSpecTuple({ productName: 'BOPP TAPE 48 mm X 42 Mic X 65 mtr' });
  assert.equal(tape.gsmFrom, null);
  assert.equal(tape.widthMm, 48);
  assert.equal(tape.micron, 42);
});

test('a paper line still gets its band from the text', () => {
  assert.deepEqual(
    [quoteSpecTuple({ productName: 'MAPLITHO 54/55 GSM' }).gsmFrom, quoteSpecTuple({ productName: 'MAPLITHO 54/55 GSM' }).gsmTo],
    [54, 55],
  );
  assert.equal(quoteSpecTuple({ productName: 'ART PAPER 100 & ABOVE' }).gsmFrom, 100);
});
