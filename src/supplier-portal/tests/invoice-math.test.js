/**
 * Invoice arithmetic tests.
 *
 * The freight cases reproduce Krishna Vanijya `KV/26-27/12945` (18-Aug-2026)
 * figure for figure. If these drift, the portal's totals will disagree with
 * the ERP's own screens on every invoice that carries freight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apportionFreight, invoiceTotals, sheetWeightKg, reconcileSheetKg,
  receiptSanity, expectedTaxType, stateCodeFromGstin,
} from '../lib/invoice-math.js';

test('freight apportions pro-rata on gross, matching the reference invoice', () => {
  const lines = [
    { grossAmount: 20890.76, cgstPercentage: 9, sgstPercentage: 9 },
    { grossAmount: 18276.48, cgstPercentage: 9, sgstPercentage: 9 },
  ];
  const [first] = apportionFreight(lines, 1180);

  assert.equal(first.freightShare, 629.38, 'freight share');
  assert.equal(first.taxableAmount, 21520.14, 'taxable = gross + freight share');
  assert.equal(first.cgstAmount, 1936.81, 'CGST on the freight-inclusive base');
  assert.equal(first.netAmount, 24764.39, 'net excludes the apportioned freight');
});

test('the line net deliberately excludes its freight share', () => {
  const [line] = apportionFreight([{ grossAmount: 1000, cgstPercentage: 9, sgstPercentage: 9 }], 100);
  assert.equal(line.taxableAmount, 1100, 'freight is in the taxable base');
  // 1000 + 99 + 99 — the 100 freight is NOT here. The header adds it once.
  assert.equal(line.netAmount, 1198);
});

test('freight shares always sum to the freight charged', () => {
  // Three lines that do not divide evenly: the remainder lands on the last
  // line rather than leaving the header and the lines a paisa apart.
  const lines = [
    { grossAmount: 100, cgstPercentage: 9, sgstPercentage: 9 },
    { grossAmount: 100, cgstPercentage: 9, sgstPercentage: 9 },
    { grossAmount: 100, cgstPercentage: 9, sgstPercentage: 9 },
  ];
  const out = apportionFreight(lines, 10);
  const total = out.reduce((s, l) => s + l.freightShare, 0);
  assert.equal(Math.round(total * 100) / 100, 10);
});

test('freight is taxed at each line own rate, handling a mixed-rate invoice', () => {
  const lines = [
    { grossAmount: 1000, cgstPercentage: 9, sgstPercentage: 9 },   // 18%
    { grossAmount: 1000, cgstPercentage: 6, sgstPercentage: 6 },   // 12%
  ];
  const out = apportionFreight(lines, 200);
  assert.equal(out[0].freightShare, 100);
  assert.equal(out[1].freightShare, 100);
  // The 18% line's freight is taxed at 18%, the 12% line's at 12% — no
  // splitting of the freight by rate was needed anywhere.
  assert.equal(out[0].cgstAmount, 99);
  assert.equal(out[1].cgstAmount, 66);
});

test('header totals add the freight back exactly once', () => {
  const lines = apportionFreight(
    [{ grossAmount: 1000, cgstPercentage: 9, sgstPercentage: 9 }], 100,
  );
  const totals = invoiceTotals(lines, { freight: 100, roundOff: 0 });
  assert.equal(totals.totalBasicAmount, 1000);
  assert.equal(totals.freight, 100);
  // 1000 + 100 freight + 99 + 99
  assert.equal(totals.netAmount, 1298);
});

test('an invoice with no freight is unaffected', () => {
  const [line] = apportionFreight([{ grossAmount: 500, cgstPercentage: 9, sgstPercentage: 9 }], 0);
  assert.equal(line.freightShare, 0);
  assert.equal(line.taxableAmount, 500);
});

test('sheet weight computes to the verified figures', () => {
  assert.equal(sheetWeightKg({ sheets: 5500, widthMm: 585, lengthMm: 915, gsm: 90 }), 264.961);
  assert.equal(sheetWeightKg({ sheets: 5500, widthMm: 584.2, lengthMm: 914.4, gsm: 90 }), 264.425);
});

test('the systematic inch-vs-metric difference is about -0.21%', () => {
  const rec = reconcileSheetKg({
    sheets: 5500, widthMm: 585, lengthMm: 915, gsm: 90, billedKg: 264.44,
  });
  assert.equal(rec.inchEquivalent, '23 x 36');
  // Billed against CDC's rounded-metric figure: roughly -0.2%.
  assert.ok(Math.abs(rec.deltaOursPct + 0.2) < 0.05, `expected about -0.2%, got ${rec.deltaOursPct}`);
  // Billed against the true-inch figure: essentially nil.
  assert.ok(Math.abs(rec.deltaTheirsPct) < 0.05, `expected about 0%, got ${rec.deltaTheirsPct}`);
  assert.equal(rec.withinTolerance, true, 'a supplier billing on true inches must not fail');
});

test('a genuine short delivery still fails the reconciliation', () => {
  const rec = reconcileSheetKg({
    sheets: 5500, widthMm: 585, lengthMm: 915, gsm: 90, billedKg: 240,
  });
  assert.equal(rec.withinTolerance, false);
});

test('the 3000-for-1500 sheets error is caught', () => {
  // The known 19-Aug-2026 case: the money was right so nothing else objected,
  // and the stock is double to this day.
  const result = receiptSanity({
    sheets: 3000,
    billedKg: 132.48,      // the kg for 1500 sheets
    wtPerPacking: 88.32,
    unitPerPacking: 1000,
    receivedQty: 3000,
    poPendingQty: 1500,
  });
  assert.equal(result.weightAgrees, false, 'sheets do not agree with the billed kg');
  assert.equal(result.withinPoTolerance, false, 'double the PO quantity is far past 10%');
});

test('a correct receipt passes both sanity conditions', () => {
  const result = receiptSanity({
    sheets: 1500,
    billedKg: 132.48,
    wtPerPacking: 88.32,
    unitPerPacking: 1000,
    receivedQty: 1500,
    poPendingQty: 1500,
  });
  assert.equal(result.weightAgrees, true);
  assert.equal(result.withinPoTolerance, true);
});

test('receipt tolerance allows 10% over and refuses 11%', () => {
  assert.equal(receiptSanity({ receivedQty: 1100, poPendingQty: 1000 }).withinPoTolerance, true);
  assert.equal(receiptSanity({ receivedQty: 1101, poPendingQty: 1000 }).withinPoTolerance, false);
});

test('tax type follows the ship-to state, not the billing state', () => {
  // CDC bills to Kolkata but consigns to Panchla or Ahmedabad; place of supply
  // for goods follows delivery.
  assert.equal(expectedTaxType({ supplierState: 'West Bengal', shipToState: 'West Bengal' }), 'CGST_SGST');
  assert.equal(expectedTaxType({ supplierState: 'West Bengal', shipToState: 'Gujarat' }), 'IGST');
  assert.equal(expectedTaxType({ supplierState: 'Maharashtra', shipToState: 'West Bengal' }), 'IGST');
  assert.equal(expectedTaxType({ supplierState: null, shipToState: 'Gujarat' }), null);
});

test('the state code is the first two digits of a GSTIN', () => {
  assert.equal(stateCodeFromGstin('19AABCC2946B1ZZ'), '19');
  assert.equal(stateCodeFromGstin('not-a-gstin'), null);
});
