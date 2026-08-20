/**
 * Supplier Portal Mongo schemas (Part 3 of the build spec).
 *
 * Mongo holds only what the ERP does not have: quotes, extracted lines,
 * supplier-item identities, mappings, rate history, queue state and audit.
 * Item masters, ledgers, stock and PO status are read live from MSSQL on every
 * request and are never cached here.
 *
 * The rule that shapes almost every schema below: **no bare ERP id is ever
 * stored**. ItemID 3845 in Kolkata is a different item from ItemID 3845 in
 * Ahmedabad, so every reference carries its site.
 *
 * Schemas are exported rather than models — they are registered against the
 * Supplier Portal's own connection in `db/mongo.js`.
 */

import mongoose from 'mongoose';
import { SITES } from '../config/constants.js';

const { Schema } = mongoose;

/** `{site, itemId}` — the only legal way to reference an ERP item. */
const itemRefSchema = new Schema({
  site: { type: String, enum: SITES, required: true },
  itemId: { type: Number, required: true },
}, { _id: false });

/** `{site, ledgerId}` — ledgers are per-database too. */
const ledgerRefSchema = new Schema({
  site: { type: String, enum: SITES, required: true },
  ledgerId: { type: Number, required: true },
}, { _id: false });

/**
 * A spec key stands in for an ItemID where pricing is spec-driven: one film
 * quote line covers ~15 ItemIDs that differ only by width, and nearly all
 * Shring foil is one rate regardless of colour or width. Storing those per
 * item means maintaining 140 identical numbers that then drift.
 */
const specKeySchema = new Schema({
  kind: {
    type: String,
    enum: ['ITEM', 'FILM_SPEC', 'FOIL_GRADE', 'PAPER_BAND'],
    default: 'ITEM',
  },
  filmType: String,     // BOPP MATTE, BOPP GLOSS, MET PET, POLYESTER GLOSS
  micron: Number,
  foilGrade: String,
  quality: String,
  gsmFrom: Number,
  gsmTo: Number,
  form: String,         // RBD (sheet) | RLS (reel)
}, { _id: false });

/** A stored validation result. Shape matches config/validations.js `check()`. */
const checkSchema = new Schema({
  code: { type: String, required: true },
  severity: { type: String, enum: ['BLOCK', 'WARN', 'INFO'], required: true },
  scope: String,
  passed: { type: Boolean, required: true },
  message: String,
  actualValue: Schema.Types.Mixed,
  expectedValue: Schema.Types.Mixed,
  lineNo: Number,
  /** Set when a WARN was accepted; a BLOCK can never carry one. */
  overrideReason: String,
  overriddenBy: String,
  overriddenAt: Date,
}, { _id: false });

// ── 10.1 supplierGroups ─────────────────────────────────────────────────────

/**
 * One supplier, however many ledgers the ERP has for it. Grouping is mandatory:
 * Siegwerk alone has five ledgers, and without grouping "who is cheapest" is
 * wrong and supplier scoring fragments across branches.
 */
export const supplierGroupSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  ledgerRefs: { type: [ledgerRefSchema], default: [] },
  aliases: { type: [String], default: [] },
  /**
   * Every GSTIN this supplier has traded under, harvested from their ledgers.
   *
   * A name on a letterhead is a guess; a GSTIN is an identifier. When an
   * uploaded quote carries one, it settles which supplier sent it outright and
   * skips the fuzzy name match entirely — which matters most for the case name
   * matching handles worst: a branch quoting under a slightly different
   * trading style.
   */
  gstins: { type: [String], default: [] },
  /**
   * CDC Printers (Ahmedabad) appears as a supplier ledger on lamination film.
   * That is an inter-unit transfer, not a purchase — excluded from all
   * benchmarking.
   */
  isInternal: { type: Boolean, default: false },
  /**
   * A quote may arrive from a different legal entity than the PO — Kamal
   * Enterprises quotes, K K Emulsions invoices. Recorded so the trader is not
   * mistaken for a separate supplier.
   */
  tradesAs: { type: [String], default: [] },
  /** Overrides TOLERANCES.defaultValidityDays for this supplier. */
  defaultValidityDays: Number,
  /** Item groups this supplier has historically supplied. Drives Tier 0. */
  historicalItemGroupIds: { type: [Number], default: [] },
  contactEmail: String,
  notes: String,
}, { collection: 'sp_supplierGroups', timestamps: true });

