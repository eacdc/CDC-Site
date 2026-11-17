/**
 * Step 3 of a run: apply the matching rules to a reading.
 *
 *   node --env-file=<env> match.mjs <Work/xxxx/reading.json>
 *
 * The reading is what the session read off the document (RUN.md, step 2).
 * This applies the same rules the portal uses - approved decisions first, then
 * the supplier's bills, rate, spec and name - and writes:
 *
 *   payload.json   ready to submit; lines the rules settled carry their item,
 *                  the rest have method NONE and their evidence attached
 *   judge.json     the unsettled lines with everything known about each, for
 *                  the session to judge before submitting
 *
 * Read-only: Indus, bill history and the proposals API. No model calls.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { api, imp, readJson, rulesVersion, runId } from './common.mjs';

const { normaliseLine } = await imp('supplier-portal/services/quotes.js');
const { matchLine } = await imp('supplier-portal/services/matching.js');
const { matchingCandidates, getItem } = await imp('supplier-portal/services/erp-items.js');
const { loadBillHistory } = await imp('supplier-portal/services/bill-history.js');
const { quoteSpecTuple, buildSpecKey, specKeyString, itemMatchesSpecKey } = await imp('supplier-portal/lib/spec.js');
const { resolvePaperType } = await imp('supplier-portal/config/paper-vocabulary.js');
const { applyBilledTypes } = await imp('supplier-portal/services/paper/billed-types.js');

const file = process.argv[2];
if (!file) { console.error('usage: match.mjs <reading.json>'); process.exit(2); }
const reading = readJson(file);
const dir = path.dirname(file);

const PAPER_GROUPS = [2, 14];
const OTHER_GROUPS = [3, 4, 5, 6, 8];
const isPaper = (l) => reading.materialClass === 'PAPER_BOARD' || Boolean(l.gsmFrom || l.gsmTo);

const [{ proposals }, billHistory] = await Promise.all([api('/proposals'), loadBillHistory().catch(() => [])]);
const group = reading.supplier?.name || reading.supplier?.gstin
  ? { name: reading.supplier.name || '', gstins: reading.supplier.gstin ? [reading.supplier.gstin] : [] }
  : null;

const candidateCache = new Map();
const candidatesFor = (site, paper) => {
  const key = `${site}:${paper}`;
  if (!candidateCache.has(key)) candidateCache.set(key, matchingCandidates(site, { itemGroupIds: paper ? PAPER_GROUPS : OTHER_GROUPS }));
  return candidateCache.get(key);
};

// Paper types the bills settle, as the paper reader would.
const typed = applyBilledTypes({ lines: reading.lines.map((l) => ({ ...l, paperType: resolvePaperType(l.productName) })) }, billHistory).payload.lines;

const lines = [];
const judge = [];
for (const [i, l] of reading.lines.entries()) {
  const site = l.site || reading.site;
  if (!site) throw new Error(`Line ${l.lineNo ?? i + 1} has no site, and neither does the reading.`);
  const raw = {
    productName: l.productName, productCode: l.productCode || null, brand: l.brand || null, grade: l.grade || null,
    gsmFrom: l.gsmFrom ?? null, gsmTo: l.gsmTo ?? null, packSize: l.packSize || null,
    rate: l.rate != null ? String(l.rate) : null, uom: l.uom || null, text: l.notes || null,
  };
  const normalised = normaliseLine(raw, new Map());
  const paper = isPaper(l);
  const candidates = await candidatesFor(site, paper);
  const m = await matchLine({ site, line: { raw, normalised }, supplierItem: null, group, candidates, billHistory, proposals });

  let itemName = null;
  if (m.itemId) {
    itemName = candidates.find((c) => Number(c.ItemID) === Number(m.itemId))?.ItemName
      || (await getItem(site, m.itemId))?.ItemName || null;
  }

  let specItems = null;
  if (paper) {
    const key = buildSpecKey(quoteSpecTuple({ raw, normalised }));
    if (key.kind !== 'ITEM') {
      const hits = candidates.filter((c) => itemMatchesSpecKey(c, key));
      specItems = { key: specKeyString(key), count: hits.length, items: hits.slice(0, 10).map((c) => ({ itemId: c.ItemID, itemName: c.ItemName, lastPaidRate: c.LastPaidRate })) };
    }
  }

  const ev = m.proposalEvidence || {};
  const evidence = [
    ...(m.rationale ? [{ kind: m.method === 'BILL_HISTORY' ? 'BILL' : m.method === 'RATE_ANCHOR' ? 'RATE' : m.method === 'APPROVED_MAPPING' ? 'APPROVED' : 'RULES', text: m.rationale }] : []),
    ...(ev.approvedElsewhere || []).map((a) => ({ kind: 'APPROVED', text: `${a.supplier} "${a.wording}" was approved as ${a.itemId} ${a.itemName || ''}` })),
    ...(ev.unapproved || []).map((a) => ({ kind: 'UNAPPROVED', text: `${a.supplier} "${a.wording}" was proposed as ${a.itemId} ${a.itemName || ''}, not yet approved` })),
    ...(typed[i]?.paperTypeBasis === 'BILLED' ? [{ kind: 'BILL', text: `Paper type ${typed[i].paperType} from CDC's bills for "${typed[i].paperTypeBilledAs}"` }] : []),
  ].slice(0, 20);
  const alternatives = (m.rankedCandidates || []).slice(0, 5)
    .filter((c) => Number(c.itemId) !== Number(m.itemId))
    .map((c) => ({ itemId: Number(c.itemId), itemName: c.itemName || null, lastPaidRate: c.lastPaidRate ?? null }));

  lines.push({
    lineNo: l.lineNo ?? i + 1,
    site,
    line: {
      productName: l.productName, productCode: l.productCode || null, brand: l.brand || null, grade: l.grade || null,
      gsmFrom: l.gsmFrom ?? null, gsmTo: l.gsmTo ?? null, sizeText: l.sizeText || null,
      packSize: l.packSize || null, rateText: raw.rate, uom: l.uom || null, notes: l.notes || null,
    },
    rate: { rate: normalised.rate ?? null, uom: normalised.uom ?? null, ratePerBaseUom: normalised.ratePerBaseUom ?? null, flags: normalised.flags || [] },
    proposal: {
      itemId: m.itemId ? Number(m.itemId) : null,
      itemName,
      method: m.method || 'NONE',
      confidence: m.confidence ?? null,
      rationale: m.rationale || null,
      evidence,
      alternatives,
      question: null,
    },
  });
  if (!m.itemId) {
    judge.push({
      index: lines.length - 1, lineNo: l.lineNo ?? i + 1, site, read: l, rate: lines.at(-1).rate,
      paperType: typed[i]?.paperType || null, rulesSaid: m.rationale, queueReason: m.queueReason,
      candidates: (m.rankedCandidates || []).slice(0, 8), billedAs: m.billedAs || {}, specItems,
      approvedElsewhere: ev.approvedElsewhere || [], unapproved: ev.unapproved || [],
    });
  }
}

const payload = {
  sha256: reading.sha256,
  fileName: reading.fileName,
  portalDocumentId: reading.source?.portalDocumentId || null,
  site: reading.site || null,
  supplier: reading.supplier || {},
  documentDate: reading.documentDate || null,
  effectiveFrom: reading.effectiveFrom || null,
  materialClass: reading.materialClass || null,
  terms: reading.terms || null,
  questions: reading.questions || [],
  rulesVersion: rulesVersion(),
  runId: process.env.SP_RUN_ID || runId(),
  lines,
};
writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(payload, null, 2));
writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(judge, null, 2));
const settled = lines.filter((l) => l.proposal.itemId).length;
console.log(`MATCHED ${settled}/${lines.length} by rules; ${judge.length} to judge -> ${path.join(dir, 'judge.json')}`);
for (const l of lines) console.log(`  ${String(l.lineNo).padStart(3)} ${l.line.productName.slice(0, 45).padEnd(45)} ${l.proposal.method.padEnd(16)} ${l.proposal.itemId ?? '-'} ${l.proposal.itemName || ''}`);
process.exit(0);
