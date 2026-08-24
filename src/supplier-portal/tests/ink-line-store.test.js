/**
 * What actually gets written when an ink reading is accepted.
 *
 * This mapping is pure on purpose. Three of the worst defects in this project —
 * an empty provider registry, an unrendered PDF, a payload that was never
 * written out — were all in code that needed a database or a network to
 * exercise, and therefore had no test, while the logic beside them was covered
 * thoroughly. So the mapping was extracted and is tested here.
 *
 * Every row is verbatim from Print Sales' July 2026 quotation or Siegwerk's
 * price list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inkLineToQuoteLine } from '../services/ink/ink-quotes.js';

const DOC = 'doc-1';

test('a UV process ink stores everything the comparison needs', () => {
  const stored = inkLineToQuoteLine(DOC, {
    lineNo: 3,
    productName: 'RADICURE INTENSE 9000 PRO CYAN',
    productCode: '120000201834',
    section: 'DIC UV INK RATE PER KGS',
    materialClass: 'INK',
    chemistry: 'UV',
    role: 'PRESS_READY',
    colour: 'CYAN',
    manufacturer: 'DIC',
    family: 'RADICURE INTENSE 9000',
    rateText: '830 .00',
    rate: 830,
    rateUom: 'KG',
    basis: 'SECTION',
  });

  assert.equal(stored.raw.chemistry, 'UV');
  assert.equal(stored.raw.colour, 'CYAN');
  assert.equal(stored.raw.manufacturer, 'DIC');
  assert.equal(stored.raw.comparisonKey, 'INK|UV|PRESS_READY|CYAN|KG');
  // The printed text survives beside the number, so a rate can be traced to a
  // line on the page.
  assert.equal(stored.raw.rate, '830 .00');
  assert.equal(stored.normalised.rate, 830);
  assert.ok(stored.flags.includes('from section heading'));
});

test('two makers\' cyans store the same key', () => {
  // The comparison CDC asked for, at the point where it becomes durable.
  const dic = inkLineToQuoteLine(DOC, {
    productName: 'RADICURE INTENSE 9000 PRO CYAN',
    materialClass: 'INK', chemistry: 'UV', role: 'PRESS_READY', colour: 'CYAN',
    manufacturer: 'DIC', rate: 830, rateUom: 'KG',
  });
  const siegwerk = inkLineToQuoteLine(DOC, {
    productName: 'SICURA PLAST 770HS PROCESS CYAN',
    materialClass: 'INK', chemistry: 'UV', role: 'PRESS_READY', colour: 'CYAN',
    manufacturer: 'SIEGWERK', rate: 810, rateUom: 'KG',
  });

  assert.equal(dic.raw.comparisonKey, siegwerk.raw.comparisonKey);
  // And the makers are still on the rows, because "who is cheapest on DIC
  // Radicure" has to remain answerable.
  assert.notEqual(dic.raw.manufacturer, siegwerk.raw.manufacturer);
});

test('the pack is stored apart from the rate unit', () => {
  /*
    "ECNO WASH KR (20 LTR)" at 220 under "RATE PER LTR." is 220 a litre and
    4,400 a can. If 20 ever reached the rate unit the row would read as 11 a
    litre and win every comparison it appeared in.
  */
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'ECNO WASH KR (20 LTR)',
    materialClass: 'PRESS_CHEMICAL',
    chemicalFunction: 'WASH',
    rate: 220,
    rateUom: 'LTR',
    pack: { size: 20, uom: 'LTR', inBaseUom: 20 },
  });

  assert.equal(stored.normalised.uom, 'LTR');
  assert.equal(stored.raw.packSize, '20');
  assert.equal(stored.raw.packUom, 'LTR');
  // And it is spelled out for a reader, because the rate beside it is per unit
  // and the two are easy to read as one number.
  assert.match(stored.raw.notes, /20 LTR pack/);
});