supplierGroupSchema.index({ 'ledgerRefs.site': 1, 'ledgerRefs.ledgerId': 1 });
supplierGroupSchema.index({ aliases: 1 });
supplierGroupSchema.index({ gstins: 1 });

// ── 10.2 quoteDocuments ─────────────────────────────────────────────────────

/** One per uploaded file. Immutable once processed. */
export const quoteDocumentSchema = new Schema({
  /**
   * Null until the supplier is settled.
   *
   * A quote arrives as a file, and everything about it — who sent it, which
   * plant it prices, when it takes effect — is printed on the page. Requiring
   * the uploader to answer first made them the extractor, and a human picking
   * from a list of eighty supplier names picks wrong occasionally, which files
   * one supplier's rates under another's name. So the field starts empty, gets
   * a proposal from `identification`, and is written when someone confirms.
   */
  supplierGroupId: {
    type: Schema.Types.ObjectId, ref: 'SpSupplierGroup', default: null, index: true,
  },
  /** Nullable — a trader's quote may not correspond to a ledger at all. */
  ledgerRef: ledgerRefSchema,

  docType: {
    type: String,
    enum: ['PRICE_LIST', 'EMAIL', 'PROFORMA_INVOICE', 'HANDWRITTEN_NOTE', 'WORKSHEET'],
    default: 'PRICE_LIST',
  },
  /** SOFT = "subject to change without notice". Never blocks a PO check. */
  quoteStrength: { type: String, enum: ['FIRM', 'SOFT'], default: 'FIRM' },

  storageKey: String,          // R2 object key
  cloudinaryUrl: String,       // legacy/alternate storage
  pageKeys: { type: [String], default: [] },
  originalFilename: String,
  mimeType: String,
  sha256: { type: String, index: true },
  perceptualHashes: { type: [String], default: [] },

  effectiveFrom: Date,
  effectiveTo: Date,
  validityBasis: { type: String, enum: ['STATED', 'DEFAULTED', 'NONE_GIVEN'], default: 'NONE_GIVEN' },

  /** Which plants the document covers. Drives the "which rows should this have produced?" check. */
  plantScope: { type: [String], enum: ['KOLKATA', 'AHMEDABAD'], default: [] },
  /** Whether the plant scope was printed, asked at review, or assumed. */
  plantScopeBasis: { type: String, enum: ['STATED', 'ASKED', 'ASSUMED'], default: 'ASSUMED' },
  cdcEntityScope: { type: String, enum: ['PAPER', 'PACKAGING', 'ALL'], default: 'ALL' },

  commercialTerms: {
    creditDays: Number,
    freightTerms: String,
    insurance: String,
    gstNote: String,
    paymentTerms: String,
  },

  /**
   * Rules stated on the document rather than priced per line — "sheet price
   * 1.00 extra from reel", "reel cut ₹1/kg extra". Applied to generate derived
   * rates instead of being stored as rows the supplier never sent.
   */
  derivationRules: [{
    _id: false,
    kind: { type: String, enum: ['FORM_PREMIUM', 'RATE_BASIS'] },
    fromForm: String,
    toForm: String,
    delta: Number,
    basisPerUom: String,
    note: String,
  }],

  /** A re-quote that restates only some lines of a prior document. */
  isPartialUpdate: { type: Boolean, default: false },
  supersedesDocId: { type: Schema.Types.ObjectId, ref: 'SpQuoteDocument', default: null },

  /** Worksheet uploads: which column the human nominated as the live price. */
  nominatedPriceColumn: String,

  /**
   * What the document said about itself, and how sure the reading was.
   *
   * Kept beside the settled fields rather than merged into them, because the
   * two answer different questions. `supplierGroupId` is what the rates will be
   * filed under; `identification.supplier` is why. A reviewer who can see "read
   * 'PRINT SALES PRIVATE LIMITED' from the signature block on page 3" confirms
   * in a glance; one who sees only a pre-filled dropdown has to reopen the PDF,
   * and in practice does not.
   *
   * The proposal is never overwritten by a correction — `basis` records which
   * happened. A month of CORRECTED readings on one supplier is the signal that
   * an alias is missing, and averaging it into the confirmed value hides that.
   */
  identification: {
    status: {
      type: String,
      enum: ['PENDING', 'PROPOSED', 'CONFIRMED'],
      default: 'PENDING',
    },

    supplier: {
      proposedGroupId: { type: Schema.Types.ObjectId, ref: 'SpSupplierGroup', default: null },
      proposedName: String,
      /** The name and GSTIN exactly as printed, whether or not they matched. */
      readName: String,
      readGstin: String,
      /** Where on the document the name was found, e.g. "signature block, page 3". */
      foundIn: String,
      confidence: Number,
      evidence: String,
      candidates: [{
        _id: false,
        supplierGroupId: { type: Schema.Types.ObjectId, ref: 'SpSupplierGroup' },
        name: String,
        score: Number,
        matchedOn: String,
      }],
      /** ERP ledgers that look right but have no group yet — a first-time supplier. */
      ledgerCandidates: [{
        _id: false,
        ledgerId: Number,
        ledgerName: String,
        gstin: String,
        score: Number,
      }],
      basis: {
        type: String,
        enum: ['READ', 'CONFIRMED', 'CORRECTED'],
        default: 'READ',
      },
    },

    plant: {
      proposed: { type: [String], enum: ['KOLKATA', 'AHMEDABAD'], default: [] },
      /** Tangra, Panchla, Ahmedabad. Finer than the plant, and not a database. */
      unit: String,
      readAddress: String,
      confidence: Number,
      evidence: String,
      basis: {
        type: String,
        enum: ['READ', 'CONFIRMED', 'CORRECTED'],
        default: 'READ',
      },
    },

    validity: { confidence: Number, evidence: String },
    strength: { confidence: Number, evidence: String },
    terms: { confidence: Number, evidence: String },

    /** Which fields a person still has to settle: 'supplier', 'plant'. */
    needsAttention: { type: [String], default: [] },
    confirmedBy: String,
    confirmedAt: Date,
  },

  extraction: {
    provider: String,
    model: String,
    startedAt: Date,
    finishedAt: Date,
    error: String,
  },
  checks: { type: [checkSchema], default: [] },

  status: {
    type: String,
    enum: ['UPLOADED', 'EXTRACTING', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'SUPERSEDED', 'REJECTED'],
    default: 'UPLOADED',
    index: true,
  },
  uploadedBy: String,
  uploadedAt: { type: Date, default: Date.now },
  approvedBy: String,
  approvedAt: Date,
}, { collection: 'sp_quoteDocuments', timestamps: true });

