/**
 * Step 2b of a run: propose the unmapped lines again when the logic changed.
 *
 *   node --env-file=<env> refresh.mjs [--dry-run] [--force]
 *
 * An undecided line with nothing proposed is re-matched with this checkout's
 * rules when either changed since the last refresh:
 *   - the rules (the backend commit: a merged rule change), or
 *   - a reviewer's decisions (an approval or a band is evidence for the rest).
 * A line the rules now settle gets a new record through /automation/refresh;
 * the old record is left as it was, and the review page shows the new one. A
 * line they still cannot settle is left alone: no new record, no churn.
 *
 * Rules only, and only their strong evidence (STRONG below). The session
 * judged these lines once and left them as questions; a rate or a name alone
 * is what it looked past, so neither replaces its question. The first dry run
 * on live data showed why: 22 of 399 lines "settled" by rate alone, several
 * plainly wrong (Hansol art paper as a 90 GSM Hizine).
 *
 * --dry-run  print what would be refreshed; post nothing, keep the state
 * --force    re-match even when nothing changed
 *
 * Work/refresh-state.json remembers what the last refresh saw. Read-only on
 * Indus and bill history; writes only through the API. No model calls.
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, api, readJson, rulesVersion, runId } from './common.mjs';
import {
  rulesContext, applyRules, billedTypes, supplierGroup, describe,
} from './rules.mjs';

/** A reviewer's approval, the supplier's own code, CDC's own bills, the exact spec. */
const STRONG = new Set(['APPROVED_MAPPING', 'PRODUCT_CODE', 'BILL_HISTORY', 'SPEC_TUPLE']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
ensureDirs();
const STATE = path.join(DIRS.work, 'refresh-state.json');
const state = existsSync(STATE) ? readJson(STATE) : {};

const version = rulesVersion();
const [open, { proposals }] = await Promise.all([api('/open-unmapped'), api('/proposals')]);
const seen = { rulesVersion: version, lastDecisionAt: open.lastDecisionAt || null };
const changed = [];
if (state.rulesVersion !== seen.rulesVersion) changed.push(`rules ${state.rulesVersion || 'never refreshed'} -> ${seen.rulesVersion}`);
if (state.lastDecisionAt !== seen.lastDecisionAt) changed.push(`decisions up to ${seen.lastDecisionAt || '-'}`);
if (!changed.length && !force) {
  console.log(`REFRESH UNCHANGED: rules ${version}, no decision since ${seen.lastDecisionAt || '-'}; ${open.lines.length} unmapped lines left as they are`);
  process.exit(0);
}
if (version.endsWith('+local') && !dryRun) {
  console.error('REFRESH REFUSED: this checkout has uncommitted rule changes; refresh only from a committed version.');
  process.exit(1);
}

const ctx = await rulesContext();
const refreshes = [];
for (const p of open.lines) {
  const l = { ...p.line, rate: p.line.rateText ?? p.rate?.rate ?? null };
  const paper = p.materialClass === 'PAPER_BOARD' || Boolean(l.gsmFrom || l.gsmTo);
  const [typed] = billedTypes(ctx, [l]);
  const r = await applyRules(ctx, {
    site: p.site, l, paper, group: supplierGroup(p.supplier), proposals, typed,
  });
  if ((!r.proposal.itemId && !r.proposal.band) || !STRONG.has(r.proposal.method)) continue;
  refreshes.push({ proposalId: String(p._id), proposal: r.proposal });
  console.log(`${describe(p.lineNo ?? '-', l.productName, r.proposal)}  [${p.supplier?.name || ''}]`);
}

console.log(`REFRESH ${refreshes.length}/${open.lines.length} unmapped lines now settled by strong rules (${changed.join('; ') || 'forced'})`);
if (dryRun) { console.log('DRY RUN: nothing posted'); process.exit(0); }

const id = process.env.SP_RUN_ID || runId();
let added = 0;
let skipped = 0;
for (let i = 0; i < refreshes.length; i += 100) {
  const res = await api('/refresh', { method: 'POST', body: { rulesVersion: version, runId: id, refreshes: refreshes.slice(i, i + 100) } });
  added += res.added.length;
  skipped += res.skipped.length;
}
writeFileSync(STATE, JSON.stringify({ ...seen, at: new Date().toISOString(), added, skipped }, null, 1));
console.log(`REFRESHED ${added}; skipped ${skipped} (decided or refreshed meanwhile)`);
process.exit(0);
