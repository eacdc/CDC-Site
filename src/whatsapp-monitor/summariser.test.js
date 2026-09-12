import test from 'node:test';
import assert from 'node:assert/strict';
import { istDayKey, istDayBounds, timeToCron, tsRange } from './summariser/window.js';
import { parseSummary, isEmptySummary, MalformedSummary } from './summariser/parse.js';

// --- IST day boundaries ---------------------------------------------------

test('an IST day key reflects Kolkata local time, not UTC', () => {
  // 19:30 UTC on the 11th is 01:00 IST on the 12th — a different day.
  assert.equal(istDayKey(new Date('2026-09-11T19:30:00Z')), '2026-09-12');
  assert.equal(istDayKey(new Date('2026-09-11T18:29:00Z')), '2026-09-11');
});

test('the IST day starts at 18:30 UTC the previous day', () => {
  const { dayKey, start } = istDayBounds(new Date('2026-09-12T14:30:00Z'));
  assert.equal(dayKey, '2026-09-12');
  assert.equal(start.toISOString(), '2026-09-11T18:30:00.000Z');
});

test('the daily window ends at the run time, not midnight', () => {
  // The 20:00 IST run covers the working day up to then; later messages fall
  // into tomorrow's window rather than being invented into today's.
  const now = new Date('2026-09-12T14:30:00Z'); // 20:00 IST
  assert.equal(istDayBounds(now).end.toISOString(), now.toISOString());
});

// --- the daily cron -------------------------------------------------------

test('a daily time becomes the matching cron expression', () => {
  assert.equal(timeToCron('20:00'), '0 20 * * *');
  assert.equal(timeToCron('9:05'), '5 9 * * *');
  assert.equal(timeToCron(' 07:30 '), '30 7 * * *');
});

test('a bad daily time throws rather than silently running at midnight', () => {
  for (const bad of ['8pm', '20', '', null, undefined, '25:00', '20:99']) {
    assert.throws(() => timeToCron(bad), Error, `expected "${bad}" to throw`);
  }
});

// --- window range ---------------------------------------------------------

test('tsRange spans the earliest and latest message whatever the order', () => {
  const msgs = [
    { ts: new Date('2026-09-12T10:00:00Z') },
    { ts: new Date('2026-09-12T08:00:00Z') },
    { ts: new Date('2026-09-12T09:00:00Z') },
  ];
  const r = tsRange(msgs);
  assert.equal(r.start.toISOString(), '2026-09-12T08:00:00.000Z');
  assert.equal(r.end.toISOString(), '2026-09-12T10:00:00.000Z');
  assert.equal(tsRange([]), null);
});

// --- summary parsing ------------------------------------------------------

test('parses the four buckets', () => {
  const out = parseSummary(
    '{"decisions":["Ravi approved the reprint"],"openIssues":["Kolbus still down"],"blocked":["Binding waiting on Ahmedabad"],"notable":[]}',
  );
  assert.deepEqual(out.decisions, ['Ravi approved the reprint']);
  assert.deepEqual(out.blocked, ['Binding waiting on Ahmedabad']);
  assert.deepEqual(out.notable, []);
});

test('a missing bucket becomes empty rather than an error', () => {
  // "Nothing was decided" is a legitimate outcome; omission is not worth a retry.
  const out = parseSummary('{"openIssues":["Kolbus down"]}');
  assert.deepEqual(out.decisions, []);
  assert.deepEqual(out.openIssues, ['Kolbus down']);
  assert.deepEqual(out.blocked, []);
});

test('strips a markdown fence', () => {
  const out = parseSummary('```json\n{"decisions":["a"]}\n```');
  assert.deepEqual(out.decisions, ['a']);
});

test('drops non-string and blank bullets', () => {
  const out = parseSummary('{"decisions":["real", 42, null, "  ", {"x":1}, " kept "]}');
  assert.deepEqual(out.decisions, ['real', 'kept']);
});

test('throws on structurally broken output so the caller can escalate', () => {
  assert.throws(() => parseSummary('I could not summarise this'), MalformedSummary);
  assert.throws(() => parseSummary('["decisions"]'), MalformedSummary);
  assert.throws(() => parseSummary('null'), MalformedSummary);
});

test('recognises a summary with nothing in it', () => {
  assert.equal(isEmptySummary(parseSummary('{"decisions":[],"openIssues":[]}')), true);
  assert.equal(isEmptySummary(parseSummary('{"notable":["client visit"]}')), false);
});