quoteDocumentSchema.index({ supplierGroupId: 1, effectiveFrom: -1 });
quoteDocumentSchema.index({ status: 1, uploadedAt: -1 });

// ── 10.3 quoteLines ─────────────────────────────────────────────────────────

/**
 * Raw extraction. Never edited in place — a correction supersedes the line, so
 * what the document actually said stays recoverable.
 */
export const quoteLineSchema = new Schema({
  quoteDocumentId: { type: Schema.Types.ObjectId, ref: 'SpQuoteDocument', required: true, index: true },
  lineNo: { type: Number, required: true },

  /** Exactly as printed. No cleaning, no inference. */
  raw: {
    text: String,
    productName: String,
    productCode: String,
    packSize: String,
    uom: String,
    rate: String,
    gstNote: String,
    gsmFrom: String,
    gsmTo: String,
    productForm: String,
    width: String,
    micron: String,
    notes: String,
  },

  normalised: {
    rate: Number,
    uom: { type: String },
    packQty: Number,
    packUom: String,
    /** rate ÷ packQty where the pack size is part of the price. */
    ratePerBaseUom: Number,
    conversionNote: String,
  },

  specKey: specKeySchema,

  supplierItemId: { type: Schema.Types.ObjectId, ref: 'SpSupplierItem', default: null, index: true },
  extractionConfidence: Number,
  flags: { type: [String], default: [] },
  checks: { type: [checkSchema], default: [] },

  /** Set when a human edits an extracted line at review. */
  supersededByLineId: { type: Schema.Types.ObjectId, ref: 'SpQuoteLine', default: null },
  editedFromLineId: { type: Schema.Types.ObjectId, ref: 'SpQuoteLine', default: null },
  /** Crop of the source page for this line, so every number links back. */
  sourceCrop: { key: String, page: Number, box: [Number] },
}, { collection: 'sp_quoteLines', timestamps: true });

