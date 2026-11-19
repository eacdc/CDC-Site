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
import { decideProposal, currentProposals, lineKey } from '../models/proposals.js';
import { SITES } from '../config/constants.js';
import { sha256Of } from './quotes.js';
import { getItem, paperItemsInGsmRange } from './erp-items.js';
import {
  PAPER_GROUP_IDS, cleanBand, itemInBand, bandLabel, bandChoices,
} from './paper/band.js';
import { uploadBuffer, viewUrl } from '../../lib/r2-storage.js';

const str = () => z.string().trim().max(2000).nullish();
const num = () => z.number().finite().nullish();

const EvidenceSchema = z.object({ kind: z.string().max(40), text: z.string().max(2000) });

const ProposalSchema = z.object({
  itemId: z.number().int().positive().nullish(),
  itemName: str(),
  method: z.enum(['APPROVED_MAPPING', 'PRODUCT_CODE', 'BILL_HISTORY', 'RATE_ANCHOR', 'SPEC_TUPLE',
    'NAME_SIMILARITY', 'JUDGEMENT', 'NONE']),
  confidence: z.number().min(0).max(1).nullish(),
  rationale: str(),
  evidence: z.array(EvidenceSchema).max(20).default([]),
  alternatives: z.array(z.object({ itemId: z.number().int(), itemName: str(), lastPaidRate: num() })).max(8).default([]),
  question: str(),
  // Only ever a band a reviewer approved for this wording: the run proposes
  // it again, it does not invent one (paper/band.js).
  band: z.object({
    quality: z.string().trim().min(1).max(200),
    mills: z.array(z.string().trim().max(200)).max(50).default([]),
    groupIds: z.array(z.number().int()).max(2).default([]),
    gsmFrom: z.number().positive(),
    gsmTo: z.number().positive(),
    itemCount: z.number().int().nullish(),
  }).nullish(),
});

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
  proposal: ProposalSchema,
});

/**
 * Undecided lines proposed again after the rules changed. Only the proposal:
 * the line, its rate and its quote are copied from the record it refreshes,
 * because what the quote says does not change with the rules.
 */
export const RefreshPayloadSchema = z.object({
  rulesVersion: z.string().trim().min(1).max(100),
  runId: z.string().trim().min(1).max(100),
  refreshes: z.array(z.object({
    proposalId: z.string().regex(/^[0-9a-f]{24}$/),
    proposal: ProposalSchema,
  })).max(1000),
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
    proposal: { ...l.proposal, itemId: l.proposal.itemId ?? null, band: l.proposal.band ?? null },
    rulesVersion: data.rulesVersion,
    runId: data.runId,
    status: 'UNAPPROVED',
  }));
  if (proposals.length) await MappingProposal.insertMany(proposals, { ordered: true });
  return { autoQuoteId: quote._id, lines: proposals.length };
}

/** Is this record the one that stands for its line, and still undecided? */
async function standingUndecided(p) {
  const key = lineKey(p);
  const line = await MappingProposal.find({ $or: [{ _id: key }, { refreshOf: key }] })
    .select('_id refreshOf status createdAt').lean();
  const [standing] = currentProposals(line);
  return standing?.status === 'UNAPPROVED' && String(standing._id) === String(p._id);
}

/**
 * Propose undecided lines again after the rules changed. Each refresh is a
 * new record carrying the old record's line, rate and quote, and the new
 * proposal; the old record is left as it was. Skipped, not refused, when the
 * line was decided or refreshed in the meantime: a reviewer's decision wins.
 */
export async function recordRefresh(payload) {
  await ensureSupplierPortalReady();
  const data = RefreshPayloadSchema.parse(payload);
  const added = [];
  const skipped = [];
  for (const r of data.refreshes) {
    const old = await MappingProposal.findById(r.proposalId).lean();
    if (!old) throw fail(404, `Proposal ${r.proposalId} not found.`);
    if (!(await standingUndecided(old))) { skipped.push(r.proposalId); continue; }
    const doc = await MappingProposal.create({
      autoQuoteId: old.autoQuoteId,
      site: old.site,
      supplier: old.supplier,
      lineNo: old.lineNo,
      line: old.line,
      rate: old.rate,
      proposal: { ...r.proposal, itemId: r.proposal.itemId ?? null, band: r.proposal.band ?? null },
      rulesVersion: data.rulesVersion,
      runId: data.runId,
      refreshOf: lineKey(old),
      status: 'UNAPPROVED',
    });
    added.push({ proposalId: r.proposalId, refreshedAs: doc._id });
  }
  return { added, skipped };
}

