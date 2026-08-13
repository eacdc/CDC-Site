/**
 * OpenAI Vision adapter for purchase bill extraction.
 *
 * Each slot has its own extraction prompt with a strict JSON schema.
 * We call GPT-4o with `response_format: json_object` and temperature 0,
 * then run the response through a slot-specific Zod schema. If validation
 * fails we retry once (the LLM sometimes returns dates as `null` strings
 * or numbers as strings — the schemas coerce where reasonable).
 */
import OpenAI from 'openai';
import { z } from 'zod';

// Lazy-init so a missing OPENAI_API_KEY doesn't crash imports at module
// load time (the server boots with multiple unrelated route modules; we
// only fail when /extract is actually called).
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set on the server.');
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MODEL = 'gpt-4o';

// ---------- Zod helpers ----------
// Many fields in our schemas may be missing on a given image. Rather than
// failing the whole extraction we coerce empty strings → null and accept
// strings or numbers for numeric fields (the LLM sometimes returns
// "1,234.50" as a string).
const NullableString = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().nullable(),
);
const NullableNumber = z.preprocess(
  (v) => {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const cleaned = v.replace(/[,₹\s]/g, '');
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  },
  z.number().nullable(),
);
const NullableDate = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().nullable(),
);
const NullableBool = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.boolean().nullable(),
);
const StringArray = z.preprocess(
  (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
  z.array(z.string()),
);

const Confidence = z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  z.enum(['high', 'medium', 'low']).nullable().default('medium'),
);
const PageQuality = z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  z.enum(['good', 'fair', 'poor']).nullable().default('fair'),
);

// ---------- Per-slot schemas ----------
export const TallyVoucherSchema = z.object({
  is_tally_voucher: z.boolean().default(false),
  confidence: Confidence,
  voucher_number: NullableString,
  voucher_date: NullableDate,
  ref_bill_number: NullableString,
  ref_bill_date: NullableDate,
  supplier_name: NullableString,
  supplier_address: NullableString,
  supplier_gstin: NullableString,
  supplier_pan: NullableString,
  cdc_unit: NullableString,
  particulars_description: NullableString,
  taxable_value: NullableNumber,
  cgst: NullableNumber,
  sgst: NullableNumber,
  igst: NullableNumber,
  round_off: NullableNumber,
  grand_total: NullableNumber,
  amount_in_words: NullableString,
  buyer_pan: NullableString,
  buyer_gstin: NullableString,
  on_account_of: NullableString,
  page_quality: PageQuality,
}).passthrough();

export const SupplierInvoiceSchema = z.object({
  is_supplier_invoice: z.boolean().default(false),
  confidence: Confidence,
  document_type: NullableString,
  invoice_number: NullableString,
  invoice_date: NullableDate,
  supplier_name: NullableString,
  supplier_address: NullableString,
  supplier_gstin: NullableString,
  supplier_pan: NullableString,
  supplier_state: NullableString,
  supplier_state_code: NullableString,
  buyer_name: NullableString,
  buyer_address: NullableString,
  buyer_gstin: NullableString,
  ship_to_address: NullableString,
  ship_to_gstin: NullableString,
  po_number: NullableString,
  hsn_codes: StringArray,
  taxable_value: NullableNumber,
  cgst_rate: NullableNumber,
  cgst_amount: NullableNumber,
  sgst_rate: NullableNumber,
  sgst_amount: NullableNumber,
  igst_rate: NullableNumber,
  igst_amount: NullableNumber,
  round_off: NullableNumber,
  grand_total: NullableNumber,
  amount_in_words: NullableString,
  is_reverse_charge: NullableBool,
  has_signature_or_stamp: NullableBool,
  has_irn: NullableBool,
  page_quality: PageQuality,
}).passthrough();

export const EwayBillSchema = z.object({
  is_eway_bill: z.boolean().default(false),
  confidence: Confidence,
  eway_bill_number: NullableString,
  eway_bill_date: NullableString,
  generated_by_gstin: NullableString,
  generated_by_name: NullableString,
  valid_from: NullableString,
  valid_until: NullableString,
  irn: NullableString,
  supplier_gstin: NullableString,
  supplier_name: NullableString,
  place_of_dispatch: NullableString,
  recipient_gstin: NullableString,
  recipient_name: NullableString,
  place_of_delivery: NullableString,
  document_number: NullableString,
  document_date: NullableDate,
  transaction_type: NullableString,
  value_of_goods: NullableNumber,
  hsn_code: NullableString,
  reason_for_transportation: NullableString,
  transporter: NullableString,
  vehicle_number: NullableString,
  distance_km: NullableNumber,
  page_quality: PageQuality,
}).passthrough();

