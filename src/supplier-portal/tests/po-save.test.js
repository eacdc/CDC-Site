/**
 * What a Create PO purchase order writes to the ERP, column by column, set
 * against PO04017_26_27 - saved once by the ERP's own screen from
 * PREQ00620_26_27 on 21 Nov 2026 - and the FY 2026-27 lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { erpRows, erpAmountInWords, PO_TAX_LEDGERS, PoRejected } from '../services/po-save.js';

const now = new Date('2026-11-21T17:03:15.900Z');
const voucherDate = new Date('2026-11-21T00:00:00Z');

/** PO04017's first line, as preparePo would hand it over. */
function preparedFromPreq() {
  return {
    supplier: { ledgerId: 6846, name: 'Supplier', gstin: '19AAAAA0000A1Z5' },
    deliveryAddress: 'M.J. Industrial Park, Panchla',
    header: { paymentTerms: 'Payment in 90 Days', transport: 'By Road', division: 'COM', currency: 'INR', purchaseReference: '' },
    lines: [{
      itemId: 4266, itemGroupId: 14, itemDescription: 'Quality:Montblanc Extra White, GSM:270',
      stockUnit: 'Sheet', purchaseUnit: 'Sheet', qty: 231, stockQty: 231, poQty: 231, qtyPerPack: 100, packs: 2,
      rate: 42, amount: 9702, gstPct: 18, cgst: 873.18, sgst: 873.18, igst: 0, net: 11448.36,
      productHsnId: 172, expectedDate: '2026-11-21', clientId: 8729,
      reqRefs: [{ reqLineId: '74093:1', requisitionTransactionId: 74093, reqNo: 'PREQ00620_26_27',
        jobRef: 'J09125_26_27[1_1]', jobContentsId: '27274', qty: 231 }],
    }],
    totals: { basic: 9702, cgst: 873.18, sgst: 873.18, igst: 0, tax: 1746.36, net: 11448.36, wordsErp: 'x' },
  };
}

test('a line from a requisition is written as the ERP writes PO04017', () => {
  const rows = erpRows(preparedFromPreq(), { userId: 9, voucherDate, fYear: '2026-2027', now });
  const d = rows.details[0];
  assert.equal(d.TransID, 1);
  assert.equal(d.RequiredQuantity, 231);
  assert.equal(d.PurchaseOrderQuantity, 231);
  assert.equal(d.ChallanWeight, 231);
  assert.equal(d.RequiredNoOfPacks, 2);
  assert.equal(d.QuantityPerPack, 100);
  assert.equal(d.RequisitionTransactionID, 74093);
  assert.equal(d.RefJobBookingJobCardContentsID, '27274');
  assert.equal(d.RefJobCardContentNo, 'J09125_26_27[1_1]');
  assert.equal(d.ClientID, 8729);
  // 9 / 9 / 18 stored whichever tax applies.
  assert.deepEqual([d.GSTPercentage, d.CGSTPercentage, d.SGSTPercentage, d.IGSTPercentage], [18, 9, 9, 18]);
  assert.deepEqual([d.CGSTAmount, d.SGSTAmount, d.IGSTAmount, d.NetAmount], [873.18, 873.18, 0, 11448.36]);
  assert.equal(d.IsVoucherItemApproved, 1);
  assert.equal(d.VoucherItemApprovedBy, 2, 'Admin, as on every ERP PO line');
  assert.equal(d.ProductHSNID, 172, 'the item\'s own HSN, always');
  assert.equal(d.ExpectedDeliveryDate.toISOString(), '2026-11-21T00:00:00.000Z');

  assert.deepEqual(rows.requisitions.map((r) => [r.RequisitionTransactionID, r.ItemID, r.TransID, r.RequisitionProcessQuantity, r.StockUnit]),
    [[74093, 4266, 1, 231, 'Sheet']]);
});

