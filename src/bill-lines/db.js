/**
 * Storage for extracted bill lines, on the CDC Bills database.
 *
 * Its own connection, deliberately, rather than `db-purchase-bills.js`: that
 * module repairs PurchaseBills' unique indexes and requeues stuck extractions
 * when it connects, and nothing in this tool may change a CDC Bills document.
 * PurchaseBills is only ever read here, through the raw collection with a
 * projection; the two collections below are the only ones written.
 *
 *   PurchaseBillLines     one document per bill: its lines, ERP link, checks
 *   PurchaseBillLineRuns  one document per run, for resuming and for cost
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const suggestionSchema = new Schema({
  piDetailId: Number,
  itemId: Number,
  itemName: String,
  itemGroupId: Number,
  method: String,
  confidence: Number,
  /** GROUP: the PI lines one supplier line stands for (one grade billed, several sizes posted). */
  group: [{ _id: false, piDetailId: Number, itemId: Number, itemName: String, itemGroupId: Number }],
}, { _id: false });

const lineSchema = new Schema({
  lineNo: Number,
  /** As printed: these are the supplier's names, and the reason this exists. */
  description: String,
  hsn: String,
  gsm: String,
  size: String,
  qty: String,
  uom: String,
  rate: String,
  amount: String,
  discountPct: String,
  discountAmount: String,
  taxableValue: String,
  poRef: String,
  kind: { type: String, enum: ['GOODS', 'CHARGE'] },
  value: Number,
  suggestion: { type: suggestionSchema, default: null },
  candidates: [Number],
  reason: String,
}, { _id: false });

const billLineSetSchema = new Schema({
  billId: { type: Schema.Types.ObjectId, required: true, unique: true },
  extractorVersion: { type: String, required: true },
  status: {
    type: String,
    enum: ['DONE', 'NEEDS_REVIEW', 'FAILED'],
    required: true,
    index: true,
  },
  site: { type: String, enum: ['KOL', 'AHM', null], default: null },

  /** What CDC Bills had, copied for the record; the bill itself is untouched. */
  bill: {
    invoiceNo: String,
    invoiceDate: Date,
    supplierName: String,
    supplierGstin: String,
    piVoucherNo: String,
    unit: String,
    taxableValue: Number,
    pageKeys: [String],
  },

  extracted: {
    invoiceNo: String,
    invoiceDate: String,
    supplierName: String,
    supplierGstin: String,
    subTotal: String,
    discount: String,
    freight: String,
    taxable: String,
    grandTotal: String,
    uncertain: [String],
  },
  lines: [lineSchema],

  link: {
    status: { type: String, enum: ['LINKED', 'AMBIGUOUS', 'GRN_ONLY', 'NOT_FOUND', null], default: null },
    keys: [String],
    keysAgreed: Boolean,
    /** BILL_KEYS: CDC Bills' invoice no and GSTIN found it; READ_KEYS: this tool's reading did. */
    via: String,
    gstinCorrected: Schema.Types.Mixed,
    piTransactionId: Number,
    piVoucherNo: String,
    grnTransactionIds: [Number],
    candidates: Schema.Types.Mixed,
    erpLines: Schema.Types.Mixed,
  },

  checks: {
    totals: Schema.Types.Mixed,
    invoiceNoAgrees: Boolean,
    gstinAgrees: Boolean,
    readerProblems: Schema.Types.Mixed,
    review: Schema.Types.Mixed,
  },
  reviewReasons: [String],

  usage: {
    calls: Number,
    inputTokens: Number,
    outputTokens: Number,
    costUsd: Number,
    models: [String],
  },
  runId: String,
  error: String,
  seconds: Number,
}, { collection: 'PurchaseBillLines', timestamps: true });

billLineSetSchema.index({ 'link.status': 1 });
billLineSetSchema.index({ 'lines.suggestion.itemId': 1 });
billLineSetSchema.index({ 'bill.supplierGstin': 1 });

const billLineRunSchema = new Schema({
  runId: { type: String, required: true, unique: true },
  args: Schema.Types.Mixed,
  billIds: [Schema.Types.ObjectId],
  startedAt: Date,
  finishedAt: Date,
  counts: Schema.Types.Mixed,
  usage: Schema.Types.Mixed,
}, { collection: 'PurchaseBillLineRuns', timestamps: true });

let connection = null;
export let BillLineSet = null;
export let BillLineRun = null;

export async function connectBillLines() {
  if (connection) return connection;
  const uri = process.env.MONGODB_URI_Billing;
  if (!uri || !String(uri).trim()) throw new Error('MONGODB_URI_Billing is not set.');
  const c = mongoose.createConnection(uri.trim(), { autoIndex: false });
  await c.asPromise();
  BillLineSet = c.model('BillLineSet', billLineSetSchema);
  BillLineRun = c.model('BillLineRun', billLineRunSchema);
  // Indexes on the two new collections only.
  await BillLineSet.createIndexes();
  await BillLineRun.createIndexes();
  connection = c;
  return c;
}

/** PurchaseBills, for reading. Callers pass a projection; nothing writes through this. */
export function purchaseBills() {
  if (!connection) throw new Error('connectBillLines() first.');
  return connection.collection('PurchaseBills');
}

export async function closeBillLines() {
  if (connection) await connection.close();
  connection = null;
  BillLineSet = null;
  BillLineRun = null;
}
