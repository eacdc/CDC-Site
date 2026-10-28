/**
 * What an extracted invoice shows to be wrong on its own face. Figures from
 * the October 2026 run of the extractor on ten new suppliers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceProblems, retryInstruction, toNumber } from '../services/extraction/invoice-review.js';

const kinds = (x) => invoiceProblems(x).map((p) => p.kind).sort();

test('printed amounts in the forms suppliers write them', () => {
  assert.equal(toNumber('1,14,887.16'), 114887.16);
  assert.equal(toNumber('1,38,550/-'), 138550);
  assert.equal(toNumber('(-)0.22'), -0.22);
  assert.equal(toNumber('(+) 0.25'), 0.25);
  assert.equal(toNumber('Less: ROUND OFF (-)0.14'), -0.14);
  assert.equal(toNumber('Rs. 2,39,692.00'), 239692);
  assert.equal(toNumber('INR 316,384.00'), 316384);
  assert.equal(toNumber('540.000 Pcs'), 540);
  assert.equal(toNumber('11830.000 [169.000]'), 11830);
  assert.equal(toNumber('-'), null);
});

test('a clean invoice has no problems (Unik 448)', () => {
  assert.deepEqual(invoiceProblems({
    supplierGstin: '19ACYPL7024P1ZK', subTotal: '19,320.00', taxable: '19,320.00', cgst: '1,738.80', sgst: '1,738.80',
    roundOff: '0.40', grandTotal: '22,798.00',
    lines: [{ lineNo: 1, qty: '7.00', rate: '2,760.00', amount: '19,320.00' }],
  }), []);
});

test('rows that slid in stacked cells show as lines that do not multiply out (RNG)', () => {
  const problems = invoiceProblems({
    lines: [
      { lineNo: 3, qty: '45.000', rate: '51.20', amount: '2304.00' },
      { lineNo: 4, qty: '1.000', rate: '51.20', amount: '2252.80' },
      { lineNo: 5, qty: '1000.000', rate: '60.80', amount: '43776.00' },
    ],
  });
  assert.deepEqual(problems.map((p) => p.lineNo), [4, 5]);
  assert.match(problems[0].message, /1\.000 x rate 51\.20 = 51\.2, but you gave the amount as 2252\.80/);
});

test('a small misread is caught too (AK Trading: 2,381.44 for 2,381.40)', () => {
  assert.deepEqual(kinds({ lines: [{ lineNo: 1, qty: '2,381.44', rate: '49.25', amount: '1,17,283.95' }] }), ['LINE_ARITHMETIC']);
});

test('the taxable value given as the goods subtotal (Flamingo)', () => {
  const p = invoiceProblems({
    subTotal: '16,700.000', freight: '500.000', taxable: '16,700.000', cgst: '417.500', sgst: '417.500', grandTotal: '17,535.000',
    lines: [{ lineNo: 1, qty: '540.000', rate: '30.000', amount: '16,200.000' }],
  });
  assert.deepEqual(p.map((x) => x.kind).sort(), ['SUBTOTAL', 'TAXABLE']);
  assert.match(p.find((x) => x.kind === 'SUBTOTAL').message, /add up to 16,200/);
});

test('a charge read as a goods line (Shree Krishna delivery charges)', () => {
  const k = kinds({
    subTotal: '28,985.84', freight: '600.00', taxable: '29,585.84',
    lines: [
      { lineNo: 1, qty: '1,032', rate: '23.36', amount: '24,107.52' },
      { lineNo: 2, qty: '136', rate: '35.87', amount: '4,878.32' },
      { lineNo: 3, description: 'DELIVERY CHARGES', qty: null, rate: null, amount: '600.00' },
    ],
  });
  assert.deepEqual(k, ['LINE_WITHOUT_QTY', 'SUBTOTAL']);
});

test('a total that does not add up names the parts', () => {
  const p = invoiceProblems({ taxable: '100.00', cgst: '9.00', sgst: '9.00', roundOff: '-0.22', grandTotal: '150.00', lines: [] });
  assert.deepEqual(p.map((x) => x.kind), ['GRAND_TOTAL']);
  assert.match(p[0].message, /= 117\.78/);
});

test('GSTIN check character; a short e-way bill is not worth a second read', () => {
  assert.deepEqual(kinds({ supplierGstin: '19AADFR0768H1Z1', shipToGstin: '19AABCC2946B1ZZ', eWayBillNo: '71167943180', lines: [] }),
    ['GSTIN']);
  assert.deepEqual(kinds({ supplierGstin: '19AADCP6122G1ZI', eWayBillNo: '8917 5691 9164', lines: [] }), []);
});

test('the retry names every problem and carries the first answer', () => {
  const first = { invoiceNo: 'X', lines: [{ lineNo: 4, qty: '1.000', rate: '51.20', amount: '2252.80' }] };
  const text = retryInstruction(first, invoiceProblems(first));
  assert.match(text, /1\. Line 4/);
  assert.match(text, /"invoiceNo":"X"/);
});
