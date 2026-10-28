/**
 * Red flags on extracted fields: where they come from, and what clears them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFieldFlags, resolveEditedFlags, confirmFlag, openFlags, normaliseFlagPath } from '../services/extraction/field-flags.js';

test('paths however the model writes them', () => {
  assert.equal(normaliseFlagPath('gateEntryNo'), 'gateEntryNo');
  assert.equal(normaliseFlagPath('GateEntryNo'), 'gateEntryNo');
  assert.equal(normaliseFlagPath('lines.3.qty'), 'lines.3.qty');
  assert.equal(normaliseFlagPath('lines[3].Qty'), 'lines.3.qty');
  assert.equal(normaliseFlagPath('line 2 rate'), 'lines.2.rate');
  assert.equal(normaliseFlagPath('lines.4'), 'lines.4');
  assert.equal(normaliseFlagPath('the colour of the stamp'), null);
  // A field the page does not show cannot carry a flag nobody could clear.
  assert.equal(normaliseFlagPath('lines.3.bundles'), null);
  assert.equal(normaliseFlagPath('freight'), null);
});

test('flags from the model and from the checks; a proof beats a doubt', () => {
  const flags = buildFieldFlags({
    uncertain: ['gateEntryNo', 'lines.4.qty', 'subTotal', 'nonsense'],
    problems: [
      { kind: 'LINE_ARITHMETIC', lineNo: 4, field: 'lines.4', message: 'Line 4: quantity 1.000 x rate 51.20 = 51.2, but you gave the amount as 2252.80. One of the three was misread.' },
      { kind: 'SUBTOTAL', field: 'subTotal', message: 'The line amounts add up to 16,200, but you gave subTotal as 16,700. "subTotal" is goods only.' },
    ],
  });
  const by = Object.fromEntries(flags.map((f) => [f.field, f]));
  assert.deepEqual(Object.keys(by).sort(), ['gateEntryNo', 'lines.4', 'lines.4.qty', 'subTotal']);
  assert.equal(by.gateEntryNo.source, 'MODEL');
  assert.equal(by.subTotal.source, 'CHECK');
  assert.match(by['lines.4'].reason, /^Line 4: quantity 1\.000 x rate 51\.20 = 51\.2, but you gave the amount as 2252\.80\.$/);
  assert.ok(flags.every((f) => f.resolved === false));
});

test('a GSTIN corrected from the ledger is flagged to be checked, with both values', () => {
  const [f] = buildFieldFlags({
    problems: [{ kind: 'GSTIN', field: 'supplierGstin', message: 'fails' }],
    identification: { matchedBy: 'GSTIN_NEAR', correctedGstin: '19AADCP6122G1ZI' },
    read: { supplierGstin: '19AADCP6122G1Z0' },
  });
  assert.equal(f.field, 'supplierGstin');
  assert.match(f.reason, /Read as 19AADCP6122G1Z0.*19AADCP6122G1ZI/);
});

const LINES = [{ lineNo: 1, qty: 10, rate: 5, amount: 50 }, { lineNo: 4, qty: 1, rate: 51.2, amount: 2252.8 }];
const FLAGS = [
  { field: 'gateEntryNo', source: 'MODEL', reason: 'r', resolved: false },
  { field: 'invoiceDate', source: 'MODEL', reason: 'r', resolved: false },
  { field: 'lines.4', source: 'CHECK', reason: 'r', resolved: false },
  { field: 'lines.1.rate', source: 'MODEL', reason: 'r', resolved: false },
];

test('an edit clears its flag; an unchanged value does not', () => {
  const before = { header: { gateEntryNo: '5212', invoiceDate: new Date('2026-10-16T00:00:00Z') }, lines: LINES };
  const after = {
    header: { gateEntryNo: '25712', invoiceDate: '2026-10-16' },     // the date sent back as text: unchanged
    lines: [LINES[0], { ...LINES[1], qty: 44 }],
  };
  const out = resolveEditedFlags(FLAGS, before, after, 'Manu');
  const by = Object.fromEntries(out.map((f) => [f.field, f]));
  assert.equal(by.gateEntryNo.resolved, true);
  assert.equal(by.gateEntryNo.how, 'EDITED');
  assert.equal(by.gateEntryNo.by, 'Manu');
  assert.equal(by.invoiceDate.resolved, false);
  assert.equal(by['lines.4'].resolved, true, 'a changed qty clears the whole-line flag');
  assert.equal(by['lines.1.rate'].resolved, false);
});

test('"5.00" for 5 is no change', () => {
  const out = resolveEditedFlags(FLAGS, { header: {}, lines: LINES }, { header: {}, lines: [{ ...LINES[0], rate: '5.00' }, LINES[1]] });
  assert.equal(out.find((f) => f.field === 'lines.1.rate').resolved, false);
});

test("a removed line's flags go with it", () => {
  const out = resolveEditedFlags(FLAGS, { header: {}, lines: LINES }, { header: {}, lines: [LINES[0]] });
  assert.deepEqual(out.map((f) => f.field), ['gateEntryNo', 'invoiceDate', 'lines.1.rate']);
});

test('marked checked by a person', () => {
  const { flags, found } = confirmFlag(FLAGS, 'gateEntryNo', 'Manu');
  assert.equal(found, true);
  assert.equal(flags[0].how, 'CONFIRMED');
  assert.equal(openFlags(flags).length, 3);
  assert.equal(confirmFlag(FLAGS, 'vehicleNo').found, false);
});

test('two reads that disagree flag the field, with both answers', () => {
  const [f] = buildFieldFlags({ disagreements: [{ field: 'gateEntryNo', first: '5212', second: '25712' }] });
  assert.equal(f.field, 'gateEntryNo');
  assert.equal(f.source, 'MODEL');
  assert.match(f.reason, /"5212" and "25712"/);
});

test('the e-way bill, the vehicle number and a line HSN are never flagged', () => {
  const flags = buildFieldFlags({ uncertain: ['eWayBillNo', 'vehicleNo', 'lines.2.hsn', 'lines.2.qty'] });
  assert.deepEqual(flags.map((f) => f.field), ['lines.2.qty']);
  // An invoice read before the change keeps its old flags; they no longer block.
  const old = ['eWayBillNo', 'vehicleNo', 'lines.2.hsn', 'lines.2', 'gateEntryNo']
    .map((field) => ({ field, source: 'MODEL', reason: 'x', resolved: false }));
  assert.deepEqual(openFlags(old).map((f) => f.field), ['lines.2', 'gateEntryNo']);
});
