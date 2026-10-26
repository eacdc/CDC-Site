/**
 * Matcher tests on a real invoice, scored against what CDC's store booked.
 *
 * Pranay Udyog PU/26-27/0710 was booked by hand as REC04597_26_27. The fixture
 * holds the supplier's open PO lines as they stood before that booking, the
 * invoice lines as GPT-4o read them (three sizes misread, no PO references
 * kept) and as they are printed, and the booking itself line for line.
 *
 * The previous matcher, replayed on this fixture, got the item right on all
 * five lines but put line 5 on the wrong PO; with the right lines closed it
 * matched box 450x450x140 at Rs 38.95 for a 450x340x230 billed at Rs 33.32.
 * These tests pin the three rules that fix both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  matchInvoiceLines, poNumberFrom, poNumbersFrom, poNumberOfVoucher, sizeFrom,
} from '../services/receiving-match.js';
import { runInvoiceChecks } from '../services/invoice-checks.js';

const F = JSON.parse(readFileSync(new URL('./fixtures/pranay-pu-26-27-0710.json', import.meta.url), 'utf8'));
const items = new Map(F.poLines.map((p) => [p.ItemID, { ItemName: p.ItemName }]));
const BOOKED_LINES = new Set(F.booked.map((b) => b.transactionDetailId));

const place = (lines, { poLines = F.poLines, poNumbers = [] } = {}) =>
  matchInvoiceLines({ lines, poLines, items, poNumbers });

const asBooked = (placements) => placements.map((p) => (p.po
  ? `${p.po.ItemID} on ${p.po.PoVoucherNo}` : 'no PO'));
const BOOKED = F.booked.map((b) => `${b.itemId} on ${b.poVoucherNo}`);

// ── reading the signals ─────────────────────────────────────────────────────

test('the PO number is the first run of digits, not the date or quantity after it', () => {
  assert.equal(poNumberFrom('PO NO = 3232 - 5/10 = 818 PCS'), 3232);
  assert.equal(poNumberFrom('3081 26-09-2026'), 3081);
  assert.equal(poNumberFrom(null), null);
  assert.deepEqual([...poNumbersFrom(['2420, 3232, 3342', '3081'])], [2420, 3232, 3342, 3081]);
  assert.equal(poNumberOfVoucher('PO03232_26_27'), 3232);
});

test('a size reads the same however it is printed, and ignores the inch figures', () => {
  assert.deepEqual(sizeFrom('5 PLY C/B BOX (550X305X206)MM'), [206, 305, 550]);
  assert.deepEqual(
    sizeFrom('5 PLY CORRUGATED BOX 450 X 340 X 230 MM, 21.65 x, 10.23 x, 9.45, 5 Ply'),
    [230, 340, 450],
  );
  assert.deepEqual(sizeFrom('5 PLY CORRUGATED BOX ( 410 X 305 X 310 ) MM'), [305, 310, 410]);
  assert.equal(sizeFrom('INK, Maplitho - Process Ink'), null);
});

// ── the invoice, against the store's booking ─────────────────────────────────

test('as printed, PO numbers kept: every line lands where the store booked it', () => {
  assert.deepEqual(asBooked(place(F.printedLines)), BOOKED);
});

test('as the AI read it - three sizes wrong, PO numbers lost - every line still lands right', () => {
  // The exact PO rate carries lines whose size was misread, and capacity sends
  // line 5 to PO03232 because line 4 has used up PO03081.
  assert.deepEqual(asBooked(place(F.aiLines)), BOOKED);
});

test('the header PO list does not change a correct placement', () => {
  assert.deepEqual(asBooked(place(F.aiLines, { poNumbers: F.headerPoNumbers })), BOOKED);
});

// ── rule 1: the printed PO number decides ───────────────────────────────────

test('a printed PO number beats an older PO that has room', () => {
  // 90 boxes of 550x340x240 at 37.93 fit PO03081 exactly, and it is older -
  // but the supplier wrote 3232 against the line.
  const [p] = place([{ lineNo: 1, description: '5PLY C/B BOX (550X340X240)MM', qty: 90, rate: 37.93, poRef: '3232' }]);
  assert.equal(p.po.PoVoucherNo, 'PO03232_26_27');
  assert.match(p.basis, /PO 3232 printed on the invoice/);
});

test('a printed PO number does not excuse the wrong box on that PO', () => {
  // PO03232 carries five boxes. Naming the PO must not hand the line any of them.
  const others = F.poLines.filter((p) => p.TransactionDetailID !== 114355);
  const [p] = place(
    [{ lineNo: 1, description: '5 PLY C/B BOX (450X340X230)MM', qty: 818, rate: 33.32, poRef: '3232' }],
    { poLines: others },
  );
  assert.equal(p.po, null);
});

// ── rule 2: the rejection floor ─────────────────────────────────────────────

test('once the right PO lines are closed, no line is offered a different box', () => {
  const closed = F.poLines.filter((p) => !BOOKED_LINES.has(p.TransactionDetailID));
  for (const [label, lines] of [['AI read', F.aiLines], ['printed', F.printedLines]]) {
    place(lines, { poLines: closed }).forEach((p, i) => {
      if (p.po) {
        assert.equal(p.po.ItemID, F.booked[i].itemId,
          `${label} line ${i + 1} was offered item ${p.po.ItemID} on ${p.po.PoVoucherNo}`);
      }
    });
  }
});

test('the box the old matcher picked is turned down, and the reviewer is told why', () => {
  const closed = F.poLines.filter((p) => !BOOKED_LINES.has(p.TransactionDetailID));
  const [p] = place([F.aiLines[0]], { poLines: closed });
  assert.equal(p.po, null);
  assert.match(p.basis, /^No open PO line fits\. Closest:/);
});

test('shared words alone never make a match', () => {
  const [p] = place([{ lineNo: 1, description: '5 PLY CORRUGATED BOX', qty: 10, rate: null, poRef: null }]);
  assert.equal(p.po, null);
});

// ── rule 3: the whole invoice shares the PO book ────────────────────────────

test('two lines for the same box at the same rate do not share a PO line with room for one', () => {
  const [line4, line5] = place([F.aiLines[3], F.aiLines[4]]);
  assert.equal(line4.po.TransactionDetailID, 111650, 'line 4 takes PO03081, the older one, which it fits');
  assert.equal(line5.po.TransactionDetailID, 114356, 'line 5 moves to PO03232 once PO03081 is used');
});

test('a line that names its PO is placed first, so an unnamed line cannot take its room', () => {
  // The unnamed line comes first on the invoice, but the named one is placed
  // first: PO03081's 90 go to the line that asked for 3081.
  const [unnamed, named] = place([
    { lineNo: 1, description: '5PLY C/B BOX (550X340X240)MM', qty: 90, rate: 37.93, poRef: null },
    { lineNo: 2, description: '5PLY C/B BOX (550X340X240)MM', qty: 90, rate: 37.93, poRef: '3081' },
  ]);
  assert.equal(named.po.PoVoucherNo, 'PO03081_26_27');
  assert.equal(unnamed.po.PoVoucherNo, 'PO03232_26_27');
});

// ── INV003 judges a PO line by the whole invoice ────────────────────────────

const onPo03081 = (lineNo, qty) => ({
  lineNo, description: '5PLY C/B BOX (550X340X240)MM', qty, rate: 37.93, amount: qty * 37.93,
  matchedPoTransactionId: 65571, matchedPoTransactionDetailId: 111650,
  poPendingQty: 90, poVoucherNo: 'PO03081_26_27', matchedPoRate: 37.93,
});

test('INV003: two lines that each fit, but not together, both fail', () => {
  const inv003 = runInvoiceChecks({ header: {}, lines: [onPo03081(4, 90), onPo03081(5, 50)] })
    .filter((c) => c.code === 'INV003');
  assert.equal(inv003.length, 2);
  for (const c of inv003) {
    assert.equal(c.passed, false);
    assert.match(c.message, /Lines 4 and 5 together receive 140 against 90 pending on PO03081_26_27/);
  }
});

test('INV003: one line within tolerance still passes', () => {
  const [c] = runInvoiceChecks({ header: {}, lines: [onPo03081(4, 90)] })
    .filter((x) => x.code === 'INV003');
  assert.equal(c.passed, true);
});

// ── include closed: seeing where an invoice went ────────────────────────────

/**
 * The PO book AFTER REC04597_26_27: the five booked lines closed, carrying the
 * pending they were left with (negative where the store took a little extra),
 * and the GRN lines that booking made, keyed the way the ERP links them.
 */
