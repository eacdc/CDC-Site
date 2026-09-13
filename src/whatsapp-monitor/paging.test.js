import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNewMessages } from './poller/cursor.js';

/**
 * fetchBackToCursor is not exported (it is an implementation detail of the
 * poller), so these tests exercise the rule it turns on: a page that reaches
 * at or past the cursor means nothing older is missing, and paging can stop.
 *
 * Getting this backwards either loses messages silently or pages through the
 * entire history of a seven-year-old group every five minutes.
 */
const at = (iso) => new Date(iso);
const msg = (id, iso) => ({ msgId: id, ts: at(iso) });
const JOINED = at('2026-01-01T00:00:00Z');
const CURSOR = at('2026-01-01T12:00:00Z');

test('a page reaching past the cursor stops the walk', () => {
  // Contains something older than the cursor: we have caught up.
  const page = [msg('older', '2026-01-01T11:00:00Z'), msg('newer', '2026-01-01T13:00:00Z')];
  const { possibleGap } = filterNewMessages(page, { joinedAt: JOINED, lastTs: CURSOR }, 60);
  assert.equal(possibleGap, false, 'should stop paging');
});

test('a page entirely newer than the cursor means there is more to find', () => {
  const page = [msg('a', '2026-01-01T13:00:00Z'), msg('b', '2026-01-01T14:00:00Z')];
  const { possibleGap } = filterNewMessages(page, { joinedAt: JOINED, lastTs: CURSOR }, 60);
  assert.equal(possibleGap, true, 'should keep paging back');
});

test('the first poll never pages back', () => {
  // With no cursor there is no gap to close, and paging would drag in history
  // that joinedAt exists to keep out.
  const page = [msg('a', '2026-01-01T13:00:00Z')];
  const { possibleGap } = filterNewMessages(page, { joinedAt: JOINED, lastTs: null }, 60);
  assert.equal(possibleGap, false);
});

test('messages below joinedAt are dropped however far back we page', () => {
  const page = [msg('ancient', '2019-03-01T10:00:00Z'), msg('recent', '2026-01-01T13:00:00Z')];
  const { keep } = filterNewMessages(page, { joinedAt: JOINED, lastTs: CURSOR }, 60);
  assert.deepEqual(keep.map((m) => m.msgId), ['recent']);
});

test('a page straddling the overlap window still counts as reaching the cursor', () => {
  // 30s before the cursor is inside the 60s overlap, so it is kept AND proves
  // we have paged back far enough.
  const page = [msg('overlap', '2026-01-01T11:59:30Z'), msg('new', '2026-01-01T12:30:00Z')];
  const state = { joinedAt: JOINED, lastTs: CURSOR };
  const { keep, possibleGap } = filterNewMessages(page, state, 60);
  assert.equal(possibleGap, false);
  assert.deepEqual(keep.map((m) => m.msgId), ['overlap', 'new']);
});
