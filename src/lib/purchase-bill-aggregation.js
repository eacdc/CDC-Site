/**
 * Multi-page aggregation per slot.
 *
 * Most fields appear on a single page (typically the first or last).
 * The rules we apply:
 *   - For scalar fields (numbers, strings, dates): take the first non-null
 *     value across pages in their original order.
 *   - For total fields (taxable_value, grand_total, cgst, sgst, igst,
 *     round_off): prefer the value from the LAST page where a non-null
 *     value appears (multi-page invoices typically show the total only
 *     on the final page).
 *   - For array fields (po_numbers, hsn_codes): union across pages,
 *     deduped, preserving first-seen order.
 *   - Booleans: OR across pages — if any page says "has_irn", we treat
 *     the bill as having an IRN.
 *
 * Slot type drives which keys exist; we operate generically using known
 * key buckets.
 */

const TOTAL_KEYS = new Set([
  'taxable_value', 'cgst', 'sgst', 'igst', 'round_off', 'grand_total',
  'cgst_amount', 'sgst_amount', 'igst_amount', 'value_of_goods',
  'total_taxable_amount', 'total_cgst', 'total_sgst', 'total_igst',
  'line_items_count', 'cgst_rate', 'sgst_rate', 'igst_rate',
]);

const ARRAY_KEYS = new Set(['po_numbers', 'hsn_codes']);

const BOOL_KEYS = new Set([
  'is_tally_voucher', 'is_supplier_invoice', 'is_eway_bill', 'is_grn_sheet',
  'is_reverse_charge', 'has_signature_or_stamp', 'has_irn',
]);

function isNullish(v) {
  return v === null || v === undefined || v === '';
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const key = typeof v === 'string' ? v.trim().toUpperCase() : v;
    if (key === '' || key == null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof v === 'string' ? v.trim() : v);
  }
  return out;
}

/**
 * Aggregate an ordered list of per-page extracted_fields objects into a
 * single canonical object for the slot.
 */
export function aggregateSlotFields(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return {};

  // Collect all keys across pages.
  const allKeys = new Set();
  for (const p of pages) {
    if (p && p.extracted_fields && typeof p.extracted_fields === 'object') {
      for (const k of Object.keys(p.extracted_fields)) allKeys.add(k);
    }
  }

  const out = {};
  for (const key of allKeys) {
    if (ARRAY_KEYS.has(key)) {
      const merged = [];
      for (const p of pages) {
        const v = p?.extracted_fields?.[key];
        if (Array.isArray(v)) merged.push(...v);
        else if (typeof v === 'string' && v.trim() !== '') merged.push(v);
      }
      out[key] = dedupePreserveOrder(merged);
    } else if (BOOL_KEYS.has(key)) {
      let v = null;
      for (const p of pages) {
        const x = p?.extracted_fields?.[key];
        if (x === true) { v = true; break; }
        if (x === false && v === null) v = false;
      }
      out[key] = v;
    } else if (TOTAL_KEYS.has(key)) {
      // Use the LAST non-null value (multi-page invoices show totals
      // on the final page).
      let v = null;
      for (const p of pages) {
        const x = p?.extracted_fields?.[key];
        if (!isNullish(x)) v = x;
      }
      out[key] = v;
    } else {
      // Scalar: first non-null wins.
      let v = null;
      for (const p of pages) {
        const x = p?.extracted_fields?.[key];
        if (!isNullish(x)) { v = x; break; }
      }
      out[key] = v;
    }
  }
  return out;
}

/**
 * Given the slots object (with pages arrays) — populate each slot's
 * `aggregated_fields`.
 */
export function aggregateAllSlots(slots) {
  const out = {};
  for (const slotName of Object.keys(slots || {})) {
    const slot = slots[slotName] || {};
    const pages = slot.pages || [];
    out[slotName] = {
      pages,
      aggregated_fields: aggregateSlotFields(pages),
    };
  }
  return out;
}

/**
 * Build the denormalized "canonical" fields on the Bill from the
 * per-slot aggregated_fields. This is the layer the UI and search
 * indexes use.
 */