const AFTER_BOOKING = new Map([[114355, -18], [116036, -10], [99683, 2], [111650, 0], [114356, -13]]);
const closedBook = F.poLines.map((p) => (AFTER_BOOKING.has(p.TransactionDetailID)
  ? { ...p, PendingQty: AFTER_BOOKING.get(p.TransactionDetailID), IsCompleted: true }
  : p));
const lineById = (id) => F.poLines.find((p) => p.TransactionDetailID === id);
const RECEIPTS = F.booked.map((b, i) => ({
  GrnVoucherNo: 'REC04597_26_27',
  PurchaseTransactionID: lineById(b.transactionDetailId).TransactionID,
  ItemID: b.itemId,
  ReceivedQty: F.printedLines[i].qty,
}));

test('open POs only - the default - is unchanged: a received invoice finds nothing to receive against', () => {
  for (const p of place(F.aiLines, { poLines: closedBook })) assert.equal(p.po, null);
});

test('include closed: every line shows the PO line it was actually received against', () => {
  const out = matchInvoiceLines({
    lines: F.aiLines, poLines: closedBook, items, includeClosed: true, receipts: RECEIPTS,
  });
  assert.deepEqual(asBooked(out), BOOKED);
  for (const p of out) {
    assert.equal(p.closed, true);
    assert.match(p.basis, /already received from this invoice on REC04597_26_27/);
  }
});

