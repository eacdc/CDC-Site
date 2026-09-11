import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNewMessages, newestOf } from './poller/cursor.js';
import { toDate } from './maytapi/normalise.js';

const at = (iso) => new Date(iso);
const msg = (id, iso) => ({ msgId: id, ts: at(iso) });
const JOINED = at('2026-01-01T10:00:00Z');

test('drops messages older than joinedAt', () => {
  const { keep } = filterNewMessages(
    [msg('a', '2026-01-01T09:59:00Z'), msg('b', '2026-01-01T10:01:00Z')],
    { joinedAt: JOINED, lastTs: null },
    60,
  );
  assert.deepEqual(keep.map((m) => m.msgId), ['b']);
});

test('re-fetches the 60s overlap window before lastTs', () => {
  const { keep } = filterNewMessages(
    [
      msg('old', '2026-01-01T11:58:30Z'),      // > 60s before cursor — dropped
      msg('overlap', '2026-01-01T11:59:30Z'),  // inside overlap — kept, dup index drops it
      msg('new', '2026-01-01T12:00:30Z'),
    ],
    { joinedAt: JOINED, lastTs: at('2026-01-01T12:00:00Z') },
    60,
  );
  assert.deepEqual(keep.map((m) => m.msgId), ['overlap', 'new']);
});

test('flags possible_gap only when every fetched message is newer than the cursor', () => {
  const lastTs = at('2026-01-01T12:00:00Z');
  assert.equal(
    filterNewMessages([msg('a', '2026-01-01T13:00:00Z')], { joinedAt: JOINED, lastTs }, 60).possibleGap,
    true,
  );
  assert.equal(
    filterNewMessages(
      [msg('a', '2026-01-01T11:59:30Z'), msg('b', '2026-01-01T13:00:00Z')],
      { joinedAt: JOINED, lastTs },
      60,
    ).possibleGap,
    false,
  );
});

test('never flags a gap on the first poll', () => {
  const { possibleGap } = filterNewMessages(
    [msg('a', '2026-01-01T13:00:00Z')],
    { joinedAt: JOINED, lastTs: null },
    60,
  );
  assert.equal(possibleGap, false);
});

test('picks the newest message for the cursor', () => {
  assert.equal(
    newestOf([msg('a', '2026-01-01T10:00:00Z'), msg('b', '2026-01-01T12:00:00Z')]).msgId,
    'b',
  );
  assert.equal(newestOf([]), null);
});

test('converts epoch seconds and millis to Date, rejects junk', () => {
  assert.equal(toDate(1767261600).toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(toDate(1767261600000).toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(toDate('1767261600').toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(toDate('not a date'), null);
  assert.equal(toDate(null), null);
});
