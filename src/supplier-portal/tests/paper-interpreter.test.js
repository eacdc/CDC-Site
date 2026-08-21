/**
 * The interpretation loop.
 *
 * The model is stubbed throughout. What is being tested is the control flow
 * around it — when it is called, when it is not, what it is told when it gets
 * something wrong, and which answers never reach it at all.
 *
 * That last one carries the most weight. The commonest question is "what paper
 * type is this brand?", and its answer is a fact rather than a judgement.
 * Sending it back to the model would cost a full document read to be told
 * something already known, and hand it the opportunity to revise a line nobody
 * asked about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAnswers, resolveKnownTypes, rulesFromAnswers,
  interpretPaperQuote, summarisePreviousQuote,
} from '../services/paper/interpreter.js';
import { buildInterpretationMessage } from '../services/paper/paper-prompt.js';

/** Sudarshan's Virgin list: two forms per product, no type stated anywhere. */
function virginPayload() {
  return {
    supplierName: 'SUDARSHAN PAPER AND BOARD PRIVATE LIMITED',
    plant: 'KOLKATA',
    listContext: 'DO BASED EX-STOCK PRICE LIST - VIRGIN BOARD',
    lines: [
      { lineNo: 1, productName: 'CENTURY PRIMA FOLD RBD', brand: 'PRIMA FOLD', paperType: null, form: 'SHEET', gsmFrom: 190, gsmTo: 400, rate: 77.5, rateUom: 'KGS' },
      { lineNo: 2, productName: 'CENTURY PRIMA FOLD RLS', brand: 'PRIMA FOLD', paperType: null, form: 'REEL', gsmFrom: 190, gsmTo: 400, rate: 74.5, rateUom: 'KGS' },
      { lineNo: 3, productName: 'ITC SAFIRE GRAPHIK RBD', brand: 'SAFIRE GRAPHIK', paperType: null, form: 'SHEET', gsmFrom: 190, gsmTo: 400, rate: 80.5, rateUom: 'KGS' },
    ],
  };
}

/**
 * A stub model that replies from a queue and repeats its last reply once the
 * queue empties — so "this model keeps making the same mistake" is expressible.
 */
function stubModel(replies) {
  const calls = [];
  const queue = [...replies];
  let last = replies[replies.length - 1];
  return {
    calls,
    send: async (args) => {
      calls.push(args);
      if (queue.length) last = queue.shift();
      return last;
    },
  };
}

// ── Answers that never reach the model ──────────────────────────────────────

test('one brand answer settles every line of that brand', () => {
  // Both forms at once. This is why the questions are grouped by brand.
  const { payload, applied } = applyAnswers(virginPayload(), [
    { kind: 'PAPER_TYPE', brand: 'PRIMA FOLD', paperType: 'FBB' },
  ]);

  assert.equal(applied, 2);
  assert.equal(payload.lines[0].paperType, 'FBB');
  assert.equal(payload.lines[1].paperType, 'FBB');
  assert.equal(payload.lines[0].paperTypeBasis, 'TAUGHT');
  assert.equal(payload.lines[2].paperType, null, 'a different brand is untouched');
});

test('an answer matches the product name when the brand field is empty', () => {
  const payload = { lines: [{ lineNo: 1, productName: 'CENTURY PRIMA FOLD RBD', paperType: null, rate: 1 }] };
  const { applied } = applyAnswers(payload, [
    { kind: 'PAPER_TYPE', brand: 'PRIMA FOLD', paperType: 'FBB' },
  ]);
  assert.equal(applied, 1);
});

test('an answer never overwrites a type already established', () => {
  const payload = { lines: [{ lineNo: 1, productName: 'X', brand: 'B', paperType: 'CBB', rate: 1 }] };
  const { payload: out, applied } = applyAnswers(payload, [
    { kind: 'PAPER_TYPE', brand: 'B', paperType: 'FBB' },
  ]);
  assert.equal(applied, 0);
  assert.equal(out.lines[0].paperType, 'CBB');
});