quoteLineSchema.index({ quoteDocumentId: 1, lineNo: 1 });

// ── 10.4 supplierItems ──────────────────────────────────────────────────────

/**
 * The supplier's stable catalogue identity. This is what makes month two free:
 * once a supplier product code is mapped, the next quote resolves at Tier 1
 * with no AI and no human.
 */
export const supplierItemSchema = new Schema({
  supplierGroupId: { type: Schema.Types.ObjectId, ref: 'SpSupplierGroup', required: true, index: true },
  supplierProductCode: { type: String, default: null },
  supplierProductName: { type: String, required: true },
  /** Upper case, punctuation stripped, diacritics folded. */
  normalisedName: { type: String, required: true, index: true },

  defaultUom: String,
  defaultPackQty: Number,
  defaultPackUom: String,

  /** From the gated online lookup. Evidence for a human, never a match signal. */
  webDescription: { type: String, default: null },
  webSources: { type: [String], default: [] },

  firstSeenAt: Date,
  lastSeenAt: Date,
  seenInDocIds: [{ type: Schema.Types.ObjectId, ref: 'SpQuoteDocument' }],
  poSightings: { type: Number, default: 0 },

  /**
   * PROVISIONAL items appeared in exactly one quote with no PO against them.
   * They do not enter the mapping queue — one-off project items must not
   * consume verification effort. A second sighting or any PO promotes them.
   */
  status: {
    type: String,
    enum: ['PROVISIONAL', 'ACTIVE', 'RETIRED'],
    default: 'PROVISIONAL',
    index: true,
  },
}, { collection: 'sp_supplierItems', timestamps: true });

supplierItemSchema.index(
  { supplierGroupId: 1, supplierProductCode: 1 },
  { unique: true, partialFilterExpression: { supplierProductCode: { $type: 'string' } } },
);
supplierItemSchema.index({ supplierGroupId: 1, normalisedName: 1 });

// ── 10.5 itemMappings ───────────────────────────────────────────────────────

/**
 * Cardinality is many-to-many both ways, deliberately.
 *
 *  - Many supplier items → one CDC item. This is what enables cross-supplier
 *    comparison at all.
 *  - One supplier item → many CDC items is legitimate when EQUIVALENT: CDC's
 *    master genuinely holds duplicate ItemIDs for one product and any of them
 *    is correct.
 *  - One supplier item → many CDC items as DISTINCT_CANDIDATE is ambiguity,
 *    and goes to the queue.
 *
 * A human's answer binds the supplier item permanently, not just this month's
 * quote.
 */
export const itemMappingSchema = new Schema({
  supplierItemId: { type: Schema.Types.ObjectId, ref: 'SpSupplierItem', required: true, index: true },
  itemRef: { type: itemRefSchema, required: true },

  relation: {
    type: String,
    enum: ['EXACT', 'EQUIVALENT', 'DISTINCT_CANDIDATE'],
    required: true,
  },
  confidence: Number,
  method: {
    type: String,
    enum: ['PRODUCT_CODE', 'RATE_ANCHOR', 'SPEC_TUPLE', 'NAME_SIMILARITY', 'LLM', 'HUMAN'],
    required: true,
  },
  evidence: {
    matchedOn: String,
    lastPaidRate: Number,
    quoteRate: Number,
    deltaPct: Number,
    rationale: String,
    notes: String,
  },

  verifiedBy: String,
  verifiedAt: Date,
  isActive: { type: Boolean, default: true, index: true },
  supersededBy: { type: Schema.Types.ObjectId, ref: 'SpItemMapping', default: null },
}, { collection: 'sp_itemMappings', timestamps: true });