export const GrnSheetSchema = z.object({
  is_grn_sheet: z.boolean().default(false),
  confidence: Confidence,
  grn_voucher_number: NullableString,
  grn_voucher_date: NullableDate,
  bill_number: NullableString,
  bill_date: NullableDate,
  supplier_name: NullableString,
  supplier_address: NullableString,
  supplier_gstin: NullableString,
  cdc_unit: NullableString,
  po_numbers: StringArray,
  line_items_count: NullableNumber,
  total_taxable_amount: NullableNumber,
  total_cgst: NullableNumber,
  total_sgst: NullableNumber,
  total_igst: NullableNumber,
  round_off: NullableNumber,
  grand_total: NullableNumber,
  amount_in_words: NullableString,
  prepared_by: NullableString,
  approved_by: NullableString,
  page_quality: PageQuality,
}).passthrough();

// ---------- Slot prompts ----------
const TALLY_VOUCHER_PROMPT = `You are extracting structured data from a CDC Printers Pvt Ltd Tally Purchase Voucher.

A Tally Purchase Voucher has these fields:
- Header: CDC PRINTERS PVT LTD address, PAN, GSTIN — these are the BUYER (CDC), never the supplier
- Voucher number (format: PUR/XXX/YY-YY, PUR/O/XXX/YY-YY, or similar). Copy it exactly, including any letter between slashes.
- Ref field (supplier's bill number and bill date), e.g. "07 dt. 18-May-26" → ref_bill_number "07"
- Voucher date (Dated: DD-Mon-YY)
- Party's Name (supplier)
- Supplier GSTIN/UIN and PAN/IT No — only if shown for the PARTY, not CDC's header GSTIN/PAN
- Unregistered suppliers (URP / Bill of Supply) often have no GSTIN; still extract their PAN if present. Return null for supplier_gstin in that case.
- Particulars section (e.g., "Ink & Chemicals", "Packing Materials", "Brokerage & Commission (URP)", with CDC unit name like "Tangra Unit" or "Panchla Unit")
- Amount column with values
- CGST, SGST, IGST, Round Off
- Total amount (top right)
- Amount in words
- Buyer's PAN (CDC) — put this in buyer_pan, never supplier_pan

Extract the following fields. Return null for any field not present.
All dates must be normalized to ISO format YYYY-MM-DD.
All amounts must be numbers (no commas, no currency symbols).

Return JSON in this exact schema:
{
  "is_tally_voucher": boolean,
  "confidence": "high" | "medium" | "low",
  "voucher_number": string,
  "voucher_date": "YYYY-MM-DD",
  "ref_bill_number": string,
  "ref_bill_date": "YYYY-MM-DD",
  "supplier_name": string,
  "supplier_address": string,
  "supplier_gstin": string,
  "supplier_pan": string,
  "cdc_unit": string,
  "particulars_description": string,
  "taxable_value": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "round_off": number,
  "grand_total": number,
  "amount_in_words": string,
  "buyer_pan": string,
  "buyer_gstin": string,
  "on_account_of": string,
  "page_quality": "good" | "fair" | "poor"
}`;

const SUPPLIER_INVOICE_PROMPT = `You are extracting structured data from a vendor document issued to CDC Printers Pvt Ltd.

This may be a tax invoice, bill of supply, handwritten bill, or partly both. It may be rotated 90 degrees or upside down. Handle all orientations — mentally rotate to read.

Rules:
- invoice_number is BILL NO / Invoice No / Bill No — not the Tally voucher number (PUR/...).
- supplier_gstin is the SELLER's GSTIN only. CDC's GSTIN (buyer) goes in buyer_gstin.
- Unregistered persons (URP) and Bills of Supply often have no seller GSTIN — return null. Still extract supplier_pan (PAN/IT No). Never copy CDC's PAN into supplier_pan.
- document_type should be bill_of_supply when the heading is BILL OF SUPPLY.

All dates must be normalized to ISO format YYYY-MM-DD.
All amounts must be numbers (no commas, no currency symbols).
Return null for any field not visible or unclear.

Return JSON in this exact schema:
{
  "is_supplier_invoice": boolean,
  "confidence": "high" | "medium" | "low",
  "document_type": "tax_invoice" | "bill_of_supply" | "proforma" | "delivery_challan" | "other",
  "invoice_number": string,
  "invoice_date": "YYYY-MM-DD",
  "supplier_name": string,
  "supplier_address": string,
  "supplier_gstin": string,
  "supplier_pan": string,
  "supplier_state": string,
  "supplier_state_code": string,
  "buyer_name": string,
  "buyer_address": string,
  "buyer_gstin": string,
  "ship_to_address": string,
  "ship_to_gstin": string,
  "po_number": string,
  "hsn_codes": string[],
  "taxable_value": number,
  "cgst_rate": number,
  "cgst_amount": number,
  "sgst_rate": number,
  "sgst_amount": number,
  "igst_rate": number,
  "igst_amount": number,
  "round_off": number,
  "grand_total": number,
  "amount_in_words": string,
  "is_reverse_charge": boolean,
  "has_signature_or_stamp": boolean,
  "has_irn": boolean,
  "page_quality": "good" | "fair" | "poor"
}`;

