/**
 * Dedup identity for purchase bills.
 *
 * A bill is a duplicate when the same supplier sent the same invoice number
 * in the same financial year. The invoice number is compared ignoring
 * punctuation, spaces and leading zeros, so INV/001, INV-001 and INV 1 match.
 *
 * Base (supplier + invoice, any year):
 *   GSTIN present → `{GSTIN}_{INVOICE}`
 *   GSTIN missing, PAN present → `P:{PAN}_{INVOICE}`
 *   both missing, or no invoice → null  (unhandled case — fail in review)
 * Key (unique): `{BASE}_{FY}`, e.g. `19AAACX1234A1Z5_INV-1_2026-27`, or
 *   `{BASE}_NOFY` when the invoice date is unknown. A bill without a date is
 *   checked against every year.
 */
import { CDC_CONFIG, isCdcGstin, panFromGstin } from '../config/cdc.js';

const PAN_RE = /[A-Z]{5}[0-9]{4}[A-Z]/;
const PAN_EXACT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

function compactAlnum(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function stripPanLabels(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/PERMANENT\s*ACCOUNT\s*(NUMBER|NO\.?)?/g, ' ')
    .replace(/PAN\s*\/\s*IT(\s*NO\.?)?/g, ' ')
    .replace(/\bPAN(\s*(NO|NUMBER|#))?/g, ' ')
    .replace(/[:.\-_/]/g, ' ');
}

function isCdcPan(pan) {
  return pan === String(CDC_CONFIG.pan || '').toUpperCase();
}

/**
 * All reasonable PAN shapes → 10-char PAN, or null.
 * Rejects CDC's own PAN so header/buyer PAN is never used as supplier identity.
 */
export function normalizePan(raw) {
  if (raw == null || raw === '') return null;
  const labelled = stripPanLabels(raw);
  const compact = compactAlnum(labelled) || compactAlnum(raw);

  if (GSTIN_RE.test(compact) || (compact.length === 15 && /^[0-9]{2}/.test(compact))) {
    const fromGstin = panFromGstin(compact);
    if (fromGstin && PAN_EXACT.test(fromGstin) && !isCdcPan(fromGstin)) return fromGstin;
  }

  if (PAN_EXACT.test(compact) && !isCdcPan(compact)) return compact;

  const matches = compact.match(new RegExp(PAN_RE, 'g')) || [];
  for (const m of matches) {
    if (!isCdcPan(m)) return m;
  }
  return null;
}

export function normalizeGstin(raw) {
  if (raw == null || raw === '') return null;
  const compact = compactAlnum(raw);
  if (!compact) return null;
  if (isCdcGstin(compact)) return null;
  if (GSTIN_RE.test(compact)) return compact;
  if (compact.length === 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}/.test(compact)) return compact;
  return null;
}

export function normalizeInvoiceNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  return s || null;
}

export function supplierPanFromFields({ supplier_gstin, supplier_pan } = {}) {
  const gstin = normalizeGstin(supplier_gstin);
  return normalizePan(supplier_pan) || (gstin ? normalizePan(panFromGstin(gstin)) : null);
}

/**
 * Invoice number as compared for duplicates: letter and digit runs only,
 * leading zeros dropped from each number. `SA/0009/26-27` → `SA-9-26-27`.
 */
export function dedupInvoiceNumber(raw) {
  const runs = String(raw ?? '').toUpperCase().match(/[A-Z]+|[0-9]+/g) || [];
  if (runs.length === 0) return null;
  return runs.map((r) => (/^[0-9]/.test(r) ? r.replace(/^0+(?=.)/, '') : r)).join('-');
}

/** Indian financial year (April–March) of a date, as `2026-27`; null if unknown. */
export function financialYear(date) {
  if (date == null || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const NO_FY = 'NOFY';

/**
 * Supplier + invoice identities, any year: the GSTIN one and the PAN one, so a
 * GSTIN bill still matches an earlier URP/PAN bill. First entry is primary.
 */
export function listDedupBases({ supplier_gstin, supplier_pan, invoice_number } = {}) {
  const invoice = dedupInvoiceNumber(invoice_number);
  if (!invoice) return [];
  const gstin = normalizeGstin(supplier_gstin);
  const pan = supplierPanFromFields({ supplier_gstin, supplier_pan });
  const bases = [];
  if (gstin) bases.push(`${gstin}_${invoice}`);
  if (pan) bases.push(`P:${pan}_${invoice}`);
  return bases;
}

/** Primary supplier + invoice identity (any year), or null. */
export function buildBillDedupBase(fields = {}) {
  return listDedupBases(fields)[0] || null;
}

/**
 * Primary unique key (supplier + invoice + financial year), or null when GSTIN
 * and PAN are both missing (or invoice is).
 */
export function buildBillDedupKey(fields = {}) {
  const base = buildBillDedupBase(fields);
  return base ? `${base}_${financialYear(fields.invoice_date) || NO_FY}` : null;
}

/**
 * Keys an earlier bill could hold if it is the same supplier + invoice + year:
 * same year, or a bill whose year was unknown. Empty when this bill's own year
 * is unknown — then every year counts (match on bases instead).
 */
export function listSameYearDedupKeys(fields = {}) {
  const fy = financialYear(fields.invoice_date);
  if (!fy) return [];
  return listDedupBases(fields).flatMap((b) => [`${b}_${fy}`, `${b}_${NO_FY}`]);
}
