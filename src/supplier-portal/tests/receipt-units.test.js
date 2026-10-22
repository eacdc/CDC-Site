/**
 * Receipt Qty (P.U.) and (S.U.), linked the way the ERP links them. Figures
 * from REC04731_26_27 as the ERP wrote it: P00026, 170 gsm 635 x 915,
 * WtPerPacking 9.87743 per 100 sheets - 1,500 sheets, 148.161 kg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { kgPerSheet, stockQtyFromPurchase, purchaseQtyFromStock, stockQtyFor } from '../services/receipt-units.js';

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
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161, stockQty: 1490, totalUnits: 1498 }), 1490);
  assert.equal(stockQtyFor({ ...P00026, qty: 148.161 }), 1500);
  // Same units: always the qty, whatever else the line says.
  assert.equal(stockQtyFor({ ...BOX, qty: 410, totalUnits: 41, stockQty: 7 }), 410);
});
