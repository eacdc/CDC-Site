/**
 * The guard on rule changes: a change may not misidentify a line a reviewer
 * has already decided.
 *
 *   node --env-file=<env> regression.mjs --out <results.json>
 *       Re-match every decided line with the rules of THIS checkout.
 *   node regression.mjs --compare <before.json> <after.json>
 *       Exit 1, listing them, if the change broke any decided line.
 *
 * Run --out in a checkout of origin/main (before) and in the change's
 * checkout (after), then --compare. Rules only: the reviewer's own decision
 * is left out of the matching, or every line would trivially "pass".
 *
 * A change breaks a line when, for an APPROVED line,
 *   - the rules used to give the approved item and now do not, or
 *   - they now give some other item they did not give before;
 * and for a REJECTED line, when the rules now give the rejected item.
 * A line that was unmatched and still is, or newly matches correctly, is fine.
 */

import { writeFileSync } from 'node:fs';
import { api, imp, readJson, rulesVersion } from './common.mjs';

const args = process.argv.slice(2);

if (args[0] === '--compare') {
  const [before, after] = [readJson(args[1]), readJson(args[2])];
  const prior = new Map(before.lines.map((l) => [l.id, l]));
  const broken = [];
  let improved = 0;
  for (const now of after.lines) {
    const was = prior.get(now.id);
    if (!was) continue;
    if (now.status === 'APPROVED') {
      if (was.rulesItemId === now.truth && now.rulesItemId !== now.truth) broken.push({ ...now, was: was.rulesItemId, why: 'no longer finds the approved item' });
      else if (now.rulesItemId != null && now.rulesItemId !== now.truth && now.rulesItemId !== was.rulesItemId) broken.push({ ...now, was: was.rulesItemId, why: 'now gives a different wrong item' });
      else if (was.rulesItemId !== now.truth && now.rulesItemId === now.truth) improved += 1;
    } else if (now.status === 'REJECTED' && now.rulesItemId != null && now.rulesItemId === now.rejectedItemId && was.rulesItemId !== now.rejectedItemId) {
      broken.push({ ...now, was: was.rulesItemId, why: 'now gives the item a reviewer rejected' });
    }
  }
  console.log(`DECIDED LINES ${after.lines.length}; BROKEN ${broken.length}; NEWLY RIGHT ${improved} (before ${before.rulesVersion}, after ${after.rulesVersion})`);
  for (const b of broken) console.log(`  BROKEN ${b.id} "${b.productName}" (${b.supplier}): ${b.why}; was ${b.was ?? '-'}, now ${b.rulesItemId ?? '-'}, decided ${b.truth ?? `not ${b.rejectedItemId}`}`);
  process.exit(broken.length ? 1 : 0);
}

const out = args[args.indexOf('--out') + 1];
if (!args.includes('--out') || !out) { console.error('usage: regression.mjs --out <file> | --compare <before> <after>'); process.exit(2); }

const { matchLine } = await imp('supplier-portal/services/matching.js');
const { matchingCandidates } = await imp('supplier-portal/services/erp-items.js');
const { loadBillHistory } = await imp('supplier-portal/services/bill-history.js');

const { proposals } = await api('/proposals');
// A line approved as a paper band has no one item for the rules to find: the
// band is reached only through the approval itself, which is left out here.
const decided = proposals.filter((p) => (p.status === 'APPROVED' && !p.decision?.band?.quality) || p.status === 'REJECTED');
const billHistory = await loadBillHistory().catch(() => []);
const cache = new Map();
const candidates = (site, paper) => {
  const key = `${site}:${paper}`;
  if (!cache.has(key)) cache.set(key, matchingCandidates(site, { itemGroupIds: paper ? [2, 14] : [3, 4, 5, 6, 8] }));
  return cache.get(key);
};

const lines = [];
for (const p of decided) {
  const raw = { ...p.line, rate: p.rate?.rate != null ? String(p.rate.rate) : null };
  const normalised = { rate: p.rate?.rate ?? null, ratePerBaseUom: p.rate?.ratePerBaseUom ?? null, uom: p.rate?.uom ?? null };
  const group = { name: p.supplier?.name || '', gstins: p.supplier?.gstin ? [p.supplier.gstin] : [] };
  const m = await matchLine({
    site: p.site, line: { raw, normalised }, supplierItem: null, group,
    candidates: await candidates(p.site, Boolean(p.line?.gsmFrom || p.line?.gsmTo)), billHistory,
  });
  lines.push({
    id: String(p._id), status: p.status, productName: p.line?.productName, supplier: p.supplier?.name,
    truth: p.status === 'APPROVED' ? Number(p.decision?.itemId) : null,
    rejectedItemId: p.status === 'REJECTED' ? Number(p.proposal?.itemId) || null : null,
    rulesItemId: m.itemId ? Number(m.itemId) : null, method: m.method,
  });
}
writeFileSync(out, JSON.stringify({ rulesVersion: rulesVersion(), at: new Date().toISOString(), lines }, null, 1));
console.log(`RE-MATCHED ${lines.length} decided lines with rules ${rulesVersion()} -> ${out}`);
process.exit(0);
