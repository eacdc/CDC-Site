/**
 * The shapes the Create PO screen depends on, built from real ERP rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  financialYearStart, firstJobNo, toPoItem, toStockRow, DELIVERY_ADDRESSES, PAYMENT_TERMS,
  poNumber, normalisePaymentTerms,
} from '../services/po.js';

test('the next PO number is in the ERP\'s own format', () => {
  assert.equal(poNumber(4000, 2026), 'PO04000_26_27');
  assert.equal(poNumber(592, 2026), 'PO00592_26_27');
  assert.equal(poNumber(1, 2099), 'PO00001_99_00');
});

test('the ERP\'s free-text payment terms become one of the fixed list', () => {
  assert.equal(normalisePaymentTerms('Payment in 90 Days\t'), 'Payment in 90 Days');
  assert.equal(normalisePaymentTerms('Payment in45Days'), 'Payment in 45 Days');
  assert.equal(normalisePaymentTerms('90 DAYS'), 'Payment in 90 Days');
  assert.equal(normalisePaymentTerms('Payment in 30 Days,Payment in 90 Days'), 'Payment in 30 Days');
  assert.equal(normalisePaymentTerms('IMMIDIATE'), 'Immediate');
  assert.equal(normalisePaymentTerms('advance\t'), 'Advance');
  assert.equal(normalisePaymentTerms('Payment in 18 Days'), null, 'not on the list');
  assert.equal(normalisePaymentTerms('URGENT'), null);
  assert.equal(normalisePaymentTerms(''), null);
});

test('the financial year starts on 1 April', () => {
  assert.equal(financialYearStart(new Date('2026-11-20')).toISOString().slice(0, 10), '2026-04-01');
  assert.equal(financialYearStart(new Date('2027-02-10')).toISOString().slice(0, 10), '2026-04-01');
  assert.equal(financialYearStart(new Date('2026-04-01T06:00:00Z')).toISOString().slice(0, 10), '2026-04-01');
});

test('a requisition line\'s client comes from its first job number', () => {
  assert.equal(firstJobNo('J09030_26_27[1_1],J09031_26_27[1_1]'), 'J09030_26_27');
  assert.equal(firstJobNo('J09048_26_27[1_1]'), 'J09048_26_27');
  assert.equal(firstJobNo(' '), null);
  assert.equal(firstJobNo(null), null);
});

test('an ERP item becomes the line item the screen needs', () => {
  const item = toPoItem({
    ItemID: '3830', ItemCode: 'P00018', ItemName: 'Gloss Art, 128 GSM, Imported, NONE, 585x915',
    ItemGroupID: 14, ItemGroupName: 'PAPER', StockUnit: 'Sheet', PurchaseUnit: 'Kg',
    GSM: 128, SizeW: 585, SizeL: 915, UnitPerPacking: 100,
  }, { HSNCode: '48101920', ProductHSNName: 'Paper & Board - GST 18%', GSTTaxPercentage: 18 });
  assert.deepEqual(item, {
    itemId: 3830, itemCode: 'P00018', itemName: 'Gloss Art, 128 GSM, Imported, NONE, 585x915',
    groupId: 14, groupName: 'PAPER', stockUnit: 'Sheet', purchaseUnit: 'Kg',
    gsm: 128, sizeW: 585, sizeL: 915, qtyPerPack: 100,
    hsnCode: '48101920', hsnName: 'Paper & Board - GST 18%', gstPct: 18,
  });
});

test('an item with a blank purchase unit is bought in its stock unit', () => {
  // PREQ and some master rows carry PurchaseUnit as a single space.
  const item = toPoItem({ ItemID: 1, ItemGroupID: 3, StockUnit: 'Kg', PurchaseUnit: ' ' }, null);
  assert.equal(item.purchaseUnit, 'Kg');
  assert.equal(item.gstPct, null, 'no HSN means no GST rate, not 0%');
});

test('a buffer proc row keeps floor and on-order apart, with the client tag', () => {
  const row = toStockRow({
    Section: 'ON ORDER', StockType: 'Incoming PO', MatchType: 'Similar', ItemID: '10573',
    ItemName: 'Gloss Art, 130 GSM, Naini, NONE, 610 X 960 MM', GSMDiff: 2, SizeWDiff: 25, SizeLDiff: 45,
    StockKG: 6242.5, BookedKG: 0, FreeKG: 6242.5, ClientTag: 'Other client', ClientTagName: 'Client F',
    RefNo: 'PO03583_26_27', PODate: '2026-10-29', SupplierName: 'Supplier', ExpectedDeliveryDate: '2026-10-29', DaysLate: 22,
  });
  assert.equal(row.section, 'ON ORDER');
  assert.equal(row.itemId, 10573);
  assert.equal(row.freeKg, 6242.5);
  assert.equal(row.clientTagName, 'Client F');
  assert.equal(row.daysLate, 22);
});

test('delivery points and payment terms are fixed lists, per plant', () => {
  assert.deepEqual(DELIVERY_ADDRESSES.KOL.map((a) => a.id), ['panchla', 'tangra']);
  assert.equal(DELIVERY_ADDRESSES.AHM.length, 1);
  assert.ok(!/rn/.test(DELIVERY_ADDRESSES.AHM[0].address.replace(/Corner|Barn/gi, '')), 'no literal rn line breaks');
  assert.ok(PAYMENT_TERMS.includes('Payment in 90 Days'));
});
