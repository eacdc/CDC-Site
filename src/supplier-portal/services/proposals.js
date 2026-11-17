/**
 * Quotes read by the scheduled run, and the item proposed for each line.
 *
 * The run is a Claude session on CDC's PC, started hourly by a scheduled task.
 * It reads the folder, matches lines with the same rules as the portal plus
 * its own judgement, and posts the result here. It never writes to Mongo
 * itself, and this server makes no model calls for it.
 *
 * Everything written here is a new record (models/proposals.js). The only
 * change ever made to one is a reviewer's decision.
 */

import { z } from 'zod';
import {
  ensureSupplierPortalReady, AutoQuote, MappingProposal, QuoteDocument,
} from '../db/mongo.js';
import { decideProposal } from '../models/proposals.js';
import { SITES } from '../config/constants.js';
import { sha256Of } from './quotes.js';
import { getItem } from './erp-items.js';
import { uploadBuffer, viewUrl } from '../../lib/r2-storage.js';

const str = () => z.string().trim().max(2000).nullish();
const num = () => z.number().finite().nullish();

const EvidenceSchema = z.object({ kind: z.string().max(40), text: z.string().max(2000) });

const LineSchema = z.object({
  lineNo: z.number().int().nullish(),
  site: z.enum(SITES).nullish(),
  line: z.object({
    productName: z.string().trim().min(1).max(500),
    productCode: str(), brand: str(), grade: str(),
    gsmFrom: num(), gsmTo: num(), sizeText: str(),
    packSize: str(), rateText: str(), uom: str(), notes: str(),
  }),
  rate: z.object({
    rate: num(), uom: str(), ratePerBaseUom: num(), flags: z.array(z.string().max(60)).max(30).default([]),
  }).default({}),
  proposal: z.object({
    itemId: z.number().int().positive().nullish(),
    itemName: str(),
    method: z.enum(['APPROVED_MAPPING', 'PRODUCT_CODE', 'BILL_HISTORY', 'RATE_ANCHOR', 'SPEC_TUPLE',
      'NAME_SIMILARITY', 'JUDGEMENT', 'NONE']),
    confidence: z.number().min(0).max(1).nullish(),
    rationale: str(),
    evidence: z.array(EvidenceSchema).max(20).default([]),
    alternatives: z.array(z.object({ itemId: z.number().int(), itemName: str(), lastPaidRate: num() })).max(8).default([]),
    question: str(),
  }),
});

/** What the run sends with a file. Anything else is dropped, including any status. */
export const RunPayloadSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().trim().min(1).max(300),
  portalDocumentId: z.string().regex(/^[0-9a-f]{24}$/).nullish(),
  site: z.enum(SITES).nullish(),
  supplier: z.object({ name: str(), gstin: str() }).default({}),
  documentDate: str(), effectiveFrom: str(), materialClass: str(),
  terms: z.record(z.string(), z.any()).nullish(),
  questions: z.array(z.object({ kind: z.string().max(40), text: z.string().max(1000), lineNos: z.array(z.number().int()).default([]) })).max(100).default([]),
  rulesVersion: z.string().trim().min(1).max(100),
  runId: z.string().trim().min(1).max(100),
  lines: z.array(LineSchema).max(1000),
});

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Has this exact file been read before? */
export async function findBySha(sha256) {
  await ensureSupplierPortalReady();
  return AutoQuote.findOne({ sha256 }).select('_id fileName createdAt').lean();
}

/**
 * Store one run's reading of one file: the file to R2, then the quote and its
 * proposals as new records. Refused when the file was already read - a second
 * reading is not a correction, and nothing here can be overwritten.
 */
export async function recordRun({ file, payload }) {
  await ensureSupplierPortalReady();
  const data = RunPayloadSchema.parse(payload);
  if (!file?.buffer?.length) throw fail(400, 'The quote file is required.');
  if (sha256Of(file.buffer) !== data.sha256) throw fail(400, 'The file does not match its sha256.');
  if (await findBySha(data.sha256)) throw fail(409, 'This file has already been read.');
  if (!data.site && data.lines.some((l) => !l.site)) {
    throw fail(400, 'Every line needs a site: give the quote one, or each line its own.');
  }

  const stored = await uploadBuffer({ folder: 'supplier-portal/auto-quotes', buffer: file.buffer, contentType: file.mimetype });
  const quote = await AutoQuote.create({
    sha256: data.sha256,
    fileName: data.fileName,
    fileKey: stored.key || stored,
    contentType: file.mimetype,
    portalDocumentId: data.portalDocumentId || null,
    site: data.site || null,
    supplier: data.supplier,
    documentDate: data.documentDate, effectiveFrom: data.effectiveFrom, materialClass: data.materialClass,
    terms: data.terms || null,
    questions: data.questions,
    rulesVersion: data.rulesVersion,
    runId: data.runId,
    lineCount: data.lines.length,
  });

  // Status is not the run's to set: every proposal starts UNAPPROVED.
  const proposals = data.lines.map((l) => ({
    autoQuoteId: quote._id,
    site: l.site || data.site,
    supplier: data.supplier,
    lineNo: l.lineNo ?? null,
    line: l.line,
    rate: l.rate,
    proposal: { ...l.proposal, itemId: l.proposal.itemId ?? null },
    rulesVersion: data.rulesVersion,
    runId: data.runId,
    status: 'UNAPPROVED',
  }));
  if (proposals.length) await MappingProposal.insertMany(proposals, { ordered: true });
  return { autoQuoteId: quote._id, lines: proposals.length };
}

