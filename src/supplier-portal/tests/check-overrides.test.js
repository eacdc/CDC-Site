/**
 * Ignoring a blocking check on a GRN: refused without a reason, kept through a
 * re-run while its check still fails, dropped once it passes, and the post
 * gate worked out from the stored checks and ignores alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { check, warningsNeedingReason } from '../config/validations.js';
import {
  NOT_IGNORABLE, canIgnore, ignoreCheck, undoIgnore, liveIgnores, withIgnores, unresolvedBlocks,
} from '../services/check-overrides.js';
import { documentSetSchema } from '../models/schemas.js';

const AT = new Date('2026-10-27T10:00:00Z');
const WHO = { by: 'manu@erp.kol', byName: 'Manu', at: AT };

/** A run with a failing line block, a failing document block, a warning, and a pass. */
function run({ ratePasses = false, taxablePasses = false } = {}) {
  return [
    check('INV001', true),
    check('INV005', ratePasses, { lineNo: 1, message: 'Line 1: invoiced at ₹52, PO says ₹50' }),
    check('INV005', true, { lineNo: 2 }),
    check('INV008', taxablePasses, { message: 'Taxable value 10,500 does not equal subtotal + freight 10,450' }),
    check('INV014', false),
  ];
}

test('a failing block is ignored with a reason, and no longer blocks', () => {
  const checks = run();
  assert.equal(unresolvedBlocks(checks, []).length, 2);

  const { ignored, error } = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: '  Rate agreed by phone with the buyer  ', ...WHO });
  assert.equal(error, undefined);
  assert.deepEqual(ignored, [{
    code: 'INV005', lineNo: 1, reason: 'Rate agreed by phone with the buyer',
    message: 'Line 1: invoiced at ₹52, PO says ₹50', by: 'manu@erp.kol', byName: 'Manu', at: AT,
  }]);
  assert.deepEqual(unresolvedBlocks(checks, ignored).map((c) => c.code), ['INV008']);

  // A document check has no line; the line number from a client as a string is the same line.
  const both = ignoreCheck(ignored, checks, { code: 'INV008', reason: 'Supplier rounded freight', ...WHO }).ignored;
  assert.equal(both.length, 2);
  assert.equal(both[1].lineNo, null);
  assert.deepEqual(unresolvedBlocks(checks, both), []);
  assert.equal(ignoreCheck([], checks, { code: 'INV005', lineNo: '1', reason: 'x', ...WHO }).ignored[0].lineNo, 1);
});

test('ignoring the same check again replaces its reason', () => {
  const checks = run();
  const first = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: 'first', ...WHO }).ignored;
  const again = ignoreCheck(first, checks, { code: 'INV005', lineNo: 1, reason: 'second', ...WHO }).ignored;
  assert.deepEqual(again.map((o) => o.reason), ['second']);
});

test('refused without a reason, for a check that is not failing, and for one that cannot be ignored', () => {
  const checks = [...run().filter((c) => c.code !== 'INV001'), check('INV001', false), check('INV002', false, { lineNo: 3 }), check('INV013', false), check('INV018', false)];
  for (const reason of [undefined, null, '', '   ']) {
    const r = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason, ...WHO });
    assert.equal(r.status, 400);
    assert.match(r.error, /reason/);
    assert.equal(r.ignored, undefined);
  }
  // Passing, on another line, a warning, or a code that is not there at all.
  assert.equal(ignoreCheck([], checks, { code: 'INV005', lineNo: 2, reason: 'x', ...WHO }).status, 404);
  assert.equal(ignoreCheck([], checks, { code: 'INV005', reason: 'x', ...WHO }).status, 404);
  assert.equal(ignoreCheck([], checks, { code: 'INV014', reason: 'x', ...WHO }).status, 404);
  assert.equal(ignoreCheck([], checks, { code: 'INV999', reason: 'x', ...WHO }).status, 404);
  // A line on no PO would be left off the GRN; freight needs its ledger to be written at all;
  // an invoice already posted would be received twice; one not billed to CDC is not ours.
  for (const [code, lineNo] of [['INV001', null], ['INV002', 3], ['INV013', null], ['INV018', null]]) {
    const r = ignoreCheck([], checks, { code, lineNo, reason: 'please', ...WHO });
    assert.equal(r.status, 400);
    assert.ok(r.error.includes(NOT_IGNORABLE[code]));
  }
});

test('an ignore with no reason, or for a check that cannot be ignored, excuses nothing', () => {
  const checks = [...run(), check('INV002', false, { lineNo: 3 })];
  // As if written straight into the store, past ignoreCheck.
  const forged = [
    { code: 'INV005', lineNo: 1, reason: '   ' },
    { code: 'INV008', lineNo: null, reason: null },
    { code: 'INV002', lineNo: 3, reason: 'trust me' },
  ];
  assert.deepEqual(unresolvedBlocks(checks, forged).map((c) => c.code).sort(), ['INV002', 'INV005', 'INV008']);
  assert.deepEqual(liveIgnores(forged, checks), []);
  assert.equal(canIgnore(checks.find((c) => c.code === 'INV002')), false);
});

