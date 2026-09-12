import test from 'node:test';
import assert from 'node:assert/strict';
import { dueForEscalation, nextEscalationTarget, MAX_ESCALATIONS } from './router/escalation-rules.js';
import { isAck, findAckTarget } from './router/ack-rules.js';

const NOW = new Date('2026-09-12T12:00:00Z');
const minsAgo = (n) => new Date(NOW.getTime() - n * 60_000);

const concern = (over = {}) => ({
  _id: 'c1',
  groupId: 'g1',
  category: 'machine_breakdown',
  summary: 'Kolbus down',
  ownerId: '91000000001',
  status: 'open',
  createdAt: minsAgo(31),
  lastEscalatedAt: null,
  escalatedTo: [],
  ...over,
});

// --- escalation timing ----------------------------------------------------

test('escalates an open concern once the window has passed', () => {
  assert.equal(dueForEscalation(concern(), NOW, 30), true);
});

test('does not escalate before the window', () => {
  assert.equal(dueForEscalation(concern({ createdAt: minsAgo(29) }), NOW, 30), false);
});

test('never escalates an acknowledged concern — a human said they have it', () => {
  assert.equal(dueForEscalation(concern({ status: 'acknowledged' }), NOW, 30), false);
});

test('never escalates a resolved concern', () => {
  assert.equal(dueForEscalation(concern({ status: 'resolved' }), NOW, 30), false);
});

test('the clock restarts at each hop, giving each person the full window', () => {
  // Raised 60 min ago but escalated 10 min ago: the second person still has time.
  const c = concern({ createdAt: minsAgo(60), escalatedTo: ['91000000002'], lastEscalatedAt: minsAgo(10) });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(dueForEscalation({ ...c, lastEscalatedAt: minsAgo(31) }, NOW, 30), true);
});

test('stops after two hops however long it stays open', () => {
  const c = concern({
    createdAt: minsAgo(600),
    escalatedTo: ['91000000002', '91000000003'],
    lastEscalatedAt: minsAgo(300),
  });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(MAX_ESCALATIONS, 2);
});

test('honours a per-route escalation window', () => {
  const c = concern({ createdAt: minsAgo(10) });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(dueForEscalation(c, NOW, 5), true);
});

// --- escalation targets ---------------------------------------------------

const ownersMap = (...pairs) => new Map(pairs.map(([id, escalationTo]) => [id, { _id: id, escalationTo }]));

test('first hop goes to the owner\'s escalationTo', () => {
  const owners = ownersMap(['91000000001', '91000000002']);
  assert.equal(nextEscalationTarget(concern(), owners), '91000000002');
});

test('second hop continues up from the last person alerted', () => {
  const owners = ownersMap(['91000000001', '91000000002'], ['91000000002', '91000000003']);
  const c = concern({ escalatedTo: ['91000000002'], lastEscalatedAt: minsAgo(31) });
  assert.equal(nextEscalationTarget(c, owners), '91000000003');
});

test('returns null when the chain ends', () => {
  assert.equal(nextEscalationTarget(concern(), ownersMap(['91000000001', null])), null);
  assert.equal(nextEscalationTarget(concern(), new Map()), null);
});

test('never escalates to someone already on the thread', () => {
  // A loop in the config: 2 escalates back to the original owner.
  const owners = ownersMap(['91000000001', '91000000002'], ['91000000002', '91000000001']);
  const c = concern({ escalatedTo: ['91000000002'] });
  assert.equal(nextEscalationTarget(c, owners), null);
});

test('returns null when the concern has no owner at all', () => {
  assert.equal(nextEscalationTarget(concern({ ownerId: null }), ownersMap()), null);
});

// --- acknowledgement matching ---------------------------------------------

test('recognises ACK in the forms people actually type', () => {
  for (const t of ['ACK', 'ack', 'Ack', 'ack noted', 'ok ack', 'Ack, dekh raha hoon']) {
    assert.equal(isAck(t), true, `expected "${t}" to acknowledge`);
  }
});

test('does not treat ack inside another word as acknowledgement', () => {
  for (const t of ['my back hurts', 'Jack is on it', 'package aa gaya', 'backup lelo']) {
    assert.equal(isAck(t), false, `expected "${t}" NOT to acknowledge`);
  }
});

test('ok and done are not acknowledgements', () => {
  // The two commonest words in any work group; accepting them would silently
  // swallow concerns nobody actually picked up.
  for (const t of ['ok', 'done', 'thik hai', 'haan', '']) {
    assert.equal(isAck(t), false, `expected "${t}" NOT to acknowledge`);
  }
  assert.equal(isAck(null), false);
  assert.equal(isAck(undefined), false);
});

// --- which concern an ACK applies to --------------------------------------

test('acknowledges the newest open concern of that owner', () => {
  const list = [
    concern({ _id: 'old', createdAt: minsAgo(90) }),
    concern({ _id: 'new', createdAt: minsAgo(5) }),
  ];
  assert.equal(findAckTarget('91000000001', list)._id, 'new');
});

test('ignores concerns that are not open', () => {
  const list = [
    concern({ _id: 'ackd', createdAt: minsAgo(5), status: 'acknowledged' }),
    concern({ _id: 'open', createdAt: minsAgo(90) }),
  ];
  assert.equal(findAckTarget('91000000001', list)._id, 'open');
});

test('someone escalated into a concern can acknowledge it', () => {
  const list = [concern({ _id: 'c', ownerId: '91000000001', escalatedTo: ['91000000002'] })];
  assert.equal(findAckTarget('91000000002', list)._id, 'c');
});

test('returns null when none of the open concerns are theirs', () => {
  assert.equal(findAckTarget('91000000009', [concern()]), null);
  assert.equal(findAckTarget('91000000001', []), null);
});
