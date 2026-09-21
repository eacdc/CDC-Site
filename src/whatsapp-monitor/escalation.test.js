import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueForEscalation,
  nextEscalationTarget,
  escalationWindowFor,
  MAX_ESCALATIONS,
} from './router/escalation-rules.js';
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
  // The first hop runs from the ALERT, not from when the concern was raised -
  // a concern now waits 15 or 30 minutes for its first DM.
  alertedAt: minsAgo(31),
  lastEscalatedAt: null,
  escalatedTo: [],
  ...over,
});

// --- escalation timing ----------------------------------------------------

test('escalates an open concern once the window has passed', () => {
  assert.equal(dueForEscalation(concern(), NOW, 30), true);
});

test('does not escalate before the window', () => {
  assert.equal(dueForEscalation(concern({ alertedAt: minsAgo(29) }), NOW, 30), false);
});

test('never escalates an acknowledged concern - a human said they have it', () => {
  assert.equal(dueForEscalation(concern({ status: 'acknowledged' }), NOW, 30), false);
});

test('never escalates a resolved concern', () => {
  assert.equal(dueForEscalation(concern({ status: 'resolved' }), NOW, 30), false);
});

test('the clock restarts at each hop, giving each person the full window', () => {
  // Raised 60 min ago but escalated 10 min ago: the second person still has time.
  const c = concern({ alertedAt: minsAgo(60), escalatedTo: ['91000000002'], lastEscalatedAt: minsAgo(10) });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(dueForEscalation({ ...c, lastEscalatedAt: minsAgo(31) }, NOW, 30), true);
});

test('stops after two hops however long it stays open', () => {
  const c = concern({
    alertedAt: minsAgo(600),
    escalatedTo: ['91000000002', '91000000003'],
    lastEscalatedAt: minsAgo(300),
  });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(MAX_ESCALATIONS, 2);
});