test('a re-run keeps an ignore while its check still fails, and drops it once it passes', () => {
  let ignored = ignoreCheck([], run(), { code: 'INV005', lineNo: 1, reason: 'agreed rate', ...WHO }).ignored;
  ignored = ignoreCheck(ignored, run(), { code: 'INV008', reason: 'rounding', ...WHO }).ignored;

  // "Match again": the same failures, perhaps reworded.
  const rerun = run().map((c) => (c.code === 'INV005' && c.lineNo === 1 ? { ...c, message: 'Line 1: invoiced at ₹53, PO says ₹50' } : c));
  assert.equal(liveIgnores(ignored, rerun).length, 2);

  // The rate was corrected: INV005 on line 1 passes, its ignore goes.
  const fixed = run({ ratePasses: true });
  const live = liveIgnores(ignored, fixed);
  assert.deepEqual(live.map((o) => o.code), ['INV008']);
  // And if the rate goes wrong again later, it blocks again - the old reason does not cover it.
  assert.deepEqual(unresolvedBlocks(run(), live).map((c) => `${c.code}:${c.lineNo}`), ['INV005:1']);

  // A removed line takes its ignore with it.
  const lineGone = run().filter((c) => !(c.code === 'INV005' && c.lineNo === 1));
  assert.deepEqual(liveIgnores(ignored, lineGone).map((o) => o.code), ['INV008']);
});

test('undo puts the block back', () => {
  const checks = run();
  const ignored = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: 'agreed rate', ...WHO }).ignored;
  const undone = undoIgnore(ignored, { code: 'INV005', lineNo: '1' });
  assert.equal(undone.found, true);
  assert.deepEqual(undone.ignored, []);
  assert.equal(unresolvedBlocks(checks, undone.ignored).length, 2);
  assert.equal(undoIgnore(ignored, { code: 'INV005', lineNo: 2 }).found, false);
});

test('the ignored block carries its reason; a stale stamp is cleared; warnings are untouched', () => {
  const checks = run();
  const ignored = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: 'agreed rate', ...WHO }).ignored;
  const stamped = withIgnores(checks, ignored);
  const rate = stamped.find((c) => c.code === 'INV005' && c.lineNo === 1);
  assert.equal(rate.overrideReason, 'agreed rate');
  assert.equal(rate.overriddenBy, 'manu@erp.kol');
  assert.equal(rate.overriddenByName, 'Manu');
  assert.equal(rate.overriddenAt, AT);
  assert.equal(rate.passed, false, 'an ignored check is still a failed check');
  assert.equal(stamped.find((c) => c.code === 'INV008').overrideReason, undefined);

  // Run again with the ignore undone: the old stamp must not survive on the stored check.
  const restamped = withIgnores(stamped, []);
  assert.equal(restamped.find((c) => c.code === 'INV005' && c.lineNo === 1).overrideReason, undefined);
  // A warning's reason is given at post time, and is not this module's to clear.
  const warned = [{ ...check('INV014', false), overrideReason: 'below threshold' }];
  assert.equal(withIgnores(warned, [])[0].overrideReason, 'below threshold');
});

test('the post gate: every block either passes or is ignored with a reason', () => {
  const checks = run();
  const gate = (stored, ignoredStored) => unresolvedBlocks(stored, liveIgnores(ignoredStored, stored));

  assert.equal(gate(checks, []).length, 2, 'nothing ignored: refused');
  let ignored = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: 'agreed rate', ...WHO }).ignored;
  assert.deepEqual(gate(checks, ignored).map((c) => c.code), ['INV008'], 'one of two ignored: refused');
  ignored = ignoreCheck(ignored, checks, { code: 'INV008', reason: 'rounding', ...WHO }).ignored;
  assert.deepEqual(gate(checks, ignored), [], 'both ignored: allowed');
  assert.deepEqual(gate(run({ ratePasses: true, taxablePasses: true }), []), [], 'all passing: allowed');

  // Ignoring a block does nothing for a warning: it still needs its own reason at post time.
  assert.deepEqual(warningsNeedingReason(checks).map((c) => c.code), ['INV014']);
  // A WARN code sent as an "ignore" is not a block and blocks nothing either way.
  assert.deepEqual(gate(checks, [...ignored, { code: 'INV014', lineNo: null, reason: 'x' }]), []);
});

test('the document set stores the ignores and the stamped checks', () => {
  const Model = mongoose.models.CheckOverridesTestSet || mongoose.model('CheckOverridesTestSet', documentSetSchema);
  const checks = run();
  const ignored = ignoreCheck([], checks, { code: 'INV005', lineNo: 1, reason: 'agreed rate', ...WHO }).ignored;
  const doc = new Model({ site: 'KOL', checks: withIgnores(checks, ignored), ignoredChecks: ignored }).toObject();
  assert.deepEqual(doc.ignoredChecks, ignored);
  const rate = doc.checks.find((c) => c.code === 'INV005' && c.lineNo === 1);
  assert.equal(rate.overriddenByName, 'Manu');
  assert.equal(rate.overrideReason, 'agreed rate');
  // Read back from the store, the gate still holds.
  assert.deepEqual(unresolvedBlocks(doc.checks, liveIgnores(doc.ignoredChecks, doc.checks)).map((c) => c.code), ['INV008']);
});