const EWAY_BILL_PROMPT = `You are extracting structured data from a GST e-way bill.

The e-way bill number is 12 digits. The IRN (if present) is 64 hex characters.
Dates may be in DD-MM-YYYY or DD/MM/YYYY format on the image — normalize to YYYY-MM-DD (or YYYY-MM-DD HH:MM if time is shown).

Return JSON in this exact schema:
{
  "is_eway_bill": boolean,
  "confidence": "high" | "medium" | "low",
  "eway_bill_number": string,
  "eway_bill_date": "YYYY-MM-DD HH:MM",
  "generated_by_gstin": string,
  "generated_by_name": string,
  "valid_from": "YYYY-MM-DD HH:MM",
  "valid_until": "YYYY-MM-DD",
  "irn": string,
  "supplier_gstin": string,
  "supplier_name": string,
  "place_of_dispatch": string,
  "recipient_gstin": string,
  "recipient_name": string,
  "place_of_delivery": string,
  "document_number": string,
  "document_date": "YYYY-MM-DD",
  "transaction_type": string,
  "value_of_goods": number,
  "hsn_code": string,
  "reason_for_transportation": string,
  "transporter": string,
  "vehicle_number": string,
  "distance_km": number,
  "page_quality": "good" | "fair" | "poor"
}`;

const GRN_SHEET_PROMPT = `You are extracting structured data from a CDC Printers Pvt Ltd GRN (Goods Receipt Note) generated by IndusEnterprise ERP.

A GRN sheet has these features:
- Header: CDC Printers (P) Ltd. with their address
- "Item Purchase Invoice (GRN)" title
- Supplier Details section: name, bill no, bill date, voucher no (e.g., PI00903_26_27), voucher date, address, GSTIN
- Billing Details + Delivery Details boxes
- Line items table with: S.No, Item Code, PO No, Item Name, Purchase Unit, Receipt Qty, Stock Unit, Rate, Total Amount, CGST, SGST, IGST, Gross Amount
- Tax ledger lines (CGST, SGST, Round Off)
- Grand Total
- Amount in words
- "Prepared By" and "Approved By"

Extract ALL unique PO numbers from the line items into the po_numbers array.
All dates as ISO YYYY-MM-DD. All amounts as plain numbers.

Return JSON in this exact schema:
{
  "is_grn_sheet": boolean,
  "confidence": "high" | "medium" | "low",
  "grn_voucher_number": string,
  "grn_voucher_date": "YYYY-MM-DD",
  "bill_number": string,
  "bill_date": "YYYY-MM-DD",
  "supplier_name": string,
  "supplier_address": string,
  "supplier_gstin": string,
  "cdc_unit": string,
  "po_numbers": string[],
  "line_items_count": number,
  "total_taxable_amount": number,
  "total_cgst": number,
  "total_sgst": number,
  "total_igst": number,
  "round_off": number,
  "grand_total": number,
  "amount_in_words": string,
  "prepared_by": string,
  "approved_by": string,
  "page_quality": "good" | "fair" | "poor"
}`;

const PROMPTS = {
  tally_voucher: TALLY_VOUCHER_PROMPT,
  supplier_invoice: SUPPLIER_INVOICE_PROMPT,
  eway_bill: EWAY_BILL_PROMPT,
  grn_sheet: GRN_SHEET_PROMPT,
};

const SCHEMAS = {
  tally_voucher: TallyVoucherSchema,
  supplier_invoice: SupplierInvoiceSchema,
  eway_bill: EwayBillSchema,
  grn_sheet: GrnSheetSchema,
};

const CLASSIFIER_KEY = {
  tally_voucher: 'is_tally_voucher',
  supplier_invoice: 'is_supplier_invoice',
  eway_bill: 'is_eway_bill',
  grn_sheet: 'is_grn_sheet',
};

/**
 * Call OpenAI vision once with the given prompt + image URL. Returns the
 * raw parsed JSON object (or throws).
 */
async function callOpenAI(imageUrl, prompt) {
  const response = await getOpenAI().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });
  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return { raw: JSON.parse(content), model: MODEL };
}

/**
 * Extract fields for a single page in a given slot. Validates the LLM
 * response via Zod. Returns { fields, model, classification_passed,
 * classification_confidence }.
 */
export async function extractFromImage(imageUrl, slotType) {
  const prompt = PROMPTS[slotType];
  const schema = SCHEMAS[slotType];
  if (!prompt || !schema) {
    throw new Error(`Unknown slot type: ${slotType}`);
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { raw, model } = await callOpenAI(imageUrl, prompt);
      const parsed = schema.safeParse(raw);
      if (parsed.success) {
        const fields = parsed.data;
        const classifierKey = CLASSIFIER_KEY[slotType];
        return {
          fields,
          model,
          classification_passed: !!fields[classifierKey],
          classification_confidence: fields.confidence ?? null,
        };
      }
      lastError = new Error(
        `Zod validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      // On the retry attempt, give the LLM one more chance with the same prompt.
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('extractFromImage failed');
}

export { PROMPTS };
