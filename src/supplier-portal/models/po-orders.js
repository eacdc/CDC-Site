/**
 * Purchase orders made with the Create PO tool.
 *
 * One record per PO the tool accepts. A PO that free floor stock already
 * covers waits here as AWAITING_APPROVAL until a photo of its signed approval
 * page is uploaded; that upload approves it and it is written to the ERP. A PO
 * that needs no approval is written at once. Either way the ERP voucher it
 * became is kept here, which is how the Purchase orders tab tells the tool's
 * POs from the ERP's own.
 *
 * `request` is what the buyer sent; `lines` and `totals` are what the server
 * worked out from it and wrote. When an approved PO is saved later, the server
 * works the lines out again from `request`, so a price withdrawn or a
 * requisition ordered elsewhere in between stops the save.
 */

import mongoose from 'mongoose';
import { SITES } from '../config/constants.js';

const { Schema } = mongoose;

const stockRowSchema = new Schema({
  itemId: Number,
  itemName: String,
  matchType: String,
  gsmDiff: Number,
  sizeWDiff: Number,
  sizeLDiff: Number,
  freeKg: Number,
  clientTag: String,
  clientTagName: String,
  coversAlone: Boolean,
}, { _id: false });

const lineSchema = new Schema({
  itemId: { type: Number, required: true },
  itemCode: String,
  itemName: String,
  itemGroupId: Number,
  groupName: String,
  itemDescription: String,
  stockUnit: String,
  purchaseUnit: String,
  qty: Number, // as typed: sheets for sheet paper bought by kg, else purchase units
  stockQty: Number,
  poQty: Number, // in the purchase unit, as the ERP stores it
  packs: Number,
  qtyPerPack: Number,
  rate: Number,
  approvedRate: Number,
  proposalId: String,
  // What the rate rests on: APPROVED (a portal price), LAST_PAID (the
  // fallback: at most the last rate paid to this supplier, on poNo), KEPT
  // (a line of an edited PO left at its rate) or OVERRIDE (the buyer ignored
  // the price rules, with an optional `reason`; `rate` is the price they would have allowed).
  priceBasis: { kind: String, rate: Number, poNo: String, poDate: Date, proposalId: String, reason: String },
  amount: Number,
  gstPct: Number,
  cgstPct: Number,
  sgstPct: Number,
  igstPct: Number,
  cgst: Number,
  sgst: Number,
  igst: Number,
  net: Number,
  productHsnId: Number,
  hsnCode: String,
  expectedDate: String, // yyyy-mm-dd
  clientId: Number,
  clientName: String,
  reqRefs: [{
    _id: false,
    reqLineId: String,
    requisitionTransactionId: Number,
    reqNo: String,
    jobRef: String,
    jobContentsId: String,
    qty: Number,
  }],
  kg: Number,
  floorFreeKg: Number,
  onOrderFreeKg: Number,
  needsApproval: Boolean,
  topStock: [stockRowSchema],
}, { _id: false });

export const poOrderSchema = new Schema({
  site: { type: String, enum: SITES, required: true, index: true },
  // CREATE: a new PO. EDIT: a change to the ERP PO in erp.transactionId,
  // kept here only while it waits for approval (and as the record after).
  kind: { type: String, enum: ['CREATE', 'EDIT'], default: 'CREATE' },
  status: {
    type: String,
    enum: ['AWAITING_APPROVAL', 'SAVED', 'SAVE_FAILED', 'CANCELLED', 'DELETED'],
    required: true,
    index: true,
  },
  request: { type: Schema.Types.Mixed, required: true },
  supplier: { ledgerId: Number, name: String, gstin: String, state: String, city: String },
  deliveryAddress: String,
  lines: [lineSchema],
  totals: { type: Schema.Types.Mixed },
  createdBy: { email: String, erpUserId: Number, name: String },
  approval: {
    needed: { type: Boolean, default: false },
    reason: String,
    signedImage: { key: String, contentType: String, bytes: Number, fileName: String },
    approvedAt: Date,
    approvedBy: { email: String, name: String },
  },
  erp: {
    transactionId: Number,
    voucherNo: String,
    voucherDate: Date,
    savedAt: Date,
    // Set when another PO turned up with the same number after ours was
    // written: the ERP's own screen reads the next number without a lock.
    duplicateOf: [String],
  },
  lastError: String,
  cancelled: { at: Date, by: String },
  deleted: { at: Date, by: String, reason: String },
  // On an EDIT: the PO as it stood, and what the edit changes.
  editOf: { voucherNo: String, changes: [String] },
}, { collection: 'sp_poOrders', timestamps: true });

poOrderSchema.index({ site: 1, createdAt: -1 });
poOrderSchema.index({ site: 1, 'erp.transactionId': 1 });
