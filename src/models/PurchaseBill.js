import mongoose from 'mongoose';

const { Schema } = mongoose;

const UNIQUE_OPTIONAL_FIELDS = ['bill_dedup_key', 'tally_voucher_number'];

/**
 * One uploaded image page belonging to a slot. We store the Cloudinary URL,
 * the slot-specific extracted JSON, plus minimal classification metadata
 * surfaced by the vision LLM so the UI can render warning badges per page.
 */
const PageSchema = new Schema({
  page_no: Number,
  // Legacy Cloudinary fields. Retained for the USE_R2 rollback path
  // (MIGRATION.md section 9) — do not drop until R2 has run clean.
  cloudinary_public_id: String,
  cloudinary_url: String,
  // R2 object key. Never a signed URL: signed URLs expire, so they are
  // minted per read via lib/media-url.js and never persisted.
  r2_key: String,
  uploaded_at: { type: Date, default: Date.now },
  extracted_fields: Schema.Types.Mixed,
  extraction_model: String,
  classification_passed: Boolean,
  classification_confidence: String,
}, { _id: false });

/**
 * A slot is a logical document type within a bill set (tally voucher,
 * supplier invoice, e-way bill, GRN sheet). Each slot has 0..N pages and a
 * merged `aggregated_fields` object produced by the aggregation library.
 */
const SlotSchema = new Schema({
  pages: { type: [PageSchema], default: [] },
  aggregated_fields: Schema.Types.Mixed,
}, { _id: false });

const CheckResultSchema = new Schema({
  check_id: String,
  category: String,
  level: String,   // "blocking" | "warning" | "informational"
  status: String,  // "pass" | "fail" | "skipped"
  message: String,
  expected: Schema.Types.Mixed,
  actual: Schema.Types.Mixed,
}, { _id: false });

/** Registered only on the billing DB connection — see `db-purchase-bills.js`. */
export const purchaseBillSchema = new Schema({
  // ---------- set metadata ----------
  set_type: { type: String, enum: ['grn', 'non_grn'], required: true, index: true },
  cdc_unit: { type: String, index: true },

  uploaded_by: { type: String, index: true },
  uploaded_at: { type: Date, default: Date.now, index: true },

  // ---------- raw slot data ----------
  slots: {
    tally_voucher: { type: SlotSchema, default: () => ({ pages: [] }) },
    supplier_invoice: { type: SlotSchema, default: () => ({ pages: [] }) },
    eway_bill: { type: SlotSchema, default: () => ({ pages: [] }) },
    grn_sheet: { type: SlotSchema, default: () => ({ pages: [] }) },
  },

  // ---------- denormalized canonical fields (searchable layer) ----------
  tally_voucher_number: { type: String },
  tally_voucher_date: { type: Date, index: true },
  tally_ref_bill_no: { type: String, index: true },
  tally_ref_bill_date: { type: Date },

  grn_voucher_number: { type: String, index: true },
  grn_voucher_date: { type: Date },

  invoice_number: { type: String, index: true },
  invoice_date: { type: Date, index: true },

  supplier_name: { type: String, index: true },
  supplier_gstin: { type: String, index: true },
  supplier_pan: String,
  supplier_state: String,

  buyer_gstin: String,
  buyer_name: String,

  po_numbers: { type: [String], index: true, default: [] },

  // ---------- amounts ----------
  taxable_value: Number,
  cgst_amount: Number,
  sgst_amount: Number,
  igst_amount: Number,
  round_off: Number,
  grand_total: Number,
  tax_type: { type: String, enum: ['intra_state', 'inter_state', 'unknown'], default: 'unknown' },

  // ---------- e-way ----------
  eway_bill_number: String,
  eway_bill_date: Date,
  eway_valid_until: Date,
  vehicle_number: String,

  // ---------- verification ----------
  verification_status: {
    type: String,
    enum: ['pending_extraction', 'verified', 'verified_with_warnings', 'needs_review', 'rejected'],
    default: 'pending_extraction',
    index: true,
  },
  check_results: { type: [CheckResultSchema], default: [] },
  blocking_failures_count: { type: Number, default: 0, index: true },
  warning_failures_count: { type: Number, default: 0 },

  // ---------- manual review trail ----------
  manually_reviewed_by: String,
  manually_reviewed_at: Date,
  review_comment: String,
  manually_overridden: { type: Boolean, default: false },

  // Placeholder rows created from the missing-voucher checker for Tally
  // vouchers that were cancelled in Tally and will never be uploaded.
  is_cancelled_voucher: { type: Boolean, default: false, index: true },
  cancellation_note: String,
  cancelled_by: String,
  cancelled_at: Date,

  // Set when background extraction fails so the UI can surface it
  extraction_error: { type: String, default: null },

  // ---------- dedup ----------
  // Uniqueness is a partial index in repairPurchaseBillUniqueIndexes —
  // never store null (Mongo unique indexes treat null as a real value).
  bill_dedup_key: { type: String },
  invoice_image_phash: String,
}, {
  collection: 'PurchaseBills',
  timestamps: true,
  autoIndex: false,
});

purchaseBillSchema.pre('save', function unsetEmptyUniqueKeys() {
  for (const field of UNIQUE_OPTIONAL_FIELDS) {
    const v = this[field];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      this.set(field, undefined);
      if (this._doc) delete this._doc[field];
    }
  }
});

// ---------- Search & lookup indexes ----------
// Text index for free-text search across the most common identifiers.
purchaseBillSchema.index({
  supplier_name: 'text',
  invoice_number: 'text',
  tally_voucher_number: 'text',
});
purchaseBillSchema.index({ supplier_gstin: 1, invoice_number: 1 });
purchaseBillSchema.index({ uploaded_at: -1 });

purchaseBillSchema.index(
  { bill_dedup_key: 1 },
  { unique: true, partialFilterExpression: { bill_dedup_key: { $type: 'string' } } },
);
purchaseBillSchema.index(
  { tally_voucher_number: 1 },
  { unique: true, partialFilterExpression: { tally_voucher_number: { $type: 'string' } } },
);

// Compound index supports the similar-bill query in check #49.
purchaseBillSchema.index({ supplier_gstin: 1, invoice_date: 1, grand_total: 1 });

// Phash lookup for check #48 (we do a coarse equality probe and then narrow
// via Hamming distance in application code).
purchaseBillSchema.index({ invoice_image_phash: 1 });
