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

// --- the paging walk itself -----------------------------------------------

import { fetchBackToCursor } from './poller/poll.js';
import { config } from './config.js';

/** A Maytapi-shaped page, so normaliseMessages does its real work. */
const page = (ids, iso) => ({
  data: {
    users: {},
    messages: ids.map((id) => ({
      timestamp: Math.floor(at(iso).getTime() / 1000),
      uid: '91000000001@c.us',
      fromMe: false,
      message: { type: 'text', text: 'x', id, _serialized: id },
    })),
  },
});

const STATE = { joinedAt: JOINED, lastTs: CURSOR };

test('stops as soon as a page reaches the cursor', async () => {
  const calls = [];
  const result = await fetchBackToCursor('g@g.us', STATE, async (_id, opts) => {
    calls.push(opts.page);
    // Page 0 already contains something older than the cursor.
    return page([`m${opts.page}`], '2026-01-01T11:00:00Z');
  });

  assert.deepEqual(calls, [0], 'should not ask for a second page');
  assert.equal(result.pages, 1);
  assert.equal(result.reachedCursor, true);
});

test('walks back while every page is newer than the cursor, up to maxPages', async () => {
  const calls = [];
  const result = await fetchBackToCursor('g@g.us', STATE, async (_id, opts) => {
    calls.push(opts.page);
    return page([`m${opts.page}`], '2026-01-01T13:00:00Z'); // always newer
  });

  assert.deepEqual(calls, [0, 1, 2, 3, 4], 'walks the full maxPages');
  assert.equal(result.reachedCursor, false, 'never reached the cursor - a real gap');
  assert.equal(result.fetched.length, 5);
});

test('an empty page ends the walk', async () => {
  const result = await fetchBackToCursor('g@g.us', STATE, async (_id, opts) =>
    opts.page === 0 ? page(['a'], '2026-01-01T13:00:00Z') : page([], '2026-01-01T13:00:00Z'),
  );
  assert.equal(result.pages, 2);
  assert.equal(result.reachedCursor, true, 'no more history is not a gap');
});

test('the same message appearing on two pages is only kept once', async () => {
  // Pages overlap in practice; a duplicate would be counted twice in the logs
  // and sent to the classifier twice.
  const result = await fetchBackToCursor('g@g.us', STATE, async (_id, opts) =>
    opts.page < 2 ? page(['dup', `m${opts.page}`], '2026-01-01T13:00:00Z') : page([], '2026-01-01T13:00:00Z'),
  );
  const ids = result.fetched.map((m) => m.msgId);
  assert.equal(ids.filter((i) => i === 'dup').length, 1);
});

test('the time budget stops the walk even when pages keep coming', async () => {
  // Without this, retries across maxPages can occupy the whole poll interval
  // and every later tick is skipped.
  const original = config.maytapi.groupBudgetMs;
  config.maytapi.groupBudgetMs = -1; // already past the deadline
  try {
    const calls = [];
    const result = await fetchBackToCursor('g@g.us', STATE, async (_id, opts) => {
      calls.push(opts.page);
      return page([`m${opts.page}`], '2026-01-01T13:00:00Z');
    });

    assert.deepEqual(calls, [0], 'the first page always runs; the walk stops after it');
    assert.equal(result.reachedCursor, false, 'surfaces as possible_gap, not silent truncation');
  } finally {
    config.maytapi.groupBudgetMs = original;
  }
});