test('a brand name that appears nowhere applies to nothing', () => {
  const { applied } = applyAnswers(virginPayload(), [
    { kind: 'PAPER_TYPE', brand: 'SOMETHING ELSE', paperType: 'FBB' },
  ]);
  assert.equal(applied, 0);
});

test('brand matching is whole-word', () => {
  // "GC1" must not settle "GC10".
  const payload = { lines: [{ lineNo: 1, productName: 'BOARDONE GC10', paperType: null, rate: 1 }] };
  const { applied } = applyAnswers(payload, [{ kind: 'PAPER_TYPE', brand: 'GC1', paperType: 'FBB' }]);
  assert.equal(applied, 0);
});

test('the second round needs no model call at all', async () => {
  // A prior payload plus structured answers is the common second round. Going
  // back to the model would cost a document read to be told what we know.
  const model = stubModel([{}]);
  const result = await interpretPaperQuote({
    priorPayload: virginPayload(),
    answers: [
      { kind: 'PAPER_TYPE', brand: 'PRIMA FOLD', paperType: 'FBB' },
      { kind: 'PAPER_TYPE', brand: 'SAFIRE GRAPHIK', paperType: 'CBB' },
    ],
    send: model.send,
  });

  assert.equal(model.calls.length, 0, 'the model was never asked');
  assert.equal(result.rounds, 0);
  assert.equal(result.stage, 'READY');
  assert.equal(result.payload.lines.every((l) => l.paperType), true);
});

test('a free-form answer does go back to the model', async () => {
  const model = stubModel([{ understanding: 'read again', payload: virginPayload() }]);
  await interpretPaperQuote({
    priorPayload: virginPayload(),
    answers: [{ kind: 'FREE_TEXT', answer: 'all the Century ones are FBB' }],
    send: model.send,
  });
  assert.equal(model.calls.length, 1);
});

// ── The vocabulary runs before the model is trusted ─────────────────────────

test('a type the vocabulary knows is filled in without asking', () => {
  const payload = {
    lines: [
      { lineNo: 1, productName: 'MEHALI ECO GREEN GB', paperType: null, rate: 54 },
      { lineNo: 2, productName: 'ITC CARTE LUMINA', paperType: null, rate: 80.5 },
      { lineNo: 3, productName: 'CENTURY PRIMA FOLD', paperType: null, rate: 77.5 },
    ],
  };
  const { payload: out, resolved } = resolveKnownTypes(payload);

  assert.equal(resolved, 2);
  assert.equal(out.lines[0].paperType, 'GREY_BACK');
  assert.equal(out.lines[1].paperType, 'CBB', 'a confirmed brand');
  assert.equal(out.lines[2].paperType, null, 'genuinely unknown, so it will be asked');
});

test('the vocabulary never overrides what the model established', () => {
  const payload = { lines: [{ lineNo: 1, productName: 'MEHALI ECO GREEN GB', paperType: 'WHITE_BACK', rate: 1 }] };
  assert.equal(resolveKnownTypes(payload).payload.lines[0].paperType, 'WHITE_BACK');
});

// ── The loop ────────────────────────────────────────────────────────────────

test('a complete reading hands off in one round', async () => {
  const model = stubModel([{
    understanding: 'Sudarshan recycled board list, Kolkata, rates per kg.',
    payload: {
      supplierName: 'SUDARSHAN', plant: 'KOLKATA',
      lines: [{ lineNo: 1, productName: 'MEHALI ECO GREEN GB', paperType: 'GREY_BACK', rate: 54, rateUom: 'KGS' }],
    },
  }]);

  const result = await interpretPaperQuote({ send: model.send });
  assert.equal(result.stage, 'READY');
  assert.equal(result.rounds, 1);
  assert.match(result.understanding, /recycled board/);
});

test('an incomplete reading returns questions rather than repairing', async () => {
  // INCOMPLETE is a person's question, not a fault. Spending another model call
  // on it would ask the model to invent what it correctly declined to guess.
  const model = stubModel([{ understanding: 'Virgin list.', payload: virginPayload() }]);
  const result = await interpretPaperQuote({ send: model.send });

  assert.equal(model.calls.length, 1, 'asked once, not repaired');
  assert.equal(result.stage, 'INCOMPLETE');
  assert.equal(result.questions.filter((q) => q.kind === 'PAPER_TYPE').length, 2);
});

