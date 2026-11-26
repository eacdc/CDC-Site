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
import { api, readJson, rulesVersion, runId } from './common.mjs';
import {
  rulesContext, applyRules, billedTypes, gsmNumber, supplierGroup, describe,
} from './rules.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: match.mjs <reading.json>'); process.exit(2); }
const reading = readJson(file);
reading.lines = (reading.lines || []).map((l) => ({ ...l, gsmFrom: gsmNumber(l.gsmFrom), gsmTo: gsmNumber(l.gsmTo) }));
const dir = path.dirname(file);

const isPaper = (l) => reading.materialClass === 'PAPER_BOARD' || Boolean(l.gsmFrom || l.gsmTo);

const [{ proposals }, ctx] = await Promise.all([api('/proposals'), rulesContext()]);
const group = supplierGroup(reading.supplier);
const typed = billedTypes(ctx, reading.lines);

const lines = [];
const judge = [];
for (const [i, l] of reading.lines.entries()) {
  const site = l.site || reading.site;
  if (!site) throw new Error(`Line ${l.lineNo ?? i + 1} has no site, and neither does the reading.`);
  const r = await applyRules(ctx, { site, l, paper: isPaper(l), group, proposals, typed: typed[i] });
  lines.push({ lineNo: l.lineNo ?? i + 1, site, line: r.line, rate: r.rate, proposal: r.proposal });
  if (r.judge) judge.push({ index: lines.length - 1, lineNo: l.lineNo ?? i + 1, site, ...r.judge });
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
const settled = lines.filter((l) => l.proposal.itemId || l.proposal.band).length;
console.log(`MATCHED ${settled}/${lines.length} by rules; ${judge.length} to judge -> ${path.join(dir, 'judge.json')}`);
for (const l of lines) console.log(describe(l.lineNo, l.line.productName, l.proposal));
process.exit(0);