test('the rate unit is stored as read and never converted', () => {
  // Five bases appear across these documents and they do not interconvert. A
  // plate at 382 a piece and a varnish at 400 a kilo must never be sorted
  // against each other, and a rate silently divided is one nobody can check
  // against the page.
  const plate = inkLineToQuoteLine(DOC, {
    productName: 'CAPRI DOUBLE COATED THERMAL PLATE',
    materialClass: 'PLATE', rate: 382.44, rateUom: 'PC',
    plate: { lengthMm: 790, widthMm: 1030, thicknessMm: 0.28, ratePerSqm: 470 },
  });

  assert.equal(plate.normalised.uom, 'PC');
  assert.equal(plate.normalised.ratePerBaseUom, 382.44);
  assert.match(plate.raw.notes, /790 × 1030 × 0.28mm/);
});

test('a mixing base stores its number and says it is one', () => {
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'VEGA PRIME FAST BLUE (R/S) PASTE 517',
    materialClass: 'INK', chemistry: 'CONVENTIONAL', role: 'MIXING_BASE',
    colour: 'FAST_BLUE', baseNumber: '517', rate: 514, rateUom: 'KG',
  });

  assert.equal(stored.raw.baseNumber, '517');
  assert.match(stored.raw.notes, /Mixing base/);
  // And it does not share a key with a press-ready ink of the same colour.
  const ready = inkLineToQuoteLine(DOC, {
    productName: 'VEGA SPRINT FAST BLUE',
    materialClass: 'INK', chemistry: 'CONVENTIONAL', role: 'PRESS_READY',
    colour: 'FAST_BLUE', rate: 292, rateUom: 'KG',
  });
  assert.notEqual(stored.raw.comparisonKey, ready.raw.comparisonKey);
});

test('a row that can be compared to nothing says so on its face', () => {
  /*
    The one failure this category can hide. A row missing its chemistry is
    stored, looks perfectly ordinary in the review table, and appears in no
    search at all — so the flag exists to make the silence audible.
  */
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'RICH PALE GOLD INK 2025 RL',
    materialClass: 'INK',
    colour: 'PALE_GOLD',
    rate: 2385,
    rateUom: 'KG',
  });

  assert.equal(stored.raw.comparisonKey, null);
  assert.ok(stored.flags.includes('not comparable'));
});

test('an announced increase keeps the price it replaced', () => {
  // CDC takes the post-increase figure. Keeping the old one beside it is what
  // turns a bare new number into a movement somebody can sanity-check.
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'SICURA PLAST 770HS PROCESS CYAN',
    materialClass: 'INK', chemistry: 'UV', role: 'PRESS_READY', colour: 'CYAN',
    rate: 820, previousRate: 810, rateUom: 'KG',
  });

  assert.equal(stored.normalised.rate, 820);
  assert.ok(stored.flags.includes('was 810'));
});

test('a taught answer is visible on every row it settled', () => {
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'NEWRANGE PROCESS BLACK',
    materialClass: 'INK', chemistry: 'UV', role: 'PRESS_READY', colour: 'BLACK',
    rate: 900, rateUom: 'KG', basis: 'TAUGHT',
  });
  assert.ok(stored.flags.includes('taught'));
});

test('the line number falls back to its position, never to nothing', () => {
  const stored = inkLineToQuoteLine(DOC, { productName: 'X', rate: 1, rateUom: 'KG' }, 4);
  assert.equal(stored.lineNo, 5);
});

test('a coating stores its finish and its slip separately', () => {
  // Slip describes the stack, not the finish, and is recorded without entering
  // the comparison.
  const stored = inkLineToQuoteLine(DOC, {
    productName: 'WB OPL - HIGH GLOSS HIGH SLIP',
    materialClass: 'COATING', chemistry: 'WATER_BASED',
    finish: 'HIGH_GLOSS', coatingProperty: 'HIGH_SLIP',
    rate: 154, rateUom: 'KG',
  });

  assert.equal(stored.raw.finish, 'HIGH_GLOSS');
  assert.equal(stored.raw.coatingProperty, 'HIGH_SLIP');
  assert.equal(stored.raw.comparisonKey, 'COATING|WATER_BASED|HIGH_GLOSS|KG');
});
