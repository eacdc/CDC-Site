import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueForFirstAlert,
  alertDelayFor,
  alertFloorFor,
  severeEnoughToAlert,
} from './router/alert-rules.js';

const NOW = new Date('2026-09-21T10:00:00Z');
const minsAgo = (n) => new Date(NOW.getTime() - n * 60_000);

const waiting = (over = {}) => ({
  _id: 'c1',
  groupId: 'g1',
  category: 'machine_breakdown',
  ownerId: '91000000001',
  status: 'open',
  firstMsgTs: minsAgo(31),
  createdAt: minsAgo(28),
  alertedAt: null,
  ...over,
});

// --- the window -----------------------------------------------------------

test('waits out the window before the first DM', () => {
  assert.equal(dueForFirstAlert(waiting({ firstMsgTs: minsAgo(29) }), NOW, 30), false);
});

test('fires once the window has passed', () => {
  assert.equal(dueForFirstAlert(waiting(), NOW, 30), true);
});

test('fires exactly on the boundary', () => {
  // A concern that waits 30 minutes should go at 30 minutes, not 35 - the poll
  // cycle already adds up to five minutes of its own.
  assert.equal(dueForFirstAlert(waiting({ firstMsgTs: minsAgo(30) }), NOW, 30), true);
});

test('the clock runs from the message, not from when the poll noticed', () => {
  // Sent 31 minutes ago, noticed 28 minutes ago. "15 minutes after the
  // message" has to mean the message, or a slow cycle silently extends it.
  const c = waiting({ firstMsgTs: minsAgo(31), createdAt: minsAgo(28) });
  assert.equal(dueForFirstAlert(c, NOW, 30), true);
});

test('falls back to createdAt when a concern has no firstMsgTs', () => {
  const c = waiting({ firstMsgTs: null, createdAt: minsAgo(31) });
  assert.equal(dueForFirstAlert(c, NOW, 30), true);
});

// --- what keeps it quiet --------------------------------------------------

test('a concern someone already acknowledged is never DMed', () => {
  // This is the outcome the wait exists to produce, not a case to work around.
  assert.equal(dueForFirstAlert(waiting({ status: 'acknowledged' }), NOW, 30), false);
});

test('a concern resolved inside the window is never DMed', () => {
  assert.equal(dueForFirstAlert(waiting({ status: 'resolved' }), NOW, 30), false);
});

test('a thread that says it is fixed stays quiet', () => {
  const c = waiting({ resolutionHint: { msgId: 'm2', text: 'Running...' } });
  assert.equal(dueForFirstAlert(c, NOW, 30), false);
});

test('a backfilled concern is never DMed, however long it waits', () => {
  assert.equal(dueForFirstAlert(waiting({ backfilledAt: minsAgo(5) }), NOW, 30), false);
});

test('a concern with nobody to send to is not due', () => {
  assert.equal(dueForFirstAlert(waiting({ ownerId: null }), NOW, 30), false);
});

test('never alerts twice', () => {
  assert.equal(dueForFirstAlert(waiting({ alertedAt: minsAgo(1) }), NOW, 30), false);
});

// --- 15 for client, 30 for internal ---------------------------------------

const windows = { internal: 30, client: 15 };

test('a client group waits 15 minutes and an internal one 30', () => {
  assert.equal(alertDelayFor({ kind: 'client' }, windows), 15);
  assert.equal(alertDelayFor({ kind: 'internal' }, windows), 30);
});

test('a group with no kind set waits the internal window', () => {
  // Groups seeded before kinds existed, and anything unrecognised. The quieter
  // window is the safer thing to get by accident.
  assert.equal(alertDelayFor({}, windows), 30);
  assert.equal(alertDelayFor(undefined, windows), 30);
  assert.equal(alertDelayFor({ kind: 'nonsense' }, windows), 30);
});

test('the same concern is due in a client group and not in an internal one', () => {
  const c = waiting({ firstMsgTs: minsAgo(20) });
  assert.equal(dueForFirstAlert(c, NOW, alertDelayFor({ kind: 'client' }, windows)), true);
  assert.equal(dueForFirstAlert(c, NOW, alertDelayFor({ kind: 'internal' }, windows)), false);
});

// --- the severity floor ----------------------------------------------------
//
// Management reviewed six real alerts and wanted two of them. Both were high,
// and nothing high was unwanted - so the floor alone would have produced their
// verdicts. Below it a concern is still raised and still on the dashboard; it
// just never reaches a phone.

const FLOORS = { internal: 'high', client: 'high' };

test('a high concern passes the floor', () => {
  assert.equal(severeEnoughToAlert('high', 'high'), true);
});

test('medium and low do not', () => {
  assert.equal(severeEnoughToAlert('medium', 'high'), false);
  assert.equal(severeEnoughToAlert('low', 'high'), false);
});

test('a lower floor lets more through', () => {
  assert.equal(severeEnoughToAlert('medium', 'medium'), true);
  assert.equal(severeEnoughToAlert('low', 'medium'), false);
  assert.equal(severeEnoughToAlert('low', 'low'), true);
});

test('an ungradable severity is alerted rather than swallowed', () => {
  // The safe direction. A concern we cannot grade must not be the one that
  // goes unreported - and the eval checks severities precisely because this
  // decision now rests on them.
  assert.equal(severeEnoughToAlert(undefined, 'high'), true);
  assert.equal(severeEnoughToAlert('nonsense', 'high'), true);
  assert.equal(severeEnoughToAlert('high', 'nonsense'), true);
});

test('the floor stops a due medium concern from being DMed', () => {
  const c = waiting({ severity: 'medium' });
  assert.equal(dueForFirstAlert(c, NOW, 30), true, 'baseline: it was otherwise due');
  assert.equal(dueForFirstAlert(c, NOW, 30, 'high'), false);
});

test('a high concern is unaffected by the floor', () => {
  assert.equal(dueForFirstAlert(waiting({ severity: 'high' }), NOW, 30, 'high'), true);
});

test('each kind of group carries its own floor', () => {
  assert.equal(alertFloorFor({ kind: 'client' }, FLOORS), 'high');
  assert.equal(alertFloorFor({ kind: 'internal' }, FLOORS), 'high');
  assert.equal(alertFloorFor({}, { internal: 'medium', client: 'high' }), 'medium');
  assert.equal(alertFloorFor(undefined, { internal: 'medium', client: 'high' }), 'medium');
});