test('an invalid payload is sent back with the exact errors, and recovers', async () => {
  const bad = { supplierName: 'X', plant: 'KOLKATA', lines: [{ lineNo: 1, productName: 'A', paperType: 'NOT A TYPE', rate: 5 }] };
  const good = { supplierName: 'X', plant: 'KOLKATA', lines: [{ lineNo: 1, productName: 'A', paperType: 'FBB', rate: 5 }] };
  const model = stubModel([{ payload: bad }, { payload: good }]);

  const result = await interpretPaperQuote({ send: model.send });

  assert.equal(model.calls.length, 2);
  assert.equal(result.stage, 'READY');
  assert.match(model.calls[1].message, /YOUR PREVIOUS REPLY WAS REJECTED/);
  assert.match(model.calls[1].message, /paperType/);
});

test('repair attempts are bounded', async () => {
  const bad = { supplierName: 'X', plant: 'KOLKATA', lines: [{ lineNo: 1, productName: 'A', paperType: 'STILL WRONG', rate: 5 }] };
  const model = stubModel([{ payload: bad }]);

  const result = await interpretPaperQuote({ send: model.send });

  assert.equal(model.calls.length, 3, 'one attempt plus two repairs, then it stops');
  assert.equal(result.stage, 'INVALID');
  assert.ok(result.errors.length);
});

test('the loop refuses to run without a model', async () => {
  await assert.rejects(() => interpretPaperQuote({}), /needs a send function/);
});

// ── What the model is told ──────────────────────────────────────────────────

test('confirmed brands are handed over so they are not asked about again', () => {
  const message = buildInterpretationMessage({
    canonicalTypes: [{ canonical: 'FBB', label: 'FBB' }],
    knownBrands: [{ brand: 'CARTE LUMINA', paperType: 'CBB', scope: 'GLOBAL' }],
  });
  assert.match(message, /CARTE LUMINA -> CBB/);
  assert.match(message, /Do not ask about them again/);
});

test('the canonical list is always included, so paperType cannot be invented', () => {
  const message = buildInterpretationMessage({
    canonicalTypes: [{ canonical: 'GREY_BACK', label: 'Grey back' }],
  });
  assert.match(message, /GREY_BACK {2}Grey back/);
});

test('a previous reading is offered as context', () => {
  const summary = summarisePreviousQuote({
    listContext: 'VIRGIN BOARD',
    lines: [
      { productName: 'ITC CARTE LUMINA', brand: 'CARTE LUMINA', paperType: 'CBB', rateUom: 'KGS' },
      { productName: 'CENTURY PRIMA FOLD', brand: 'PRIMA FOLD', paperType: 'FBB', rateUom: 'KGS' },
    ],
  });
  assert.match(summary, /VIRGIN BOARD/);
  assert.match(summary, /CARTE LUMINA -> CBB/);

  const message = buildInterpretationMessage({ previousSummary: summary });
  assert.match(message, /same document with new prices/);
});

test('a supplier with no history summarises to nothing', () => {
  assert.equal(summarisePreviousQuote({ lines: [] }), null);
  assert.equal(summarisePreviousQuote(null), null);
});

// ── What gets remembered ────────────────────────────────────────────────────

test('answers become supplier-scoped rules', () => {
  // Scoped to the supplier because "DO" means one thing on AKT's note and could
  // mean another elsewhere. Promotion to global should be a deliberate act.
  const rules = rulesFromAnswers([
    { kind: 'PAPER_TYPE', brand: 'PRIMA FOLD', paperType: 'FBB' },
    { kind: 'FREE_TEXT', answer: 'ignore me' },
  ], { supplierGroupId: 'sup1' });

  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    brand: 'PRIMA FOLD', paperType: 'FBB', scope: 'SUPPLIER', supplierGroupId: 'sup1',
  });
});
