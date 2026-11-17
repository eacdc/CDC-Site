/**
 * The proposal collections take new records and a reviewer's decision, and
 * nothing else.
 *
 * Run against an unconnected Mongoose connection with buffering off: a write
 * the guard allows fails for want of a database, and a write it refuses fails
 * at the guard first. The two errors are told apart by message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { autoQuoteSchema, mappingProposalSchema, lockModel, decideProposal } from '../models/proposals.js';
import { RunPayloadSchema } from '../services/proposals.js';

const conn = mongoose.createConnection();
conn.set('bufferCommands', false);
const Proposal = lockModel(conn.model('TestProposal', mappingProposalSchema.clone()));
const Quote = lockModel(conn.model('TestAutoQuote', autoQuoteSchema.clone()));
const REFUSED = /only takes new records/;
const id = new mongoose.Types.ObjectId();

test('updates and deletes through a query are refused', async () => {
  await assert.rejects(Proposal.updateOne({ _id: id }, { $set: { status: 'APPROVED' } }), REFUSED);
  await assert.rejects(Proposal.updateOne({ _id: id, status: 'UNAPPROVED' }, { $set: { 'decision.itemId': 1 } }), REFUSED,
    'a well-formed decision outside decideProposal is still refused');
  await assert.rejects(Proposal.deleteOne({ _id: id }), REFUSED);
  await assert.rejects(Quote.updateOne({ _id: id }, { $set: { fileName: 'x' } }), REFUSED);
  await assert.rejects(Quote.deleteOne({ _id: id }), REFUSED);
  await assert.rejects(Proposal.findOne({ _id: id }).updateOne({ $set: { status: 'REJECTED' } }), REFUSED);
});

test('bulk and convenience writes are taken off the model', () => {
  for (const call of [
    () => Proposal.bulkWrite([]), () => Proposal.updateMany({}, {}), () => Proposal.deleteMany({}),
    () => Proposal.findByIdAndUpdate(id, {}), () => Proposal.findByIdAndDelete(id),
    () => Proposal.findOneAndUpdate({}, {}), () => Proposal.replaceOne({}, {}), () => Quote.deleteMany({}),
  ]) assert.throws(call, REFUSED);
});

test('an existing record cannot be saved over or removed', async () => {
  const doc = Proposal.hydrate({ _id: id, autoQuoteId: id, site: 'KOL', line: { productName: 'x' }, rulesVersion: 'v', runId: 'r' });
  doc.status = 'APPROVED';
  await assert.rejects(doc.save(), REFUSED);
  await assert.rejects(doc.deleteOne(), REFUSED);
});

test('a new record is allowed through', async () => {
  // Fails for want of a database, not at the guard.
  await assert.rejects(
    Proposal.create({ autoQuoteId: id, site: 'KOL', line: { productName: 'x' }, rulesVersion: 'v', runId: 'r' }),
    (err) => !REFUSED.test(err.message),
  );
});

test('a decision needs a known action and a reviewer', async () => {
  await assert.rejects(decideProposal(Proposal, { id, action: 'DELETE', by: 'a@b' }), REFUSED);
  await assert.rejects(decideProposal(Proposal, { id, action: 'APPROVE' }), /no reviewer/);
});

test('the run cannot set a status or decision on what it sends', () => {
  const parsed = RunPayloadSchema.parse({
    sha256: 'a'.repeat(64), fileName: 'q.pdf', site: 'KOL', rulesVersion: 'v1', runId: 'r1',
    lines: [{ line: { productName: 'Tape' }, proposal: { method: 'NONE' }, status: 'APPROVED', decision: { action: 'APPROVE' } }],
  });
  assert.equal(parsed.lines[0].status, undefined);
  assert.equal(parsed.lines[0].decision, undefined);
});
