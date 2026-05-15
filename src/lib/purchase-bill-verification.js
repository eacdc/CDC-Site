/**
 * Verification engine for CDC purchase bills.
 *
 * `runVerificationChecks(bill, dbHelpers)` returns an array of CheckResult
 * objects, one per check (50 total). The order roughly follows the
 * categories in the spec. Checks #46–#49 are async (need DB lookups);
 * everything else is a pure function of the bill record.
 *
 * `computeVerificationStatus(results)` reduces the results to a single
 * `{ status, blocking, warning }` tuple used for the bill's overall
 * verification_status.
 */

import { CDC_CONFIG, TOLERANCES, EWAY_THRESHOLDS, isCdcGstin, panFromGstin } from '../config/cdc.js';
import { hammingDistance } from './phash.js';

const PASS = 'pass';
const FAIL = 'fail';
const SKIP = 'skipped';

const BLOCKING = 'blocking';
const WARNING = 'warning';
const INFO = 'informational';

// ---------- small utilities ----------

function close(a, b, tol) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tol;
}

function normStr(s) {
  return (s ?? '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

function bothPresent(...vals) {
  return vals.every(v => v !== null && v !== undefined && v !== '');
}

function isNullish(v) {
  return v === null || v === undefined || v === '';
}

function dateOnly(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function sameDay(a, b) {
  const da = dateOnly(a), db = dateOnly(b);
  if (!da || !db) return false;
  return da.getTime() === db.getTime();
}

function daysBetween(later, earlier) {
  const da = dateOnly(later), db = dateOnly(earlier);
  if (!da || !db) return null;
  return Math.round((da.getTime() - db.getTime()) / 86_400_000);
}

/**
 * Jaccard token similarity on whitespace-split tokens of a normalized
 * name. Quick & cheap; good enough for "Annapurna Polythene Bags" vs
 * "Annapurna Polythene Bags Pvt Ltd".
 */
function fuzzyNameSim(a, b) {
  if (!a || !b) return 0;
  const tokensOf = s => new Set(
    String(s).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(t => t && t.length > 1),
  );
  const sa = tokensOf(a);
  const sb = tokensOf(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / new Set([...sa, ...sb]).size;
}

function mk(check_id, category, level, status, message, expected, actual) {
  const r = { check_id, category, level, status, message };
  if (expected !== undefined) r.expected = expected;
  if (actual !== undefined) r.actual = actual;
  return r;
}

// ---------- main entry ----------

/**
 * @param {object} bill                Bill document (slot fields aggregated, plus canonical fields)
 * @param {object} dbHelpers           injected DB helpers for async checks
 *   - findExistingByDedupKey(key, excludeId) => Promise<bill|null>
 *   - findByTallyVoucher(no, excludeId)      => Promise<bill|null>
 *   - findByImageHashCandidates(phash, excludeId) => Promise<bill[]> (coarse candidates to compare)
 *   - findSimilarBills(gstin, date, amount, tolerance, daysBack, excludeId) => Promise<bill[]>
 */
export async function runVerificationChecks(bill, dbHelpers = {}) {
  const results = [];

  const voucher = bill.slots?.tally_voucher?.aggregated_fields ?? {};
  const invoice = bill.slots?.supplier_invoice?.aggregated_fields ?? {};
  const eway = bill.slots?.eway_bill?.aggregated_fields ?? {};
  const grn = bill.slots?.grn_sheet?.aggregated_fields ?? {};

  const isGrnType = bill.set_type === 'grn';
  const hasEway = (bill.slots?.eway_bill?.pages?.length ?? 0) > 0;
  const hasGrn = (bill.slots?.grn_sheet?.pages?.length ?? 0) > 0;
  const hasVoucher = (bill.slots?.tally_voucher?.pages?.length ?? 0) > 0;
  const hasInvoice = (bill.slots?.supplier_invoice?.pages?.length ?? 0) > 0;

  // ================================================================
  // SET INTEGRITY (Blocking, checks #1–#7)
  // ================================================================
  results.push(mk(
    'SET_TALLY_VOUCHER_PRESENT', 'set_integrity', BLOCKING,
    hasVoucher ? PASS : FAIL,
    hasVoucher ? 'Tally voucher slot has at least one page.' : 'Tally voucher slot is empty.',
  ));
  results.push(mk(
    'SET_INVOICE_PRESENT', 'set_integrity', BLOCKING,
    hasInvoice ? PASS : FAIL,
    hasInvoice ? 'Supplier invoice slot has at least one page.' : 'Supplier invoice slot is empty.',
  ));
  results.push(mk(
    'SET_GRN_PRESENT_IF_GRN_TYPE', 'set_integrity', BLOCKING,
    !isGrnType ? SKIP : (hasGrn ? PASS : FAIL),
    !isGrnType
      ? 'Set type is non-GRN; no GRN sheet expected.'
      : (hasGrn ? 'GRN slot has at least one page.' : 'GRN slot is empty but set type is GRN.'),
  ));

  // Classification checks rely on `classification_passed` flag set by the
  // vision adapter (was the `is_<slot>_*` boolean true for at least one
  // page in the slot?).
  const classifiedAny = (slot) => (bill.slots?.[slot]?.pages ?? []).some(p => p.classification_passed === true);
  results.push(mk(
    'SET_TALLY_VOUCHER_CLASSIFIED', 'set_integrity', BLOCKING,
    !hasVoucher ? SKIP : (classifiedAny('tally_voucher') ? PASS : FAIL),
    !hasVoucher
      ? 'No tally voucher pages to classify.'
      : (classifiedAny('tally_voucher')
          ? 'At least one page classified as a Tally voucher.'
          : 'No page in the Tally voucher slot was classified as a Tally voucher.'),
  ));
  results.push(mk(
    'SET_INVOICE_CLASSIFIED', 'set_integrity', BLOCKING,
    !hasInvoice ? SKIP : (classifiedAny('supplier_invoice') ? PASS : FAIL),
    !hasInvoice
      ? 'No supplier invoice pages to classify.'
      : (classifiedAny('supplier_invoice')
          ? 'At least one page classified as a supplier invoice.'
          : 'No page in the supplier invoice slot was classified as an invoice.'),
  ));
  results.push(mk(
    'SET_GRN_CLASSIFIED_IF_PRESENT', 'set_integrity', BLOCKING,
    !hasGrn ? SKIP : (classifiedAny('grn_sheet') ? PASS : FAIL),
    !hasGrn
      ? 'No GRN pages to classify.'
      : (classifiedAny('grn_sheet')
          ? 'At least one page classified as a GRN sheet.'
          : 'No page in the GRN slot was classified as a GRN sheet.'),
  ));
  results.push(mk(
    'SET_EWAY_CLASSIFIED_IF_PRESENT', 'set_integrity', BLOCKING,
    !hasEway ? SKIP : (classifiedAny('eway_bill') ? PASS : FAIL),
    !hasEway
      ? 'No e-way bill pages to classify.'
      : (classifiedAny('eway_bill')
          ? 'At least one page classified as an e-way bill.'
          : 'No page in the e-way slot was classified as an e-way bill.'),
  ));

  // ================================================================
  // E-WAY REQUIREMENT (Warning, #8–#9)
  // ================================================================
  const grandTotal = bill.grand_total ?? invoice.grand_total ?? 0;
  const supplierState = (invoice.supplier_state || '').toString();
  const isInterState = supplierState && supplierState.toLowerCase() !== CDC_CONFIG.state.toLowerCase();
  const isIntraState = supplierState && supplierState.toLowerCase() === CDC_CONFIG.state.toLowerCase();

  if (isInterState && grandTotal > EWAY_THRESHOLDS.interstate) {
    results.push(mk(
      'EWAY_REQUIRED_INTERSTATE', 'eway_requirement', WARNING,
      hasEway ? PASS : FAIL,
      hasEway
        ? `Inter-state bill of ₹${grandTotal} has the required e-way bill.`
        : `Inter-state bill of ₹${grandTotal} exceeds ₹${EWAY_THRESHOLDS.interstate} but no e-way bill uploaded.`,
      `e-way bill required`,
      hasEway ? 'present' : 'missing',
    ));
  } else {
    results.push(mk('EWAY_REQUIRED_INTERSTATE', 'eway_requirement', WARNING, SKIP,
      'Not an inter-state bill above ₹50,000.'));
  }

  if (isIntraState && grandTotal > EWAY_THRESHOLDS.intrastate) {
    results.push(mk(
      'EWAY_REQUIRED_INTRASTATE', 'eway_requirement', WARNING,
      hasEway ? PASS : FAIL,
      hasEway
        ? `Intra-state bill of ₹${grandTotal} has an e-way bill.`
        : `Intra-state goods bill of ₹${grandTotal} exceeds ₹${EWAY_THRESHOLDS.intrastate} but no e-way bill. Service bills are exempt — dismiss if applicable.`,
    ));
  } else {
    results.push(mk('EWAY_REQUIRED_INTRASTATE', 'eway_requirement', WARNING, SKIP,
      'Not an intra-state bill above ₹1,00,000.'));
  }

  // ================================================================
  // BILL NUMBER CROSS-CHECK (#10–#12)
  // ================================================================
  results.push(crossField(
    'BILL_NO_VOUCHER_VS_INVOICE', 'bill_number', BLOCKING,
    voucher.ref_bill_number, invoice.invoice_number,
    'Tally voucher Ref bill number matches supplier invoice number.',
  ));
  results.push(crossField(
    'BILL_NO_GRN_VS_INVOICE', 'bill_number', isGrnType ? BLOCKING : WARNING,
    grn.bill_number, invoice.invoice_number,
    'GRN bill number matches supplier invoice number.',
    !hasGrn,
  ));
  results.push(crossField(
    'BILL_NO_EWAY_VS_INVOICE', 'bill_number', WARNING,
    eway.document_number, invoice.invoice_number,
    'E-way bill document number matches supplier invoice number.',
    !hasEway,
  ));

  // ================================================================
  // BILL DATE CROSS-CHECK (#13–#17)
  // ================================================================
  results.push(crossDate(
    'BILL_DATE_VOUCHER_VS_INVOICE', 'bill_date', BLOCKING,
    voucher.ref_bill_date, invoice.invoice_date,
    'Tally voucher Ref bill date matches supplier invoice date.',
  ));
  results.push(crossDate(
    'BILL_DATE_GRN_VS_INVOICE', 'bill_date', WARNING,
    grn.bill_date, invoice.invoice_date,
    'GRN bill date matches supplier invoice date.',
    !hasGrn,
  ));
  results.push(crossDate(
    'BILL_DATE_EWAY_VS_INVOICE', 'bill_date', WARNING,
    eway.document_date, invoice.invoice_date,
    'E-way document date matches supplier invoice date.',
    !hasEway,
  ));

  // voucher_date >= bill_date
  {
    const vd = dateOnly(voucher.voucher_date);
    const bd = dateOnly(invoice.invoice_date);
    if (!vd || !bd) {
      results.push(mk('VOUCHER_DATE_AFTER_BILL_DATE', 'bill_date', WARNING, SKIP,
        'Voucher date or invoice date missing.'));
    } else if (vd.getTime() >= bd.getTime()) {
      results.push(mk('VOUCHER_DATE_AFTER_BILL_DATE', 'bill_date', WARNING, PASS,
        'Tally voucher date is on or after the bill date.'));
    } else {
      results.push(mk('VOUCHER_DATE_AFTER_BILL_DATE', 'bill_date', WARNING, FAIL,
        `Voucher date (${vd.toISOString().slice(0,10)}) is before bill date (${bd.toISOString().slice(0,10)}).`,
        '>= bill date', vd.toISOString().slice(0,10)));
    }
  }

  // voucher_date - bill_date <= 60 days
  {
    const gap = daysBetween(voucher.voucher_date, invoice.invoice_date);
    if (gap === null) {
      results.push(mk('VOUCHER_DATE_GAP_REASONABLE', 'bill_date', WARNING, SKIP,
        'Voucher date or invoice date missing.'));
    } else if (gap <= TOLERANCES.date_gap_max_days) {
      results.push(mk('VOUCHER_DATE_GAP_REASONABLE', 'bill_date', WARNING, PASS,
        `Voucher posted ${gap} day(s) after the bill — within ${TOLERANCES.date_gap_max_days}-day limit.`));
    } else {
      results.push(mk('VOUCHER_DATE_GAP_REASONABLE', 'bill_date', WARNING, FAIL,
        `Voucher posted ${gap} days after the bill — exceeds ${TOLERANCES.date_gap_max_days}-day limit.`,
        `<= ${TOLERANCES.date_gap_max_days} days`, `${gap} days`));
    }
  }

  // ================================================================
  // SUPPLIER IDENTITY (#18–#22)
  // ================================================================
  results.push(crossField(
    'SUPPLIER_GSTIN_VOUCHER_VS_INVOICE', 'supplier_identity', BLOCKING,
    voucher.supplier_gstin, invoice.supplier_gstin,
    'Tally voucher supplier GSTIN matches invoice supplier GSTIN.',
  ));
  results.push(crossField(
    'SUPPLIER_GSTIN_GRN_VS_INVOICE', 'supplier_identity', isGrnType ? BLOCKING : WARNING,
    grn.supplier_gstin, invoice.supplier_gstin,
    'GRN supplier GSTIN matches invoice supplier GSTIN.',
    !hasGrn,
  ));
  results.push(crossField(
    'SUPPLIER_GSTIN_EWAY_VS_INVOICE', 'supplier_identity', WARNING,
    eway.generated_by_gstin || eway.supplier_gstin, invoice.supplier_gstin,
    'E-way generated-by GSTIN matches invoice supplier GSTIN.',
    !hasEway,
  ));

  // Fuzzy name match — only on supplier name where Tally tends to abbreviate.
  {
    const sim = fuzzyNameSim(voucher.supplier_name, invoice.supplier_name);
    if (!voucher.supplier_name || !invoice.supplier_name) {
      results.push(mk('SUPPLIER_NAME_VOUCHER_VS_INVOICE', 'supplier_identity', WARNING, SKIP,
        'Supplier name missing on voucher or invoice.'));
    } else if (sim >= TOLERANCES.fuzzy_supplier_name) {
      results.push(mk('SUPPLIER_NAME_VOUCHER_VS_INVOICE', 'supplier_identity', WARNING, PASS,
        `Supplier names match (similarity ${sim.toFixed(2)}).`));
    } else {
      results.push(mk('SUPPLIER_NAME_VOUCHER_VS_INVOICE', 'supplier_identity', WARNING, FAIL,
        `Supplier names differ (similarity ${sim.toFixed(2)} < ${TOLERANCES.fuzzy_supplier_name}).`,
        invoice.supplier_name, voucher.supplier_name));
    }
  }

  // PAN derived from GSTIN
  {
    const derived = panFromGstin(invoice.supplier_gstin || voucher.supplier_gstin);
    const stated = (invoice.supplier_pan || voucher.supplier_pan || '').toString().toUpperCase().trim();
    if (!derived || !stated) {
      results.push(mk('SUPPLIER_PAN_DERIVED_FROM_GSTIN', 'supplier_identity', WARNING, SKIP,
        'GSTIN or PAN missing for supplier.'));
    } else if (derived === stated) {
      results.push(mk('SUPPLIER_PAN_DERIVED_FROM_GSTIN', 'supplier_identity', WARNING, PASS,
        `Supplier PAN (${stated}) is consistent with GSTIN.`));
    } else {
      results.push(mk('SUPPLIER_PAN_DERIVED_FROM_GSTIN', 'supplier_identity', WARNING, FAIL,
        `Stated supplier PAN ${stated} does not match PAN ${derived} derived from GSTIN.`,
        derived, stated));
    }
  }

  // ================================================================
  // BUYER IDENTITY (CDC) (#23–#26)
  // ================================================================
  {
    const buyerGstin = (invoice.buyer_gstin || '').toString();
    if (!buyerGstin) {
      results.push(mk('BUYER_GSTIN_IS_CDC', 'buyer_identity', BLOCKING, FAIL,
        'Buyer GSTIN not found on invoice — cannot verify this bill is for CDC.'));
    } else if (isCdcGstin(buyerGstin)) {
      results.push(mk('BUYER_GSTIN_IS_CDC', 'buyer_identity', BLOCKING, PASS,
        `Invoice is addressed to CDC (${buyerGstin}).`));
    } else {
      results.push(mk('BUYER_GSTIN_IS_CDC', 'buyer_identity', BLOCKING, FAIL,
        `Invoice buyer GSTIN ${buyerGstin} is not a known CDC GSTIN.`,
        CDC_CONFIG.gstins.join(', '), buyerGstin));
    }
  }

  // Derived buyer PAN
  {
    const derived = panFromGstin(invoice.buyer_gstin);
    if (!derived) {
      results.push(mk('BUYER_PAN_IS_CDC', 'buyer_identity', BLOCKING, FAIL,
        'Buyer GSTIN not found — cannot derive PAN.'));
    } else if (derived === CDC_CONFIG.pan) {
      results.push(mk('BUYER_PAN_IS_CDC', 'buyer_identity', BLOCKING, PASS,
        `Derived buyer PAN ${derived} matches CDC PAN.`));
    } else {
      results.push(mk('BUYER_PAN_IS_CDC', 'buyer_identity', BLOCKING, FAIL,
        `Derived buyer PAN ${derived} does not match CDC PAN ${CDC_CONFIG.pan}.`,
        CDC_CONFIG.pan, derived));
    }
  }

  {
    const sim = fuzzyNameSim(invoice.buyer_name, CDC_CONFIG.legal_name);
    if (!invoice.buyer_name) {
      results.push(mk('BUYER_NAME_IS_CDC', 'buyer_identity', WARNING, SKIP,
        'Buyer name missing on invoice.'));
    } else if (sim >= TOLERANCES.fuzzy_buyer_name) {
      results.push(mk('BUYER_NAME_IS_CDC', 'buyer_identity', WARNING, PASS,
        `Buyer name matches CDC (similarity ${sim.toFixed(2)}).`));
    } else {
      results.push(mk('BUYER_NAME_IS_CDC', 'buyer_identity', WARNING, FAIL,
        `Buyer name "${invoice.buyer_name}" doesn't match "${CDC_CONFIG.legal_name}" (similarity ${sim.toFixed(2)}).`,
        CDC_CONFIG.legal_name, invoice.buyer_name));
    }
  }

  results.push(crossField(
    'BUYER_GSTIN_VOUCHER_VS_INVOICE', 'buyer_identity', WARNING,
    voucher.buyer_gstin, invoice.buyer_gstin,
    'Tally voucher buyer GSTIN matches invoice buyer GSTIN.',
  ));

  // ================================================================
  // CDC UNIT (#27–#28)
  // ================================================================
  {
    const u = bill.cdc_unit || voucher.cdc_unit || grn.cdc_unit;
    if (u) {
      results.push(mk('CDC_UNIT_EXTRACTABLE', 'cdc_unit', WARNING, PASS,
        `CDC unit extracted: ${u}`));
    } else {
      results.push(mk('CDC_UNIT_EXTRACTABLE', 'cdc_unit', WARNING, FAIL,
        'CDC unit could not be extracted from voucher or GRN.'));
    }
  }
  {
    if (!isGrnType || !hasGrn) {
      results.push(mk('CDC_UNIT_CONSISTENT_VOUCHER_GRN', 'cdc_unit', WARNING, SKIP,
        'GRN not present; skipping unit consistency check.'));
    } else {
      const a = normUnit(voucher.cdc_unit);
      const b = normUnit(grn.cdc_unit);
      if (!a || !b) {
        results.push(mk('CDC_UNIT_CONSISTENT_VOUCHER_GRN', 'cdc_unit', WARNING, SKIP,
          'CDC unit missing on voucher or GRN.'));
      } else if (a === b) {
        results.push(mk('CDC_UNIT_CONSISTENT_VOUCHER_GRN', 'cdc_unit', WARNING, PASS,
          `Voucher and GRN both reference ${voucher.cdc_unit}.`));
      } else {
        results.push(mk('CDC_UNIT_CONSISTENT_VOUCHER_GRN', 'cdc_unit', WARNING, FAIL,
          `Voucher unit "${voucher.cdc_unit}" differs from GRN unit "${grn.cdc_unit}".`,
          voucher.cdc_unit, grn.cdc_unit));
      }
    }
  }

  // ================================================================
  // AMOUNT CROSS-CHECK (#29–#38)
  // ================================================================
  results.push(crossAmount(
    'GRAND_TOTAL_VOUCHER_VS_INVOICE', 'amounts', BLOCKING,
    voucher.grand_total, invoice.grand_total, TOLERANCES.amount,
    'Tally voucher grand total matches invoice grand total',
  ));
  results.push(crossAmount(
    'GRAND_TOTAL_GRN_VS_INVOICE', 'amounts', isGrnType ? BLOCKING : WARNING,
    grn.grand_total, invoice.grand_total, TOLERANCES.amount,
    'GRN grand total matches invoice grand total',
    !hasGrn,
  ));

  // E-way often shows pre-tax value; fall back to invoice.taxable_value.
  {
    if (!hasEway) {
      results.push(mk('GRAND_TOTAL_EWAY_VS_INVOICE', 'amounts', WARNING, SKIP,
        'No e-way bill present.'));
    } else {
      const ev = eway.value_of_goods;
      const ig = invoice.grand_total;
      const it = invoice.taxable_value;
      if (isNullish(ev) || (isNullish(ig) && isNullish(it))) {
        results.push(mk('GRAND_TOTAL_EWAY_VS_INVOICE', 'amounts', WARNING, SKIP,
          'E-way value or invoice totals missing.'));
      } else if (close(ev, ig, TOLERANCES.amount) || close(ev, it, TOLERANCES.amount)) {
        results.push(mk('GRAND_TOTAL_EWAY_VS_INVOICE', 'amounts', WARNING, PASS,
          `E-way value ₹${ev} matches invoice grand total or taxable value (±₹${TOLERANCES.amount}).`));
      } else {
        results.push(mk('GRAND_TOTAL_EWAY_VS_INVOICE', 'amounts', WARNING, FAIL,
          `E-way value ₹${ev} doesn't match invoice grand total ₹${ig} or taxable ₹${it}.`,
          `±${TOLERANCES.amount}`, ev));
      }
    }
  }

  results.push(crossAmount(
    'TAXABLE_VALUE_VOUCHER_VS_INVOICE', 'amounts', WARNING,
    voucher.taxable_value, invoice.taxable_value, TOLERANCES.amount,
    'Tally voucher taxable value matches invoice taxable value',
  ));
  results.push(crossAmount(
    'CGST_VOUCHER_VS_INVOICE', 'amounts', WARNING,
    voucher.cgst, invoice.cgst_amount, TOLERANCES.tax_amount,
    'CGST matches between voucher and invoice',
  ));
  results.push(crossAmount(
    'SGST_VOUCHER_VS_INVOICE', 'amounts', WARNING,
    voucher.sgst, invoice.sgst_amount, TOLERANCES.tax_amount,
    'SGST matches between voucher and invoice',
  ));
  results.push(crossAmount(
    'IGST_VOUCHER_VS_INVOICE', 'amounts', WARNING,
    voucher.igst, invoice.igst_amount, TOLERANCES.tax_amount,
    'IGST matches between voucher and invoice',
  ));

  // CGST == SGST for intra-state on invoice
  {
    if (bill.tax_type !== 'intra_state') {
      results.push(mk('CGST_EQUALS_SGST_INTRASTATE', 'amounts', WARNING, SKIP,
        'Not an intra-state bill.'));
    } else {
      const c = invoice.cgst_amount;
      const s = invoice.sgst_amount;
      if (isNullish(c) || isNullish(s)) {
        results.push(mk('CGST_EQUALS_SGST_INTRASTATE', 'amounts', WARNING, SKIP,
          'CGST or SGST missing.'));
      } else if (close(c, s, TOLERANCES.tax_amount)) {
        results.push(mk('CGST_EQUALS_SGST_INTRASTATE', 'amounts', WARNING, PASS,
          `CGST ₹${c} ≈ SGST ₹${s}.`));
      } else {
        results.push(mk('CGST_EQUALS_SGST_INTRASTATE', 'amounts', WARNING, FAIL,
          `CGST ₹${c} differs from SGST ₹${s} by more than ₹${TOLERANCES.tax_amount}.`,
          `|cgst-sgst| <= ${TOLERANCES.tax_amount}`, Math.abs((c ?? 0) - (s ?? 0))));
      }
    }
  }

  results.push(crossAmount(
    'ROUND_OFF_REASONABLE', 'amounts', WARNING,
    voucher.round_off, invoice.round_off, TOLERANCES.round_off,
    'Round-off matches between voucher and invoice',
  ));

  // Tax type vs geography
  {
    if (!supplierState) {
      results.push(mk('TAX_TYPE_MATCHES_GEOGRAPHY', 'amounts', WARNING, SKIP,
        'Supplier state missing on invoice.'));
    } else if (isInterState) {
      const igstOk = (invoice.igst_amount ?? 0) > 0
        && (invoice.cgst_amount ?? 0) === 0
        && (invoice.sgst_amount ?? 0) === 0;
      results.push(mk('TAX_TYPE_MATCHES_GEOGRAPHY', 'amounts', WARNING,
        igstOk ? PASS : FAIL,
        igstOk
          ? 'Inter-state bill correctly uses IGST.'
          : 'Inter-state bill should have IGST only (no CGST/SGST).',
        'IGST > 0, CGST = SGST = 0',
        { igst: invoice.igst_amount, cgst: invoice.cgst_amount, sgst: invoice.sgst_amount },
      ));
    } else {
      // intra-state
      const intraOk = ((invoice.cgst_amount ?? 0) > 0 || (invoice.sgst_amount ?? 0) > 0)
        && (invoice.igst_amount ?? 0) === 0;
      results.push(mk('TAX_TYPE_MATCHES_GEOGRAPHY', 'amounts', WARNING,
        intraOk ? PASS : FAIL,
        intraOk
          ? 'Intra-state bill correctly uses CGST + SGST.'
          : 'Intra-state bill should have CGST + SGST (no IGST).',
        'CGST + SGST > 0, IGST = 0',
        { igst: invoice.igst_amount, cgst: invoice.cgst_amount, sgst: invoice.sgst_amount },
      ));
    }
  }

  // ================================================================
  // GST COMPLIANCE (#39–#41)
  // ================================================================
  {
    const dt = (invoice.document_type || '').toLowerCase();
    if (!dt) {
      results.push(mk('DOCUMENT_IS_TAX_INVOICE', 'gst_compliance', WARNING, SKIP,
        'Document type not identified.'));
    } else if (dt === 'tax_invoice') {
      results.push(mk('DOCUMENT_IS_TAX_INVOICE', 'gst_compliance', WARNING, PASS,
        'Document is a tax invoice.'));
    } else {
      results.push(mk('DOCUMENT_IS_TAX_INVOICE', 'gst_compliance', WARNING, FAIL,
        `Document is "${dt}" — Input Tax Credit may not be claimable.`,
        'tax_invoice', dt));
    }
  }
  {
    const hsn = Array.isArray(invoice.hsn_codes) ? invoice.hsn_codes.filter(Boolean) : [];
    if (hsn.length > 0) {
      results.push(mk('HSN_CODE_PRESENT', 'gst_compliance', INFO, PASS,
        `${hsn.length} HSN code(s) found.`));
    } else {
      results.push(mk('HSN_CODE_PRESENT', 'gst_compliance', INFO, FAIL,
        'No HSN code found on invoice.'));
    }
  }
  {
    const rc = invoice.is_reverse_charge === true;
    results.push(mk('NOT_REVERSE_CHARGE', 'gst_compliance', INFO,
      rc ? FAIL : PASS,
      rc ? 'Bill marked as reverse charge — verify ITC handling.' : 'Standard (non-reverse-charge) bill.'));
  }

  // ================================================================
  // E-WAY VALIDATION (#42–#45)
  // ================================================================
  {
    if (!hasEway) {
      results.push(mk('EWAY_NUMBER_VALID_FORMAT', 'eway', WARNING, SKIP, 'No e-way bill present.'));
      results.push(mk('EWAY_VEHICLE_PRESENT', 'eway', WARNING, SKIP, 'No e-way bill present.'));
      results.push(mk('EWAY_VALID_UNTIL_PRESENT', 'eway', INFO, SKIP, 'No e-way bill present.'));
      results.push(mk('EWAY_RECIPIENT_GSTIN_IS_CDC', 'eway', WARNING, SKIP, 'No e-way bill present.'));
    } else {
      const ewayNum = (eway.eway_bill_number || '').toString().replace(/\s+/g, '');
      results.push(mk('EWAY_NUMBER_VALID_FORMAT', 'eway', WARNING,
        /^\d{12}$/.test(ewayNum) ? PASS : FAIL,
        /^\d{12}$/.test(ewayNum) ? `E-way number ${ewayNum} is 12 digits.` : `E-way number "${ewayNum}" is not 12 digits.`,
        '12-digit number', ewayNum));
      results.push(mk('EWAY_VEHICLE_PRESENT', 'eway', WARNING,
        eway.vehicle_number ? PASS : FAIL,
        eway.vehicle_number ? `Vehicle number recorded: ${eway.vehicle_number}.` : 'Vehicle number missing on e-way bill.'));
      results.push(mk('EWAY_VALID_UNTIL_PRESENT', 'eway', INFO,
        eway.valid_until ? PASS : FAIL,
        eway.valid_until ? `Validity recorded until ${eway.valid_until}.` : 'Validity date missing.'));
      const rg = eway.recipient_gstin;
      if (!rg) {
        results.push(mk('EWAY_RECIPIENT_GSTIN_IS_CDC', 'eway', WARNING, FAIL,
          'E-way recipient GSTIN missing.'));
      } else if (isCdcGstin(rg)) {
        results.push(mk('EWAY_RECIPIENT_GSTIN_IS_CDC', 'eway', WARNING, PASS,
          `E-way recipient GSTIN ${rg} matches CDC.`));
      } else {
        results.push(mk('EWAY_RECIPIENT_GSTIN_IS_CDC', 'eway', WARNING, FAIL,
          `E-way recipient GSTIN ${rg} is not CDC.`, CDC_CONFIG.gstins.join(', '), rg));
      }
    }
  }

  // ================================================================
  // DUPLICATES (async, #46–#49)
  // ================================================================
  const excludeId = bill._id || bill.id || null;

  // #46 — exact (supplier_gstin + invoice_number)
  {
    if (!bill.bill_dedup_key) {
      results.push(mk('DUPLICATE_BILL_NUMBER', 'duplicate', BLOCKING, SKIP,
        'Supplier GSTIN or invoice number missing — cannot dedup.'));
    } else {
      let existing = null;
      try {
        existing = await dbHelpers.findExistingByDedupKey?.(bill.bill_dedup_key, excludeId);
      } catch (err) {
        console.warn('[verify] dedup lookup failed:', err?.message);
      }
      if (existing) {
        results.push(mk('DUPLICATE_BILL_NUMBER', 'duplicate', BLOCKING, FAIL,
          `Bill ${bill.invoice_number} from this supplier already exists (uploaded by ${existing.uploaded_by || 'unknown'} on ${existing.uploaded_at?.toISOString?.().slice(0,10) || 'unknown date'}).`,
          'unique', { existing_bill_id: String(existing._id) }));
      } else {
        results.push(mk('DUPLICATE_BILL_NUMBER', 'duplicate', BLOCKING, PASS,
          'No existing bill found with this supplier GSTIN + invoice number.'));
      }
    }
  }

  // #47 — same tally voucher number
  {
    if (!bill.tally_voucher_number) {
      results.push(mk('DUPLICATE_TALLY_VOUCHER', 'duplicate', BLOCKING, SKIP,
        'Tally voucher number missing — cannot dedup.'));
    } else {
      let existing = null;
      try {
        existing = await dbHelpers.findByTallyVoucher?.(bill.tally_voucher_number, excludeId);
      } catch (err) {
        console.warn('[verify] tally dedup lookup failed:', err?.message);
      }
      if (existing) {
        results.push(mk('DUPLICATE_TALLY_VOUCHER', 'duplicate', BLOCKING, FAIL,
          `Tally voucher ${bill.tally_voucher_number} was already uploaded (bill ${String(existing._id)}).`,
          'unique', { existing_bill_id: String(existing._id) }));
      } else {
        results.push(mk('DUPLICATE_TALLY_VOUCHER', 'duplicate', BLOCKING, PASS,
          'No existing bill found with this Tally voucher number.'));
      }
    }
  }

  // #48 — phash near-match
  {
    const ph = bill.invoice_image_phash;
    if (!ph) {
      results.push(mk('DUPLICATE_IMAGE_HASH', 'duplicate', WARNING, SKIP,
        'No perceptual hash computed (invoice page 1 missing).'));
    } else {
      let candidates = [];
      try {
        candidates = await dbHelpers.findByImageHashCandidates?.(ph, excludeId) || [];
      } catch (err) {
        console.warn('[verify] phash candidate lookup failed:', err?.message);
      }
      const near = candidates.find(c => hammingDistance(c.invoice_image_phash, ph) <= 5);
      if (near) {
        results.push(mk('DUPLICATE_IMAGE_HASH', 'duplicate', WARNING, FAIL,
          `Invoice image is visually similar (≤5 bit difference) to bill ${String(near._id)}.`,
          'no near-match',
          { existing_bill_id: String(near._id), invoice_number: near.invoice_number }));
      } else {
        results.push(mk('DUPLICATE_IMAGE_HASH', 'duplicate', WARNING, PASS,
          'Invoice image hash is unique among recent bills.'));
      }
    }
  }

  // #49 — similar bill (same supplier + same date + amount within ₹10, 90 days back)
  {
    const gstin = bill.supplier_gstin;
    const date = bill.invoice_date;
    const amount = bill.grand_total;
    if (!gstin || !date || isNullish(amount)) {
      results.push(mk('DUPLICATE_SIMILAR_BILL', 'duplicate', WARNING, SKIP,
        'Supplier, date, or amount missing — cannot run similar-bill check.'));
    } else {
      let similar = [];
      try {
        similar = await dbHelpers.findSimilarBills?.(gstin, date, amount, TOLERANCES.amount, 90, excludeId) || [];
      } catch (err) {
        console.warn('[verify] similar bill lookup failed:', err?.message);
      }
      if (similar.length > 0) {
        results.push(mk('DUPLICATE_SIMILAR_BILL', 'duplicate', WARNING, FAIL,
          `Found ${similar.length} bill(s) from this supplier with the same date and amount within ₹${TOLERANCES.amount}. Verify before submitting.`,
          'no similar bill',
          similar.slice(0, 3).map(b => ({
            existing_bill_id: String(b._id),
            invoice_number: b.invoice_number,
            invoice_date: b.invoice_date,
            grand_total: b.grand_total,
          }))));
      } else {
        results.push(mk('DUPLICATE_SIMILAR_BILL', 'duplicate', WARNING, PASS,
          'No similar bills in the last 90 days.'));
      }
    }
  }

  // ================================================================
  // IMAGE QUALITY (#50)
  // ================================================================
  {
    const allPages = [
      ...(bill.slots?.tally_voucher?.pages || []),
      ...(bill.slots?.supplier_invoice?.pages || []),
      ...(bill.slots?.eway_bill?.pages || []),
      ...(bill.slots?.grn_sheet?.pages || []),
    ];
    const poor = allPages.filter(p => p?.extracted_fields?.page_quality === 'poor');
    if (allPages.length === 0) {
      results.push(mk('ALL_PAGES_READABLE', 'image_quality', WARNING, SKIP,
        'No pages to evaluate.'));
    } else if (poor.length === 0) {
      results.push(mk('ALL_PAGES_READABLE', 'image_quality', WARNING, PASS,
        'All pages have acceptable readability.'));
    } else {
      results.push(mk('ALL_PAGES_READABLE', 'image_quality', WARNING, FAIL,
        `${poor.length} page(s) flagged as poor quality — consider re-uploading.`,
        'no poor pages',
        poor.length));
    }
  }

  return results;
}

/**
 * Reduce check results to a single status + counts.
 */
export function computeVerificationStatus(results) {
  const blocking = results.filter(r => r.level === BLOCKING && r.status === FAIL).length;
  const warning = results.filter(r => r.level === WARNING && r.status === FAIL).length;
  let status = 'verified';
  if (blocking > 0) status = 'needs_review';
  else if (warning > 0) status = 'verified_with_warnings';
  return { status, blocking, warning };
}

// ---------- private check helpers ----------

function crossField(check_id, category, level, a, b, passMsg, skipIf) {
  if (skipIf) return mk(check_id, category, level, SKIP, 'Source slot not present.');
  if (!bothPresent(a, b)) return mk(check_id, category, level, SKIP, 'One side missing.');
  if (normStr(a) === normStr(b)) return mk(check_id, category, level, PASS, passMsg);
  return mk(check_id, category, level, FAIL,
    `Values differ: "${a}" vs "${b}".`, b, a);
}

function crossDate(check_id, category, level, a, b, passMsg, skipIf) {
  if (skipIf) return mk(check_id, category, level, SKIP, 'Source slot not present.');
  if (!bothPresent(a, b)) return mk(check_id, category, level, SKIP, 'One side missing.');
  if (sameDay(a, b)) return mk(check_id, category, level, PASS, passMsg);
  return mk(check_id, category, level, FAIL,
    `Dates differ: ${formatDate(a)} vs ${formatDate(b)}.`,
    formatDate(b), formatDate(a));
}

function crossAmount(check_id, category, level, a, b, tol, passMsg, skipIf) {
  if (skipIf) return mk(check_id, category, level, SKIP, 'Source slot not present.');
  if (isNullish(a) || isNullish(b)) return mk(check_id, category, level, SKIP, 'One side missing.');
  if (close(a, b, tol)) return mk(check_id, category, level, PASS, `${passMsg} (±₹${tol}).`);
  return mk(check_id, category, level, FAIL,
    `${passMsg.replace('matches', 'differs')}: ₹${a} vs ₹${b} (tolerance ±₹${tol}).`,
    b, a);
}

function normUnit(s) {
  if (!s) return null;
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatDate(d) {
  const dd = dateOnly(d);
  return dd ? dd.toISOString().slice(0, 10) : String(d);
}
