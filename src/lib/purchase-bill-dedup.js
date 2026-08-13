/**
 * Dedup identity for purchase bills.
 *
 * Key format:
 *   GSTIN present → `{GSTIN}_{INVOICE}`  (unchanged, matches existing rows)
 *   GSTIN missing, PAN present → `P:{PAN}_{INVOICE}`
 *   both missing, or no invoice → null  (unhandled case — fail in review)
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
 * Primary unique key, or null when GSTIN and PAN are both missing (or invoice is).
 */
export function buildBillDedupKey({ supplier_gstin, supplier_pan, invoice_number } = {}) {
  const invoice = normalizeInvoiceNumber(invoice_number);
  if (!invoice) return null;

  const gstin = normalizeGstin(supplier_gstin);
  if (gstin) return `${gstin}_${invoice}`;

  const pan = supplierPanFromFields({ supplier_gstin, supplier_pan });
  if (pan) return `P:${pan}_${invoice}`;

  return null;
}

/**
 * All keys that could represent the same supplier+invoice (GSTIN bill vs earlier URP/PAN bill).
 */
export function listDedupKeys({ supplier_gstin, supplier_pan, invoice_number, bill_dedup_key } = {}) {
  const invoice = normalizeInvoiceNumber(invoice_number);
  const gstin = normalizeGstin(supplier_gstin);
  const pan = supplierPanFromFields({ supplier_gstin, supplier_pan });
  const keys = new Set();
  if (bill_dedup_key) keys.add(String(bill_dedup_key).trim());
  if (gstin && invoice) keys.add(`${gstin}_${invoice}`);
  if (pan && invoice) keys.add(`P:${pan}_${invoice}`);
  return [...keys].filter(Boolean);
}