itemMappingSchema.index({ supplierItemId: 1, isActive: 1 });
itemMappingSchema.index({ 'itemRef.site': 1, 'itemRef.itemId': 1, isActive: 1 });

// ── 10.6 rateHistory ────────────────────────────────────────────────────────

/**
 * Denormalised, append-only, query-optimised.
 *
 * `plant` holds ONE plant. A document covering both writes two rows per line,
 * with different rates — NR Agarwal quotes Kolkata and Ahmedabad roughly
 * ₹4,000/MT apart for the same grade.
 *
 * Absence is meaningful: no row for a plant means this supplier has not quoted
 * this item there. It does not mean the other plant's rate applies, and
 * nothing in this application may fall back across plants.
 */
export const rateHistorySchema = new Schema({
  quoteLineId: { type: Schema.Types.ObjectId, ref: 'SpQuoteLine', required: true },
  quoteDocumentId: { type: Schema.Types.ObjectId, ref: 'SpQuoteDocument', required: true, index: true },

  supplierGroupId: { type: Schema.Types.ObjectId, ref: 'SpSupplierGroup', required: true, index: true },
  supplierItemId: { type: Schema.Types.ObjectId, ref: 'SpSupplierItem', index: true },

  /** Null when the rate is spec-level, or when the line is not yet mapped. */
  itemRef: { type: itemRefSchema, default: null },
  specKey: specKeySchema,

  rate: { type: Number, required: true },
  uom: String,
  ratePerBaseUom: Number,

  plant: { type: String, enum: ['KOLKATA', 'AHMEDABAD'], required: true },
  cdcEntityScope: { type: String, enum: ['PAPER', 'PACKAGING', 'ALL'], default: 'ALL' },

  effectiveFrom: { type: Date, required: true },
  effectiveTo: Date,
  quoteStrength: { type: String, enum: ['FIRM', 'SOFT'], default: 'FIRM' },

  /** Derived rather than quoted — e.g. a sheet rate from a stated reel premium. */
  isDerived: { type: Boolean, default: false },
  derivationNote: String,

  /** Exactly one true per (supplierItem | specKey, plant). */
  isCurrent: { type: Boolean, default: true },
}, { collection: 'sp_rateHistory', timestamps: { createdAt: true, updatedAt: false } });

rateHistorySchema.index({ 'itemRef.site': 1, 'itemRef.itemId': 1, isCurrent: 1 });
rateHistorySchema.index({ supplierGroupId: 1, plant: 1, isCurrent: 1 });
rateHistorySchema.index({ 'specKey.filmType': 1, 'specKey.micron': 1, plant: 1, isCurrent: 1 });
rateHistorySchema.index({ 'specKey.foilGrade': 1, supplierGroupId: 1, plant: 1, isCurrent: 1 });
rateHistorySchema.index({ effectiveTo: 1 });
rateHistorySchema.index({ supplierItemId: 1, plant: 1, isCurrent: 1 });

// ── 10.7 mappingQueue ───────────────────────────────────────────────────────

export const mappingQueueSchema = new Schema({
  supplierItemId: { type: Schema.Types.ObjectId, ref: 'SpSupplierItem', required: true, index: true },
  quoteLineId: { type: Schema.Types.ObjectId, ref: 'SpQuoteLine', required: true },

  reason: {
    type: String,
    enum: ['NO_CANDIDATE', 'AMBIGUOUS', 'LOW_CONFIDENCE', 'UOM_UNRESOLVED',
           'RATE_OUT_OF_BAND', 'NEW_ITEM_BETTER_MATCH'],
    required: true,
  },
  site: { type: String, enum: SITES, required: true },

  candidates: [{
    _id: false,
    itemId: Number,
    itemName: String,
    itemCode: String,
    subGroupName: String,
    lastPaidRate: Number,
    lastSupplier: String,
    purchaseCount: Number,
    score: Number,
    rationale: String,
  }],

  /** Annual spend on the candidates — the queue is worked highest-value first. */
  priority: { type: Number, default: 0, index: true },

  status: {
    type: String,
    enum: ['OPEN', 'RESOLVED', 'NO_CDC_ITEM', 'DEFERRED'],
    default: 'OPEN',
    index: true,
  },
  /** ItemID within `site`. Null for NO_CDC_ITEM. */
  resolvedTo: { type: Number, default: null },
  resolvedBy: String,
  resolvedAt: Date,
  note: String,
}, { collection: 'sp_mappingQueue', timestamps: true });