test('include closed: the receipts tell apart two closed lines for the same box at the same rate', () => {
  // No PO numbers and the size misread: only the receipt says which is which.
  const [line4, line5] = matchInvoiceLines({
    lines: [F.aiLines[3], F.aiLines[4]], poLines: closedBook, items, includeClosed: true, receipts: RECEIPTS,
  });
  assert.equal(line4.po.TransactionDetailID, 111650);
  assert.equal(line5.po.TransactionDetailID, 114356);
});

test('include closed with no receipts: the printed PO numbers still find the right closed lines', () => {
  const out = matchInvoiceLines({ lines: F.printedLines, poLines: closedBook, items, includeClosed: true });
  assert.deepEqual(asBooked(out), BOOKED);
});

test('include closed: an open line is still preferred when nothing says otherwise', () => {
  const box = { ItemID: 5560, ItemName: '5 PLY CORRUGATED BOX 550 X 340 X 240 MM', ItemDescription: null, PurchaseRate: 37.93, PurchaseOrderQuantity: 400 };
  const pool = [
    { ...box, TransactionID: 1, TransactionDetailID: 1, PoVoucherNo: 'PO00100_26_27', PoDate: '2026-06-01', PendingQty: 0, IsCompleted: true },
    { ...box, TransactionID: 2, TransactionDetailID: 2, PoVoucherNo: 'PO00200_26_27', PoDate: '2026-09-01', PendingQty: 100 },
  ];
  const [p] = matchInvoiceLines({
    lines: [{ lineNo: 1, description: '5PLY C/B BOX (550X340X240)MM', qty: 50, rate: 37.93 }],
    poLines: pool, items: new Map([[5560, { ItemName: box.ItemName }]]), includeClosed: true,
  });
  assert.equal(p.po.TransactionDetailID, 2);
  assert.equal(p.closed, false);
});

test('a line matched to a closed PO line fails INV002, and raises no over-receipt noise', () => {
  const closedLine = { ...onPo03081(4, 90), poPendingQty: 0, matchedPoClosed: true };
  const results = runInvoiceChecks({ header: {}, lines: [closedLine] });
  const inv002 = results.find((c) => c.code === 'INV002');
  assert.equal(inv002.passed, false);
  assert.match(inv002.message, /PO03081_26_27, but that PO line is closed/);
  assert.equal(results.some((c) => c.code === 'INV003'), false);
});

// ── lines placed by hand ────────────────────────────────────────────────────

test('a line placed by hand keeps its PO line, and automatic placement works around it', () => {
  // A person puts line 5 on PO03081. Line 4 - same box, same rate, which would
  // otherwise take PO03081 as the oldest - now goes to PO03232 instead.
  const po03081 = F.poLines.find((p) => p.TransactionDetailID === 111650);
  const [line4, line5] = matchInvoiceLines({
    lines: [F.aiLines[3], F.aiLines[4]], poLines: F.poLines, items,
    fixed: [{ index: 1, po: po03081 }],
  });
  assert.equal(line5.po.TransactionDetailID, 111650);
  assert.equal(line5.manual, true);
  assert.equal(line5.basis, null, 'the route keeps the person\'s own note');
  assert.equal(line4.po.TransactionDetailID, 114356);
});

test('a hand-picked line may sit on a closed PO line, and says so', () => {
  const closed = { ...F.poLines.find((p) => p.TransactionDetailID === 114355), PendingQty: -18, IsCompleted: true };
  const [p] = matchInvoiceLines({
    lines: [F.aiLines[0]], poLines: [closed], items, fixed: [{ index: 0, po: closed }],
  });
  assert.equal(p.po.TransactionDetailID, 114355);
  assert.equal(p.closed, true);
});
