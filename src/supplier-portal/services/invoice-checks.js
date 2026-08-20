/**
 * INV001–INV019 (§18).
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
import { expectedTaxType, reconcileSheetKg, round } from '../lib/invoice-math.js';

/** E-way bill thresholds (₹). */
const EWAY_THRESHOLD = { interstate: 50000, intrastate: 100000 };

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

  for (const line of lines) {
    const qty = num(line.qty);
    const rate = num(line.rate);
    const amount = num(line.amount);

    // INV006 — the line's own arithmetic.
    if (qty !== null && rate !== null && amount !== null) {
      const expected = round(qty * rate, 2);
      results.push(check('INV006', Math.abs(amount - expected) <= tol, {
        lineNo: line.lineNo,
        message: Math.abs(amount - expected) > tol
          ? `Line ${line.lineNo}: ${qty} × ₹${rate} = ₹${expected}, but the invoice shows ₹${amount}`
          : undefined,
        actualValue: amount,
        expectedValue: expected,
      }));
    }

    // INV002 — every line must land on an open PO.
    results.push(check('INV002', Boolean(line.matchedPoTransactionId), {
      lineNo: line.lineNo,
      message: line.matchedPoTransactionId
        ? undefined
        : `Line ${line.lineNo} ("${line.description || 'no description'}") has no matching open PO for this supplier`,
    }));

    // INV003 — over-receipt beyond 10%. A hard block with no override: this is
    // the check that would have caught the 3000-for-1500 sheets error.
    if (qty !== null && num(line.poPendingQty) !== null) {
      const pending = num(line.poPendingQty);
      const limit = pending * (1 + TOLERANCES.receiptOverPct);
      results.push(check('INV003', qty <= limit, {
        lineNo: line.lineNo,
        message: qty > limit
          ? `Line ${line.lineNo}: receiving ${qty} against ${pending} pending — ${round(((qty - pending) / pending) * 100, 1)}% over the 10% tolerance`
          : undefined,
        actualValue: qty,
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

    // INV005 — the invoice rate must equal the PO rate.
    if (rate !== null && num(line.matchedPoRate) !== null) {
      const poRate = num(line.matchedPoRate);
      results.push(check('INV005', Math.abs(rate - poRate) <= 0.01, {
        lineNo: line.lineNo,
        message: Math.abs(rate - poRate) > 0.01
          ? `Line ${line.lineNo}: invoiced at ₹${rate}, PO says ₹${poRate}`
          : undefined,
        actualValue: rate,
        expectedValue: poRate,
      }));
    }

    // INV017 — HSN disagreement. A warning: HSN classification is genuinely
    // arguable, and a mismatch is a question for the supplier rather than a
    // reason to refuse the goods at the gate.
    if (line.hsn && line.expectedHsn) {
      const same = String(line.hsn).replace(/\D/g, '').startsWith(String(line.expectedHsn).replace(/\D/g, '').slice(0, 4));
      results.push(check('INV017', same, {
        lineNo: line.lineNo,
        message: same ? undefined : `Line ${line.lineNo}: invoice HSN ${line.hsn}, item master says ${line.expectedHsn}`,
        actualValue: line.hsn,
        expectedValue: line.expectedHsn,
      }));
    }
  }

  // ── Header arithmetic ────────────────────────────────────────────────────

  const lineSum = lines.reduce((sum, l) => sum + (num(l.amount) || 0), 0);
  const subTotal = num(header.subTotal);
  const freight = num(header.freight) || 0;
  const taxable = num(header.taxable);
  const cgst = num(header.cgst) || 0;
  const sgst = num(header.sgst) || 0;
  const igst = num(header.igst) || 0;
  const roundOff = num(header.roundOff) || 0;
  const grandTotal = num(header.grandTotal);

  // INV007 — lines against the subtotal.
  if (subTotal !== null && lines.length) {
    results.push(check('INV007', Math.abs(lineSum - subTotal) <= tol, {
      message: Math.abs(lineSum - subTotal) > tol
        ? `Lines total ₹${round(lineSum, 2)} but the invoice subtotal is ₹${subTotal}`
        : undefined,
      actualValue: round(lineSum, 2),
      expectedValue: subTotal,
    }));
  }

  // INV008 — taxable base. Freight is added BEFORE tax, which is what makes
  // this check meaningful rather than tautological.
  if (taxable !== null && subTotal !== null) {
    const expected = round(subTotal + freight, 2);
    results.push(check('INV008', Math.abs(taxable - expected) <= tol, {
      message: Math.abs(taxable - expected) > tol
        ? `Taxable value ₹${taxable} does not equal subtotal ₹${subTotal} + freight ₹${freight} = ₹${expected}`
        : undefined,
      actualValue: taxable,
      expectedValue: expected,
    }));
  }

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

  // ── E-way bill and freight ledger ────────────────────────────────────────

  const threshold = expectedType === 'IGST' ? EWAY_THRESHOLD.interstate : EWAY_THRESHOLD.intrastate;
  const needsEway = grandTotal !== null && grandTotal >= threshold;
  const ewayOk = !needsEway || isValidEwayBill(header.eWayBillNo);
  results.push(check('INV014', ewayOk, {
    message: ewayOk
      ? undefined
      : (header.eWayBillNo
          ? `E-way bill "${header.eWayBillNo}" is not a 12-digit number`
          : `No e-way bill on an invoice of ₹${grandTotal}, above the ₹${threshold} threshold`),
    actualValue: header.eWayBillNo ?? null,
  }));

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

/** A GST e-way bill number is 12 digits. */
export function isValidEwayBill(value) {
  const digits = String(value ?? '').replace(/\s|-/g, '');
  return /^\d{12}$/.test(digits);
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
