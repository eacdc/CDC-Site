/**
 * A GRN line that stock has been issued from cannot be deleted until its
 * issue lines are. Data: REC04597_26_27 as the ERP holds it (22 Oct 2026) -
 * line 1 drawn on by IS18211 (300), line 4 by IS18087 (90).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deletableGrnLines } from '../services/grn-issues.js';

const REC04597 = [
  { TransactionDetailID: 116781, TransID: 1, ItemID: 7296, Qty: 818 },
  { TransactionDetailID: 116782, TransID: 2, ItemID: 5518, Qty: 810 },
  { TransactionDetailID: 116783, TransID: 3, ItemID: 9652, Qty: 118 },
  { TransactionDetailID: 116784, TransID: 4, ItemID: 5560, Qty: 90 },
  { TransactionDetailID: 116785, TransID: 5, ItemID: 5560, Qty: 413 },
];
const ISSUES = [
  { BatchID: 116784, IssueNo: 'IS18087_26_27', IssueDate: '2026-10-12', IssueQuantity: 90 },
  { BatchID: 116781, IssueNo: 'IS18211_26_27', IssueDate: '2026-10-14', IssueQuantity: 300 },
];

test('an issued GRN line cannot be deleted, and says which issue holds it', () => {
  const lines = deletableGrnLines(REC04597, ISSUES);
  assert.deepEqual(lines.map((l) => l.deletable), [false, true, true, false, true]);
  assert.match(lines[0].reason, /Issued on IS18211_26_27 \(300\)\. Delete that issue line first\./);
  assert.equal(lines[3].issuedQty, 90);
});

test('the issue is matched to the exact GRN line, not just the item', () => {
  // Lines 4 and 5 are the same box; only line 4's batch was issued.
  const lines = deletableGrnLines(REC04597, ISSUES);
  assert.equal(lines[3].deletable, false);
  assert.equal(lines[4].deletable, true);
});

test('once the issue line is deleted, the GRN line is free again', () => {
  const lines = deletableGrnLines(REC04597, ISSUES.filter((i) => i.IssueNo !== 'IS18211_26_27'));
  assert.equal(lines[0].deletable, true);
  assert.equal(lines[3].deletable, false);
});

test('several issues on one line are all named', () => {
  const two = [...ISSUES, { BatchID: 116781, IssueNo: 'IS18300_26_27', IssueDate: '2026-10-20', IssueQuantity: 200 }];
  const [line1] = deletableGrnLines(REC04597, two);
  assert.equal(line1.issuedQty, 500);
  assert.match(line1.reason, /IS18211_26_27, IS18300_26_27 \(500\)\. Delete those issue lines first\./);
});