mappingQueueSchema.index({ status: 1, priority: -1 });
mappingQueueSchema.index({ site: 1, status: 1 });

// ── 10.8 documentSets (M5) ──────────────────────────────────────────────────

const capturedPageSchema = new Schema({
  storageKey: String,
  url: String,
  pageNo: Number,
  extraction: Schema.Types.Mixed,
}, { _id: false });

export const documentSetSchema = new Schema({
  setType: { type: String, default: 'GRN_PURCHASE' },
  site: { type: String, enum: SITES, required: true },

  slots: {
    supplierInvoice: { type: [capturedPageSchema], default: [] },
    eWayBill: { type: [capturedPageSchema], default: [] },
    packingList: { type: [capturedPageSchema], default: [] },
  },

  extractedHeader: {
    invoiceNo: String,
    invoiceDate: Date,
    supplierGstin: String,
    buyerGstin: String,
    shipToGstin: String,
    shipToState: String,
    supplierState: String,
    eWayBillNo: String,
    vehicleNo: String,
    taxType: { type: String, enum: ['CGST_SGST', 'IGST'] },
    subTotal: Number,
    freight: Number,
    taxable: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    roundOff: Number,
    grandTotal: Number,
  },

  extractedLines: [{
    _id: false,
    lineNo: Number,
    description: String,
    hsn: String,
    gsm: Number,
    size: String,
    unitWt: Number,
    bundles: Number,
    totalUnits: Number,
    qty: Number,
    uom: String,
    rate: Number,
    amount: Number,
    /** Weight CDC computes on rounded metric, vs what the supplier billed. */
    computedKg: Number,
    billedKg: Number,
    matchedPoTransactionId: Number,
    matchedItemId: Number,
    matchedPoRate: Number,
    poPendingQty: Number,
  }],

  poCandidates: { type: [Number], default: [] },
  /** Session context captured at post time — three separate ID spaces. */
  context: {
    userId: Number,            // UserMaster
    employeeLedgerId: Number,  // LedgerMaster, LedgerType 'Employees'
    warehouseId: Number,
    supplierLedgerId: Number,
    purchaseLedgerId: Number,
    freightLedgerId: Number,
  },

  checks: { type: [checkSchema], default: [] },

  status: {
    type: String,
    enum: ['CAPTURED', 'EXTRACTED', 'MATCHED', 'NEEDS_REVIEW', 'POSTED', 'REJECTED'],
    default: 'CAPTURED',
    index: true,
  },

  posted: {
    grnTransactionId: Number,
    grnVoucherNo: String,
    piTransactionId: Number,
    piVoucherNo: String,
    postedAt: Date,
    postedBy: String,
    stockRefreshOk: Boolean,
    stockRefreshError: String,
  },

  createdBy: String,
}, { collection: 'sp_documentSets', timestamps: true });

documentSetSchema.index({ site: 1, status: 1, createdAt: -1 });
documentSetSchema.index(
  { 'extractedHeader.invoiceNo': 1, 'extractedHeader.supplierGstin': 1 },
  { sparse: true },
);

// ── 10.9 supporting collections ─────────────────────────────────────────────

export const uomNormalisationSchema = new Schema({
  raw: { type: String, required: true, unique: true, uppercase: true, trim: true },
  canonical: { type: String, default: null },  // null = ambiguous, needs a human
  factor: { type: Number, default: 1 },
  isAmbiguous: { type: Boolean, default: false },
}, { collection: 'sp_uomNormalisation', timestamps: true });

/**
 * Every ERP write, mapping decision and override, with before/after. This is
 * the only record of why a number in the ERP looks the way it does.
 */
