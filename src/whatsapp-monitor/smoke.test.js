import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSmokeMessage, tally, SMOKE_MARKER } from './smoke.js';

test('the synthetic message is shaped like a real ingested one', () => {
  const now = new Date('2026-09-14T10:00:00Z');
  const m = buildSmokeMessage('123@g.us', 'abc', now);

  assert.equal(m.groupId, '123@g.us');
  assert.equal(m.msgId, 'smoke-abc');
  assert.equal(m.classified, false, 'must be unclassified or the detector will skip it');
  assert.equal(m.fromMe, false, 'own messages are excluded from some paths');
  assert.ok(m.ts instanceof Date && m.receivedAt instanceof Date);
  assert.equal(m[SMOKE_MARKER], 'abc', 'cleanup finds it by this marker');
  assert.match(m.text, /SMOKE TEST/, 'a human reading the group data must see what it is');
});

test('two runs never collide on the unique msgId index', () => {
  assert.notEqual(
    buildSmokeMessage('g', 'one').msgId,
    buildSmokeMessage('g', 'two').msgId,
  );
});

test('tally counts each state separately', () => {
  const counts = tally([
    { state: 'PASS' },
    { state: 'PASS' },
    { state: 'SKIP' },
    { state: 'FAIL' },
  ]);
  assert.deepEqual(counts, { passed: 2, failed: 1, skipped: 1, total: 4, ok: false });
});

test('a skipped stage is not a pass and not a failure', () => {
  const counts = tally([{ state: 'PASS' }, { state: 'SKIP' }]);
  assert.equal(counts.ok, true, 'a skip must not fail the run');
  assert.equal(counts.passed, 1, 'but it must not be counted as passing either');
});

test('an empty run is vacuously ok', () => {
  assert.deepEqual(tally([]), { passed: 0, failed: 0, skipped: 0, total: 0, ok: true });
});
