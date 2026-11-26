/**
 * Editing a PO in the ERP: what the audit records, and what the checks keep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { editSummary, editBasis } from '../services/po-edit.js';

const before = {
  supplierLedgerId: 6846,
  lines: [
    { itemId: 4266, qty: 231, rate: 42, expectedDate: '2026-11-21', clientId: 8729, requisition: { requisitionTransactionId: 74093 } },
    { itemId: 4089, qty: 617, rate: 16.32, expectedDate: '2026-11-21', clientId: 9891, requisition: null },
  ],
};

test('the audit lists every change, line by line', () => {
  const changes = editSummary(before, {
    lines: [
      { itemId: 4266, itemCode: 'P00797', qty: 300, rate: 42, expectedDate: '2026-11-25' },
      { itemId: 3830, itemCode: 'P00018', qty: 1000, rate: 79.5, expectedDate: '2026-11-25' },
    ],
  });
  assert.deepEqual(changes, [
    'P00797 qty 231 -> 300',
    'P00797 expected 2026-11-21 -> 2026-11-25',
    'added P00018: 1000 at 79.5',
    'removed item 4089',
  ]);
});

test('an unchanged line records no change', () => {
  assert.deepEqual(editSummary(before, { lines: [{ itemId: 4266, itemCode: 'P00797', qty: 231, rate: 42, expectedDate: '2026-11-21' }, { itemId: 4089, itemCode: 'X', qty: 617, rate: 16.32, expectedDate: '2026-11-21' }] }), []);
});

test('the checks see each line as it stands, by item', () => {
  const basis = editBasis(before);
  assert.equal(basis.supplierLedgerId, 6846);
  assert.equal(basis.linesByItem.get(4266).rate, 42);
  assert.equal(basis.linesByItem.get(4266).requisition.requisitionTransactionId, 74093);
  assert.equal(basis.linesByItem.get(1), undefined);
});