export const auditLogSchema = new Schema({
  action: { type: String, required: true, index: true },
  entity: String,
  entityId: String,
  site: { type: String, enum: SITES },
  actor: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  reason: String,
  meta: Schema.Types.Mixed,
}, { collection: 'sp_auditLog', timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

/** Internal users. Supplier logins live in a separate collection, never mixed. */
export const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: String,
  roles: { type: [String], default: ['VIEWER'] },  // VIEWER | BUYER | APPROVER | STORE | ADMIN
  /** Default site and receiving context; a user may switch site if permitted. */
  defaultSite: { type: String, enum: SITES, default: 'KOL' },
  allowedSites: { type: [String], enum: SITES, default: ['KOL'] },
  employeeLedgerId: Number,
  warehouseId: Number,
  erpUserId: Number,
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { collection: 'sp_users', timestamps: true });

/**
 * Supplier logins (M7). A separate identity space from internal users — the
 * two collections are never joined, and every supplier query is scoped by
 * supplierGroupId at the data layer rather than in a controller.
 */
export const supplierUserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  supplierGroupId: { type: Schema.Types.ObjectId, ref: 'SpSupplierGroup', required: true, index: true },
  displayName: String,
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { collection: 'sp_supplierUsers', timestamps: true });

export const sessionSchema = new Schema({
  token: { type: String, required: true, unique: true },
  principalType: { type: String, enum: ['USER', 'SUPPLIER_USER'], required: true },
  principalId: { type: Schema.Types.ObjectId, required: true },
  /** The receiving context a store user selected at login. */
  context: {
    site: { type: String, enum: SITES },
    erpUserId: Number,
    employeeLedgerId: Number,
    warehouseId: Number,
  },
  expiresAt: { type: Date, required: true },
  userAgent: String,
  ip: String,
}, { collection: 'sp_sessions', timestamps: true });

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Per-item override of the brand-vs-spec ranking default. Sub-group defaults
 * live in config; this collection holds only the corrections.
 */
export const itemClassificationSchema = new Schema({
  itemRef: { type: itemRefSchema, required: true },
  rankingMode: { type: String, enum: ['BRAND', 'SPEC'], required: true },
  setBy: String,
  note: String,
}, { collection: 'sp_itemClassification', timestamps: true });

itemClassificationSchema.index({ 'itemRef.site': 1, 'itemRef.itemId': 1 }, { unique: true });

/**
 * Daily snapshot of `ExpectedDeliveryDate` on open PO lines.
 *
 * The ERP edits that date in place when a supplier pre-informs a change, so
 * on-time% measures against a moving target. Commitment stability can only be
 * measured from snapshots, and every day without this job is data that cannot
 * be recovered — which is why it starts on day one, before the scorecard that
 * consumes it exists.
 */
export const deliveryDateSnapshotSchema = new Schema({
  site: { type: String, enum: SITES, required: true },
  snapshotDate: { type: Date, required: true },
  poTransactionId: Number,
  poVoucherNo: String,
  transactionDetailId: { type: Number, required: true },
  itemId: Number,
  ledgerId: Number,
  expectedDeliveryDate: Date,
  pendingQty: Number,
}, { collection: 'sp_deliveryDateSnapshots', timestamps: { createdAt: true, updatedAt: false } });

deliveryDateSnapshotSchema.index({ site: 1, transactionDetailId: 1, snapshotDate: 1 }, { unique: true });
deliveryDateSnapshotSchema.index({ site: 1, snapshotDate: -1 });

export const SCHEMAS = {
  SpSupplierGroup: supplierGroupSchema,
  SpQuoteDocument: quoteDocumentSchema,
  SpQuoteLine: quoteLineSchema,
  SpSupplierItem: supplierItemSchema,
  SpItemMapping: itemMappingSchema,
  SpRateHistory: rateHistorySchema,
  SpMappingQueue: mappingQueueSchema,
  SpDocumentSet: documentSetSchema,
  SpUomNormalisation: uomNormalisationSchema,
  SpAuditLog: auditLogSchema,
  SpUser: userSchema,
  SpSupplierUser: supplierUserSchema,
  SpSession: sessionSchema,
  SpItemClassification: itemClassificationSchema,
  SpDeliveryDateSnapshot: deliveryDateSnapshotSchema,
};
