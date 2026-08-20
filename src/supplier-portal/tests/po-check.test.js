/**
 * PO checker tests.
 *
 * The rules that matter most here are the ones about what must NOT happen: a
 * soft quote must never block, and a missing quote at one plant must never be
 * answered with the other plant's rate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLine, verdictFor } from '../services/po-check.js';
import { bestQuote, groupForRanking, QUOTE_STATE } from '../services/comparator.js';
import { rankingMode, onTimeToleranceDays } from '../config/constants.js';

const GROUP = { _id: 'g1', name: 'Siegwerk', historicalItemGroupIds: [3] };
const ITEM = { ItemID: 1, ItemName: 'UV Ink - Process-Cyan', ItemGroupID: 3, PurchaseUnit: 'KG' };

function line(overrides = {}) {
  return {
    TransactionDetailID: 100, ItemID: 1, PurchaseOrderQuantity: 50,
    PurchaseUnit: 'KG', PurchaseRate: 820, ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    supplierGroupId: 'g1', supplierName: 'Siegwerk', state: QUOTE_STATE.QUOTED,
    rate: 820, quoteStrength: 'FIRM', isExpired: false, ...overrides,
  };
}

function find(result, code) {
  return result.checks.find((c) => c.code === code);
}

test('a PO priced at the supplier own quote passes', () => {
  const result = checkLine({
    line: line(), item: ITEM, quotes: [quote()], supplierGroup: GROUP,
    lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  assert.equal(result.verdict.level, 'OK');
});

test('PO002 blocks a rate above the supplier own written price', () => {
  const result = checkLine({
    line: line({ PurchaseRate: 900 }), item: ITEM, quotes: [quote({ rate: 820 })],
    supplierGroup: GROUP, lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  const check = find(result, 'PO002');
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'BLOCK');
  assert.equal(result.verdict.level, 'BLOCK');
});

test('PO002 tolerates half a percent of rounding', () => {
  const result = checkLine({
    line: line({ PurchaseRate: 823 }), item: ITEM, quotes: [quote({ rate: 820 })],
    supplierGroup: GROUP, lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  assert.equal(find(result, 'PO002').passed, true, '0.37% is rounding, not overpaying');
});

test('PO001 warns when a cheaper supplier was available', () => {
  const result = checkLine({
    line: line({ PurchaseRate: 820 }),
    item: ITEM,
    quotes: [quote(), quote({ supplierGroupId: 'g2', supplierName: 'Sakata', rate: 700 })],
    supplierGroup: GROUP,
    lastPaid: { rate: 820 },
    plant: 'KOLKATA',
  });
  const check = find(result, 'PO001');
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'WARN', 'a cheaper alternative is a question, not a refusal');
});

test('a SOFT quote is recorded but never blocks', () => {
  // Purv's email says prices "may fluctuate and are subject to change without
  // prior notice" — usable as a benchmark, never as hard evidence.
  const result = checkLine({
    line: line({ PurchaseRate: 900 }),
    item: ITEM,
    quotes: [quote({ rate: 820, quoteStrength: 'SOFT' })],
    supplierGroup: GROUP,
    lastPaid: { rate: 820 },
    plant: 'KOLKATA',
  });
  assert.equal(find(result, 'PO005').severity, 'INFO');
  // The best-quote comparison excludes soft quotes entirely.
  assert.equal(result.bestQuote, null, 'a soft quote is not "the best available"');
});

test('PO003 warns rather than reaching for the other plant rate', () => {
  const result = checkLine({
    line: line(), item: ITEM, quotes: [], supplierGroup: GROUP,
    lastPaid: { rate: 820 }, plant: 'AHMEDABAD',
  });
  const check = find(result, 'PO003');
  assert.equal(check.passed, false);
  assert.match(check.message, /Ahmedabad/);
  assert.equal(result.bestQuote, null);
});

test('PO004 flags a comparison made against an expired quote', () => {
  const result = checkLine({
    line: line(), item: ITEM,
    quotes: [quote({ isExpired: true, effectiveTo: new Date('2026-06-30') })],
    supplierGroup: GROUP, lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  assert.equal(find(result, 'PO004').passed, false);
});

test('PO006 warns on a large move from what was last paid', () => {
  const result = checkLine({
    line: line({ PurchaseRate: 1000 }), item: ITEM, quotes: [quote({ rate: 1000 })],
    supplierGroup: GROUP, lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  assert.equal(find(result, 'PO006').passed, false, '22% is past the 15% threshold');
});

test('PO007 warns on a supplier outside their usual groups', () => {
  const cartons = { ...ITEM, ItemGroupID: 7 };
  const result = checkLine({
    line: line(), item: cartons, quotes: [quote()], supplierGroup: GROUP,
    lastPaid: null, plant: 'KOLKATA',
  });
  assert.equal(find(result, 'PO007').passed, false, 'an ink supplier quoting cartons is worth a look');
});

test('PO008 blocks a unit mismatch', () => {
  // Every downstream quantity and value is computed in the purchase unit.
  const result = checkLine({
    line: line({ PurchaseUnit: 'LTR' }), item: ITEM, quotes: [quote()],
    supplierGroup: GROUP, lastPaid: { rate: 820 }, plant: 'KOLKATA',
  });
  const check = find(result, 'PO008');
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'BLOCK');
});

test('the verdict reports the worst finding first', () => {
  assert.equal(verdictFor([{ checks: [] }]).level, 'OK');
  assert.equal(verdictFor([{ checks: [{ passed: false, severity: 'WARN', message: 'w' }] }]).level, 'WARN');
  assert.equal(verdictFor([{
    checks: [
      { passed: false, severity: 'WARN', message: 'w' },
      { passed: false, severity: 'BLOCK', message: 'b' },
    ],
  }]).level, 'BLOCK');
});

// ── Comparator ─────────────────────────────────────────────────────────────

test('the three plant states stay distinct', () => {
  const quotes = [
    quote({ supplierName: 'Bagla', rate: 1920 }),
    {
      supplierGroupId: 'g3', supplierName: 'NR Agarwal', state: QUOTE_STATE.NOT_AT_PLANT,
      rate: null, quotedAtPlant: 'AHMEDABAD', displayNote: 'not quoted (Ahmedabad only)',
    },
  ];
  const best = bestQuote(quotes);
  assert.equal(best.supplierName, 'Bagla', 'a rate at another plant is not a rate here');
  // A row with no rate here sorts last: a blank at the top of a price list
  // reads as "free".
  assert.equal(quotes.find((q) => q.state === QUOTE_STATE.NOT_AT_PLANT).rate, null);
});

test('an expired quote is shown but is not the best available', () => {
  const quotes = [quote({ rate: 700, isExpired: true }), quote({ rate: 820 })];
  assert.equal(bestQuote(quotes).rate, 820);
});

test('brand-defined items rank within brand, spec-defined rank outright', () => {
  const quotes = [
    quote({ supplierName: 'Siegwerk', rate: 810 }),
    quote({ supplierGroupId: 'g2', supplierName: 'Sakata', rate: 308 }),
  ];

  // Siegwerk cyan at 810 and SKT Enviro NEO cyan at 308 are not the same
  // purchase, and one ranking would say they are.
  const brand = groupForRanking(quotes, 'BRAND');
  assert.equal(brand.ranked, null);
  assert.equal(brand.byBrand.length, 2);
  assert.ok(brand.crossBrandNote);

  const spec = groupForRanking(quotes, 'SPEC');
  assert.equal(spec.byBrand, null);
  assert.equal(spec.ranked[0].rate, 308, 'cheapest first when brand is irrelevant');
});

test('ranking mode falls back item, then sub-group, then group, then BRAND', () => {
  assert.equal(rankingMode({ itemOverride: 'SPEC', itemSubGroupId: 3, itemGroupId: 3 }), 'SPEC');
  assert.equal(rankingMode({ itemSubGroupId: 27, itemGroupId: 8 }), 'BRAND', 'printing plates');
  assert.equal(rankingMode({ itemSubGroupId: 7, itemGroupId: 8 }), 'SPEC', 'packing materials');
  assert.equal(rankingMode({ itemGroupId: 5 }), 'SPEC', 'lamination film');
  // Paper carries no sub-group on any item and no default: BRAND is the
  // conservative answer because it forces a human onto the comparison.
  assert.equal(rankingMode({ itemGroupId: 14 }), 'BRAND');
});

test('the on-time window is floored at two days', () => {
  // Without the floor, short-lead items score as chronically late on rounding.
  assert.equal(onTimeToleranceDays(60), 6);
  assert.equal(onTimeToleranceDays(5), 2, '10% of 5 days is half a day — too tight to be real');
  assert.equal(onTimeToleranceDays(0), 2);
});
