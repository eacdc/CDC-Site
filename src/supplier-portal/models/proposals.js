/**
 * Mapping proposals: what the scheduled run thinks each quote line is.
 *
 * The scheduled run (a Claude session on CDC's PC, not an API call from this
 * server) reads each new quote, proposes an Indus item for every line, and
 * sends both here through the automation API. Nothing it proposes is used for
 * a price until a person approves it.
 *
 * APPEND-ONLY, BY CONSTRUCTION. Both collections take inserts and nothing
 * else - no update, replace or delete, from any caller - with one exception:
 * a reviewer's decision on a proposal that has not been decided yet. That one
 * change goes through `decideProposal`, which holds the only key the guard
 * accepts, and it may set the decision fields and nothing else. A proposal is
 * decided once; a second decision is refused, not applied over the first.
 *
 * This is a code-level guard on the Mongo user the server already has, as CDC
 * chose. It stops every path through Mongoose. The raw driver behind
 * `Model.collection` is not covered, which is why nothing in this module hands
 * it out.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { SITES } from '../config/constants.js';

const { Schema } = mongoose;

/**
 * Held only here. A write made inside this scope is the reviewer's decision;
 * nothing outside `decideProposal` can enter it.
 */
const decisionScope = new AsyncLocalStorage();

const WRITE_HOOKS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
];

/**
 * Only these may change, and only on an undecided proposal. `updatedAt` and
 * a `$setOnInsert` of `createdAt` are Mongoose's timestamps, added to every
 * update; nothing else rides along.
 */
const DECISION_FIELDS = ['status', 'decision', 'updatedAt'];

function refuse(what) {
  const err = new Error(`${what} is not allowed: this collection only takes new records.`);
  err.status = 403;
  return err;
}

/**
 * The guard. Every query-level write is refused unless it carries the
 * decision key, and a decision may only $set the decision fields on a
 * document still UNAPPROVED.
 */
function appendOnly(schema, { decidable = false } = {}) {
  schema.pre(WRITE_HOOKS, function guard() {
    if (!decidable || decisionScope.getStore() !== true || this.op !== 'updateOne') throw refuse(`${this.op}`);
    const update = this.getUpdate() || {};
    const ops = Object.keys(update).filter((op) => !(op === '$setOnInsert'
      && Object.keys(update.$setOnInsert || {}).every((k) => k === 'createdAt')));
    if (ops.length !== 1 || ops[0] !== '$set') throw refuse('A decision other than $set');
    const fields = Object.keys(update.$set).map((k) => k.split('.')[0]);
    if (!fields.every((f) => DECISION_FIELDS.includes(f))) throw refuse(`Changing ${fields.join(', ')}`);
    if (this.getFilter()?.status !== 'UNAPPROVED') throw refuse('A decision on a decided proposal');
  });
  // A document's own save/delete: new documents only.
  schema.pre('save', function guardSave() {
    if (!this.isNew) throw refuse('Saving over an existing record');
  });
  schema.pre('deleteOne', { document: true, query: false }, () => { throw refuse('deleteOne'); });
}

