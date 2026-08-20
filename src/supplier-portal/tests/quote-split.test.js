/**
 * Splitting a quote that prices both plants.
 *
 * Built against a real NR board quote: three brands, eight GSM bands, Kolkata
 * and Ahmedabad in two side-by-side rate columns — 48 rates on one page, with
 * Ahmedabad exactly ₹4,000 below Kolkata on every row.
 *
 * The rule these protect is that rates never cross plants. A Kolkata rate
 * filed against Ahmedabad is silent, permanent, and shows up later as a
 * supplier who appears to have undercut everyone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePlant, groupLinesByPlant, planPlantSplit } from '../services/quote-split.js';

/** Two rate columns, one set of bands — the layout that motivated all this. */
function nrQuoteLines() {
  const bands = [['54', '55'], ['56', '57'], ['58', '59'], ['60', '63']];
  const lines = [];
  let lineNo = 1;
  for (const [plant, base] of [['KOLKATA', 72336], ['AHMEDABAD', 68336]]) {
    for (const [gsmFrom, gsmTo] of bands) {
      lines.push({
        lineNo: lineNo++,
        plant,
        mill: 'NR',
        brand: 'MAXIMA',
        grade: 'SS',
        brightness: '84B',
        productForm: 'REEL',
        gsmFrom,
        gsmTo,
        rate: String(base - (Number(gsmFrom) - 54) * 250),
      });
    }
  }
  return lines;
}

// ── normalisePlant ──────────────────────────────────────────────────────────

test('Tangra and Panchla are both Kolkata', () => {
  // Both CDC units share the IndusEnterprise database. An address naming
  // either one is Kolkata, and treating them as separate plants would split
  // one plant's rate history in half.
  assert.equal(normalisePlant('Tangra'), 'KOLKATA');
  assert.equal(normalisePlant('PANCHLA'), 'KOLKATA');
  assert.equal(normalisePlant('FOR KOLKATA - REEL'), 'KOLKATA');
});

test('Ahmedabad and Gujarat are Ahmedabad', () => {
  assert.equal(normalisePlant('FOR AHMEDABAD - REEL'), 'AHMEDABAD');
  assert.equal(normalisePlant('gujarat'), 'AHMEDABAD');
});

test('an unrecognised plant is null, never a guess', () => {
  assert.equal(normalisePlant('Mumbai'), null);
  assert.equal(normalisePlant(''), null);
  assert.equal(normalisePlant(null), null);
});

// ── Grouping ────────────────────────────────────────────────────────────────

test('the NR quote splits into two plants, all rates kept', () => {
  const lines = nrQuoteLines();
  const { plants, groups } = groupLinesByPlant(lines);

  assert.deepEqual(plants.sort(), ['AHMEDABAD', 'KOLKATA']);
  assert.equal(groups.get('KOLKATA').length, 4);
  assert.equal(groups.get('AHMEDABAD').length, 4);
  // Nothing invented, nothing lost.
  assert.equal(groups.get('KOLKATA').length + groups.get('AHMEDABAD').length, lines.length);
});

test('each plant keeps its own rates', () => {
  const { groups } = groupLinesByPlant(nrQuoteLines());
  assert.equal(groups.get('KOLKATA')[0].rate, '72336');
  assert.equal(groups.get('AHMEDABAD')[0].rate, '68336');
});

test('plantBlocks works when lines carry no plant of their own', () => {
  // The other layout: separate blocks, one after the other.
  const lines = [
    { lineNo: 1, rate: '100' },
    { lineNo: 2, rate: '200' },
    { lineNo: 3, rate: '300' },
  ];
  const blocks = [
    { plant: 'Kolkata', lineNos: [1, 2] },
    { plant: 'Ahmedabad', lineNos: [3] },
  ];
  const { groups } = groupLinesByPlant(lines, blocks);
  assert.equal(groups.get('KOLKATA').length, 2);
  assert.equal(groups.get('AHMEDABAD').length, 1);
});

test('a line\'s own plant beats plantBlocks', () => {
  // The line-level value came from the rate column the row was actually in.
  const lines = [{ lineNo: 1, plant: 'Ahmedabad', rate: '100' }];
  const blocks = [{ plant: 'Kolkata', lineNos: [1] }];
  const { groups } = groupLinesByPlant(lines, blocks);
  assert.equal(groups.get('AHMEDABAD').length, 1);
  assert.equal(groups.has('KOLKATA'), false);
});

test('an unplaced line goes to both plants rather than being dropped', () => {
  // A band printed once against both columns applies to both. Dropping it
  // loses a real rate; putting it in the first group invents a distinction the
  // document never made.
  const lines = [
    { lineNo: 1, plant: 'Kolkata', rate: '100' },
    { lineNo: 2, plant: 'Ahmedabad', rate: '90' },
    { lineNo: 3, rate: '50' },
  ];
  const { groups, unplaced } = groupLinesByPlant(lines);
  assert.equal(unplaced.length, 1);
  assert.equal(groups.get('KOLKATA').length, 2);
  assert.equal(groups.get('AHMEDABAD').length, 2);
  assert.ok(groups.get('KOLKATA').some((l) => l.lineNo === 3));
  assert.ok(groups.get('AHMEDABAD').some((l) => l.lineNo === 3));
});

test('lines come back in document order', () => {
  const lines = [
    { lineNo: 9, plant: 'Kolkata', rate: '1' },
    { lineNo: 2, plant: 'Kolkata', rate: '2' },
  ];
  const { groups } = groupLinesByPlant(lines);
  assert.deepEqual(groups.get('KOLKATA').map((l) => l.lineNo), [2, 9]);
});

// ── The split plan ──────────────────────────────────────────────────────────

test('a single-plant document is not split at all', () => {
  // The common case has to stay free: returning a plan here would put every
  // upload through the split path.
  assert.equal(planPlantSplit([{ lineNo: 1, plant: 'Kolkata', rate: '1' }]), null);
});

test('a document naming no plant is not split', () => {
  assert.equal(planPlantSplit([{ lineNo: 1, rate: '1' }, { lineNo: 2, rate: '2' }]), null);
});

test('the two-plant quote plans one kept document and one new one', () => {
  const plan = planPlantSplit(nrQuoteLines());
  assert.ok(plan);
  assert.equal(plan.keep.plant, 'KOLKATA', 'Kolkata stays on the open document');
  assert.equal(plan.spawn.length, 1);
  assert.equal(plan.spawn[0].plant, 'AHMEDABAD');
  assert.equal(plan.keep.lines.length + plan.spawn[0].lines.length, 8);
});

test('Ahmedabad-only quotes keep their own plant, not Kolkata', () => {
  const lines = [
    { lineNo: 1, plant: 'Ahmedabad', rate: '1' },
    { lineNo: 2, plant: 'Ahmedabad', rate: '2' },
  ];
  assert.equal(planPlantSplit(lines), null);
});
