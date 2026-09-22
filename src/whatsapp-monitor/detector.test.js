import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicate } from './detector/concerns.js';
import { parseConcerns, MalformedLlmOutput } from './llm/parse.js';
import { resolveRouting } from './router/resolve.js';
import { promptForKind } from './llm/openai.js';

const NOW = new Date('2026-09-11T12:00:00Z');
const minsAgo = (n) => new Date(NOW.getTime() - n * 60_000);

const concern = (over = {}) => ({
  groupId: 'g1',
  category: 'machine_breakdown',
  severity: 'high',
  summary: 'Kolbus down',
  status: 'open',
  createdAt: minsAgo(10),
  threadRootIds: ['t1'],
  ...over,
});

const candidate = (over = {}) => ({
  messageIds: ['m2'],
  category: 'machine_breakdown',
  severity: 'high',
  summary: 'Kolbus still down',
  ownerHint: null,
  threadRootIds: ['t1'],
  ...over,
});

// --- de-duplication -------------------------------------------------------
//
// Identity is the reply thread, not the category-and-time-window it used to be.
// See threads.test.js for the thread walking itself.

test('matches a live concern sharing the reply thread', () => {
  assert.notEqual(findDuplicate(candidate(), [concern()]), null);
});

test('still matches long after the old cooldown would have expired', () => {
  // A follow-up the next morning belongs to the problem already being tracked.
  assert.notEqual(findDuplicate(candidate(), [concern({ createdAt: minsAgo(60 * 20) })]), null);
});

test('treats an acknowledged concern as still live', () => {
  assert.notEqual(findDuplicate(candidate(), [concern({ status: 'acknowledged' })]), null);
});

test('does not match a resolved concern - a recurrence deserves a fresh alert', () => {
  assert.equal(findDuplicate(candidate(), [concern({ status: 'resolved' })]), null);
});

test('does not match a different thread, even in the same category', () => {
  // Two machines failing minutes apart are two problems.
  assert.equal(findDuplicate(candidate({ threadRootIds: ['t2'] }), [concern()]), null);
});

test('matches on thread alone, whatever the category says', () => {
  // The model can label a follow-up differently from the message it replies to;
  // the reply chain is the more reliable signal.
  assert.notEqual(findDuplicate(candidate({ category: 'quality_reprint' }), [concern()]), null);
});

test('picks the newest match so appends follow the live thread', () => {
  const older = concern({ createdAt: minsAgo(20), summary: 'older' });
  const newer = concern({ createdAt: minsAgo(2), summary: 'newer' });
  assert.equal(findDuplicate(candidate(), [older, newer]).summary, 'newer');
});

// --- classifier output parsing -------------------------------------------

const known = new Set(['m1', 'm2']);

test('accepts a clean response', () => {
  const out = parseConcerns(
    '{"concerns":[{"messageIds":["m1"],"category":"machine_breakdown","severity":"high","summary":"Kolbus down","ownerHint":"maintenance"}]}',
    known,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'machine_breakdown');
  assert.equal(out[0].ownerHint, 'maintenance');
});

test('accepts an empty result - the common case', () => {
  assert.deepEqual(parseConcerns('{"concerns":[]}', known), []);
});

test('strips a markdown fence rather than failing over it', () => {
  const out = parseConcerns(
    '```json\n{"concerns":[{"messageIds":["m1"],"category":"safety","severity":"high","summary":"burn"}]}\n```',
    known,
  );
  assert.equal(out.length, 1);
});

test('drops invented message ids, and the concern if none survive', () => {
  const out = parseConcerns(
    '{"concerns":[{"messageIds":["m1","nope"],"category":"safety","severity":"low","summary":"a"},{"messageIds":["ghost"],"category":"safety","severity":"low","summary":"b"}]}',
    known,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].messageIds, ['m1']);
});

test('coerces unknown categories and severities instead of rejecting', () => {
  const out = parseConcerns(
    '{"concerns":[{"messageIds":["m1"],"category":"made_up","severity":"catastrophic","summary":"x"}]}',
    known,
  );
  assert.equal(out[0].category, 'other');
  assert.equal(out[0].severity, 'low');
});

test('throws on malformed output so the caller can escalate', () => {
  assert.throws(() => parseConcerns('sorry, I cannot help with that', known), MalformedLlmOutput);
  assert.throws(() => parseConcerns('{"result":[]}', known), MalformedLlmOutput);
});

// --- routing --------------------------------------------------------------

const defaults = { ownerPhone: '919000000000', cooldownMin: 30, escalateAfterMin: 30 };
const rows = [
  { groupId: '*', category: 'machine_breakdown', ownerPhone: '919000000002' },
  { groupId: 'g1', category: 'machine_breakdown', ownerPhone: '919000000001', cooldownMin: 15 },
  { groupId: '*', category: 'safety', ownerPhone: '919000000003', escalateAfterMin: 5 },
];

