import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResolution } from './llm/parse.js';
import { dueForEscalation } from './router/escalation-rules.js';
import { threadQueryFor } from './detector/threads.js';

const known = new Set(['M1', 'M2']);

test('a clear resolution with evidence is accepted', () => {
  const v = parseResolution('{"resolved":true,"msgId":"M2","reason":"machine running"}', known);
  assert.deepEqual(v, { resolved: true, msgId: 'M2', reason: 'machine running' });
});

test('not resolved is the answer whenever the model says so', () => {
  assert.equal(parseResolution('{"resolved":false,"msgId":null}', known).resolved, false);
});

test('a resolution citing a message we never sent is not trusted', () => {
  // Evidence we cannot show the user is not evidence, and the safe direction is
  // to leave the concern escalating.
  assert.equal(parseResolution('{"resolved":true,"msgId":"INVENTED"}', known).resolved, false);
});

test('a resolution with no evidence at all is not trusted', () => {
  assert.equal(parseResolution('{"resolved":true}', known).resolved, false);
});

test('unparseable output means not resolved rather than throwing', () => {
  // Unlike the classifier, there is no strong model to escalate to here, and a
  // wrong "resolved" silently stops escalation - so junk fails safe.
  assert.equal(parseResolution('the machine seems fine now', known).resolved, false);
  assert.equal(parseResolution('', known).resolved, false);
});

test('a markdown fence is stripped like everywhere else', () => {
  const v = parseResolution('```json\n{"resolved":true,"msgId":"M1"}\n```', known);
  assert.equal(v.resolved, true);
});

const overdue = (extra = {}) => ({
  status: 'open',
  createdAt: new Date(Date.now() - 60 * 60_000),
  escalatedTo: [],
  ...extra,
});

test('a possibly-resolved concern does not escalate', () => {
  assert.equal(dueForEscalation(overdue(), new Date(), 30), true, 'baseline: it would have');
  assert.equal(dueForEscalation(overdue({ resolutionHint: { msgId: 'M2' } }), new Date(), 30), false);
});

test('clearing the hint resumes escalation', () => {
  const concern = overdue({ resolutionHint: { msgId: 'M2' } });
  assert.equal(dueForEscalation(concern, new Date(), 30), false);
  delete concern.resolutionHint;
  assert.equal(dueForEscalation(concern, new Date(), 30), true);
});

// --- backfilled concerns --------------------------------------------------

test('a backfilled concern never escalates', () => {
  // It was history when the tool read it and nobody was DMed, so an escalation
  // would be the first anyone heard - about a problem that may be long over.
  assert.equal(dueForEscalation(overdue({ backfilledAt: new Date() }), new Date(), 30), false);
});

test('a backfilled concern escalates again once the flag is cleared', () => {
  // detect.js clears it when new messages land in the thread during a normal
  // poll: still being talked about means it is live after all.
  const concern = overdue({ backfilledAt: new Date() });
  assert.equal(dueForEscalation(concern, new Date(), 30), false);
  delete concern.backfilledAt;
  assert.equal(dueForEscalation(concern, new Date(), 30), true);
});

test('backfilled outranks the resolution hint - both mean do not escalate', () => {
  assert.equal(
    dueForEscalation(overdue({ backfilledAt: new Date(), resolutionHint: { msgId: 'M2' } }), new Date(), 30),
    false,
  );
});

// --- which messages count as the thread -----------------------------------
//
// The detail route and the resolution checker must agree. They once did not:
// the route fell back to the cited messages when a concern had no thread roots
// and the checker bailed out, so the page showed a conversation ending in
// "Running..." while the checker never read a word of it.

test('a concern with thread roots is read by its roots', () => {
  assert.deepEqual(threadQueryFor({ groupId: 'G1', threadRootIds: ['R1', 'R2'], messageIds: ['M1'] }), {
    groupId: 'G1',
    threadRootId: { $in: ['R1', 'R2'] },
  });
});

test('a concern with no roots falls back to the messages it cited', () => {
  assert.deepEqual(threadQueryFor({ groupId: 'G1', threadRootIds: [], messageIds: ['M1', 'M2'] }), {
    msgId: { $in: ['M1', 'M2'] },
  });
});

test('a concern predating thread roots entirely still has a query', () => {
  // whatsapp-backfill-threads leaves threadRootIds absent or empty by design.
  assert.deepEqual(threadQueryFor({ groupId: 'G1', messageIds: ['M1'] }), { msgId: { $in: ['M1'] } });
});

test('a concern with nothing to anchor to yields a query that matches nothing', () => {
  // Rather than throwing, or worse, matching every message in the collection.
  assert.deepEqual(threadQueryFor({ groupId: 'G1' }), { msgId: { $in: [] } });
});