/**
 * The undecided lines with nothing proposed, as they stand, with their
 * quote's material class: what a refresh looks at. `lastDecisionAt` is when a
 * reviewer last decided anything, since a decision changes what the rules
 * find too.
 */
export async function openUnmapped({ sites = SITES } = {}) {
  await ensureSupplierPortalReady();
  const all = await MappingProposal.find({ site: { $in: sites } })
    .select('autoQuoteId site supplier lineNo line rate proposal rulesVersion refreshOf status decision.at createdAt').lean();
  const lastDecisionAt = all.reduce((at, p) => (p.decision?.at && (!at || p.decision.at > at) ? p.decision.at : at), null);
  const open = currentProposals(all).filter((p) => p.status === 'UNAPPROVED' && !p.proposal?.itemId && !p.proposal?.band?.quality);
  const classes = new Map((await AutoQuote.find({ _id: { $in: [...new Set(open.map((p) => String(p.autoQuoteId)))] } })
    .select('materialClass').lean()).map((q) => [String(q._id), q.materialClass || null]));
  return {
    lastDecisionAt,
    lines: open.map((p) => ({ ...p, materialClass: classes.get(String(p.autoQuoteId)) ?? null })),
  };
}

/**
 * The proposals that stand for each line, for these sites, for the run's
 * approved-first matching. Records a refresh replaced are left out, so an
 * old guess does not count as evidence twice.
 */
