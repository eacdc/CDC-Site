/**
 * A paper quote cannot be approved until it has been read as one.
 *
 * The hole this closes: the general extractor runs on upload, classifies the
 * document as PAPER_BOARD, and produces a plausible-looking table that names no
 * grade — because flattening a board line into a product name is exactly what
 * it does, and it cannot ask a question. That table was approvable. A reviewer
 * could accept it without ever noticing the paper reading existed, and the
 * rates would go into history with nothing to compare them against.
 *
 * COMPUTED, NEVER STORED. Every other check is written down at extraction and
 * stays true until extraction runs again. This one stops being true the moment
 * interpretation succeeds — an event that touches neither extraction nor the
 * stored checks. Stored, it would go stale in the one direction that matters:
 * still blocking a document that has since been read properly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { paperInterpretationCheck } from '../services/quotes.js';

test('a paper quote never read as one is blocked', () => {
  const check = paperInterpretationCheck({ materialClass: 'PAPER_BOARD' });
  assert.ok(check);
  assert.equal(check.code, 'EXT013');
  assert.equal(check.severity, 'BLOCK');
  assert.equal(check.passed, false);
  assert.equal(check.actualValue, 'not read');
});

test('once interpreted, it stops blocking', () => {
  // The transition that makes storing this wrong: nothing about extraction has
  // changed, and the check has to notice anyway.
  assert.equal(paperInterpretationCheck({
    materialClass: 'PAPER_BOARD',
    interpretation: { stage: 'INTERPRETED' },
  }), null);
});

test('a reading with open questions still blocks, and says so', () => {
  // Answering is the point. A half-read quote is not a read one.
  const check = paperInterpretationCheck({
    materialClass: 'PAPER_BOARD',
    interpretation: { stage: 'NEEDS_INPUT' },
  });
  assert.equal(check.passed, false);
  assert.match(check.message, /open questions/);
});

test('a failed reading blocks with its own message', () => {
  const check = paperInterpretationCheck({
    materialClass: 'PAPER_BOARD',
    interpretation: { stage: 'FAILED' },
  });
  assert.match(check.message, /could not be read/);
});

test('a reading in flight blocks rather than racing the approval', () => {
  const check = paperInterpretationCheck({
    materialClass: 'PAPER_BOARD',
    interpretation: { stage: 'INTERPRETING' },
  });
  assert.equal(check.passed, false);
});

test('nothing else is affected', () => {
  // Inks, tapes and films still take the one-shot path, and a guard that fired
  // on them would block every quote CDC uploads.
  assert.equal(paperInterpretationCheck({ materialClass: 'INK' }), null);
  assert.equal(paperInterpretationCheck({ materialClass: 'CONSUMABLE' }), null);
  assert.equal(paperInterpretationCheck({ materialClass: null }), null);
  assert.equal(paperInterpretationCheck({}), null);
  assert.equal(paperInterpretationCheck(null), null);
});

test('the block cannot be waived with a reason', () => {
  // BLOCK, not WARN, and the difference is not severity theatre. A reviewer who
  // has not run the paper reading has nothing to weigh, so a typed reason would
  // be a reason for a decision nobody is in a position to make.
  const check = paperInterpretationCheck({ materialClass: 'PAPER_BOARD' });
  assert.equal(check.severity, 'BLOCK');
  assert.equal(check.overrideReason, undefined);
});
