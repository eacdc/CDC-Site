import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResolution } from './llm/parse.js';
import { dueForEscalation } from './router/escalation-rules.js';

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
