/**
 * Answering "what does this word mean?".
 *
 * The panel asked CDC three questions off the Krishna Vanijya list — HI KOTE,
 * LWC, PDB — and rendered them as text with nowhere to reply. The screen posed
 * a question and offered no way to answer it, which is worse than not asking:
 * the reviewer can see the gap and cannot close it, and approval stays blocked
 * on something the interface will not let them settle.
 *
 * An unknown term is answered exactly like a brand — pick a paper type — with
 * one extra option brands do not need. HI KOTE may be a grade, a brand or a
 * marketing word, so "it means nothing about the paper" has to be recordable
 * or the same three questions arrive with every monthly list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAnswers, rulesFromAnswers, interpretPaperQuote, NOT_A_PAPER_TYPE,
} from '../services/paper/interpreter.js';
import { assessReadiness } from '../services/paper/paper-quote-schema.js';

const KV_LINES = [
  { lineNo: 1, productName: 'UNI GLOBAL PDB 230-259', paperType: null, rate: 46.5, rateUom: 'KGS' },
  { lineNo: 2, productName: 'UNI GLOBAL PDB 260 & ABOVE', paperType: null, rate: 45, rateUom: 'KGS' },
];

const KV = { supplierName: 'Krishna Vanijya', plant: 'KOLKATA', lines: KV_LINES };

test('a term answered with a type settles the lines that carry it', () => {
  const { payload, applied } = applyAnswers(KV, [
    { kind: 'UNKNOWN_TERM', token: 'PDB', paperType: 'GREY_BACK' },
  ]);
  assert.equal(applied, 2, 'both rows, matched on the token in the product name');
  assert.equal(payload.lines[0].paperType, 'GREY_BACK');
  assert.equal(payload.lines[0].paperTypeBasis, 'TAUGHT');
});

test('"not a paper type" settles the question without typing anything', () => {
  // The verdict closes the question and touches no line, which is exactly
  // right: the word means nothing about the paper.
  const { payload, applied, unapplied } = applyAnswers(KV, [
    { kind: 'UNKNOWN_TERM', token: 'PDB', paperType: NOT_A_PAPER_TYPE },
  ]);
  assert.equal(payload.lines[0].paperType, null);
  assert.equal(unapplied.length, 0, 'settled, so it must not send the round to the model');
  assert.ok(applied > 0, 'still progress — a question closed');
});

test('both kinds of verdict are remembered', () => {
  const rules = rulesFromAnswers([
    { kind: 'UNKNOWN_TERM', token: 'PDB', paperType: 'GREY_BACK' },
    { kind: 'UNKNOWN_TERM', token: 'HI KOTE', paperType: NOT_A_PAPER_TYPE },
  ], { supplierGroupId: 'kv' });

  assert.equal(rules.length, 2);
  assert.equal(rules[0].brand, 'PDB');
  assert.equal(rules[1].paperType, NOT_A_PAPER_TYPE);
  assert.ok(rules.every((r) => r.scope === 'SUPPLIER'));
});

test('a settled term stops being asked about', () => {
  // Without this the same three questions arrive with every monthly list, and
  // answering them would visibly accomplish nothing.
  const asked = assessReadiness(KV);
  assert.ok(asked.gaps.some((g) => g.kind === 'UNKNOWN_TERM' && g.token === 'PDB'));

  const settled = assessReadiness(KV, { settledTokens: ['PDB'] });
  assert.ok(!settled.gaps.some((g) => g.kind === 'UNKNOWN_TERM'));
});

test('matching a settled term ignores case', () => {
  const settled = assessReadiness(KV, { settledTokens: ['pdb'] });
  assert.ok(!settled.gaps.some((g) => g.kind === 'UNKNOWN_TERM'));
});

test('answering closes the question in the same round', async () => {
  // The answer has to count immediately. Accepting "PDB means nothing" and
  // then asking about PDB again would make the button look broken.
  const result = await interpretPaperQuote({
    priorPayload: KV,
    answers: [{ kind: 'UNKNOWN_TERM', token: 'PDB', paperType: NOT_A_PAPER_TYPE }],
    send: async () => { throw new Error('the model should not have been called'); },
  });

  assert.equal(result.rounds, 0, 'no model call — a verdict is a fact, not a judgement');
  assert.ok(!result.questions.some((q) => q.kind === 'UNKNOWN_TERM' && q.token === 'PDB'));
});

test('a term answered with a real type reaches READY', async () => {
  const result = await interpretPaperQuote({
    priorPayload: KV,
    answers: [{ kind: 'UNKNOWN_TERM', token: 'PDB', paperType: 'GREY_BACK' }],
    send: async () => { throw new Error('the model should not have been called'); },
  });

  assert.equal(result.stage, 'READY');
  assert.equal(result.payload.lines.every((l) => l.paperType === 'GREY_BACK'), true);
});

test('brand answers still behave as they did', () => {
  // The two kinds share one list and one button now; the older path must not
  // have changed underneath it.
  const { applied } = applyAnswers(
    { lines: [{ lineNo: 1, productName: 'CENTURY PRIMA FOLD RBD', brand: 'PRIMA FOLD', paperType: null, rate: 1 }] },
    [{ kind: 'PAPER_TYPE', brand: 'PRIMA FOLD', paperType: 'FBB' }],
  );
  assert.equal(applied, 1);
});
