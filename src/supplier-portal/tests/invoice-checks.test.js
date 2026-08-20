/**
 * Validation catalogue tests.
 *
 * These checks stand between a tablet photo and a posted voucher, so what
 * matters as much as catching a bad invoice is not blocking a good one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runInvoiceChecks, isValidEwayBill } from '../services/invoice-checks.js';
import { hasBlockingFailure, warningsNeedingReason, check } from '../config/validations.js';

/** A clean invoice, used as the baseline every case perturbs. */
function goodInvoice(overrides = {}) {
  const header = {
    invoiceNo: 'KV/26-27/12945',
    invoiceDate: new Date(Date.now() - 86400000),
    buyerGstin: '19AABCC2946B1ZZ',
    supplierState: 'West Bengal',
    shipToState: 'West Bengal',
    taxType: 'CGST_SGST',
    subTotal: 39167.24,
    freight: 1180,
    taxable: 40347.24,
    cgst: 3631.25,
    sgst: 3631.25,
    igst: 0,
    roundOff: 0.26,
    grandTotal: 47610,
    eWayBillNo: '123456789012',
    ...overrides.header,
  };
  const lines = [
    {
      lineNo: 1, description: 'Gloss Art 90 GSM', qty: 20890.76 / 76, rate: 76,
      amount: 20890.76, matchedPoTransactionId: 58682, matchedPoRate: 76, poPendingQty: 300,
      ...(overrides.line1 || {}),
    },
    {
      lineNo: 2, description: 'Gloss Art 100 GSM', qty: 18276.48 / 79, rate: 79,
      amount: 18276.48, matchedPoTransactionId: 58682, matchedPoRate: 79, poPendingQty: 300,
      ...(overrides.line2 || {}),
    },
  ];
  return { header, lines, context: { freightLedgerId: 9621 }, ...overrides.rest };
}

function find(checks, code) {
  return checks.filter((c) => c.code === code);
}

test('a clean invoice raises no blocking failure', () => {
  const checks = runInvoiceChecks(goodInvoice());
  const blocking = checks.filter((c) => !c.passed && c.severity === 'BLOCK');
  assert.deepEqual(blocking.map((c) => `${c.code}: ${c.message}`), [], 'nothing should block');
});

test('checks report passing explicitly, not by absence', () => {
  // A check that vanishes when it succeeds is indistinguishable from one that
  // never ran, and the review screen has to show the arithmetic was verified.
  const checks = runInvoiceChecks(goodInvoice());
  assert.ok(find(checks, 'INV010').length, 'the grand total check must be present');
  assert.equal(find(checks, 'INV010')[0].passed, true);
});

test('INV001 blocks an invoice already posted', () => {
  const checks = runInvoiceChecks({
    ...goodInvoice(),
    alreadyPosted: { VoucherNo: 'REC03283_26_27', VoucherDate: new Date() },
  });
  assert.equal(find(checks, 'INV001')[0].passed, false);
  assert.ok(hasBlockingFailure(checks));
});

test('INV013 blocks an invoice billed to someone other than CDC', () => {
  const checks = runInvoiceChecks(goodInvoice({ header: { buyerGstin: '27AAAAA0000A1Z5' } }));
  assert.equal(find(checks, 'INV013')[0].passed, false);
});

test('INV003 blocks over-receipt beyond 10% and allows 10%', () => {
  const over = runInvoiceChecks(goodInvoice({ line1: { qty: 331, poPendingQty: 300 } }));
  assert.equal(find(over, 'INV003')[0].passed, false, '331 against 300 is over the tolerance');

  const atLimit = runInvoiceChecks(goodInvoice({ line1: { qty: 330, poPendingQty: 300 } }));
  assert.equal(find(atLimit, 'INV003')[0].passed, true, 'exactly 10% over is allowed');
});

test('INV002 blocks a line with no matching open PO', () => {
  const checks = runInvoiceChecks(goodInvoice({ line1: { matchedPoTransactionId: null } }));
  assert.equal(find(checks, 'INV002')[0].passed, false);
});