test('the header carries the totals and the ERP\'s fixed values', () => {
  const h = erpRows(preparedFromPreq(), { userId: 9, voucherDate, fYear: '2026-2027', now }).header;
  assert.equal(h.VoucherPrefix, 'PO');
  assert.equal(h.VoucherID, -11);
  assert.equal(h.LedgerID, 6846);
  assert.equal(h.TotalQuantity, 231);
  assert.equal(h.NetAmount, 11448.36, 'the sum of the lines, unrounded');
  assert.equal(h.PurchaseDivision, 'COM');
  assert.equal(h.CurrencyCode, 'INR');
  assert.equal(h.TermsOfPayment, 'Payment in 90 Days');
  assert.equal(h.CreatedBy, 9);
  assert.equal(h.FYear, '2026-2027');
  assert.equal(h.Particular, ' ', 'single spaces where the ERP keeps them');
});

test('only taxes with an amount get a row, on ledgers 6 / 7 / 8', () => {
  const intra = erpRows(preparedFromPreq(), { userId: 9, voucherDate, fYear: '2026-2027', now }).taxes;
  assert.deepEqual(intra.map((t) => [t.TransID, t.LedgerID, t.Amount, t.TaxPercentage, t.CalculatedON]),
    [[1, PO_TAX_LEDGERS.CGST, 873.18, 0, 'Value'], [2, PO_TAX_LEDGERS.SGST, 873.18, 0, 'Value']]);

  const p = preparedFromPreq();
  p.totals = { ...p.totals, cgst: 0, sgst: 0, igst: 1746.36 };
  const inter = erpRows(p, { userId: 9, voucherDate, fYear: '2026-2027', now }).taxes;
  assert.deepEqual(inter.map((t) => [t.TransID, t.LedgerID]), [[1, PO_TAX_LEDGERS.IGST]]);
});

test('a line typed fresh has no requisition and no required quantity', () => {
  const p = preparedFromPreq();
  p.lines[0].reqRefs = [];
  p.lines[0].clientId = null;
  const rows = erpRows(p, { userId: 9, voucherDate, fYear: '2026-2027', now });
  assert.equal(rows.details[0].RequiredQuantity, 0);
  assert.equal(rows.details[0].RequisitionTransactionID, 0);
  assert.equal(rows.details[0].RefJobCardContentNo, null);
  assert.equal(rows.requisitions.length, 0);
});

test('several jobs on one line: IDs glued, job numbers comma-separated, as the ERP does', () => {
  const p = preparedFromPreq();
  p.lines[0].reqRefs = [
    { requisitionTransactionId: 74093, jobRef: 'J09076_26_27[1_5]', jobContentsId: '27216', qty: 1000 },
    { requisitionTransactionId: 74095, jobRef: 'J09076_26_27[4_5]', jobContentsId: '27219', qty: 720 },
  ];
  const d = erpRows(p, { userId: 9, voucherDate, fYear: '2026-2027', now }).details[0];
  assert.equal(d.RefJobBookingJobCardContentsID, '2721627219');
  assert.equal(d.RefJobCardContentNo, 'J09076_26_27[1_5],J09076_26_27[4_5]');
  assert.equal(d.RequiredQuantity, 1720);
  assert.equal(d.RequisitionTransactionID, 74093, 'one requisition per PO line, the first');
});

test('the amount in words follows the ERP\'s PO wording', () => {
  assert.equal(erpAmountInWords(22535.92), 'Twenty Two Thousand Five Hundred Thirty Five Rupee and Ninety Two Paisa');
  assert.equal(erpAmountInWords(7320.02), 'Seven Thousand Three Hundred Twenty Rupee and Two Paisa');
  assert.equal(erpAmountInWords(330400), 'Three Lakhs Thirty Thousand Four Hundred Rupee');
  assert.equal(erpAmountInWords(114398.04), 'One Lakh Fourteen Thousand Three Hundred Ninety Eight Rupee and Four Paisa');
  assert.equal(erpAmountInWords(12690310), 'One Crore Twenty Six Lakhs Ninety Thousand Three Hundred Ten Rupee');
});

test('a refused PO lists every problem', () => {
  const err = new PoRejected(['Choose the payment terms.', 'P00017: enter a quantity.']);
  assert.equal(err.status, 422);
  assert.equal(err.problems.length, 2);
  assert.match(err.message, /2 things stop this PO/);
});
