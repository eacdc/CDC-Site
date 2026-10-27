/**
 * Receipt Qty (P.U.) and (S.U.), linked the way the ERP links them. Figures
 * from REC04731_26_27 as the ERP wrote it: P00026, 170 gsm 635 x 915,
 * WtPerPacking 9.87743 per 100 sheets - 1,500 sheets, 148.161 kg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { kgPerSheet, stockQtyFromPurchase, purchaseQtyFromStock, stockQtyFor, sheetsWritten } from '../services/receipt-units.js';

const P00026 = { purchaseUnit: 'KG', stockUnit: 'Sheet', wtPerPacking: 9.87743, unitPerPacking: 100 };
const BOX = { purchaseUnit: 'PCS', stockUnit: 'NOS', wtPerPacking: 0, unitPerPacking: 0 };

test('sheets to kg, as the ERP wrote REC04731', () => {
  assert.equal(purchaseQtyFromStock(1500, P00026), 148.161);
  assert.equal(stockQtyFromPurchase(148.161, P00026), 1500);
});

test('a round trip lands on the same whole sheet count', () => {
  for (const sheets of [625, 3000, 12750]) {
    assert.equal(stockQtyFromPurchase(purchaseQtyFromStock(sheets, P00026), P00026), sheets);
  }
});

test('every other pair of units carries one number in both', () => {
  assert.equal(kgPerSheet(BOX), null);
  assert.equal(stockQtyFromPurchase(410, BOX), 410);
  assert.equal(purchaseQtyFromStock(410, BOX), 410);
  assert.equal(kgPerSheet({ ...P00026, purchaseUnit: 'Sheet' }), null);
});

test('no weight per packing, no conversion', () => {
  assert.equal(kgPerSheet({ ...P00026, wtPerPacking: 0 }), null);
});

test('a count already on the line wins over the arithmetic', () => {
  // The invoice said 1,498 sheets for 148.161 kg; that is what arrived.
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161, totalUnits: 1498 }), 1498);
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161, stockQty: 1490, stockQtyByHand: true, totalUnits: 1498 }), 1490);
  // A count worked out earlier, not typed, is worked out again.
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161, stockQty: 123 }), 1500);
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161 }), 1500);
  // Same units: always the qty, whatever else the line says.
  assert.equal(stockQtyFor({ ...BOX, qty: 410, totalUnits: 41, stockQty: 7 }), 410);
});

test('reams in the units column are not sheets (Krishna Vanijya KV/26-27/19508)', () => {
  const P00023 = { purchaseUnit: 'Kg', stockUnit: 'Sheet', wtPerPacking: 6.58063, unitPerPacking: 100 };
  // "Total Units 123" is 123 reams of 250; the description writes the sheets out.
  assert.equal(stockQtyFor({ ...P00023, qty: 2024.58, totalUnits: 123, description: 'NI KOTE PAPER 123 x 250 = 30750 Sheet' }), 30750);
  // Without the sum written out, the kg decide - not the 123.
  assert.equal(stockQtyFor({ ...P00023, qty: 2024.58, totalUnits: 123, description: 'NI KOTE PAPER' }), 30766);
});

test('a sheet total written on the line', () => {
  assert.equal(sheetsWritten('HI KOTE PAPER 59 x 500 = 29500 Sheet'), 29500);
  assert.equal(sheetsWritten('80X144=11,520 sheets'), 11520);
  assert.equal(sheetsWritten('HI KOTE PAPER'), null);
});
