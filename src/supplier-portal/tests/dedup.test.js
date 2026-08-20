/**
 * What counts as a duplicate.
 *
 * The EXT001 block exists for exactly one reason: approving the same file
 * twice would write its rates into `rateHistory` twice. Everything here
 * follows from that, and the case that motivated these tests is the one where
 * it does not follow — a first upload whose extraction failed had produced no
 * lines and no rates, yet still blocked the retry of the very file it failed
 * on. The user was left with a refused upload and, on the other side of the
 * refusal, an empty record with no way to re-run it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveDocument } from '../services/quotes.js';

test('a normal prior upload still blocks a re-upload', () => {
  // The whole point of the check. Two approvals of one file is two sets of
  // rates from one supplier statement.
  assert.equal(isLiveDocument({ status: 'EXTRACTED' }), true);
  assert.equal(isLiveDocument({ status: 'NEEDS_REVIEW' }), true);
  assert.equal(isLiveDocument({ status: 'APPROVED' }), true);
  assert.equal(isLiveDocument({ status: 'UPLOADED' }), true);
});

test('an upload whose extraction errored does not block the retry', () => {
  // This is the bug. The provider was unregistered, extraction threw, the
  // document was left with an error and nothing else — and it then refused the
  // re-upload as a duplicate of itself.
  assert.equal(
    isLiveDocument({ status: 'NEEDS_REVIEW', extraction: { error: 'Extraction provider "openai" is not registered.' } }),
    false,
  );
});

test('a rejected document does not block a re-upload', () => {
  // Rejecting is a decision to discard. Having discarded it, the file should
  // be uploadable again without anybody hunting for the record that refuses it.
  assert.equal(isLiveDocument({ status: 'REJECTED' }), false);
});

test('a rejected document stays non-blocking even if it extracted cleanly', () => {
  assert.equal(
    isLiveDocument({ status: 'REJECTED', extraction: { error: null, provider: 'openai' } }),
    false,
  );
});

test('nothing at all is not a live document', () => {
  assert.equal(isLiveDocument(null), false);
  assert.equal(isLiveDocument(undefined), false);
});
