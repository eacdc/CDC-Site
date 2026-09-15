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

// --- reading history, cursor ignored --------------------------------------
//
// What the catch-up script does. The first version of it lowered joinedAt and
// left the cursor in place, which kept only the overlap window and ingested
// nothing at all - the two filters are independent and history needs both open.

test('a null cursor keeps messages older than the live cursor', () => {
  const old = { msgId: 'OLD', ts: new Date('2026-09-10T09:00:00Z') };
  const recent = { msgId: 'NEW', ts: new Date('2026-09-15T09:00:00Z') };

  const withCursor = filterNewMessages(
    [old, recent],
    { joinedAt: new Date('2026-09-01T00:00:00Z'), lastTs: new Date('2026-09-14T00:00:00Z') },
    60,
  );
  assert.deepEqual(withCursor.keep.map((m) => m.msgId), ['NEW'], 'the cursor hides history');

  const ignoringCursor = filterNewMessages(
    [old, recent],
    { joinedAt: new Date('2026-09-01T00:00:00Z'), lastTs: null },
    0,
  );
  assert.deepEqual(ignoringCursor.keep.map((m) => m.msgId), ['OLD', 'NEW']);
});

test('ignoring the cursor still honours joinedAt', () => {
  // The floor is the one rule a catch-up must not break: it is what keeps the
  // years of history before monitoring started out of the database.
  const before = { msgId: 'BEFORE', ts: new Date('2026-08-01T00:00:00Z') };
  const after = { msgId: 'AFTER', ts: new Date('2026-09-10T00:00:00Z') };

  const { keep } = filterNewMessages(
    [before, after],
    { joinedAt: new Date('2026-09-01T00:00:00Z'), lastTs: null },
    0,
  );
  assert.deepEqual(keep.map((m) => m.msgId), ['AFTER']);
});
