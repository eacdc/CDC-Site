import test from 'node:test';
import assert from 'node:assert/strict';
import { threadRootOf, assignThreadRoots, splitByThread, sharesThread, MAX_DEPTH } from './detector/threads.js';
import { findDuplicate, recentlyAlerted } from './detector/concerns.js';

const msg = (msgId, quotedMsgId = null) => ({ msgId, quotedMsgId });
const lookupOf = (...msgs) => {
  const m = new Map(msgs.map((x) => [x.msgId, x]));
  return (id) => m.get(id) ?? null;
};

test('a message quoting nothing is its own thread root', () => {
  assert.equal(threadRootOf(msg('A'), () => null), 'A');
});

test('a chain of replies resolves to the oldest message', () => {
  const a = msg('A');
  const b = msg('B', 'A');
  const c = msg('C', 'B');
  assert.equal(threadRootOf(c, lookupOf(a, b, c)), 'A');
  assert.equal(threadRootOf(b, lookupOf(a, b, c)), 'A');
});

test('quoting a message we do not have roots the thread at that id', () => {
  // The quoted message predates joinedAt or has aged out under the TTL. Every
  // other reply to it resolves the same way, so the thread still holds together.
  assert.equal(threadRootOf(msg('B', 'GONE'), () => null), 'GONE');
});

test('a reply cycle resolves to the same root from either end', () => {
  // Otherwise the cycle splits into two threads, which is worse than the cycle.
  const a = msg('A', 'B');
  const b = msg('B', 'A');
  const lookup = lookupOf(a, b);
  assert.equal(threadRootOf(a, lookup), threadRootOf(b, lookup));
  assert.equal(threadRootOf(a, lookup), 'A');
});

test('a message quoting itself is its own root', () => {
  const a = msg('A', 'A');
  assert.equal(threadRootOf(a, lookupOf(a)), 'A');
});

test('a chain longer than the depth cap stops rather than hanging', () => {
  const chain = [];
  for (let i = 0; i <= MAX_DEPTH + 10; i++) chain.push(msg(`m${i}`, i === 0 ? null : `m${i - 1}`));
  const root = threadRootOf(chain[chain.length - 1], lookupOf(...chain));
  assert.ok(root, 'returns something rather than looping forever');
});

test('assignThreadRoots resolves parents inside the same batch', () => {
  const out = assignThreadRoots([msg('A'), msg('B', 'A'), msg('C', 'B'), msg('D')]);
  assert.deepEqual(out.map((m) => m.threadRootId), ['A', 'A', 'A', 'D']);
});

// The case from CDC Maintenance: "Eterna foil machine stop" and "Same problem,
// machine stop" are separate reports - neither quotes the other - and the model
// returned them as one concern.
test('a candidate citing two threads is split into two concerns', () => {
  const rootOf = (id) => ({ ETERNA: 'ETERNA', REPLY: 'ETERNA', SAME: 'SAME' })[id];
  const out = splitByThread(
    [{ summary: 'machines down', category: 'machine_breakdown', messageIds: ['ETERNA', 'REPLY', 'SAME'] }],
    rootOf,
  );

  assert.equal(out.length, 2, 'two threads, two concerns');
  assert.deepEqual(out[0].messageIds, ['ETERNA', 'REPLY']);
  assert.deepEqual(out[0].threadRootIds, ['ETERNA']);
  assert.deepEqual(out[1].messageIds, ['SAME']);
  assert.deepEqual(out[1].threadRootIds, ['SAME']);
});

test('a candidate inside one thread passes through with its root recorded', () => {
  const out = splitByThread([{ summary: 'x', messageIds: ['A', 'B'] }], () => 'A');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].threadRootIds, ['A']);
});

test('sharesThread is true only on a common root', () => {
  assert.equal(sharesThread(['A', 'B'], ['B']), true);
  assert.equal(sharesThread(['A'], ['B']), false);
  assert.equal(sharesThread([], ['B']), false);
});

test('a reply joins its concern however long after it was raised', () => {
  const yesterday = new Date(Date.now() - 30 * 3600e3);
  const live = [{ _id: 1, status: 'open', category: 'machine_breakdown', createdAt: yesterday, threadRootIds: ['ETERNA'] }];
  const match = findDuplicate({ category: 'machine_breakdown', threadRootIds: ['ETERNA'] }, live);
  assert.equal(match?._id, 1, 'the cooldown window no longer decides identity');
});

test('a separate report of the same category does not join', () => {
  const live = [{ _id: 1, status: 'open', category: 'machine_breakdown', createdAt: new Date(), threadRootIds: ['ETERNA'] }];
  assert.equal(findDuplicate({ category: 'machine_breakdown', threadRootIds: ['SAME'] }, live), null);
});

test('a resolved concern does not absorb new messages in its thread', () => {
  const live = [{ _id: 1, status: 'resolved', category: 'machine_breakdown', createdAt: new Date(), threadRootIds: ['ETERNA'] }];
  assert.equal(findDuplicate({ category: 'machine_breakdown', threadRootIds: ['ETERNA'] }, live), null);
});

test('the alert cooldown suppresses a second DM for the same category', () => {
  const now = new Date();
  const live = [{ _id: 1, category: 'machine_breakdown', alertedAt: new Date(now - 5 * 60_000) }];
  assert.ok(recentlyAlerted({ category: 'machine_breakdown' }, live, now, 30));
  assert.equal(recentlyAlerted({ category: 'delivery_delay' }, live, now, 30), null, 'a different category still alerts');
  assert.equal(recentlyAlerted({ category: 'machine_breakdown' }, live, now, 0), null, 'zero disables it');
});

test('a concern that was never alerted does not suppress anything', () => {
  const now = new Date();
  const live = [{ _id: 1, category: 'machine_breakdown', alertedAt: null }];
  assert.equal(recentlyAlerted({ category: 'machine_breakdown' }, live, now, 30), null);
});
