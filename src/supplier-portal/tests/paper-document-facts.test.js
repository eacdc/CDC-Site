/**
 * The gate must not ask what the document already answered.
 *
 * CDC read a Sudarshan maplitho list and saw two panels disagree on the same
 * screen: "PLANT 98% sure Kolkata", confirmed against CDC's own West Bengal
 * GSTIN, directly under "Which plant do these rates apply to?".
 *
 * Both were right about their own inputs. Identification reads the addressee
 * block and a person confirms it; the interpreter reads the page again and its
 * plant came back null. Two readings of one document that had never been
 * introduced to each other, and the reviewer left holding the contradiction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentFacts, interpretPaperQuote } from '../services/paper/interpreter.js';

const LINE = {
  lineNo: 1, productName: 'ORIENT PLATINUM MAPLITHO', paperType: 'MAPLITHO',
  rate: 69.5, rateUom: 'KGS',
};

test('a plant the document settled fills a gap in the reading', () => {
  const out = applyDocumentFacts(
    { plant: null, supplierName: null, lines: [LINE] },
    { plant: 'KOLKATA', supplierName: 'Sudarshan Paper & Board Pvt Ltd' },
  );
  assert.equal(out.plant, 'KOLKATA');
  assert.equal(out.supplierName, 'Sudarshan Paper & Board Pvt Ltd');
});

test('the document never overwrites what the interpreter actually read', () => {
  // A document whose plant was assumed must not silently override a plant
  // printed in the rate columns — that is the NR case, where the page itself
  // is the better evidence.
  const out = applyDocumentFacts(
    { plant: 'AHMEDABAD', supplierName: 'Read From Letterhead', lines: [LINE] },
    { plant: 'KOLKATA', supplierName: 'Something Else' },
  );
  assert.equal(out.plant, 'AHMEDABAD');
  assert.equal(out.supplierName, 'Read From Letterhead');
});

test('no facts, no change', () => {
  const payload = { plant: null, lines: [LINE] };
  assert.equal(applyDocumentFacts(payload, null), payload);
  assert.equal(applyDocumentFacts(payload, {}), payload);
});

test('a document that knows only the plant supplies only the plant', () => {
  const out = applyDocumentFacts({ lines: [LINE] }, { plant: 'KOLKATA' });
  assert.equal(out.plant, 'KOLKATA');
  assert.equal(out.supplierName, null);
});

test('the plant question disappears once the document supplies it', async () => {
  // End to end through the gate: the same payload that asked before now
  // reaches READY, because the only thing missing was already on file.
  const payload = {
    supplierName: null, plant: null,
    lines: [LINE],
  };
  const send = async () => ({ understanding: 'Maplitho list.', payload });

  const without = await interpretPaperQuote({ send });
  assert.equal(without.stage, 'INCOMPLETE');
  assert.ok(without.questions.some((q) => q.kind === 'PLANT'));

  const with_ = await interpretPaperQuote({
    send,
    documentFacts: { plant: 'KOLKATA', supplierName: 'Sudarshan Paper & Board Pvt Ltd' },
  });
  assert.equal(with_.stage, 'READY');
  assert.deepEqual(with_.questions, []);
});

test('facts apply on the no-model round too', async () => {
  // The second round folds answers in without calling the model. It has to
  // apply the document's facts as well, or answering the last paper-type
  // question would still leave a plant gap that nothing could close.
  const result = await interpretPaperQuote({
    priorPayload: {
      supplierName: null, plant: null,
      lines: [{ ...LINE, paperType: null, brand: 'PLATINUM' }],
    },
    answers: [{ kind: 'PAPER_TYPE', brand: 'PLATINUM', paperType: 'MAPLITHO' }],
    documentFacts: { plant: 'KOLKATA', supplierName: 'Sudarshan' },
    send: async () => { throw new Error('the model should not have been called'); },
  });

  assert.equal(result.rounds, 0);
  assert.equal(result.stage, 'READY');
});