test('INV005 blocks an invoice rate that differs from the PO rate', () => {
  const checks = runInvoiceChecks(goodInvoice({ line1: { rate: 80, matchedPoRate: 76 } }));
  assert.equal(find(checks, 'INV005')[0].passed, false);
});

test('INV006 catches a line whose total is not quantity times rate', () => {
  const checks = runInvoiceChecks(goodInvoice({ line1: { qty: 100, rate: 76, amount: 9999 } }));
  assert.equal(find(checks, 'INV006')[0].passed, false);
});

test('INV008 checks that freight is in the taxable base', () => {
  // Taxable stated as the subtotal alone, with freight ignored.
  const checks = runInvoiceChecks(goodInvoice({ header: { taxable: 39167.24 } }));
  assert.equal(find(checks, 'INV008')[0].passed, false);
});

test('INV010 catches a grand total that does not add up', () => {
  const checks = runInvoiceChecks(goodInvoice({ header: { grandTotal: 50000 } }));
  assert.equal(find(checks, 'INV010')[0].passed, false);
});

test('INV012 warns on a tax-type disagreement but never blocks', () => {
  // Place of supply follows delivery: a Gujarat consignment should be IGST.
  const checks = runInvoiceChecks(goodInvoice({
    header: { shipToState: 'Gujarat', taxType: 'CGST_SGST' },
  }));
  const inv012 = find(checks, 'INV012')[0];
  assert.equal(inv012.passed, false);
  assert.equal(inv012.severity, 'WARN', 'the supplier decided this when they filed — never override it');
});

test('INV015 blocks a future-dated invoice', () => {
  const checks = runInvoiceChecks(goodInvoice({
    header: { invoiceDate: new Date(Date.now() + 5 * 86400000) },
  }));
  assert.equal(find(checks, 'INV015')[0].passed, false);
});

test('INV016 warns on an invoice more than 90 days old', () => {
  const checks = runInvoiceChecks(goodInvoice({
    header: { invoiceDate: new Date(Date.now() - 120 * 86400000) },
  }));
  const inv016 = find(checks, 'INV016')[0];
  assert.equal(inv016.passed, false);
  assert.equal(inv016.severity, 'WARN');
});

test('INV018 blocks freight with no ledger selected', () => {
  const input = goodInvoice();
  input.context = {};
  const checks = runInvoiceChecks(input);
  assert.equal(find(checks, 'INV018')[0].passed, false);
});

test('INV014 requires an e-way bill above the threshold', () => {
  // Intrastate threshold is ₹1,00,000.
  const missing = runInvoiceChecks(goodInvoice({
    header: { grandTotal: 150000, eWayBillNo: null },
  }));
  assert.equal(find(missing, 'INV014')[0].passed, false);

  const below = runInvoiceChecks(goodInvoice({
    header: { grandTotal: 50000, eWayBillNo: null },
  }));
  assert.equal(find(below, 'INV014')[0].passed, true, 'below the threshold none is needed');
});

test('an e-way bill number is twelve digits', () => {
  assert.equal(isValidEwayBill('123456789012'), true);
  assert.equal(isValidEwayBill('1234 5678 9012'), true);
  assert.equal(isValidEwayBill('12345'), false);
  assert.equal(isValidEwayBill(null), false);
});

test('a BLOCK can never be overridden, a WARN needs a reason', () => {
  const checks = [
    check('INV003', false),
    check('INV016', false),
    check('INV011', true),
  ];
  assert.equal(hasBlockingFailure(checks), true);
  assert.deepEqual(warningsNeedingReason(checks).map((c) => c.code), ['INV016']);

  // A reason on a WARN does not clear a BLOCK.
  checks[1].overrideReason = 'Supplier re-sent an old invoice; confirmed with them.';
  assert.equal(hasBlockingFailure(checks), true);
});
