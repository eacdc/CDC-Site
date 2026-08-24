/**
 * An ink quote cannot be approved before it has been read as one.
 *
 * The general extractor produces a plausible table of product names and prices
 * with no chemistry and no colour on any row. That table is approvable and
 * useless: every rate in it gets filed where no comparison can reach it, and
 * nothing on the screen says so.
 *
 * The check is COMPUTED, NEVER STORED. Every other check is written down at
 * extraction and stays true until extraction runs again; this one stops being
 * true the moment interpretation succeeds — an event that touches neither
 * extraction nor the stored checks. Stored, it would go stale in the one
 * direction that matters: still blocking a document that has since been read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inkInterpretationCheck } from '../services/quotes.js';

test('an unread ink quote is blocked', () => {
  const check = inkInterpretationCheck({ materialClass: 'INK' });
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'BLOCK');
  assert.equal(check.actualValue, 'not read');
});

test('every classification this reader owns is blocked', () => {
  /*
    One quote routinely holds all of them. Print Sales prices Capri plates, DIC
    UV ink, DIC coating and Boettcher chemicals under one letterhead, and the
    classifier picks a single label for the document — so whichever it lands on
    has to lead to the same reading.
  */
  for (const materialClass of ['INK', 'PLATE', 'CHEMICAL', 'INK_COATING']) {
    assert.equal(inkInterpretationCheck({ materialClass })?.passed, false, materialClass);
  }
});

test('a tape or film quote is NOT blocked', () => {
  /*
    The classifier's "CONSUMABLE" means tape, strapping, stretch film, stitching
    wire and cartons — none of which this reader knows anything about. Blocking
    them would stop CDC approving a tape quote until somebody ran an ink reading
    that could only produce questions with no answers.

    The panel still OFFERS itself there, because a pressroom consumable — a
    sponge, anti set-off powder, a Pantone guide — is classified the same way
    and does belong here. Offering is cheap and reversible; blocking is neither.
  */
  assert.equal(inkInterpretationCheck({ materialClass: 'CONSUMABLE' }), null);
  assert.equal(inkInterpretationCheck({ materialClass: 'FILM' }), null);
  assert.equal(inkInterpretationCheck({ materialClass: 'ADHESIVE' }), null);
  assert.equal(inkInterpretationCheck({ materialClass: 'PAPER_BOARD' }), null);
  assert.equal(inkInterpretationCheck({ materialClass: null }), null);
  assert.equal(inkInterpretationCheck({}), null);
  assert.equal(inkInterpretationCheck(null), null);
});

test('a read quote passes, and the check disappears', () => {
  assert.equal(inkInterpretationCheck({
    materialClass: 'INK_COATING',
    interpretation: { stage: 'INTERPRETED' },
  }), null);
});

test('a quote with open questions is blocked, and says which', () => {
  // "Not read" and "read but eight families still have no chemistry" call for
  // different actions, and a single message for both points at the wrong one.
  const check = inkInterpretationCheck({
    materialClass: 'INK',
    interpretation: { stage: 'NEEDS_INPUT' },
  });
  assert.equal(check.passed, false);
  assert.match(check.message, /open questions/);
});

test('a reading in flight is blocked without being called a failure', () => {
  const check = inkInterpretationCheck({
    materialClass: 'CHEMICAL',
    interpretation: { stage: 'INTERPRETING' },
  });
  assert.match(check.message, /still being read/);
});

test('a failed reading points at the error rather than at itself', () => {
  const check = inkInterpretationCheck({
    materialClass: 'PLATE',
    interpretation: { stage: 'FAILED' },
  });
  assert.match(check.message, /could not be read/);
});