export function buildCanonicalFields(slots, { setType }) {
  const voucher = slots?.tally_voucher?.aggregated_fields || {};
  const invoice = slots?.supplier_invoice?.aggregated_fields || {};
  const eway = slots?.eway_bill?.aggregated_fields || {};
  const grn = slots?.grn_sheet?.aggregated_fields || {};

  const supplier_gstin = (invoice.supplier_gstin || voucher.supplier_gstin || grn.supplier_gstin || null);
  const invoice_number = (invoice.invoice_number || voucher.ref_bill_number || grn.bill_number || null);

  const cdc_unit = voucher.cdc_unit || grn.cdc_unit || null;

  // tax_type from CGST/SGST/IGST presence
  let tax_type = 'unknown';
  const c = num(invoice.cgst_amount) ?? num(voucher.cgst);
  const s = num(invoice.sgst_amount) ?? num(voucher.sgst);
  const i = num(invoice.igst_amount) ?? num(voucher.igst);
  if (i > 0 && (c === 0 || c == null) && (s === 0 || s == null)) tax_type = 'inter_state';
  else if ((c > 0 || s > 0) && (i === 0 || i == null)) tax_type = 'intra_state';

  const dedupKey =
    supplier_gstin && invoice_number
      ? `${String(supplier_gstin).trim().toUpperCase()}_${String(invoice_number).trim().toUpperCase()}`
      : null;

  return {
    set_type: setType,
    cdc_unit,

    tally_voucher_number: voucher.voucher_number || null,
    tally_voucher_date: parseDate(voucher.voucher_date),
    tally_ref_bill_no: voucher.ref_bill_number || null,
    tally_ref_bill_date: parseDate(voucher.ref_bill_date),

    grn_voucher_number: grn.grn_voucher_number || null,
    grn_voucher_date: parseDate(grn.grn_voucher_date),

    invoice_number,
    invoice_date: parseDate(invoice.invoice_date),

    supplier_name: invoice.supplier_name || voucher.supplier_name || grn.supplier_name || null,
    supplier_gstin: supplier_gstin ? String(supplier_gstin).trim().toUpperCase() : null,
    supplier_pan: invoice.supplier_pan || voucher.supplier_pan || null,
    supplier_state: invoice.supplier_state || null,

    buyer_gstin: invoice.buyer_gstin || voucher.buyer_gstin || null,
    buyer_name: invoice.buyer_name || null,

    po_numbers: dedupArr([
      ...(Array.isArray(grn.po_numbers) ? grn.po_numbers : []),
      ...(invoice.po_number ? [invoice.po_number] : []),
    ]),

    taxable_value: num(invoice.taxable_value) ?? num(grn.total_taxable_amount) ?? num(voucher.taxable_value),
    cgst_amount: num(invoice.cgst_amount) ?? num(grn.total_cgst) ?? num(voucher.cgst),
    sgst_amount: num(invoice.sgst_amount) ?? num(grn.total_sgst) ?? num(voucher.sgst),
    igst_amount: num(invoice.igst_amount) ?? num(grn.total_igst) ?? num(voucher.igst),
    round_off: num(invoice.round_off) ?? num(grn.round_off) ?? num(voucher.round_off),
    grand_total: num(invoice.grand_total) ?? num(grn.grand_total) ?? num(voucher.grand_total),
    tax_type,

    eway_bill_number: eway.eway_bill_number || null,
    eway_bill_date: parseDate(eway.eway_bill_date),
    eway_valid_until: parseDate(eway.valid_until),
    vehicle_number: eway.vehicle_number || null,

    bill_dedup_key: dedupKey,
  };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dedupArr(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (v == null || v === '') continue;
    const k = String(v).trim().toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(v).trim());
  }
  return out;
}

/**
 * Parse an ISO-ish date string into a JS Date, tolerating "YYYY-MM-DD"
 * and "YYYY-MM-DD HH:MM".
 */
function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  const str = String(s).trim();
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}
