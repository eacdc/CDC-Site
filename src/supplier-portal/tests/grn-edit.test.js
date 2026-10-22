/**
 * The rules for editing and deleting a posted GRN, on REC04597_26_27 as the
 * ERP holds it (22 Oct 2026): line 1 issued 300 on IS18211, line 4 issued 90
 * on IS18087; lines 2, 3 and 5 free. With and without a purchase invoice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeGrn, issueState } from '../services/grn-register.js';
import { planGrnEdit, canEditGrns } from '../services/erp-grn-edit.js';

const HEADER = {
  TransactionID: 68220, VoucherNo: 'REC04597_26_27', VoucherDate: '2026-10-12', LedgerID: 8535,
  SupplierName: 'Pranay Udyog', DeliveryNoteNo: 'PU/26-27/0710', DeliveryNoteDate: new Date('2026-10-09T00:00:00Z'),
  GateEntryNo: '25605', GateEntryDate: new Date('2026-10-11T00:00:00Z'), EWayBillNumber: null, EWayBillDate: null,
  VehicleNo: null, ReceivedBy: 9879, ModifiedDate: new Date('2026-10-12T12:32:27.990Z'),
};
const box = (id, transId, itemId, qty) => ({
  TransactionDetailID: id, TransID: transId, ItemID: itemId, ItemCode: `S${itemId}`, ItemName: `Box ${itemId}`,
  Qty: qty, StockQty: qty, StockUnit: 'NOS', PurchaseUnit: 'PCS', WarehouseID: 13, WtPerPacking: 0, UnitPerPacking: 0,
  PoVoucherNo: 'PO03342_26_27', PoTransactionDetailID: 9000 + transId, PoCompleted: false,
});
const LINES = [box(116781, 1, 7296, 818), box(116782, 2, 5518, 810), box(116783, 3, 9652, 118), box(116784, 4, 5560, 90), box(116785, 5, 5560, 413)];
const ISSUES = [
  { BatchID: 116784, IssueNo: 'IS18087_26_27', IssueDate: '2026-10-12', IssueQuantity: 90 },
  { BatchID: 116781, IssueNo: 'IS18211_26_27', IssueDate: '2026-10-14', IssueQuantity: 300 },
];
const PI = [{ TransactionID: 8700, VoucherNo: 'PI04500_26_27', VoucherDate: '2026-10-12' }];

const grn = (invoices = []) => shapeGrn(HEADER, LINES, ISSUES, invoices);
const line = (g, no) => g.lines.find((l) => l.lineNo === no);

test('issued, part or full - of the stock the GRN brought in', () => {
  assert.equal(issueState(500, 0), 'none');
  assert.equal(issueState(500, 120), 'part');
  assert.equal(issueState(500, 500), 'full');
});

test('a GRN issued from cannot be deleted, and says which issues hold it', () => {
  const g = grn();
  assert.match(g.deleteLocked, /line 1, 4/);
  assert.match(g.deleteLocked, /IS18211_26_27/);
  assert.match(g.deleteLocked, /IS18087_26_27/);
});

test('a GRN with a purchase invoice cannot be deleted, issued or not', () => {
  const free = shapeGrn(HEADER, LINES, [], PI);
  assert.match(free.deleteLocked, /PI04500_26_27.*Delete it in the ERP first/);
  assert.equal(shapeGrn(HEADER, LINES, [], []).deleteLocked, null);
});

test('header fields change; unchanged ones are not written', () => {
  const plan = planGrnEdit(grn(PI), { header: { deliveryNoteNo: 'PU/26-27/0710', gateEntryNo: '25606', deliveryNoteDate: '2026-10-09' } });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.header, [{ field: 'gateEntryNo', before: '25605', after: '25606' }]);
});

test('the D.N. no. cannot be blanked', () => {
  const plan = planGrnEdit(grn(), { header: { deliveryNoteNo: '  ' } });
  assert.match(plan.errors.join(' '), /cannot be blank/);
});

test('an issued line can go down, but not below what was issued', () => {
  const g = grn();
  const ok = planGrnEdit(g, { lines: [{ transactionDetailId: 116781, stockQty: 300 }] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.lines[0].changes.map((c) => [c.field, c.after]), [['stockQty', 300], ['qty', 300]]);
  const low = planGrnEdit(g, { lines: [{ transactionDetailId: 116781, stockQty: 299 }] });
  assert.match(low.errors.join(' '), /Line 1: 300 NOS has already been issued from it \(IS18211_26_27\)/);
});

test('an issued line keeps its warehouse and cannot be removed', () => {
  const plan = planGrnEdit(grn(), { lines: [
    { transactionDetailId: 116784, warehouseId: 14 },
    { transactionDetailId: 116781, remove: true },
  ] });
  assert.match(plan.errors.join(' '), /Line 4: Issued on IS18087_26_27: the stock left from this warehouse/);
  assert.match(plan.errors.join(' '), /Line 1: Issued on IS18211_26_27 \(300\)/);
});

test('a free line moves warehouse or comes off', () => {
  const plan = planGrnEdit(grn(), { lines: [
    { transactionDetailId: 116782, warehouseId: 14 },
    { transactionDetailId: 116783, remove: true },
  ] });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.lines[0].changes, [{ field: 'warehouseId', before: 13, after: 14 }]);
  assert.deepEqual(plan.removals.map((r) => r.lineNo), [3]);
});

test('with a purchase invoice: header yes, quantities and removals no', () => {
  const plan = planGrnEdit(grn(PI), { lines: [
    { transactionDetailId: 116782, stockQty: 800 },
    { transactionDetailId: 116783, remove: true },
  ] });
  assert.equal(plan.errors.length, 2);
  assert.ok(plan.errors.every((e) => /PI04500_26_27/.test(e)));
  // The warehouse of a line nothing was issued from still moves.
  assert.deepEqual(planGrnEdit(grn(PI), { lines: [{ transactionDetailId: 116782, warehouseId: 14 }] }).errors, []);
});

test('paper: sheets set the kg, as on the GRN screen', () => {
  const paper = shapeGrn(HEADER, [{ ...box(1, 1, 3820, 148.161), StockQty: 1500, StockUnit: 'Sheet', PurchaseUnit: 'Kg', WtPerPacking: 9.87743, UnitPerPacking: 100 }]);
  const plan = planGrnEdit(paper, { lines: [{ transactionDetailId: 1, stockQty: 1000 }] });
  assert.deepEqual(plan.lines[0].changes.map((c) => [c.field, c.after]), [['stockQty', 1000], ['qty', 98.774]]);
});

test('removing every line is a delete, not an edit; nothing changed is said so', () => {
  const two = shapeGrn(HEADER, LINES.slice(1, 3));
  const plan = planGrnEdit(two, { lines: [{ transactionDetailId: 116782, remove: true }, { transactionDetailId: 116783, remove: true }] });
  assert.match(plan.errors.join(' '), /Delete the GRN instead/);
  assert.match(planGrnEdit(grn(), {}).errors.join(' '), /Nothing has changed/);
});

test('a line from another GRN is refused', () => {
  assert.match(planGrnEdit(grn(), { lines: [{ transactionDetailId: 1, stockQty: 5 }] }).errors.join(' '), /not on REC04597_26_27/);
});

test('only the people named in SP_GRN_EDITORS may edit', () => {
  const before = process.env.SP_GRN_EDITORS;
  try {
    delete process.env.SP_GRN_EDITORS;
    assert.equal(canEditGrns({ erpUserName: 'Manu' }), false);
    process.env.SP_GRN_EDITORS = 'manu, Pranay';
    assert.equal(canEditGrns({ erpUserName: 'MANU' }), true);
    assert.equal(canEditGrns({ erpUserName: 'Manik' }), false);
    assert.equal(canEditGrns({}), false);
  } finally {
    if (before === undefined) delete process.env.SP_GRN_EDITORS; else process.env.SP_GRN_EDITORS = before;
  }
});