test('honours a per-route escalation window', () => {
  const c = concern({ alertedAt: minsAgo(10) });
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

// --- never alerted, never escalated ---------------------------------------

test('a concern nobody was ever alerted about does not escalate', () => {
  // Escalation means "nobody answered the alert". With no alert there is
  // nothing to answer, and waking the next person up the chain would be the
  // first anyone had heard of it.
  assert.equal(dueForEscalation(concern({ alertedAt: null }), NOW, 30), false);
});

test('the first hop is measured from the alert, not from when it was raised', () => {
  // Raised an hour ago but only DMed five minutes ago: the owner still has the
  // full window before anyone goes over their head.
  const c = concern({ createdAt: minsAgo(60), alertedAt: minsAgo(5) });
  assert.equal(dueForEscalation(c, NOW, 30), false);
  assert.equal(dueForEscalation({ ...c, alertedAt: minsAgo(31) }, NOW, 30), true);
});

// --- a group's own escalation ladder --------------------------------------
//
// Where a group has a list, that list is the whole ladder for it: the older
// per-person escalationTo chain is not consulted at all, so there is one place
// to look when asking who hears about this group.

const LADDER = ['91000000005', '91000000006', '91000000007'];
const noOwners = new Map();

test('walks the ladder in order, one person per hop', () => {
  const c = concern({ escalatedTo: [] });
  assert.equal(nextEscalationTarget(c, noOwners, LADDER), '91000000005');
  assert.equal(nextEscalationTarget(concern({ escalatedTo: LADDER.slice(0, 1) }), noOwners, LADDER), '91000000006');
  assert.equal(nextEscalationTarget(concern({ escalatedTo: LADDER.slice(0, 2) }), noOwners, LADDER), '91000000007');
});

test('the ladder ends when everyone on it has been pulled in', () => {
  assert.equal(nextEscalationTarget(concern({ escalatedTo: LADDER }), noOwners, LADDER), null);
});

test('skips the owner if they were put on their own ladder', () => {
  // A configuration mistake, and it must not silently disable everyone below
  // them on the list.
  const withOwner = ['91000000001', '91000000005'];
  assert.equal(nextEscalationTarget(concern(), noOwners, withOwner), '91000000005');
});

test('goes deeper than two hops when the ladder is longer', () => {
  // The old cap was two. A group's ladder climbs as far as the list goes.
  const c = concern({ escalatedTo: LADDER.slice(0, 2), lastEscalatedAt: minsAgo(31) });
  assert.equal(dueForEscalation(c, NOW, 30, LADDER.length), true);
  assert.equal(dueForEscalation(c, NOW, 30, MAX_ESCALATIONS), false, 'and would have stopped before');
});

test('stops once the ladder is spent', () => {
  const c = concern({ escalatedTo: LADDER, lastEscalatedAt: minsAgo(31) });
  assert.equal(dueForEscalation(c, NOW, 30, LADDER.length), false);
});

test('a group with no ladder still uses the per-person chain', () => {
  const owners = new Map([['91000000001', { _id: '91000000001', escalationTo: '91000000002' }]]);
  assert.equal(nextEscalationTarget(concern(), owners, []), '91000000002');
  assert.equal(nextEscalationTarget(concern(), owners), '91000000002', 'and with the argument omitted');
});

test("a group's ladder overrides the per-person chain entirely", () => {
  const owners = new Map([['91000000001', { _id: '91000000001', escalationTo: '91000000002' }]]);
  assert.equal(nextEscalationTarget(concern(), owners, LADDER), '91000000005');
});

test('the per-person chain still stops after two hops', () => {
  const c = concern({ escalatedTo: ['91000000002', '91000000003'], lastEscalatedAt: minsAgo(31) });
  assert.equal(dueForEscalation(c, NOW, 30), false);
});

// --- severity stretches the escalation window ------------------------------
//
// A low-severity note nobody has acknowledged should not climb the ladder at
// the pace of a stopped press.

const MULTIPLIERS = { high: 1, medium: 3, low: 6 };

test('high escalates on the base window', () => {
  assert.equal(escalationWindowFor('high', 30, MULTIPLIERS), 30);
});

test('medium waits three times as long, low six', () => {
  assert.equal(escalationWindowFor('medium', 30, MULTIPLIERS), 90);
  assert.equal(escalationWindowFor('low', 30, MULTIPLIERS), 180);
});

test('the multiplier rides on the route window rather than replacing it', () => {
  // A safety route set to 5 minutes still means 5 for a high - the per-route
  // window keeps saying what it said, and severity stretches it.
  assert.equal(escalationWindowFor('high', 5, MULTIPLIERS), 5);
  assert.equal(escalationWindowFor('medium', 5, MULTIPLIERS), 15);
  assert.equal(escalationWindowFor('low', 5, MULTIPLIERS), 30);
});

test('an unreadable severity gets the base window, which is the shortest', () => {
  // The safe direction: a concern whose severity we cannot read must not end
  // up being the one that sits quietest.
  assert.equal(escalationWindowFor(undefined, 30, MULTIPLIERS), 30);
  assert.equal(escalationWindowFor('nonsense', 30, MULTIPLIERS), 30);
  assert.equal(escalationWindowFor('high', 30, undefined), 30);
});

test('a medium is not due at the window a high would have escalated on', () => {
  const c = concern({ alertedAt: minsAgo(31), severity: 'medium' });
  assert.equal(dueForEscalation(c, NOW, escalationWindowFor('high', 30, MULTIPLIERS)), true);
  assert.equal(dueForEscalation(c, NOW, escalationWindowFor('medium', 30, MULTIPLIERS)), false);
});

test('a medium escalates once its own window has passed', () => {
  const c = concern({ alertedAt: minsAgo(91), severity: 'medium' });
  assert.equal(dueForEscalation(c, NOW, escalationWindowFor('medium', 30, MULTIPLIERS)), true);
});

test('the stretch applies to the second hop too', () => {
  // Escalated an hour ago: a high would be due again, a low is nowhere near.
  const c = concern({
    alertedAt: minsAgo(300),
    escalatedTo: ['91000000002'],
    lastEscalatedAt: minsAgo(60),
    severity: 'low',
  });
  assert.equal(dueForEscalation(c, NOW, escalationWindowFor('high', 30, MULTIPLIERS)), true);
  assert.equal(dueForEscalation(c, NOW, escalationWindowFor('low', 30, MULTIPLIERS)), false);
});
