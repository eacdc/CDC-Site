/**
 * What is provably wrong with an extracted invoice, before anyone looks at it.
 *
 * An invoice checks itself: each line's quantity times rate is its amount,
 * the lines add up to the goods value, goods plus freight is the taxable
 * value, and that plus tax and round-off is the total. A GSTIN carries a check
 * character, and an e-way bill is twelve digits. When the extractor's answer
 * breaks one of these, it misread something - and saying exactly what to the
 * model, once, fixes it more often than not.
 *
 * From the October 2026 run on ten new suppliers: RNG's stacked qty cells slid
 * one row (line 4 read as 1 x 51.20 = 2,252.80), and AK Trading's quantities
 * were 2,381.44 for 2,381.40 - both visible as a line that does not multiply
 * out; three invoices gave the taxable value as the goods subtotal; six of ten
 * supplier GSTINs failed their check character.
 */

import { isValidGstin, cleanGstin } from '../../lib/gstin.js';

/** Rupees of slack, as check INV006 allows. */
const TOLERANCE = 1;

/**
 * A printed amount as a number: separators, currency, "/-", a trailing unit,
 * a bracketed second figure, and signs written "(-)" or "Less".
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let t = String(value).trim();
  const negative = /^\(-\)|^-|^less\b/i.test(t) || /\(-\)/.test(t);
  t = t.replace(/\[[^\]]*\]/g, ' ')          // "11830.000 [169.000]" -> the first figure
    .replace(/\(\s*[+-]\s*\)/g, ' ')
    .replace(/^less\b/i, ' ')
    .replace(/₹|rs\.?|inr/gi, ' ')
    .replace(/\/-\s*$/, ' ');
  const m = t.match(/-?\d[\d,]*(?:\.\d+)?|-?\.\d+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => r2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/**
 * Every problem the answer shows on its own face.
 * @returns {Array<{kind: string, field: string, lineNo?: number, message: string}>}
 */
export function invoiceProblems(x = {}) {
  const problems = [];
  const lines = Array.isArray(x.lines) ? x.lines : [];

  let sum = 0;
  let summed = 0;
  for (const l of lines) {
    const q = toNumber(l.qty);
    const r = toNumber(l.rate);
    const a = toNumber(l.amount);
    if (a !== null) { sum += a; summed += 1; }
    if (q !== null && r !== null && a !== null && Math.abs(q * r - a) > TOLERANCE) {
      problems.push({
        kind: 'LINE_ARITHMETIC', field: `lines.${l.lineNo}`, lineNo: l.lineNo,
        message: `Line ${l.lineNo}: quantity ${l.qty} x rate ${l.rate} = ${fmt(q * r)}, but you gave the amount as ${l.amount}. `
          + 'One of the three was misread - read that row again, column by column.',
      });
    }
    if (a !== null && q === null && r === null) {
      problems.push({
        kind: 'LINE_WITHOUT_QTY', field: `lines.${l.lineNo}`, lineNo: l.lineNo,
        message: `Line ${l.lineNo} ("${l.description ?? ''}") has an amount but no quantity and no rate. If it is a charge `
          + '(delivery, freight, transport, packing), it is not a goods line: leave it out of "lines" and put it in "freight".',
      });
    }
  }

  const subTotal = toNumber(x.subTotal);
  const freight = toNumber(x.freight) ?? 0;
  const taxable = toNumber(x.taxable);
  const tax = (toNumber(x.cgst) ?? 0) + (toNumber(x.sgst) ?? 0) + (toNumber(x.igst) ?? 0);
  const roundOff = toNumber(x.roundOff) ?? 0;
  const grandTotal = toNumber(x.grandTotal);

  if (summed && subTotal !== null && Math.abs(sum - subTotal) > TOLERANCE) {
    problems.push({
      kind: 'SUBTOTAL', field: 'subTotal',
      message: `The line amounts add up to ${fmt(sum)}, but you gave subTotal as ${x.subTotal}. "subTotal" is the value of the `
        + 'goods lines only - before freight, other charges and tax. If the figure you gave includes freight, it is the taxable '
        + 'value: put it in "taxable" instead. If a goods line is missing or misread, read the table again.',
    });
  }
  if (subTotal !== null && taxable !== null && Math.abs(subTotal + freight - taxable) > TOLERANCE) {
    problems.push({
      kind: 'TAXABLE', field: 'taxable',
      message: `subTotal ${x.subTotal} + freight ${x.freight ?? 0} = ${fmt(subTotal + freight)}, but you gave taxable as ${x.taxable}.`,
    });
  }
  const base = taxable ?? (subTotal !== null ? subTotal + freight : null);
  if (base !== null && grandTotal !== null && Math.abs(base + tax + roundOff - grandTotal) > TOLERANCE) {
    problems.push({
      kind: 'GRAND_TOTAL', field: 'grandTotal',
      message: `taxable ${fmt(base)} + tax ${fmt(tax)} + round-off ${fmt(roundOff)} = ${fmt(base + tax + roundOff)}, but you gave `
        + `grandTotal as ${x.grandTotal}. Check the tax figures, the tax type (CGST + SGST, or IGST) and the round-off, `
        + 'including its sign. If the total is on a later page, read it there.',
    });
  }

  for (const field of ['supplierGstin', 'shipToGstin']) {
    const g = cleanGstin(x[field]);
    if (g && !isValidGstin(g)) {
      problems.push({
        kind: 'GSTIN', field,
        message: `${field} "${x[field]}" fails the GSTIN check character, so at least one character was misread. A GSTIN is `
          + '2 digits, 5 letters, 4 digits, a letter, a letter or digit, "Z", and a check character. Read it again character by '
          + 'character - 0 and O, 1 and I, 5 and S, 8 and B are the usual mistakes. If you cannot read it, return null.',
      });
    }
  }

  const eway = String(x.eWayBillNo ?? '').replace(/[\s-]/g, '');
  if (eway && !/^\d{12}$/.test(eway)) {
    problems.push({
      kind: 'EWAY_BILL', field: 'eWayBillNo',
      message: `eWayBillNo "${x.eWayBillNo}" is not twelve digits; an e-way bill number always is. Read it again, or return null.`,
    });
  }

  return problems;
}

/** The second request: what was wrong, and the first answer to correct. */
export function retryInstruction(first, problems) {
  return [
    'You have already read this invoice once. Your answer is below, and it has these problems:',
    ...problems.map((p, i) => `${i + 1}. ${p.message}`),
    '',
    'Look at the images again and return the whole invoice corrected, in the same JSON shape. Keep every value you are sure '
      + 'of; change only what the images show was misread. Do not make the numbers agree by guessing - read them.',
    '',
    'Your first answer:',
    JSON.stringify(first),
  ].join('\n');
}
