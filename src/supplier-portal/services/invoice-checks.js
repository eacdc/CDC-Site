/**
 * INV001–INV021 (§18).
 *
 * Pure and synchronous: everything the checks need is passed in, so the whole
 * catalogue can be run in a test without a database or an ERP connection.
 * That matters because these are the checks standing between a tablet photo
 * and a posted voucher.
 *
 * Every check reports `passed` explicitly, including when it passes. A check
 * that disappears when it succeeds is indistinguishable from one that never
 * ran, and the review screen has to be able to show a store person that the
 * arithmetic was actually verified.
 */

import { check } from '../config/validations.js';
import { CDC_IDENTITY, TOLERANCES } from '../config/constants.js';
import {
  expectedTaxType, reconcileSheetKg, round, piQty, lineMoney, headerDiscount, discountedLines, goodsValue,
} from '../lib/invoice-math.js';

/**
 * Run the full catalogue.
 *
 * @param {Object} input
 * @param {Object} input.header      extracted invoice header
 * @param {Array}  input.lines       extracted lines, each already matched to a
 *                                   PO line where possible
 * @param {Object} [input.alreadyPosted]  a prior GRN with this invoice number
 * @param {Object} [input.context]   selected ledgers and warehouse
 * @returns {Array} check results
 */
export function runInvoiceChecks({ header = {}, lines = [], alreadyPosted = null, context = {} } = {}) {
  const results = [];
  const tol = TOLERANCES.invoiceAmount;

  // ── Identity and duplication ─────────────────────────────────────────────

  results.push(check('INV001', !alreadyPosted, {
    message: alreadyPosted
      ? `Invoice ${header.invoiceNo} was already received as ${alreadyPosted.VoucherNo} on ${formatDate(alreadyPosted.VoucherDate)}`
      : undefined,
    actualValue: alreadyPosted?.VoucherNo ?? null,
  }));

  const buyerGstin = normaliseGstin(header.buyerGstin);
  results.push(check('INV013', !buyerGstin || buyerGstin === CDC_IDENTITY.gstin, {
    message: buyerGstin && buyerGstin !== CDC_IDENTITY.gstin
      ? `Buyer GSTIN on the invoice is ${buyerGstin}, not CDC's ${CDC_IDENTITY.gstin}`
      : undefined,
    actualValue: buyerGstin,
    expectedValue: CDC_IDENTITY.gstin,
  }));

  // ── Dates ────────────────────────────────────────────────────────────────

  const invoiceDate = toDate(header.invoiceDate);
  const now = new Date();

  results.push(check('INV015', !invoiceDate || invoiceDate <= endOfToday(now), {
    message: invoiceDate && invoiceDate > endOfToday(now)
      ? `Invoice is dated ${formatDate(invoiceDate)}, which is in the future`
      : undefined,
    actualValue: header.invoiceDate,
  }));

  const ageDays = invoiceDate ? Math.floor((now - invoiceDate) / 86400000) : null;
  results.push(check('INV016', ageDays === null || ageDays <= 90, {
    message: ageDays !== null && ageDays > 90
      ? `Invoice is ${ageDays} days old — check whether it has already been received on paper`
      : undefined,
    actualValue: ageDays,
    expectedValue: 90,
  }));

  // ── Line arithmetic ──────────────────────────────────────────────────────

  /**
   * What each PO line receives across the WHOLE invoice. Two invoice lines on
   * one PO line must fit its pending together: 90 + 50 against 90 pending
   * passes a line-by-line check twice and still over-receives by half.
   */
  const usage = new Map();
  for (const l of lines) {
    const key = l.matchedPoTransactionDetailId;
    const q = num(l.qty);
    // A closed line is not being received against, so it uses no pending.
    if (!key || q === null || l.matchedPoClosed) continue;
    const u = usage.get(key) || { qty: 0, lineNos: [] };
    u.qty += q;
    u.lineNos.push(l.lineNo);
    usage.set(key, u);
  }

  // Each line's money as it will post: its own discount and its share of a
  // discount on the whole bill (lib/invoice-math.js).
  const numeric = lines.map((l) => ({
    ...l,
    qty: num(l.qty), rate: num(l.rate), amount: num(l.amount), billedKg: num(l.billedKg),
    discountPct: num(l.discountPct), discountAmount: num(l.discountAmount), taxableValue: num(l.taxableValue),
  }));
  const money = numeric.map((l) => lineMoney(l));
  const posted = discountedLines(numeric, { discount: num(header.discount), discountPct: num(header.discountPct) });

  for (const [index, line] of lines.entries()) {
    const qty = num(line.qty);
    const rate = num(line.rate);
    const amount = num(line.amount);
    const m = money[index];
    // What the amount is billed on: the billed kg where a person gave one.
    const billedQty = num(piQty(numeric[index]));

    // INV006 — the line's own arithmetic. On a bill that prints the amount
    // after the discount, the gross is qty x rate and the amount is the net.
    if (billedQty !== null && rate !== null && amount !== null) {
      const expected = round(billedQty * rate, 2);
      results.push(check('INV006', Math.abs(m.gross - expected) <= tol, {
        lineNo: line.lineNo,
        message: Math.abs(m.gross - expected) > tol
          ? `Line ${line.lineNo}: ${billedQty} × ₹${rate} = ₹${expected}, but the invoice shows ₹${amount}`
          : undefined,
        actualValue: m.gross,
        expectedValue: expected,
      }));
    }

    // INV020 — the discount's own arithmetic: amount less discount is the
    // line's value after it, and a percentage and an amount agree.
    const printedNet = num(line.taxableValue);
    const pctAmount = m.pct !== null && m.gross !== null ? round((m.gross * m.pct) / 100, 2) : null;
    const givenAmount = num(line.discountAmount) || null;
    if (m.gross !== null && ((m.stated !== null && printedNet !== null) || (givenAmount !== null && pctAmount !== null)
      || (m.stated === null && printedNet !== null && printedNet > m.gross + tol))) {
      const wrong = [];
      if (givenAmount !== null && pctAmount !== null && Math.abs(givenAmount - pctAmount) > tol) {
        wrong.push(`${m.pct}% of ₹${m.gross} is ₹${pctAmount}, but the discount shows ₹${givenAmount}`);
      }
      const expected = round(m.gross - (m.stated ?? 0), 2);
      if (printedNet !== null && Math.abs(printedNet - expected) > tol) {
        wrong.push(m.stated === null
          ? `the value after discount ₹${printedNet} is more than the amount ₹${m.gross}`
          : `₹${m.gross} less discount ₹${m.stated} = ₹${expected}, but the value after discount shows ₹${printedNet}`);
      }
      results.push(check('INV020', wrong.length === 0, {
        lineNo: line.lineNo,
        message: wrong.length ? `Line ${line.lineNo}: ${wrong.join('; ')}` : undefined,
        actualValue: printedNet ?? givenAmount,
        expectedValue: printedNet !== null ? expected : pctAmount,
      }));
    }

    // INV002 — every line must land on an OPEN PO line. A match to a closed
    // one (the include-closed view) shows where the goods belonged; nothing
    // more can be received against it, so it fails here and blocks the post.
    const onOpenPo = Boolean(line.matchedPoTransactionId) && !line.matchedPoClosed;
    results.push(check('INV002', onOpenPo, {
      lineNo: line.lineNo,
      message: onOpenPo ? undefined
        : (line.matchedPoTransactionId
          ? `Line ${line.lineNo} matches ${line.poVoucherNo || 'a PO'}, but that PO line is closed — nothing more can be received against it`
          : `Line ${line.lineNo} ("${line.description || 'no description'}") has no matching open PO for this supplier`),
    }));

    // INV003 — over-receipt beyond 10%. A hard block with no override: this is
    // the check that would have caught the 3000-for-1500 sheets error.
    // Not for a closed line: INV002 has already said why it cannot be posted,
    // and "over pending" on a line nothing is received against is just noise.
    if (qty !== null && num(line.poPendingQty) !== null && !line.matchedPoClosed) {
      const pending = num(line.poPendingQty);
      const limit = pending * (1 + TOLERANCES.receiptOverPct);
      const shared = usage.get(line.matchedPoTransactionDetailId);
      const together = Boolean(shared && shared.lineNos.length > 1);
      const total = together ? round(shared.qty, 3) : qty;
      const over = pending > 0
        ? `${round(((total - pending) / pending) * 100, 1)}% over the 10% tolerance`
        : 'and nothing is pending';
      results.push(check('INV003', total <= limit, {
        lineNo: line.lineNo,
        message: total > limit
          ? (together
            ? `Lines ${listLineNos(shared.lineNos)} together receive ${total} against ${pending} pending on ${line.poVoucherNo || 'the same PO line'} — ${over}`
            : `Line ${line.lineNo}: receiving ${qty} against ${pending} pending — ${over}`)
          : undefined,
        actualValue: total,
        expectedValue: round(limit, 3),
      }));
    }

    // INV004 — sheets against kg.
    if (num(line.totalUnits) !== null && num(line.billedKg ?? line.qty) !== null && line.widthMm && line.lengthMm && line.gsm) {
      const rec = reconcileSheetKg({
        sheets: num(line.totalUnits),
        widthMm: num(line.widthMm),
        lengthMm: num(line.lengthMm),
        gsm: num(line.gsm),
        billedKg: num(line.billedKg ?? line.qty),
        wtPerPacking: num(line.wtPerPacking),
        unitPerPacking: num(line.unitPerPacking),
        tolerancePct: TOLERANCES.sheetKgPct,
      });
      results.push(check('INV004', rec.withinTolerance, {
        lineNo: line.lineNo,
        message: rec.withinTolerance
          ? undefined
          : `Line ${line.lineNo}: ${line.totalUnits} sheets computes to ${rec.computedOurs} kg but ${rec.billed} kg was billed (${rec.deltaOursPct}%)`,
        actualValue: rec.billed,
        expectedValue: rec.computedOurs,
      }));
    }

    // INV005 — the rate CDC pays must equal the PO rate: after any discount,
    // since that is the rate the PO is raised at (Sonafine: 35.25 less 20% is
    // the PO's 28.20).
    if (rate !== null && num(line.matchedPoRate) !== null) {
      const poRate = num(line.matchedPoRate);
      const discounted = posted[index].discount !== 0 && billedQty > 0;
      const paid = discounted ? round(posted[index].net / billedQty, 4) : rate;
      const off = Math.abs(paid - poRate) > 0.01;
      results.push(check('INV005', !off, {
        lineNo: line.lineNo,
        message: off
          ? (discounted
            ? `Line ${line.lineNo}: ₹${rate} less discount is ₹${round(paid, 2)}, PO says ₹${poRate}`
            : `Line ${line.lineNo}: invoiced at ₹${rate}, PO says ₹${poRate}`)
          : undefined,
        actualValue: paid,
        expectedValue: poRate,
      }));
    }

    // INV017 (HSN against the item master) was dropped on 28 Oct 2026: CDC
    // does not hold a GRN over an HSN, so the warning only asked for a reason.
  }

  // ── Header arithmetic ────────────────────────────────────────────────────

  const lineSum = money.reduce((sum, m) => sum + (m.gross || 0), 0);
  const netSum = money.reduce((sum, m) => sum + (m.net || 0), 0);
  const hasAmounts = lines.some((l) => num(l.amount) !== null);
  const subTotal = num(header.subTotal);
  const freight = num(header.freight) || 0;
  const taxable = num(header.taxable);
  const cgst = num(header.cgst) || 0;
  const sgst = num(header.sgst) || 0;
  const igst = num(header.igst) || 0;
  const roundOff = num(header.roundOff) || 0;
  const grandTotal = num(header.grandTotal);

  // INV007 — lines against the subtotal: a bill prints its goods total
  // before the line discounts or after them, and either adds up.
  if (subTotal !== null && lines.length) {
    const before = Math.abs(lineSum - subTotal) <= tol;
    const after = Math.abs(netSum - subTotal) <= tol;
    const discounted = Math.abs(netSum - lineSum) > 0.005;
    results.push(check('INV007', before || after, {
      message: before || after ? undefined
        : `Lines total ₹${round(lineSum, 2)}${discounted ? ` (₹${round(netSum, 2)} after discount)` : ''} but the invoice subtotal is ₹${subTotal}`,
      actualValue: round(after && !before ? netSum : lineSum, 2),
      expectedValue: subTotal,
    }));
  }

  // INV008 — taxable base: the goods after their discounts, less a discount
  // on the whole bill, plus freight. Freight is added BEFORE tax, which is
  // what makes this check meaningful rather than tautological. The goods are
  // the printed subtotal - less the line discounts when it is printed before
  // them - so that a misread line fails INV006/INV007, not this; the lines
  // stand in only when no subtotal was read.
  const goods = goodsValue({ subTotal, lineSum, netSum, hasAmounts, tol });
  const billDiscount = headerDiscount({ discount: num(header.discount), discountPct: num(header.discountPct) }, goods ?? 0);
  if (taxable !== null && goods !== null) {
    const expected = round(goods - billDiscount + freight, 2);
    const parts = `${subTotal === null ? 'the lines' : 'subtotal'} ₹${round(goods, 2)}${goods !== subTotal && subTotal !== null ? ' after line discounts' : ''}`
      + `${billDiscount ? ` - bill discount ₹${billDiscount}` : ''} + freight ₹${freight}`;
    results.push(check('INV008', Math.abs(taxable - expected) <= tol, {
      message: Math.abs(taxable - expected) > tol
        ? `Taxable value ₹${taxable} does not equal ${parts} = ₹${expected}`
        : undefined,
      actualValue: taxable,
      expectedValue: expected,
    }));
  }

  // INV021 — a discount nobody read. The figures say something came off
  // before tax, but no discount was entered, so the purchase invoice would
  // post the gross. Ignoring INV006 or INV008 instead of entering it is how a
  // discounted bill gets overstated by the discount and the tax on it.
  const unread = [];
  const anyRead = money.some((m) => m.read) || billDiscount > 0;
  for (const [index, line] of lines.entries()) {
    const m = money[index];
    const q = num(piQty(numeric[index]));
    const r = num(line.rate);
    if (m.read) continue;
    if (m.discount > tol) {
      unread.push(`line ${line.lineNo}'s value after discount ₹${m.net} is ₹${m.discount} (${pctOf(m.discount, m.gross)}) below its amount`);
    } else if (q !== null && r !== null && m.gross !== null && q * r - m.gross > tol) {
      const gap = round(q * r - m.gross, 2);
      unread.push(`line ${line.lineNo}'s amount ₹${m.gross} is ₹${gap} (${pctOf(gap, q * r)}) below ${q} × ₹${r}`);
    }
  }
  // Below the goods + freight, with goods and lines agreeing: what is
  // missing came off between the two.
  const linesAgree = subTotal === null || Math.abs(lineSum - subTotal) <= tol;
  if (!anyRead && !unread.length && hasAmounts && linesAgree && taxable !== null && goods + freight - taxable > tol) {
    const gap = round(goods + freight - taxable, 2);
    unread.push(`the taxable value ₹${taxable} is ₹${gap} (${pctOf(gap, goods)} of the goods) below the goods + freight`);
  }
  results.push(check('INV021', unread.length === 0, {
    message: unread.length
      ? `No discount was read, but ${unread.join('; ')}. If the bill takes a discount, enter it on the line (or the bill) `
        + 'rather than ignoring the arithmetic - otherwise the purchase invoice posts the gross'
      : undefined,
    actualValue: unread.length ? unread.length : null,
  }));

  // INV009 — tax against the taxable base at the stated rate.
  if (taxable !== null && num(header.gstRate) !== null) {
    const rate = num(header.gstRate) / 100;
    const charged = cgst + sgst + igst;
    const expected = round(taxable * rate, 2);
    results.push(check('INV009', Math.abs(charged - expected) <= tol, {
      message: Math.abs(charged - expected) > tol
        ? `GST charged ₹${round(charged, 2)} but ₹${taxable} at ${header.gstRate}% is ₹${expected}`
        : undefined,
      actualValue: round(charged, 2),
      expectedValue: expected,
    }));
  }

  // INV010 — the grand total.
  if (grandTotal !== null && taxable !== null) {
    const expected = round(taxable + cgst + sgst + igst + roundOff, 2);
    results.push(check('INV010', Math.abs(grandTotal - expected) <= tol, {
      message: Math.abs(grandTotal - expected) > tol
        ? `Grand total ₹${grandTotal} does not equal taxable ₹${taxable} + tax ₹${round(cgst + sgst + igst, 2)} + round off ₹${roundOff} = ₹${expected}`
        : undefined,
      actualValue: grandTotal,
      expectedValue: expected,
    }));
  }

  // INV011 — round off outside a rupee is not a round off.
  results.push(check('INV011', Math.abs(roundOff) <= 1, {
    message: Math.abs(roundOff) > 1 ? `Round off is ₹${roundOff}` : undefined,
    actualValue: roundOff,
    expectedValue: '±1',
  }));

  // ── Tax type ─────────────────────────────────────────────────────────────

  // INV012 — a warning, never an override. The supplier decided the tax type
  // when they filed and input credit must match GSTR-2B; the value of catching
  // it here is that a corrected invoice can be requested before the credit is
  // lost. Place of supply for goods follows delivery, so ship-to state decides.
  const expectedType = expectedTaxType({
    supplierState: header.supplierState,
    shipToState: header.shipToState,
  });
  if (expectedType && header.taxType) {
    results.push(check('INV012', expectedType === header.taxType, {
      message: expectedType !== header.taxType
        ? `Invoice charges ${header.taxType} but ${header.supplierState} → ${header.shipToState} implies ${expectedType}`
        : undefined,
      actualValue: header.taxType,
      expectedValue: expectedType,
    }));
  }

  // ── Freight ledger ───────────────────────────────────────────────────────

  // INV014 (e-way bill above the threshold) was dropped on 28 Oct 2026: CDC
  // does not hold a GRN over the e-way bill.

  // INV018 — freight charged but no ledger chosen. Blocking because the
  // freight ledger is picked by a human to match the material's GST rate, and
  // there is no safe default.
  results.push(check('INV018', !(freight > 0) || Boolean(context.freightLedgerId), {
    message: freight > 0 && !context.freightLedgerId
      ? `Invoice carries ₹${freight} freight — select the inward freight ledger matching the material's GST rate`
      : undefined,
    actualValue: context.freightLedgerId ?? null,
  }));

  // INV019 — everything on the PO has already been received.
  const allComplete = lines.length > 0 && lines.every((l) => num(l.poPendingQty) === 0);
  results.push(check('INV019', !allComplete, {
    message: allComplete ? 'Every matched PO line is already fully received' : undefined,
  }));

  return results;
}

/** 22,108.80 of 1,10,544 -> "20%". */
function pctOf(part, whole) {
  return whole > 0 ? `${round((part / whole) * 100, 2)}%` : '?%';
}

/** [4, 5] -> "4 and 5"; [1, 2, 3] -> "1, 2 and 3". */
function listLineNos(nos) {
  const list = nos.map(String);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join('');
}

function normaliseGstin(value) {
  const t = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return t || null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[₹\s]/g, '').replace(/(?<=\d),(?=\d)/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const dmy = String(value).match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = new Date(year, Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function endOfToday(now) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatDate(date) {
  if (!date) return 'an unknown date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