export async function proposalsForMatching({ sites = SITES } = {}) {
  await ensureSupplierPortalReady();
  return currentProposals(await MappingProposal.find({ site: { $in: sites } })
    .select('site supplier line rate proposal.itemId proposal.itemName proposal.band refreshOf status decision createdAt')
    .lean());
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

/** Quotes with how many of their lines are still waiting. A refreshed line counts once. */
export async function listQuotes({ site = null, open = true, limit = 100 } = {}) {
  await ensureSupplierPortalReady();
  const lines = currentProposals(await MappingProposal.find(site ? { site } : {})
    .select('autoQuoteId refreshOf status createdAt').lean());
  const byQuote = new Map();
  for (const p of lines) {
    const c = byQuote.get(String(p.autoQuoteId)) || { _id: p.autoQuoteId, total: 0, unapproved: 0 };
    c.total += 1;
    if (p.status === 'UNAPPROVED') c.unapproved += 1;
    byQuote.set(String(p.autoQuoteId), c);
  }
  const counts = [...byQuote.values()];
  const quotes = await AutoQuote.find({ _id: { $in: counts.filter((c) => !open || c.unapproved > 0).map((c) => c._id) } })
    .sort({ createdAt: -1 }).limit(limit).lean();
  return quotes.map((q) => ({ ...q, total: byQuote.get(String(q._id))?.total || 0, unapproved: byQuote.get(String(q._id))?.unapproved || 0 }));
}

/** One quote, its file, and the proposal that stands for each line. */
export async function quoteForReview(id) {
  await ensureSupplierPortalReady();
  const quote = await AutoQuote.findById(id).lean();
  if (!quote) throw fail(404, 'Quote not found.');
  const proposals = currentProposals(await MappingProposal.find({ autoQuoteId: quote._id }).lean())
    .sort((a, b) => ((a.lineNo ?? Infinity) - (b.lineNo ?? Infinity)) || lineKey(a).localeCompare(lineKey(b)));
  return { quote: { ...quote, fileUrl: await viewUrl(quote.fileKey, 3600) }, proposals };
}

/** The GSM range a paper line states, or the reviewer's own when it states none. */
function gsmRange(line = {}, { gsmFrom, gsmTo } = {}) {
  const from = Number(gsmFrom ?? line.gsmFrom ?? line.gsmTo);
  const to = Number(gsmTo ?? line.gsmTo ?? from);
  return Number.isFinite(from) && from > 0 ? { gsmFrom: from, gsmTo: Number.isFinite(to) && to >= from ? to : from } : null;
}

/**
 * What a reviewer can approve a paper line as: the Indus qualities in its GSM
 * range, their mills, and how many sheet and reel items each covers.
 */
export async function bandChoicesFor(id, override = {}) {
  await ensureSupplierPortalReady();
  const p = await MappingProposal.findById(id).select('site line').lean();
  if (!p) throw fail(404, 'Proposal not found.');
  const range = gsmRange(p.line, override);
  if (!range) throw fail(400, 'This line states no GSM: give the range to look in.');
  const items = await paperItemsInGsmRange(p.site, range);
  return { ...range, site: p.site, choices: bandChoices(items) };
}

/** The Indus items a band covers right now, a few of them named, for the reviewer to check. */
export async function previewBand(id, input) {
  await ensureSupplierPortalReady();
  const p = await MappingProposal.findById(id).select('site').lean();
  if (!p) throw fail(404, 'Proposal not found.');
  const band = cleanBand(input);
  const items = (await paperItemsInGsmRange(p.site, { ...band, itemGroupIds: band.groupIds })).filter((it) => itemInBand(it, band));
  return {
    band, label: bandLabel(band), itemCount: items.length,
    sample: items.slice(0, 12).map((it) => ({ itemId: Number(it.ItemID), itemName: it.ItemName, gsm: it.GSM, mill: it.Manufecturer })),
  };
}

/**
 * A reviewer's decision. A changed item must exist in Indus at that site, so a
 * typo cannot become an approved mapping; a band must cover at least one item,
 * for the same reason. Only the record that stands for its line can be
 * decided, so a reviewer looking at an old page cannot decide a replaced guess.
 */
export async function decide({ id, action, itemId, band = null, note, actor }) {
  await ensureSupplierPortalReady();
  const target = await MappingProposal.findById(id).select('_id refreshOf status createdAt').lean();
  if (!target) throw fail(404, 'Proposal not found.');
  if (target.status === 'UNAPPROVED' && !(await standingUndecided(target))) {
    throw fail(409, 'This line was proposed again after the rules changed: reload and decide the newer proposal.');
  }
  let itemName = null;
  let checkedBand = null;
  if (action === 'CHANGE') {
    const current = await MappingProposal.findById(id).select('site').lean();
    if (!current) throw fail(404, 'Proposal not found.');
    const item = await getItem(current.site, Number(itemId));
    if (!item) throw fail(400, `Item ${itemId} is not in ${current.site}'s item master.`);
    itemName = item.ItemName;
  }
  if (action === 'BAND') {
    const preview = await previewBand(id, band || {});
    if (!preview.itemCount) throw fail(400, `No Indus item is inside ${preview.label}.`);
    checkedBand = { ...preview.band, itemCount: preview.itemCount };
  }
  const decided = await decideProposal(MappingProposal, {
    id, action, itemId, itemName, band: checkedBand, by: actor, note,
  });
  if (!decided) throw fail(409, 'This line has already been decided.');
  return decided;
}

/**
 * Approved prices for one Indus item, newest per supplier, cheapest first:
 * the comparison the portal exists for. A paper item is priced by the bands
 * approved over it as well as by lines approved as the item itself.
 */
export async function compareItem({ site, itemId }) {
  await ensureSupplierPortalReady();
  const select = 'supplier line.productName rate decision createdAt autoQuoteId';
  const direct = await MappingProposal.find({ site, status: 'APPROVED', 'decision.itemId': Number(itemId) })
    .select(select).lean();
  const item = await getItem(site, Number(itemId));
  const banded = item && PAPER_GROUP_IDS.includes(Number(item.ItemGroupID))
    ? (await MappingProposal.find({ site, status: 'APPROVED', 'decision.band.quality': { $ne: null } }).select(select).lean())
      .filter((r) => itemInBand(item, r.decision.band))
    : [];
  const rows = [...direct, ...banded].sort((a, b) => b.createdAt - a.createdAt);
  const latest = new Map();
  for (const r of rows) {
    const key = (r.supplier?.gstin || r.supplier?.name || '').toUpperCase();
    if (!latest.has(key)) latest.set(key, r);
  }
  return [...latest.values()]
    .filter((r) => Number.isFinite(r.rate?.ratePerBaseUom ?? r.rate?.rate))
    .sort((a, b) => (a.rate.ratePerBaseUom ?? a.rate.rate) - (b.rate.ratePerBaseUom ?? b.rate.rate));
}