/** Whole-collection writes that skip the query hooks are taken away from the model. */
export function lockModel(model) {
  for (const name of ['bulkWrite', 'bulkSave', 'updateMany', 'deleteMany', 'replaceOne', 'findByIdAndUpdate',
    'findByIdAndDelete', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace']) {
    Object.defineProperty(model, name, { value: () => { throw refuse(name); }, configurable: false, writable: false });
  }
  return model;
}

const evidenceSchema = new Schema({
  kind: String, // BILL, RATE, SPEC, NAME, APPROVED, UNAPPROVED, JUDGEMENT
  text: String,
}, { _id: false });

/**
 * One file the scheduled run read. The file itself is in R2; `fileKey` finds
 * it for the review page.
 */
export const autoQuoteSchema = new Schema({
  sha256: { type: String, required: true, unique: true },
  fileName: String,
  fileKey: { type: String, required: true },
  contentType: String,
  // A quote uploaded through the portal instead of dropped in the folder.
  portalDocumentId: { type: Schema.Types.ObjectId, default: null },

  site: { type: String, enum: SITES, default: null },
  supplier: { name: String, gstin: String },
  documentDate: String,
  effectiveFrom: String,
  materialClass: String,
  terms: Schema.Types.Mixed,

  /** What the document left open: plant, a paper type, a unit. For the reviewer. */
  questions: [{ kind: String, text: String, lineNos: [Number], _id: false }],
  /** Which version of the rules and instructions produced this reading. */
  rulesVersion: { type: String, required: true },
  runId: { type: String, required: true },
  lineCount: Number,
}, { collection: 'sp_autoQuotes', timestamps: true });
appendOnly(autoQuoteSchema);

/** One quote line and the item proposed for it. */
export const mappingProposalSchema = new Schema({
  autoQuoteId: { type: Schema.Types.ObjectId, ref: 'SpAutoQuote', required: true, index: true },
  site: { type: String, enum: SITES, required: true },
  supplier: { name: String, gstin: String },
  lineNo: Number,

  /** The line exactly as read. */
  line: {
    productName: { type: String, required: true },
    productCode: String, brand: String, grade: String,
    gsmFrom: Number, gsmTo: Number, sizeText: String,
    packSize: String, rateText: String, uom: String, notes: String,
  },
  /** The rate on a comparable basis, and how it got there. */
  rate: { rate: Number, uom: String, ratePerBaseUom: Number, flags: [String] },

  /** Null itemId means no item: a new product, or a question first. */
  proposal: {
    itemId: { type: Number, default: null },
    itemName: String,
    method: String, // APPROVED_MAPPING, PRODUCT_CODE, BILL_HISTORY, RATE_ANCHOR, SPEC_TUPLE, NAME_SIMILARITY, JUDGEMENT, NONE
    confidence: Number,
    rationale: String,
    evidence: [evidenceSchema],
    alternatives: [{ itemId: Number, itemName: String, lastPaidRate: Number, _id: false }],
    question: String,
  },
  rulesVersion: { type: String, required: true },
  runId: { type: String, required: true },

  status: { type: String, enum: ['UNAPPROVED', 'APPROVED', 'REJECTED'], default: 'UNAPPROVED', index: true },
  decision: {
    action: { type: String, enum: ['APPROVE', 'CHANGE', 'REJECT'] },
    itemId: Number, // what it is, after the decision: the proposal's, or the reviewer's correction
    itemName: String,
    by: String,
    at: Date,
    note: String,
  },
}, { collection: 'sp_mappingProposals', timestamps: true });
mappingProposalSchema.index({ site: 1, status: 1, 'decision.itemId': 1 });
mappingProposalSchema.index({ 'supplier.gstin': 1, status: 1 });
appendOnly(mappingProposalSchema, { decidable: true });

/**
 * A reviewer's decision: the one change these collections accept.
 *
 * APPROVE keeps the proposed item; CHANGE names a different one; REJECT says
 * no item from this proposal is right. Refused when the proposal is already
 * decided, so two reviewers cannot overwrite each other.
 *
 * @returns the decided proposal, or null when it was already decided
 */
export async function decideProposal(Model, { id, action, itemId = null, itemName = null, by, note = null }) {
  if (!['APPROVE', 'CHANGE', 'REJECT'].includes(action)) throw refuse(`Action ${action}`);
  if (!by) throw refuse('A decision with no reviewer');
  const current = await Model.findById(id).lean();
  if (!current) return null;
  const chosen = action === 'CHANGE' ? Number(itemId) : (action === 'APPROVE' ? current.proposal?.itemId : null);
  if (action !== 'REJECT' && !Number.isFinite(chosen)) {
    const err = new Error(action === 'CHANGE' ? 'Changing needs the Indus ItemID.' : 'There is no proposed item to approve; choose one.');
    err.status = 400;
    throw err;
  }
  const decision = {
    action, itemId: action === 'REJECT' ? null : chosen,
    itemName: action === 'CHANGE' ? itemName : (action === 'APPROVE' ? current.proposal?.itemName : null),
    by, at: new Date(), note,
  };
  // exec() inside the scope: a Query only runs when awaited, and awaited
  // outside it the guard would never see the decision.
  const res = await decisionScope.run(true, () => Model.updateOne(
    { _id: id, status: 'UNAPPROVED' },
    { $set: { status: action === 'REJECT' ? 'REJECTED' : 'APPROVED', decision } },
  ).exec());
  if (!res.modifiedCount) return null;
  return Model.findById(id).lean();
}
