/**
 * Trade discounts, end to end: reading, the checks, and the purchase invoice.
 *
 * The reference is Sonafine Corporation's KOLGST26/5003360 (26-10-2026, KOL):
 * 3,136 sheets at 35.25 = 1,10,544, "Disc %" 20.00, line taxable value
 * 88,435.20; freight 3,200, taxable 91,635.20, CGST and SGST 8,247.17 each,
 * round off 0.46, grand total 1,08,130. The PO (PO03515_26_27) is at 28.20,
 * the rate after the discount. Before discounts were understood, INV005 and
 * INV008 failed it, the reader asked for a re-read, and the purchase invoice
 * would have posted 1,10,544 - 22,108.80 high, plus tax. It now posts at
 * 28.20, the way CDC has always posted a discounted bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runInvoiceChecks } from '../services/invoice-checks.js';
import { hasBlockingFailure, warningsNeedingReason } from '../config/validations.js';
import { invoiceProblems } from '../services/extraction/invoice-review.js';
import { ExtractedInvoiceSchema } from '../services/extraction/provider.js';
import { normaliseFlagPath } from '../services/extraction/field-flags.js';
import { lineMoney, discountedLines, goodsValue, storedRate } from '../lib/invoice-math.js';
import { postDocumentSet, priceLines, discountNote, narrationFor } from '../services/erp-receiving.js';
import { repricedDiscount } from '../services/line-corrections.js';

const SONAFINE_HEADER = {
  invoiceNo: 'KOLGST26/5003360',
  invoiceDate: new Date(Date.now() - 86400000),
  buyerGstin: '19AABCC2946B1ZZ',
  supplierState: 'West Bengal',
  shipToState: 'West Bengal',
  taxType: 'CGST_SGST',
  subTotal: 110544,
  freight: 3200,
  taxable: 91635.2,
  cgst: 8247.17,
  sgst: 8247.17,
  igst: 0,
  roundOff: 0.46,
  grandTotal: 108130,
  eWayBillNo: '123456789012',
};

const SONAFINE_LINE = {
  lineNo: 1, description: 'Duplex board', qty: 3136, uom: 'SHEETS', rate: 35.25, amount: 110544,
  discountPct: 20, taxableValue: 88435.2,
  matchedPoTransactionId: 61234, matchedPoTransactionDetailId: 98765, matchedPoRate: 28.2,
  poPendingQty: 3136, poQty: 3136,
};

function sonafine({ header = {}, line = {} } = {}) {
  return {
    header: { ...SONAFINE_HEADER, ...header },
    lines: [{ ...SONAFINE_LINE, ...line }],
    context: { freightLedgerId: 9621 },
  };
}

const find = (checks, code) => checks.filter((c) => c.code === code);
const failing = (checks) => checks.filter((c) => !c.passed).map((c) => `${c.code}: ${c.message}`);

// ── The line's money ────────────────────────────────────────────────────────

test('a discounted line: gross, discount and net, as printed', () => {
  const m = lineMoney(SONAFINE_LINE);
  assert.equal(m.gross, 110544);
  assert.equal(m.discount, 22108.8);
  assert.equal(m.net, 88435.2);
  assert.equal(m.read, true);
});

test('a percentage alone gives the discount and the net', () => {
  const m = lineMoney({ qty: 3136, rate: 35.25, amount: 110544, discountPct: 20 });
  assert.equal(m.net, 88435.2);
  assert.equal(m.stated, 22108.8);
});

test('an amount column printed after the discount is recognised', () => {
  const m = lineMoney({ qty: 3136, rate: 35.25, amount: 88435.2, discountPct: 20 });
  assert.equal(m.gross, 110544, 'the gross is qty x rate');
  assert.equal(m.net, 88435.2);
  assert.equal(m.netFromAmount, true);
});

test('a line with no discount is its amount', () => {
  const m = lineMoney({ qty: 100, rate: 76, amount: 7600 });
  assert.deepEqual([m.gross, m.discount, m.net, m.read], [7600, 0, 7600, false]);
});

test('a discount on the whole bill is spread over the lines, the last taking the remainder', () => {
  const lines = [
    { qty: 10, rate: 100, amount: 1000 },
    { qty: 20, rate: 100, amount: 2000 },
    { qty: 1, rate: 333.33, amount: 333.33 },
  ];
  const out = discountedLines(lines, { discount: 100 });
  assert.equal(Math.round(out.reduce((s, l) => s + l.discount, 0) * 100) / 100, 100);
  assert.deepEqual(out.map((l) => l.discount), [30, 60, 10]);
  assert.deepEqual(out.map((l) => l.net), [970, 1940, 323.33]);
});

test('the goods value: a subtotal before line discounts is taken net of them', () => {
  assert.equal(goodsValue({ subTotal: 110544, lineSum: 110544, netSum: 88435.2, hasAmounts: true }), 88435.2);
  assert.equal(goodsValue({ subTotal: 88435.2, lineSum: 110544, netSum: 88435.2, hasAmounts: true }), 88435.2);
  assert.equal(goodsValue({ subTotal: null, lineSum: 110544, netSum: 88435.2, hasAmounts: true }), 88435.2);
});

// ── The checks ──────────────────────────────────────────────────────────────

test('Sonafine passes every check once its discount is read', () => {
  const checks = runInvoiceChecks(sonafine());
  assert.deepEqual(failing(checks), []);
  for (const code of ['INV005', 'INV006', 'INV007', 'INV008', 'INV010', 'INV020', 'INV021']) {
    assert.equal(find(checks, code)[0]?.passed, true, `${code} should run and pass`);
  }
  assert.equal(find(checks, 'INV005')[0].actualValue, 28.2, 'compared at the rate after discount');
});

test('Sonafine with its subtotal printed after the discount passes as well', () => {
  const checks = runInvoiceChecks(sonafine({ header: { subTotal: 88435.2 } }));
  assert.deepEqual(failing(checks), []);
});

test('Sonafine with only the percentage read passes', () => {
  const checks = runInvoiceChecks(sonafine({ line: { taxableValue: null } }));
  assert.deepEqual(failing(checks), []);
});

test('Sonafine read without its discount: INV008 blocks and INV021 says why', () => {
  const checks = runInvoiceChecks(sonafine({ line: { discountPct: null, taxableValue: null } }));
  assert.equal(find(checks, 'INV008')[0].passed, false);
  assert.equal(find(checks, 'INV005')[0].passed, false, '35.25 against the PO 28.20');
  const unread = find(checks, 'INV021')[0];
  assert.equal(unread.passed, false);
  assert.equal(unread.severity, 'WARN');
  assert.match(unread.message, /22108\.8 \(20%/);
  assert.ok(warningsNeedingReason(checks).some((c) => c.code === 'INV021'));
});

test('a value after discount with no discount read is a WARN, not silence', () => {
  const checks = runInvoiceChecks(sonafine({ line: { discountPct: null } }));
  const unread = find(checks, 'INV021')[0];
  assert.equal(unread.passed, false);
  assert.match(unread.message, /line 1's value after discount/);
});

test('an amount printed below qty x rate with no discount read raises INV021 as well', () => {
  const checks = runInvoiceChecks(sonafine({ line: { amount: 88435.2, discountPct: null, taxableValue: null } }));
  assert.equal(find(checks, 'INV006')[0].passed, false);
  assert.match(find(checks, 'INV021')[0].message, /below 3136 × ₹35\.25/);
});

test('INV020 blocks a value after discount that does not follow from the discount', () => {
  const checks = runInvoiceChecks(sonafine({ line: { taxableValue: 88000 } }));
  const c = find(checks, 'INV020')[0];
  assert.equal(c.passed, false);
  assert.equal(c.severity, 'BLOCK');
  assert.equal(c.expectedValue, 88435.2);
  assert.ok(hasBlockingFailure(checks));
});

test('INV020 blocks a percentage and an amount that disagree', () => {
  const checks = runInvoiceChecks(sonafine({ line: { discountAmount: 20000, taxableValue: null } }));
  assert.equal(find(checks, 'INV020')[0].passed, false);
  assert.match(find(checks, 'INV020')[0].message, /20% of ₹110544 is ₹22108\.8/);
});

test('INV005 still blocks when the rate after discount is not the PO rate', () => {
  const checks = runInvoiceChecks(sonafine({ line: { matchedPoRate: 30 } }));
  const c = find(checks, 'INV005')[0];
  assert.equal(c.passed, false);
  assert.match(c.message, /₹35\.25 less discount is ₹28\.2, PO says ₹30/);
});

test('a whole-bill discount counts in INV008 and INV005', () => {
  // The same money as Sonafine, with the 20% taken off the bill instead of the line.
  const checks = runInvoiceChecks(sonafine({
    header: { discount: 22108.8 },
    line: { discountPct: null, taxableValue: null },
  }));
  assert.deepEqual(failing(checks), []);
});

test('an undiscounted invoice is unaffected: INV021 passes', () => {
  const checks = runInvoiceChecks(sonafine({
    header: { subTotal: 88435.2 },
    line: { rate: 28.2, amount: 88435.2, discountPct: null, taxableValue: null },
  }));
  assert.deepEqual(failing(checks), []);
});

// ── The reader's self-check ─────────────────────────────────────────────────

const READ = {
  invoiceNo: 'KOLGST26/5003360', subTotal: '1,10,544.00', freight: '3,200.00', taxable: '91,635.20',
  cgst: '8,247.17', sgst: '8,247.17', roundOff: '0.46', grandTotal: '1,08,130.00',
  lines: [{ lineNo: 1, qty: '3,136', rate: '35.25', amount: '1,10,544.00', discountPct: '20.00', taxableValue: '88,435.20' }],
};

test('the self-check takes a read discount as a reading, not a misreading', () => {
  assert.deepEqual(invoiceProblems(READ), []);
});

test('the self-check, without the discount, asks for it by name', () => {
  const p = invoiceProblems({ ...READ, lines: [{ ...READ.lines[0], discountPct: null, taxableValue: null }] });
  assert.deepEqual(p.map((x) => x.kind), ['TAXABLE']);
  assert.match(p[0].message, /discount/);
});

test('the self-check flags a discount that does not add up', () => {
  const p = invoiceProblems({ ...READ, lines: [{ ...READ.lines[0], taxableValue: '88,000.00' }] });
  assert.ok(p.some((x) => x.kind === 'LINE_DISCOUNT'));
});

test('the reader keeps the discount keys', () => {
  const parsed = ExtractedInvoiceSchema.safeParse({
    invoiceNo: 'KOLGST26/5003360', invoiceDate: '26-10-2026', supplierName: 'Sonafine Corporation Pvt Ltd',
    supplierGstin: null, supplierState: null, buyerGstin: null, shipToGstin: null, shipToAddress: null,
    eWayBillNo: null, vehicleNo: null, poNumbers: null, taxType: 'CGST_SGST',
    subTotal: '1,10,544.00', discount: null, freight: '3,200.00', taxable: '91,635.20',
    cgst: '8,247.17', sgst: '8,247.17', igst: null, roundOff: '0.46', grandTotal: '1,08,130.00',
    lines: [{
      lineNo: 1, description: 'Duplex board', hsn: '4810', gsm: null, size: null, unitWt: null, bundles: null,
      totalUnits: null, qty: '3,136', uom: 'SHEETS', rate: '35.25', amount: '1,10,544.00',
      discountPct: '20.00', discountAmount: null, taxableValue: '88,435.20',
    }],
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.lines[0].discountPct, '20.00');
  assert.equal(parsed.data.lines[0].taxableValue, '88,435.20');
});

test('a discount field can carry a red flag', () => {
  assert.equal(normaliseFlagPath('lines[1].discountPct'), 'lines.1.discountPct');
  assert.equal(normaliseFlagPath('discount'), 'discount');
});

// ── A person's edits ────────────────────────────────────────────────────────

test('a changed quantity re-applies the percentage', () => {
  // 3,000 sheets arrived, not 3,136: the amount is 1,05,750 and 20% off it.
  assert.deepEqual(repricedDiscount({ amount: 105750, discountPct: 20, taxableValue: 88435.2 }), {
    discountAmount: 21150, taxableValue: 84600,
  });
});

test('clearing the discount clears its figures', () => {
  assert.deepEqual(repricedDiscount({ amount: 110544, discountPct: 20 }, { discountPct: null }), {
    discountPct: null, discountAmount: null, taxableValue: null,
  });
});

test('a typed discount amount stands, and drops the percentage', () => {
  assert.deepEqual(repricedDiscount({ amount: 110544, discountPct: 20 }, { discountAmount: 22000 }), {
    discountAmount: 22000, discountPct: null, taxableValue: 88544,
  });
});

// ── The purchase invoice ────────────────────────────────────────────────────
//
// Posted as CDC always has: at the rate after discount, with no discount on
// the ERP's lines. Not one PI in either plant carries a DiscountAmount, and
// every PI for item 4360 is at 28.20 with Gross = Basic.

const POST_CONTEXT = {
  userId: 7, employeeLedgerId: 2001, supplierLedgerId: 3001, warehouseId: 11, purchaseLedgerId: 4001,
  freightLedgerId: 9621, chargeLedgers: { CGST: 1, SGST: 2, IGST: 3, ROUND_OFF: 4 },
};

const POST_LINE = {
  lineNo: 1, itemId: 4360, itemGroupId: 14, poTransactionId: 61234, poTransactionDetailId: 98765, poVoucherNo: 'PO03515_26_27',
  poQty: 3136, poPendingQty: 3136, qty: 3136, stockQty: 3136, rate: 35.25, amount: 110544,
  discountPct: 20, discountAmount: null, taxableValue: 88435.2,
  purchaseUnit: 'SHEETS', stockUnit: 'SHEETS', gstPercentage: 18, cgstPercentage: 9, sgstPercentage: 9, igstPercentage: 0,
};

const dryRun = (header, lines) => postDocumentSet({ site: 'KOL', header, lines, context: POST_CONTEXT, dryRun: true });

test('Sonafine posts at the rate after discount, with no discount on the ERP line', async () => {
  const r = await dryRun({ ...SONAFINE_HEADER }, [{ ...POST_LINE }]);
  const [l] = r.pi.lines;
  assert.equal(l.receiptRate, 28.2);
  assert.equal(l.grossAmount, 88435.2);
  assert.equal(l.basicAmount, 88435.2);
  assert.equal(l.discountAmount, 0);
  assert.equal(l.taxableAmount, 91635.2, 'basic + freight share');
  assert.equal(l.cgstAmount, 8247.17);
  assert.equal(l.sgstAmount, 8247.17);
  assert.equal(l.netAmount, 104929.54);
  assert.equal(l.landedRate, 28.2);
  assert.deepEqual(l.printed, { rate: 35.25, gross: 110544, discount: 22108.8, pct: 20 });

  assert.equal(r.grn.lines[0].landedRate, 28.2);
  assert.equal(r.grn.lines[0].grsRate, 28.2, 'not the printed 35.25');

  assert.equal(r.totals.totalBasicAmount, 88435.2);
  assert.equal(r.totals.totalDiscountAmount, undefined, 'the header discount stays 0');
  assert.equal(r.totals.totalTaxableAmount, 91635.2);
  assert.equal(r.totals.totalTaxAmount, 16494.34);
  assert.equal(r.totals.netAmount, 108130, 'the invoice grand total');
});

test('the printed discount goes in the remark, after a person\'s own', async () => {
  const r = await dryRun({ ...SONAFINE_HEADER, remark: 'Board for job 4412' }, [{ ...POST_LINE }]);
  assert.equal(r.pi.discountNote,
    'Trade discount 20% on line 1: printed rate 35.25, gross 1,10,544.00, discount 22,108.80; posted at 28.20.');
  assert.equal(r.pi.narration, `Board for job 4412 | ${r.pi.discountNote}`);
});

test('a remark that leaves no room keeps the remark, and the note is left to the audit', () => {
  const own = 'x'.repeat(480);
  assert.equal(narrationFor(own, discountNote(priceLines({ header: SONAFINE_HEADER, lines: [{ ...POST_LINE }] }))), own);
  assert.equal(narrationFor('', ''), '');
});

test('an undiscounted line posts as before', () => {
  const [l] = priceLines({
    header: { freight: 0 },
    lines: [{ ...POST_LINE, rate: 28.2, amount: 88435.2, discountPct: null, taxableValue: null }],
  });
  assert.equal(l.rate, 28.2);
  assert.equal(l.grossAmount, 88435.2);
  assert.equal(l.printed, undefined);
  assert.equal(discountNote([l]), '');
});

test('a whole-bill discount goes into each line\'s rate, to the paisa', async () => {
  // 20% off the whole of Sonafine's bill instead of off its line.
  const r = await dryRun(
    { ...SONAFINE_HEADER, discount: 22108.8 },
    [{ ...POST_LINE, discountPct: null, taxableValue: null }],
  );
  assert.equal(r.pi.lines[0].receiptRate, 28.2);
  assert.equal(r.pi.lines[0].grossAmount, 88435.2);
  assert.equal(r.totals.netAmount, 108130);
});

test('a discount that does not divide into a 2-place rate keeps the amount exact', () => {
  // 3 lines sharing a 100 discount: 1000/2000/333.33 -> 970/1940/323.33.
  const lines = priceLines({
    header: { freight: 0, discount: 100 },
    lines: [
      { ...POST_LINE, lineNo: 1, qty: 10, rate: 100, amount: 1000, discountPct: null, taxableValue: null },
      { ...POST_LINE, lineNo: 2, qty: 20, rate: 100, amount: 2000, discountPct: null, taxableValue: null },
      { ...POST_LINE, lineNo: 3, qty: 7, rate: 47.618571, amount: 333.33, discountPct: null, taxableValue: null },
    ],
  });
  assert.deepEqual(lines.map((l) => l.grossAmount), [970, 1940, 323.33], 'the lines add up to the bill less 100');
  // 323.33 / 7 = 46.19 to 2 places, which x 7 is 323.33: the ERP stores the
  // rate to 2 places and keeps the amount exact, as it does for 17.925.
  assert.deepEqual(lines.map((l) => storedRate(l.rate)), [97, 97, 46.19]);
});