test('prefers an exact group+category rule over the wildcard', () => {
  const r = resolveRouting('g1', 'machine_breakdown', rows, defaults);
  assert.equal(r.ownerPhone, '919000000001');
  assert.equal(r.matched, 'group_category');
  assert.equal(r.cooldownMin, 15);
});

test('falls back to the wildcard rule for another group', () => {
  const r = resolveRouting('g2', 'machine_breakdown', rows, defaults);
  assert.equal(r.ownerPhone, '919000000002');
  assert.equal(r.matched, 'any_group_category');
});

test('falls back to the default owner when no rule matches', () => {
  const r = resolveRouting('g1', 'hr_attendance', rows, defaults);
  assert.equal(r.ownerPhone, '919000000000');
  assert.equal(r.matched, 'default');
});

test('inherits unset cooldown and escalation from the defaults', () => {
  assert.equal(resolveRouting('g2', 'machine_breakdown', rows, defaults).cooldownMin, 30);
  assert.equal(resolveRouting('g2', 'safety', rows, defaults).escalateAfterMin, 5);
  assert.equal(resolveRouting('g2', 'safety', rows, defaults).cooldownMin, 30);
});

test('returns null when nobody can be alerted at all', () => {
  assert.equal(resolveRouting('g1', 'hr_attendance', [], { ...defaults, ownerPhone: '' }), null);
});

// --- the group's own person -----------------------------------------------
//
// A client group has one person who owns that customer. They should get
// everything from that group without anyone writing one routing row per
// category to say so.

const withPerson = { ...defaults, groupOwnerPhone: '919000000009' };

test("the group's person beats the wildcard rule", () => {
  const r = resolveRouting('g2', 'machine_breakdown', rows, withPerson);
  assert.equal(r.ownerPhone, '919000000009');
  assert.equal(r.matched, 'group');
});

test("the group's person beats the default owner", () => {
  const r = resolveRouting('g1', 'hr_attendance', rows, withPerson);
  assert.equal(r.ownerPhone, '919000000009');
  assert.equal(r.matched, 'group');
});

test("an exact group+category rule still beats the group's person", () => {
  // Naming both the group and the category is a deliberate override, and the
  // more specific statement wins.
  const r = resolveRouting('g1', 'machine_breakdown', rows, withPerson);
  assert.equal(r.ownerPhone, '919000000001');
  assert.equal(r.matched, 'group_category');
});

test('no person on the group changes nothing', () => {
  const r = resolveRouting('g2', 'machine_breakdown', rows, { ...defaults, groupOwnerPhone: null });
  assert.equal(r.matched, 'any_group_category');
});

// --- one prompt per kind of group -----------------------------------------

test('a client group is judged by the client prompt', () => {
  assert.match(promptForKind('client'), /customers/);
  assert.match(promptForKind('client'), /unanswered ask is a concern/);
});

test('an internal group is judged by the internal prompt', () => {
  assert.match(promptForKind('internal'), /Has something gone wrong/);
});

test('an unknown or missing kind falls back to internal', () => {
  // The client prompt raises far more. Applying it to a plant group because a
  // field was never set would bury somebody in alerts, so the quiet prompt is
  // the one you get by accident.
  assert.equal(promptForKind(undefined), promptForKind('internal'));
  assert.equal(promptForKind('nonsense'), promptForKind('internal'));
});

// --- the ladder's first rung is better than nobody --------------------------
//
// A group with an escalation ladder and no person alerted names an ordered list
// of people and no first recipient. Read literally that alerts nobody: the
// first alert never fires, so the ladder that only climbs after one never runs.
// Nobody writing a list of names meant that.

const LADDER = ['919000000005', '919000000006'];

test("the ladder's first rung is alerted when nothing else names anyone", () => {
  const r = resolveRouting('g9', 'machine_breakdown', [], {
    cooldownMin: 30,
    escalateAfterMin: 30,
    ownerPhone: '',
    groupLadder: LADDER,
  });
  assert.equal(r.ownerPhone, '919000000005');
  assert.equal(r.matched, 'ladder_first');
});

test('but the default owner still beats it', () => {
  const r = resolveRouting('g9', 'machine_breakdown', [], { ...defaults, groupLadder: LADDER });
  assert.equal(r.ownerPhone, defaults.ownerPhone);
  assert.equal(r.matched, 'default');
});

test("and the group's own person beats it", () => {
  const r = resolveRouting('g9', 'machine_breakdown', [], {
    ...defaults,
    groupOwnerPhone: '919000000009',
    groupLadder: LADDER,
  });
  assert.equal(r.ownerPhone, '919000000009');
  assert.equal(r.matched, 'group');
});

test('an empty ladder and nothing else still reaches nobody', () => {
  // The caller has to say so loudly rather than pretending someone was alerted.
  assert.equal(
    resolveRouting('g9', 'machine_breakdown', [], {
      cooldownMin: 30,
      escalateAfterMin: 30,
      ownerPhone: '',
      groupLadder: [],
    }),
    null,
  );
});
