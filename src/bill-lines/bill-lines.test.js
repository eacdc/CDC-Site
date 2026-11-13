/**
 * Pairing supplier invoice lines with ERP purchase-invoice lines, and the link
 * decision. PI lines are AK Trading's PI04071_26_27 (Kolkata, Sep 2026): three
 * Grey Back sizes billed at the same 49.25/kg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestPiLines, totalsCheck, normaliseInvoiceNo, lineNumbers } from './line-match.js';
import { decideLink } from './erp-link.js';
import { reviewReasons, billTotals } from './extract-bill.js';

test('a subtotal printed before discount does not fail the totals when the taxable value agrees', () => {
  // Sonafine: subtotal 5,800 before 20% off; lines and PI 5,220... taxable 5,370 with 150 freight.
  const t = billTotals(
    [line(1, 'ART CARD', '100', '58', '5800', { discountAmount: '580' })],
    { subTotal: '5,800.00', taxable: '5,370.00', freight: '150.00' },
    [{ gross: 5220 }],
  );
  assert.equal(t.bill.ok, true);
  assert.equal(t.bill.target, 5220);
  assert.equal(t.pi.ok, true);
});

const PI = [
  { detailId: 1, itemId: 6035, itemGroupId: 14, itemName: 'Grey Back, 350 GSM, Dev Priya, NONE, 585 X 525 MM', qty: 1736, challanQty: 16128, rate: 49.25, gross: 85498 },
  { detailId: 2, itemId: 8011, itemGroupId: 14, itemName: 'Grey Back, 300 GSM, Devpriya, NONE, 760 X 605 MM', qty: 4099.4, challanQty: 29664, rate: 49.25, gross: 201895.45 },
  { detailId: 3, itemId: 8791, itemGroupId: 14, itemName: 'Grey Back, 300 GSM, Dev Priya, NONE, 710 X 640 MM', qty: 1764, challanQty: 12960, rate: 49.25, gross: 86877 },
];

const line = (lineNo, description, qty, rate, amount, extra = {}) => ({
  lineNo, description, hsn: '4810', qty: String(qty), rate: String(rate), amount: String(amount), ...extra,
});

test('same-rate paper lines pair on amount and quantity, not on rate', () => {
  const lines = [
    line(1, 'GREY BACK 300 GSM 71X64', '1,764.000', '49.25', '86,877.00'),
    line(2, 'GREY BACK 350 GSM 58.5X52.5', '1736', '49.25', '85498'),
    line(3, 'GREY BACK 300 GSM 76X60.5', '4099.40', '49.25', '2,01,895.45'),
  ];
  const out = suggestPiLines(lines, PI);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [8791, 6035, 8011]);
  assert.ok(out.every((r) => r.suggestion.method === 'AMOUNT_QTY'));
});

test('a rate match alone pairs nothing', () => {
  const out = suggestPiLines([line(1, 'GREY BACK', '999', '49.25', '49200.75')], PI);
  assert.equal(out[0].suggestion, null);
  assert.match(out[0].reason, /no PI line agrees/);
});

test('sheets billed against a kg PI line still pair on the sheet count', () => {
  const out = suggestPiLines([line(1, 'GREY BACK 350', '16128', '5.30', '85,498.00')], PI);
  assert.equal(out[0].suggestion.itemId, 6035);
  assert.equal(out[0].suggestion.method, 'AMOUNT_QTY');
});

test('two PI lines equally good leave the line for review', () => {
  const twins = [
    { detailId: 10, itemId: 1, itemName: 'Cyan', qty: 20, rate: 900, gross: 18000 },
    { detailId: 11, itemId: 2, itemName: 'Magenta', qty: 20, rate: 900, gross: 18000 },
  ];
  const out = suggestPiLines([line(1, 'SICURA PLUS', '20', '900', '18000')], twins);
  assert.equal(out[0].suggestion, null);
  assert.deepEqual(out[0].candidates, [10, 11]);
});

test('numbers that tie are settled by the colour in the description', () => {
  // Ever Right: Radicure magenta and yellow, both 12 x 830.
  const pi = [
    { detailId: 20, itemId: 1, itemName: 'UV Ink, UV Ink - Process-Magenta', qty: 12, rate: 830, gross: 9960 },
    { detailId: 21, itemId: 2, itemName: 'UV Ink, UV Ink - Process-Yellow', qty: 12, rate: 830, gross: 9960 },
  ];
  const out = suggestPiLines([
    line(1, 'RADICURE INTENSE 9000 PRO MAGENTA 0685 (2 KG)', '12', '830', '9960'),
    line(2, 'RADICURE INTENSE 9000 PRO YELLOW-0686 (2 KG)', '12', '830', '9960'),
  ], pi);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [1, 2]);
  assert.equal(out[0].suggestion.method, 'AMOUNT_QTY+TEXT');
});

test('numbers that tie are settled by the width, or by a model word', () => {
  // Shring: gold foil 160 mm and 320 mm, both 3,840 m.
  const foil = [
    { detailId: 30, itemId: 1, itemName: '101 Gloss Gold Foil 1500 MTR, 160 mm', qty: 3840, rate: 10.5, gross: 40320 },
    { detailId: 31, itemId: 2, itemName: '101 Gloss Gold Foil 1500 MTR, 320 mm', qty: 3840, rate: 10.5, gross: 40320 },
  ];
  const f = suggestPiLines([line(1, 'STAMPING FOIL 1 101 GLOSS GOLD 320 MM X 1500 M X 8 ROLL', '3840', '10.50', '40320')], foil);
  assert.equal(f[0].suggestion.itemId, 2);
  // Kurz: Alufin silver and 385 gold, same quantity and amount.
  const kurz = [
    { detailId: 40, itemId: 1, itemName: 'KURZ 385 METALITE GLOSS GOLD FOIL 610 MM X 244 MTR, 610 mm', qty: 2381.44, rate: 19, gross: 45247.36 },
    { detailId: 41, itemId: 2, itemName: 'KURZ METALITE ALUFIN GLOSS SILVER 610 MM X 244 MTR, 610 mm', qty: 2381.44, rate: 19, gross: 45247.36 },
  ];
  const k = suggestPiLines([
    line(1, '10114268 METALITE ALUFIN 16050', '2381.44', '19', '45247.36'),
    line(2, '10114276 METALITE 16050/385', '2381.44', '19', '45247.36'),
  ], kurz);
  assert.deepEqual(k.map((r) => r.suggestion?.itemId), [2, 1]);
});

test('numbers that tie are settled by GSM and a size printed in cm', () => {
  // Krishna Vanijya: two Cyber XL Pac sizes, both 24,796.80.
  const pi = [
    { detailId: 60, itemId: 1, itemName: 'FBB, 220 GSM, ITC, NONE, 510 X 642 MM', qty: 302.4, rate: 82, gross: 24796.8 },
    { detailId: 61, itemId: 2, itemName: 'FBB, 250 GSM, ITC, None, 560 X 770 MM', qty: 302.4, rate: 82, gross: 24796.8 },
  ];
  const out = suggestPiLines([
    line(1, 'R-CYBER XL PAC ITC 28 x 100 = 2800 Sheet', '28', '885.60', '24796.80', { gsm: '250', size: '56X77' }),
    line(2, 'R-CYBER XL PAC ITC 42 x 100 = 4200 Sheet', '42', '590.40', '24796.80', { gsm: '220', size: '51X64.2' }),
  ], pi);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [2, 1]);
});

test('the PI line left over from a tie is not taken when the description contradicts it', () => {
  // SR Graphic: Impact yellow, magenta, cyan at 14,550; in Indus yellow is 13,800 and black 14,550.
  const pi = [
    { detailId: 50, itemId: 1, itemName: 'SAKATA - Conv - Sakata Impact  - Cyan', qty: 30, rate: 485, gross: 14550 },
    { detailId: 51, itemId: 2, itemName: 'SAKATA - Conv - Sakata Impact  - Magenta', qty: 30, rate: 485, gross: 14550 },
    { detailId: 52, itemId: 3, itemName: 'SAKATA - Conv - Sakata Impact  - Yellow', qty: 30, rate: 460, gross: 13800 },
    { detailId: 53, itemId: 4, itemName: 'SAKATA - Conv - Sakata Impact  - Black', qty: 30, rate: 485, gross: 14550 },
  ];
  const out = suggestPiLines([
    line(1, 'SKT Impact Magenta (V)(1)', '30', '485', '14550'),
    line(2, 'SKT Impact Cyan (V)(1)', '30', '485', '14550'),
    line(3, 'SKT Impact Yellow (V)(1)', '30', '485', '14550'),
  ], pi);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId ?? null), [2, 1, null]);
  assert.match(out[2].reason, /colour|fit equally/);
});

test('once one twin is taken by a better line, the other is no longer ambiguous', () => {
  const twins = [
    { detailId: 10, itemId: 1, itemName: 'Cyan', qty: 20, rate: 900, gross: 18000 },
    { detailId: 11, itemId: 2, itemName: 'Magenta', qty: 25, rate: 720, gross: 18000 },
  ];
  const out = suggestPiLines([
    line(1, 'SICURA CYAN', '20', '900', '18000'),
    line(2, 'SICURA MAGENTA', '25', '720', '18000'),
  ], twins);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [1, 2]);
});

test('a line discount is applied before comparing', () => {
  // Sonafine-style: 35.25 less 20% = 28.20 a sheet.
  const pi = [{ detailId: 5, itemId: 4360, itemName: 'Art Card', qty: 3136, rate: 28.2, gross: 88435.2 }];
  const out = suggestPiLines([line(1, 'ART CARD 72X102', '3136', '35.25', '110544.00', { discountPct: '20', discountAmount: '22108.80' })], pi);
  assert.equal(out[0].suggestion.itemId, 4360);
  assert.equal(out[0].suggestion.method, 'AMOUNT_QTY');
});

test('freight is a charge, not an item', () => {
  const out = suggestPiLines([
    line(1, 'GREY BACK 350', '1736', '49.25', '85498'),
    { lineNo: 2, description: 'Freight Charges', hsn: '996511', qty: null, rate: null, amount: '1500' },
  ], PI);
  assert.equal(out[1].kind, 'CHARGE');
  assert.equal(out[1].suggestion, null);
});

test('the only line on both sides is paired at low confidence when the money disagrees', () => {
  const pi = [{ detailId: 7, itemId: 77, itemName: 'Glue', qty: 50, rate: 210, gross: 10500 }];
  const out = suggestPiLines([line(1, 'PVA ADHESIVE', '48', '205', '9840')], pi);
  assert.equal(out[0].suggestion.method, 'ONLY_CANDIDATE');
  assert.ok(out[0].suggestion.confidence < 0.85);
});

test('one supplier line can stand for several PI lines (Purv Flexipack, one grade, two widths)', () => {
  const pi = [
    { detailId: 1, itemId: 101, itemGroupId: 5, itemName: 'BOPP Gloss, Indian, 864 MM, 10 MICRON', qty: 201.4, challanQty: 201.4, rate: 242, gross: 48738.8 },
    { detailId: 2, itemId: 102, itemGroupId: 5, itemName: 'BOPP Gloss, Indian, 1030 MM, 10 MICRON', qty: 211, challanQty: 211, rate: 242, gross: 51062 },
    { detailId: 3, itemId: 103, itemGroupId: 5, itemName: 'BOPP Matte, Indian, 750 MM, 12 MICRON', qty: 512, challanQty: 512, rate: 250, gross: 128000 },
    { detailId: 4, itemId: 104, itemGroupId: 5, itemName: 'BOPP Matte, Indian, 902 MM, 12 MICRON', qty: 507.2, challanQty: 507.2, rate: 250, gross: 126800 },
    { detailId: 5, itemId: 105, itemGroupId: 5, itemName: 'BOPP MATTE, Indian, 1020 MM, 12 MICRON', qty: 287.6, challanQty: 287.6, rate: 250, gross: 71900 },
  ];
  const out = suggestPiLines([
    line(1, 'BOPP Film ( NCL 10 ) 10mic.Glossy', '412.400', '242.00', '99,800.80'),
    line(2, 'BOPP Film(NMA12) 12mic.Matt', '1,306.800', '250.00', '3,26,700.00'),
  ], pi);
  assert.equal(out[0].suggestion.method, 'GROUP');
  assert.deepEqual(out[0].suggestion.group.map((g) => g.itemId), [101, 102]);
  assert.deepEqual(out[1].suggestion.group.map((g) => g.itemId), [103, 104, 105]);
  assert.equal(out[1].suggestion.itemGroupId, 5);
});

test('quantities pair when every line carries the same unprinted discount (Emami)', () => {
  const pi = [
    { detailId: 1, itemId: 201, itemGroupId: 2, itemName: 'CBB, 290 GSM, Emami, 1030 mm', qty: 1757, challanQty: 1757, rate: 76.5, gross: 134410.5 },
    { detailId: 2, itemId: 202, itemGroupId: 2, itemName: 'CBB, 280 GSM, Emami, 640 mm', qty: 1451, challanQty: 1451, rate: 76.5, gross: 111001.5 },
    { detailId: 3, itemId: 203, itemGroupId: 2, itemName: 'CBB, 340 GSM, Emami, 1270 mm', qty: 2674, challanQty: 2674, rate: 76.5, gross: 204561 },
  ];
  const out = suggestPiLines([
    line(1, 'EMAMI GLAM KOT HB (FSC)', '1,451.00', '98.55', '142,996.05'),
    line(2, 'EMAMI GLAM KOT HB (FSC)', '1,757.00', '98.55', '173,152.35'),
    line(3, 'EMAMI GLAM KOT HB (FSC)', '2,674.00', '98.55', '263,522.70'),
  ], pi);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [202, 201, 203]);
  assert.ok(out.every((r) => r.suggestion.method === 'QTY_COMMON_DISCOUNT' && r.suggestion.confidence >= 0.85));
});

test('several supplier lines can be posted as one PI line (Kapoor blankets, two sizes)', () => {
  const pi = [
    { detailId: 1, itemId: 301, itemName: 'Web Blanket 508 Normal - 889 X 576', qty: 5, challanQty: 5, rate: 4565, gross: 22825 },
    { detailId: 2, itemId: 302, itemName: 'Web Blanket 546(1) Orient 889 x 612', qty: 5, challanQty: 5, rate: 4823, gross: 24115 },
  ];
  const out = suggestPiLines([
    line(1, 'Rubber Blanket EX6000 (889G x 612)', '1.00', '4,823.00', '4823'),
    line(2, 'Rubber Blanket EX6000 (889G x 612)', '4.00', '4,823.00', '19292'),
    line(3, 'Rubber Blanket Atlas Web (889Gx576)', '1.00', '4,565.00', '4565'),
    line(4, 'Rubber Blanket Atlas Web (889Gx576)', '4.00', '4,565.00', '18260'),
  ], pi);
  assert.deepEqual(out.map((r) => r.suggestion?.itemId), [302, 302, 301, 301]);
  assert.ok(out.every((r) => r.suggestion.method === 'SPLIT'));
});

test('a lone quantity-only pair stays low confidence', () => {
  const pi = [{ detailId: 1, itemId: 9, itemName: 'Glue', qty: 50, rate: 150, gross: 7500 }, { detailId: 2, itemId: 8, itemName: 'Ink', qty: 10, rate: 900, gross: 9000 }];
  const out = suggestPiLines([line(1, 'ADHESIVE', '50', '210', '10500')], pi);
  assert.equal(out[0].suggestion.method, 'QTY');
  assert.ok(out[0].suggestion.confidence < 0.85);
});

test('invoice numbers compare without spaces or invisible characters', () => {
  assert.equal(normaliseInvoiceNo(' 2627 / 604 '), '2627/604');
  assert.equal(normaliseInvoiceNo('410017366​0'), '4100173660');
  assert.equal(normaliseInvoiceNo('kv/26-27/16827'), 'KV/26-27/16827');
  assert.equal(normaliseInvoiceNo(''), null);
});

test('Indian digit grouping and line values', () => {
  const n = lineNumbers(line(1, 'X', '4099.40', '49.25', '2,01,895.45'));
  assert.equal(n.value, 201895.45);
  assert.equal(n.isCharge, false);
});

test('totals: lines against the bill and against the PI', () => {
  const lines = PI.map((p, i) => line(i + 1, 'GB', p.qty, p.rate, p.gross));
  const t = totalsCheck(lines, { billGoodsValue: 374270.45, piGross: 374270.45 });
  assert.equal(t.linesTotal, 374270.45);
  assert.equal(t.bill.ok, true);
  assert.equal(t.pi.ok, true);
  assert.equal(totalsCheck(lines, { billGoodsValue: 380000 }).bill.ok, false);
});

test('link decision: one PI, many PIs, GRN only, nothing', () => {
  const one = decideLink({ grnIds: [65451], piKeys: new Map([[8280, new Set(['PI_VOUCHER', 'GRN_INVOICE'])]]) });
  assert.equal(one.status, 'LINKED');
  assert.equal(one.keysAgreed, true);
  assert.deepEqual(one.keys, ['GRN_INVOICE', 'PI_VOUCHER']);

  const two = decideLink({ piKeys: new Map([[1, new Set(['PI_VOUCHER'])], [2, new Set(['GRN_INVOICE'])]]) });
  assert.equal(two.status, 'AMBIGUOUS');
  assert.equal(two.candidates.length, 2);

  assert.equal(decideLink({ grnIds: [9], piKeys: new Map() }).status, 'GRN_ONLY');
  assert.equal(decideLink({}).status, 'NOT_FOUND');
});

test('a bill is DONE only when everything agrees', () => {
  const good = {
    link: { status: 'LINKED', keysAgreed: true },
    lines: [{ kind: 'GOODS', suggestion: { confidence: 0.95 } }],
    checks: { readerProblems: [], totals: { bill: { ok: true }, pi: { ok: true } }, invoiceNoAgrees: true },
  };
  assert.deepEqual(reviewReasons(good), []);
  const weak = { ...good, link: { status: 'LINKED', keysAgreed: false }, lines: [{ kind: 'GOODS', suggestion: { confidence: 0.6 } }] };
  assert.deepEqual(reviewReasons(weak), ['linked by one key only', '1 low-confidence suggestion(s)']);
});
