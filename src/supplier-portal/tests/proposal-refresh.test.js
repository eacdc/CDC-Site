/**
 * An undecided line is proposed again, as a new record, when the rules
 * change: the old record is never edited, and exactly one record stands for
 * each line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { currentProposals, lineKey } from '../models/proposals.js';
import { RefreshPayloadSchema } from '../services/proposals.js';

const at = (day) => new Date(`2026-11-${String(day).padStart(2, '0')}T10:00:00Z`);
const first = { _id: 'a1', refreshOf: null, status: 'UNAPPROVED', createdAt: at(17), proposal: { itemId: null } };
const again = { _id: 'a2', refreshOf: 'a1', status: 'UNAPPROVED', createdAt: at(18), proposal: { itemId: 501 } };
const other = { _id: 'b1', refreshOf: null, status: 'UNAPPROVED', createdAt: at(17), proposal: { itemId: null } };

test('a refresh shares its line with the record it replaces', () => {
  assert.equal(lineKey(first), 'a1');
  assert.equal(lineKey(again), 'a1');
});

test('the newest record stands for an undecided line, and the line counts once', () => {
  const current = currentProposals([first, again, other]);
  assert.equal(current.length, 2);
  const line = current.find((p) => lineKey(p) === 'a1');
  assert.equal(line._id, 'a2');
  assert.equal(line.refreshes, 1);
  assert.equal(current.find((p) => lineKey(p) === 'b1').refreshes, 0);
});

test('a decision stands over any later refresh', () => {
  const decided = { ...first, status: 'REJECTED' };
  assert.equal(currentProposals([decided, again])[0]._id, 'a1', 'a refresh that raced a decision does not undo it');
});

test('a refresh carries only a proposal: the line and its rate come from the record it replaces', () => {
  const payload = {
    rulesVersion: 'abc', runId: 'r',
    refreshes: [{ proposalId: 'a'.repeat(24), proposal: { itemId: 501, itemName: 'x', method: 'APPROVED_MAPPING' }, line: { productName: 'changed' } }],
  };
  const parsed = RefreshPayloadSchema.parse(payload);
  assert.equal(parsed.refreshes[0].line, undefined);
  assert.equal(parsed.refreshes[0].proposal.itemId, 501);
  assert.throws(() => RefreshPayloadSchema.parse({ ...payload, refreshes: [{ proposalId: 'nope', proposal: payload.refreshes[0].proposal }] }));
});