/** Every proposal for these sites, for the run's approved-first matching. */
export async function proposalsForMatching({ sites = SITES } = {}) {
  await ensureSupplierPortalReady();
  return MappingProposal.find({ site: { $in: sites } })
    .select('site supplier line rate proposal.itemId proposal.itemName status decision createdAt')
    .lean();
}

/**
 * Quotes uploaded through the portal that no run has read yet. The portal
 * makes no model calls any more, so these wait for the next scheduled run.
 */
export async function pendingPortalUploads({ limit = 50 } = {}) {
  await ensureSupplierPortalReady();
  const read = await AutoQuote.find({ portalDocumentId: { $ne: null } }).distinct('portalDocumentId');
  const docs = await QuoteDocument.find({
    _id: { $nin: read }, storageKey: { $ne: null }, status: { $nin: ['REJECTED', 'DELETED'] },
  }).sort({ createdAt: 1 }).limit(limit)
    .select('_id originalFilename mimeType sha256 storageKey plantScope createdAt').lean();
  return Promise.all(docs.map(async (d) => ({
    portalDocumentId: d._id, fileName: d.originalFilename, mimeType: d.mimeType, sha256: d.sha256,
    plantScope: d.plantScope || [], uploadedAt: d.createdAt, downloadUrl: await viewUrl(d.storageKey, 900),
  })));
}

// ── For reviewers ──────────────────────────────────────────────────────────

/** Quotes with how many of their lines are still waiting. */
export async function listQuotes({ site = null, open = true, limit = 100 } = {}) {
  await ensureSupplierPortalReady();
  const counts = await MappingProposal.aggregate([
    ...(site ? [{ $match: { site } }] : []),
    { $group: { _id: '$autoQuoteId', total: { $sum: 1 }, unapproved: { $sum: { $cond: [{ $eq: ['$status', 'UNAPPROVED'] }, 1, 0] } } } },
  ]);
  const byQuote = new Map(counts.map((c) => [String(c._id), c]));
  const quotes = await AutoQuote.find({ _id: { $in: counts.filter((c) => !open || c.unapproved > 0).map((c) => c._id) } })
    .sort({ createdAt: -1 }).limit(limit).lean();
  return quotes.map((q) => ({ ...q, total: byQuote.get(String(q._id))?.total || 0, unapproved: byQuote.get(String(q._id))?.unapproved || 0 }));
}

/** One quote, its file, and every line's proposal. */
export async function quoteForReview(id) {
  await ensureSupplierPortalReady();
  const quote = await AutoQuote.findById(id).lean();
  if (!quote) throw fail(404, 'Quote not found.');
  const proposals = await MappingProposal.find({ autoQuoteId: quote._id }).sort({ lineNo: 1, _id: 1 }).lean();
  return { quote: { ...quote, fileUrl: await viewUrl(quote.fileKey, 3600) }, proposals };
}

/**
 * A reviewer's decision. A changed item must exist in Indus at that site, so a
 * typo cannot become an approved mapping.
 */
export async function decide({ id, action, itemId, note, actor }) {
  await ensureSupplierPortalReady();
  let itemName = null;
  if (action === 'CHANGE') {
    const current = await MappingProposal.findById(id).select('site').lean();
    if (!current) throw fail(404, 'Proposal not found.');
    const item = await getItem(current.site, Number(itemId));
    if (!item) throw fail(400, `Item ${itemId} is not in ${current.site}'s item master.`);
    itemName = item.ItemName;
  }
  const decided = await decideProposal(MappingProposal, { id, action, itemId, itemName, by: actor, note });
  if (!decided) throw fail(409, 'This line has already been decided.');
  return decided;
}

/**
 * Approved prices for one Indus item, newest per supplier, cheapest first:
 * the comparison the portal exists for.
 */
export async function compareItem({ site, itemId }) {
  await ensureSupplierPortalReady();
  const rows = await MappingProposal.find({ site, status: 'APPROVED', 'decision.itemId': Number(itemId) })
    .sort({ createdAt: -1 }).select('supplier line.productName rate decision createdAt autoQuoteId').lean();
  const latest = new Map();
  for (const r of rows) {
    const key = (r.supplier?.gstin || r.supplier?.name || '').toUpperCase();
    if (!latest.has(key)) latest.set(key, r);
  }
  return [...latest.values()]
    .filter((r) => Number.isFinite(r.rate?.ratePerBaseUom ?? r.rate?.rate))
    .sort((a, b) => (a.rate.ratePerBaseUom ?? a.rate.rate) - (b.rate.ratePerBaseUom ?? b.rate.rate));
}
