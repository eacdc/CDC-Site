/**
 * UOM and pack-size tests.
 *
 * The cases are taken from the August 2026 quote batch rather than invented,
 * so a failure here means a real document would be read wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseUom, parsePackSize, parseRateCell, parseAmount,
  normaliseRate, packEquivalentRate, magnitudeCheck,
} from '../lib/uom.js';

test('unit spellings all fold to one canonical value', () => {
  // Group 6 alone carries six spellings of square metre.
  for (const spelling of ['Sq. Meter', 'Sq.Meter', 'SQ.METER', 'SQ METER', 'Sq meter', 'Sq.meter']) {
    assert.equal(normaliseUom(spelling).canonical, 'SQM', `${spelling} should be SQM`);
  }
  for (const spelling of ['KGS.', 'Kg', 'KG', 'kg']) {
    assert.equal(normaliseUom(spelling).canonical, 'KG');
  }
  for (const spelling of ['Liters', 'LITRE', 'Ltr']) {
    assert.equal(normaliseUom(spelling).canonical, 'LTR');
  }
});

test('MT converts to KG with a factor of 1000, not silently', () => {
  const mt = normaliseUom('MT');
  assert.equal(mt.canonical, 'KG');
  assert.equal(mt.factor, 1000);
});

test('ambiguous units resolve to null rather than a guess', () => {
  // SQ INCH could be an area or a length depending on the document; guessing
  // is how a rate ends up off by orders of magnitude.
  const result = normaliseUom('SQ INCH');
  assert.equal(result.canonical, null);
  assert.equal(result.isAmbiguous, true);
});

test('NR Agarwal per-MT rate normalises to per-KG', () => {
  const result = normaliseRate({ rate: '74,342', uom: 'MT' });
  assert.equal(result.rate, 74342);
  assert.equal(result.uom, 'KG');
  assert.equal(result.ratePerBaseUom, 74.342);
  assert.match(result.conversionNote, /per MT.*per KG/);
});

test('pack sizes hidden in product names are found', () => {
  assert.deepEqual(
    pick(parsePackSize('Technomelt Q 970 - 26kg')),
    { packQty: 26, packUom: 'KG' },
  );
  assert.deepEqual(
    pick(parsePackSize('GI Wire 26(15 kg Spool)')),
    { packQty: 15, packUom: 'KG' },
  );
  assert.deepEqual(pick(parsePackSize('IPA 205 LTR')), { packQty: 205, packUom: 'LTR' });
  assert.deepEqual(pick(parsePackSize('UNI GUM (5 LTR)')), { packQty: 5, packUom: 'LTR' });
  // 500 ML is stored as 0.5 LTR so it compares against litre rates.
  assert.deepEqual(
    pick(parsePackSize('DEEP KLEEN SHAMPOO (500 ML)')),
    { packQty: 0.5, packUom: 'LTR' },
  );
});

test('a bare parenthesised number is only a pack size when a unit is supplied', () => {
  // "SKT XUV-225 RC (20)" — the 20 could as easily be a grade as a pack.
  assert.equal(parsePackSize('SKT XUV-225 RC (20)'), null);
  const withHint = parsePackSize('SKT XUV-225 RC (20)', { defaultPackUom: 'KG' });
  assert.equal(withHint.packQty, 20);
  assert.equal(withHint.assumedUom, true);
});

test('the unit comes from the rate cell, never from a column header', () => {
  // Print Sales' column reads "RATE PER LTR" while its rows say otherwise.
  assert.deepEqual(parseRateCell('131.00/UNIT'), { rate: 131, uom: 'NOS', rawUom: 'UNIT' });
  assert.deepEqual(parseRateCell('160.00/PC'), { rate: 160, uom: 'PCS', rawUom: 'PC' });
  assert.deepEqual(parseRateCell('375.00/KG'), { rate: 375, uom: 'KG', rawUom: 'KG' });
});

test('Indian and Western number grouping both parse', () => {
  assert.equal(parseAmount('₹1,23,456.78'), 123456.78);
  assert.equal(parseAmount('123,456.78'), 123456.78);
  assert.equal(parseAmount('2,235/-'), 2235);
  assert.equal(parseAmount('Rs. 5077'), 5077);
});

test('Ultimate Logistix pack conversion reproduces the verified figure', () => {
  // ₹149/kg × 15 kg spool = ₹2,235, which is exactly what CDC last paid for
  // G.I WIRE SPOOL BIG 26 per Nos.
  assert.equal(packEquivalentRate({ ratePerBaseUom: 149, packQty: 15 }), 2235);
});

test('a rate quoted per pack divides by the pack size', () => {
  const result = normaliseRate({
    rate: 2235, uom: 'NOS', packQty: 15, packUom: 'KG', perPack: true,
  });
  assert.equal(result.ratePerBaseUom, 149);
});

test('the magnitude guard catches a 1000x basis error', () => {
  // Per-MT read as per-kg against an item last bought at ₹74/kg.
  const verdict = magnitudeCheck(74342, 74.342);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.ratio, 1000);
  assert.match(verdict.likelyCause, /per pack or per MT/);
});

test('the magnitude guard stays silent without a last-paid rate', () => {
  // A new item has no history, and no history is not evidence of a problem.
  assert.equal(magnitudeCheck(500, null), null);
  assert.equal(magnitudeCheck(500, 0), null);
});

test('a normal price move is not flagged as a basis error', () => {
  assert.equal(magnitudeCheck(285, 250).passed, true);
  assert.equal(magnitudeCheck(1850, 285).passed, true, 'a 6.5x move is a pricing question, not a unit error');
});

function pick(result) {
  return result ? { packQty: result.packQty, packUom: result.packUom } : null;
}
