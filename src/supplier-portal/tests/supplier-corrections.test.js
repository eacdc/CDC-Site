/**
 * Who sent a quote: an approver's correction is a new record, the newest one
 * wins, and the quote and its lines keep what the run read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { latestCorrections, applyCorrections } from '../models/proposals.js';
import { uploaderSupplier, typedSupplier } from '../services/proposals.js';

const fix = (id, quote, name, at, extra = {}) => ({
  _id: id, autoQuoteId: quote, supplier: { name, gstin: extra.gstin ?? null },
  previous: { name: 'Read name', gstin: null }, by: 'approver@cdc', createdAt: new Date(at), ...extra,
});

test('the newest correction for a quote wins', () => {
  const latest = latestCorrections([
    fix('a1', 'q1', 'First', '2026-11-01'),
    fix('a2', 'q1', 'Second', '2026-11-03'),
    fix('a3', 'q2', 'Other', '2026-11-02'),
  ]);
  assert.equal(latest.get('q1').supplier.name, 'Second');
  assert.equal(latest.get('q2').supplier.name, 'Other');
});

test('a line takes its quote\'s correction; a quote is matched by its own id', () => {
  const corrections = [fix('a1', 'q1', 'Sudarshan Papers', '2026-11-01', { gstin: '19ABCDE1234F1Z5', note: 'trader letterhead' })];
  const [line, other] = applyCorrections([
    { _id: 'p1', autoQuoteId: 'q1', supplier: { name: 'Read name' } },
    { _id: 'p2', autoQuoteId: 'q9', supplier: { name: 'Untouched' } },
  ], corrections);
  assert.deepEqual(line.supplier, { name: 'Sudarshan Papers', gstin: '19ABCDE1234F1Z5' });
  assert.equal(line.supplierCorrected.by, 'approver@cdc');
  assert.equal(line.supplierCorrected.previous.name, 'Read name');
  assert.equal(line.supplierCorrected.note, 'trader letterhead');
  assert.equal(other.supplier.name, 'Untouched');
  assert.equal(other.supplierCorrected, undefined);

  const [quote] = applyCorrections([{ _id: 'q1', supplier: { name: 'Read name' } }], corrections, { quoteIdOf: (q) => q._id });
  assert.equal(quote.supplier.name, 'Sudarshan Papers');
});

test('no corrections leaves the records as they were', () => {
  const records = [{ _id: 'p1', autoQuoteId: 'q1', supplier: { name: 'X' } }];
  assert.equal(applyCorrections(records, []), records);
});

test('the uploader\'s supplier: picked from the list, typed, or none', () => {
  const groups = new Map([['g1', { _id: 'g1', name: 'JK Paper', gstins: ['24AAACJ1234F1Z1'] }], ['g2', { _id: 'g2', name: 'Two Plants', gstins: ['A', 'B'] }]]);
  assert.deepEqual(uploaderSupplier({ supplierGroupId: 'g1' }, groups),
    { name: 'JK Paper', gstin: '24AAACJ1234F1Z1', gstins: ['24AAACJ1234F1Z1'], picked: true });
  assert.equal(uploaderSupplier({ supplierGroupId: 'g2' }, groups).gstin, null, 'two GSTINs: the document says which');
  assert.deepEqual(uploaderSupplier({ uploaderSupplier: { name: 'New Trader' } }, groups),
    { name: 'New Trader', gstin: null, gstins: [], picked: false });
  assert.equal(uploaderSupplier({}, groups), null);
});

test('a typed supplier is tidied, and a GSTIN must look like one', () => {
  assert.deepEqual(typedSupplier({ name: '  New   Trader ', gstin: ' 19abcde1234f1z5 ' }), { name: 'New Trader', gstin: '19ABCDE1234F1Z5' });
  assert.deepEqual(typedSupplier({ name: 'X' }), { name: 'X', gstin: null });
  assert.throws(() => typedSupplier({ name: ' ' }), /Choose a supplier/);
  assert.throws(() => typedSupplier({ name: 'X', gstin: '123' }), /15 letters/);
});
