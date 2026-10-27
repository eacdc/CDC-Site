/**
 * Sizes in mm, cm or inches, GSM, and supplier trade names.
 *
 * Krishna Vanijya KV/26-27/19508 (26 Oct 2026) against PO03496_26_27 as the
 * ERP holds it: three lines at Rs 78, all Gloss Art, told apart only by GSM
 * and size. The invoice prints its own name, "HI KOTE", and sizes in inches;
 * the item master names "Gloss Art" and holds mm. It matched nothing before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchInvoiceLines, assessCandidate, sizeWithUnit, compareSizeUnits } from '../services/receiving-match.js';

const PO = (id, itemId, pending, rate = 78) => ({
  TransactionDetailID: id, TransactionID: 9496, ItemID: itemId, PoVoucherNo: 'PO03496_26_27',
  PoDate: '2026-10-26', PurchaseRate: rate, PurchaseOrderQuantity: pending, PendingQty: pending, IsCompleted: false,
});
const PO_LINES = [PO(119044, 3830, 548.12), PO(119043, 3835, 2023.54), PO(119045, 3839, 899.26)];
const ITEMS = new Map([
  [3830, { ItemName: 'Gloss Art, 128 GSM, Imported, NONE, 585x915', GSM: 128, SizeW: 585, SizeL: 915 }],
  [3835, { ItemName: 'Gloss Art, 170 GSM, Imported, NONE, 508x762', GSM: 170, SizeW: 508, SizeL: 762 }],
  [3839, { ItemName: 'Gloss Art, 210 GSM, Imported, NONE, 585x915', GSM: 210, SizeW: 585, SizeL: 915 }],
]);
const KV_19508 = [
  { lineNo: 1, description: 'HI KOTE PAPER 123 x 250 = 30750 Sheet', gsm: '170', size: '20X30', qty: '2024.580', uom: 'KGS', rate: '78.00', amount: '1,57,917.24' },
  { lineNo: 2, description: 'HI KOTE PAPER 32 x 250 = 8000 Sheet', gsm: '128', size: '23X36', qty: '547.200', uom: 'KGS', rate: '78.00', amount: '42,681.60' },
  { lineNo: 3, description: 'HI KOTE BOARD 32 x 250 = 8000 Sheet', gsm: '210', size: '23X36', qty: '897.280', uom: 'KGS', rate: '78.00', amount: '69,987.84' },
];

test('a size knows the unit printed right after it, and only that one', () => {
  assert.deepEqual(sizeWithUnit('600X360X335 mm'), { dims: [335, 360, 600], shown: [600, 360, 335], unit: 'mm' });
  assert.equal(sizeWithUnit('5 PLY CORRUGATED BOXES ( 320 X 225 X 285 )MM').unit, 'mm');
  assert.equal(sizeWithUnit('20X30').unit, null);
  assert.equal(sizeWithUnit('23x36 inch').unit, 'inch');
  // RNG: the MM after "-1.9" is the board's caliper, not the size's unit.
  assert.equal(sizeWithUnit('MULTILAYER GREY/GREY 63.5X091.4-1.9 MM').unit, null);
});

test('a sheet count worked out is not a size', () => {
  assert.equal(sizeWithUnit('HI KOTE PAPER 123 x 250 = 30750 Sheet'), null);
  assert.deepEqual(sizeWithUnit('HI KOTE PAPER 123 x 250 = 30750 Sheet 20X30').shown, [20, 30]);
  // With the size field empty, the line still matches on its wording's size, not the count.
  const placed = matchInvoiceLines({
    lines: [{ ...KV_19508[0], size: null, description: 'HI KOTE PAPER 20X30 123 x 250 = 30750 Sheet' }],
    poLines: PO_LINES, items: ITEMS, poNumbers: ['3496'],
  });
  assert.equal(placed[0].po && placed[0].po.TransactionDetailID, 119043);
});

test('inches, cm and mm all compare with the item in mm', () => {
  assert.deepEqual(compareSizeUnits(sizeWithUnit('20X30'), [508, 762]), { result: 'exact', unit: 'inch' });
  assert.deepEqual(compareSizeUnits(sizeWithUnit('23X36'), [585, 915]), { result: 'exact', unit: 'inch' });
  assert.deepEqual(compareSizeUnits(sizeWithUnit('63.5X091.4'), [635, 914]), { result: 'exact', unit: 'cm' });
  assert.deepEqual(compareSizeUnits(sizeWithUnit('585 x 915'), [585, 915]), { result: 'exact', unit: 'mm' });
  assert.equal(compareSizeUnits(sizeWithUnit('23X36'), [635, 914]).result, 'mismatch');
});

test('in the same unit a box is still digit for digit: 2 mm off is another box', () => {
  assert.equal(compareSizeUnits(sizeWithUnit('450 X 450 X 142 MM'), [140, 450, 450]).result, 'mismatch');
  assert.equal(compareSizeUnits(sizeWithUnit('450 X 450 X 140 MM'), [140, 450, 450]).result, 'exact');
});

test('KV/26-27/19508: each line lands on its own PO line, by GSM and size', () => {
  const placed = matchInvoiceLines({ lines: KV_19508, poLines: PO_LINES, items: ITEMS, poNumbers: ['PO/3496'] });
  assert.deepEqual(placed.map((p) => p.po && p.po.TransactionDetailID), [119043, 119044, 119045]);
  assert.match(placed[0].basis, /size 20×30 in = 508×762 mm/);
  assert.match(placed[0].basis, /170 GSM matches/);
});

test('a different GSM is a different item, whatever the size and rate', () => {
  const a = assessCandidate(KV_19508[1], PO_LINES[2], { items: ITEMS, headerPoNumbers: new Set([3496]) });
  assert.equal(a.sizeExact, true);
  assert.equal(a.gsmMismatch, true);
  assert.equal(a.accepted, false);
});

test('the trade name alone does not carry it: with no size, still no match', () => {
  const noSize = { ...KV_19508[0], size: null };
  const a = assessCandidate(noSize, PO_LINES[1], { items: ITEMS, headerPoNumbers: new Set() });
  assert.equal(a.accepted, false, 'rate and GSM agree, but "HI KOTE PAPER" shares no word with "Gloss Art"');
});
