/**
 * Units written as a phrase rather than a symbol.
 *
 * A strapping-tape quote produced seven blocking errors, each reading
 * `Unit "Per Kg" is not in the normalisation table`. It was — KG has been in
 * the seed since the first commit, and so has ROLL. The units were refused
 * over the word in front of them: `key()` strips punctuation, so "/KG"
 * resolved and "Per Kg" became "PERKG" and matched nothing.
 *
 * The failure mode is what makes this worth pinning. It did not look like a
 * parsing gap; it looked like a data gap, and it pointed a reviewer at the
 * normalisation table to add an entry that was already there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseUom, uomOverridesFrom } from '../lib/uom.js';

test('"Per Kg" resolves — the spelling that produced three blocking errors', () => {
  const r = normaliseUom('Per Kg');
  assert.equal(r.canonical, 'KG');
  assert.ok(!r.unknown);
});

test('"Per Roll" resolves, and ROLL is a unit we can compare', () => {
  // Rolls are countable, so ₹34.50 per roll compares to another supplier's
  // ₹/roll directly. Nothing about this needed a human.
  const r = normaliseUom('Per Roll');
  assert.equal(r.canonical, 'ROLL');
  assert.ok(!r.isAmbiguous);
});

test('a currency prefix is peeled too', () => {
  assert.equal(normaliseUom('Rs/Kg').canonical, 'KG');
  assert.equal(normaliseUom('Rs. per Kg').canonical, 'KG');
});

test('case and spacing do not matter', () => {
  assert.equal(normaliseUom('per pc').canonical, 'PCS');
  assert.equal(normaliseUom('PER SHEET').canonical, 'SHEET');
});

test('"Per Inch" still asks a human', () => {
  // Correctly ambiguous, and it must stay that way: an inch of film is not a
  // quantity without a width and a thickness, so ₹230 "per inch" cannot be
  // compared to anything until somebody says what it means.
  const r = normaliseUom('Per Inch');
  assert.equal(r.canonical, null);
  assert.equal(r.isAmbiguous, true);
});

test('peeling never invents a unit', () => {
  // "PERCENT" strips to "CENT", which resolves to nothing, so the original
  // answer stands. A prefix is only dropped when the remainder is a real unit.
  const r = normaliseUom('percent');
  assert.equal(r.canonical, null);
  assert.equal(r.unknown, true);
});

test('an unprefixed spelling is unaffected', () => {
  assert.equal(normaliseUom('KG').canonical, 'KG');
  assert.equal(normaliseUom('/KG').canonical, 'KG');
  assert.equal(normaliseUom('MT').canonical, 'KG');
  assert.equal(normaliseUom('MT').factor, 1000);
});

test('the purchase team\'s own table still wins, phrase or not', () => {
  // The override table is edited by people and must beat the seed. A phrasing
  // fix that quietly took precedence over a human decision would be worse than
  // the bug it replaced.
  const overrides = uomOverridesFrom([{ raw: 'KG', canonical: 'PCS', factor: 7 }]);
  const r = normaliseUom('Per Kg', overrides);
  assert.equal(r.canonical, 'PCS');
  assert.equal(r.factor, 7);
});
