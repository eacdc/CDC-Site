/**
 * A split half keeps only its own plant's lines.
 *
 * The NR board list prices 24 products for Kolkata and the same 24 for
 * Ahmedabad — 48 rates on one page. The file is split into two documents, one
 * per plant, and then the paper reading re-reads the whole file, because the
 * PDF is one file and there is no half of it to read.
 *
 * Both halves were being handed all 48. Kolkata showed every Ahmedabad rate and
 * Ahmedabad showed every Kolkata one, each product appearing twice at two
 * different prices — and since the Ahmedabad rates run Rs 4,000/MT below
 * Kolkata's, the cheaper of the two would have won every comparison at the
 * wrong plant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPlantLines, interpretPaperQuote } from '../services/paper/interpreter.js';

/** Three products, both plants, as the NR sheet prices them. */
function bothPlants() {
  const lines = [];
  let lineNo = 1;
  for (const [plant, base] of [['KOLKATA', 72336], ['AHMEDABAD', 68336]]) {
    for (const brand of ['MAXIMA', 'EXCEL', 'SHINE']) {
      lines.push({
        lineNo: lineNo++, productName: `NR ${brand} SS (REEL)`, brand,
        paperType: 'FBB', plant, rate: base, rateUom: 'MT',
      });
    }
  }
  return { supplierName: 'NR', lines };
}

test('a Kolkata half keeps only Kolkata rates', () => {
  const out = selectPlantLines(bothPlants(), 'KOLKATA');
  assert.equal(out.lines.length, 3, 'three, not six');
  assert.ok(out.lines.every((l) => l.plant === 'KOLKATA'));
  assert.equal(out.lines[0].rate, 72336);
});

test('an Ahmedabad half keeps only Ahmedabad rates', () => {
  const out = selectPlantLines(bothPlants(), 'AHMEDABAD');
  assert.equal(out.lines.length, 3);
  assert.equal(out.lines[0].rate, 68336, 'the Rs 4,000 cheaper side, and only it');
});

test('plant names are matched however the document wrote them', () => {
  const payload = {
    lines: [
      { lineNo: 1, plant: 'FOR KOLKATA - REEL', rate: 1 },
      { lineNo: 2, plant: 'AHM', rate: 2 },
    ],
  };
  assert.equal(selectPlantLines(payload, 'KOLKATA').lines.length, 1);
  assert.equal(selectPlantLines(payload, 'AHMEDABAD').lines[0].lineNo, 2);
});

test('a single-plant document is left entirely alone', () => {
  // The failure this must never cause. Sudarshan's lists name one plant or
  // none, and quietly dropping rows there would be far worse than the bug
  // being fixed — a price list that silently lost half its products.
  const payload = {
    lines: [
      { lineNo: 1, plant: 'KOLKATA', rate: 1 },
      { lineNo: 2, plant: 'KOLKATA', rate: 2 },
    ],
  };
  assert.equal(selectPlantLines(payload, 'KOLKATA').lines.length, 2);
});

test('lines with no plant at all are kept', () => {
  const payload = { lines: [{ lineNo: 1, rate: 1 }, { lineNo: 2, rate: 2 }] };
  assert.equal(selectPlantLines(payload, 'KOLKATA').lines.length, 2);
});

test('an unattributed line stays in both halves', () => {
  // The same rule the split itself uses: a row the document never attributed
  // is likelier to apply to both plants than to belong to one, and losing a
  // priced row silently is the worst outcome available.
  const payload = {
    lines: [
      { lineNo: 1, plant: 'KOLKATA', rate: 1 },
      { lineNo: 2, plant: 'AHMEDABAD', rate: 2 },
      { lineNo: 3, rate: 3 },
    ],
  };
  assert.deepEqual(selectPlantLines(payload, 'KOLKATA').lines.map((l) => l.lineNo), [1, 3]);
  assert.deepEqual(selectPlantLines(payload, 'AHMEDABAD').lines.map((l) => l.lineNo), [2, 3]);
});

test('no owned plant means no filtering', () => {
  const payload = bothPlants();
  assert.equal(selectPlantLines(payload, null), payload);
});

test('the filter runs inside the loop, before anything is stored', async () => {
  const payload = bothPlants();
  const send = async () => ({ understanding: 'NR board list, both plants.', payload });

  const all = await interpretPaperQuote({ send, documentFacts: { plant: 'KOLKATA' } });
  assert.equal(all.payload.lines.length, 6, 'unfiltered, both plants');

  const kol = await interpretPaperQuote({
    send, ownedPlant: 'KOLKATA', documentFacts: { plant: 'KOLKATA' },
  });
  assert.equal(kol.payload.lines.length, 3);
  assert.ok(kol.payload.lines.every((l) => l.plant === 'KOLKATA'));
});

test('the no-model round filters too', async () => {
  // Answering a question must not quietly restore the other plant's rows.
  const result = await interpretPaperQuote({
    priorPayload: {
      supplierName: 'NR', plant: 'KOLKATA',
      lines: bothPlants().lines.map((l) => ({ ...l, paperType: null })),
    },
    answers: [{ kind: 'PAPER_TYPE', brand: 'MAXIMA', paperType: 'FBB' }],
    ownedPlant: 'KOLKATA',
    send: async () => { throw new Error('the model should not have been called'); },
  });

  assert.equal(result.rounds, 0);
  assert.ok(result.payload.lines.every((l) => l.plant === 'KOLKATA'));
});
