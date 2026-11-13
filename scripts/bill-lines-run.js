/**
 * Supplier Portal v2, phase 1: read the item lines off CDC Bills' GRN bills.
 *
 *   node --env-file=.env scripts/bill-lines-run.js select --pool 1000 --size 200 --out sample.json
 *   node --env-file=.env scripts/bill-lines-run.js run --ids-file sample.json [--limit 5] [--concurrency 3]
 *   node --env-file=.env scripts/bill-lines-run.js run --bill <PurchaseBills _id>
 *   node --env-file=.env scripts/bill-lines-run.js rematch [--run <runId>]
 *   node --env-file=.env scripts/bill-lines-run.js report [--run <runId>]
 *
 * select  links recent bills to Indus (SQL only, no AI cost), reports the link
 *         rate, and picks a sample spread across item types.
 * run     reads each bill's invoice with Claude and saves PurchaseBillLines.
 *         Bills already done at this extractor version are skipped unless
 *         --force, so an interrupted run resumes where it stopped.
 *         --dry-run prints instead of saving.
 * rematch pairs saved lines again with the current matching rules, without
 *         reading anything again (no AI cost).
 * report  sums up what has been saved.
 *
 * Reads PurchaseBills and Indus; writes only PurchaseBillLines and
 * PurchaseBillLineRuns. Never writes to Indus.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectBillLines, closeBillLines, purchaseBills, BillLineSet, BillLineRun } from '../src/bill-lines/db.js';
import {
  BILL_PROJECTION, EXTRACTOR_VERSION, billSummary, linkBill, processBill, rematch,
} from '../src/bill-lines/extract-bill.js';
import { getProvider } from '../src/supplier-portal/services/extraction/provider.js';
import { closeWritePools } from '../src/supplier-portal/db/mssql.js';

const GROUP_BUCKET = {
  2: 'PAPER', 14: 'PAPER', 13: 'ROLL', 3: 'INK', 4: 'COATING', 5: 'FILM', 6: 'FOIL', 7: 'BOX', 8: 'OTHER',
};
const bucketOf = (groupId) => GROUP_BUCKET[groupId] || 'OTHER';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

/** Run `fn` over `items`, `n` at a time, in order of completion. */
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Stable pseudo-random order, so a sample can be reproduced. */
const shuffleKey = (id) => createHash('sha1').update(String(id)).digest('hex');

const goodBillFilter = {
  set_type: 'grn',
  is_cancelled_voucher: { $ne: true },
  'slots.supplier_invoice.pages.0': { $exists: true },
};

async function select(opts) {
  const poolSize = Number(opts.pool || 1000);
  const size = Number(opts.size || 200);
  const minPerBucket = Number(opts['min-per-type'] || 15);
  // Bills Indus cannot find from CDC Bills' values, to measure how many the re-read recovers.
  const unlinkedWanted = Number(opts.unlinked || 0);
  const out = opts.out || 'bill-lines-sample.json';

  const bills = await purchaseBills()
    .find(goodBillFilter, { projection: BILL_PROJECTION })
    .sort({ uploaded_at: -1 })
    .limit(poolSize)
    .toArray();

  const linked = [];
  const unlinked = [];
  const stats = {
    pool: bills.length, byStatus: {}, keysAgreed: 0, oneKey: {}, bySite: {}, noGstin: 0, gstinCorrected: 0, errors: 0,
  };
  let done = 0;
  await pool(bills, 6, async (bill) => {
    const s = billSummary(bill);
    if (!s.supplierGstin) stats.noGstin += 1;
    try {
      const { site, link, erpLines } = await linkBill(s);
      stats.byStatus[link.status] = (stats.byStatus[link.status] || 0) + 1;
      if (site) stats.bySite[site] = (stats.bySite[site] || 0) + 1;
      if (link.gstinCorrected && link.status === 'LINKED') stats.gstinCorrected += 1;
      if (link.status === 'NOT_FOUND') unlinked.push({ id: String(bill._id), bucket: 'UNLINKED', status: link.status, lines: 0 });
      if (link.status === 'LINKED') {
        if (link.keysAgreed) stats.keysAgreed += 1;
        else stats.oneKey[link.keys[0]] = (stats.oneKey[link.keys[0]] || 0) + 1;
      }
      if (['LINKED', 'GRN_ONLY'].includes(link.status) && erpLines.length) {
        // A bill's type is the group carrying most of its value (or most lines, for a GRN).
        const weight = new Map();
        for (const l of erpLines) {
          const b = bucketOf(l.itemGroupId);
          weight.set(b, (weight.get(b) || 0) + (l.gross ?? 1));
        }
        const bucket = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
        linked.push({ id: String(bill._id), bucket, status: link.status, lines: erpLines.length });
      }
    } catch (err) {
      stats.errors += 1;
      if (stats.errors <= 3) console.warn(`link failed for ${bill._id}: ${err.message}`);
    }
    done += 1;
    if (done % 100 === 0) console.log(`linked ${done}/${bills.length}`);
  });

  // Every type gets at least `minPerBucket` (when it has them); the rest in proportion.
  const byBucket = new Map();
  for (const b of linked.sort((x, y) => shuffleKey(x.id).localeCompare(shuffleKey(y.id)))) {
    if (!byBucket.has(b.bucket)) byBucket.set(b.bucket, []);
    byBucket.get(b.bucket).push(b);
  }
  const quota = new Map();
  const unlinkedPicked = unlinked
    .sort((x, y) => shuffleKey(x.id).localeCompare(shuffleKey(y.id)))
    .slice(0, Math.min(unlinkedWanted, size));
  let left = size - unlinkedPicked.length;
  for (const [k, list] of byBucket) {
    const q = Math.min(list.length, minPerBucket);
    quota.set(k, q);
    left -= q;
  }
  const spare = [...byBucket.entries()].map(([k, list]) => [k, list.length - quota.get(k)]);
  const spareTotal = spare.reduce((s, [, n]) => s + n, 0);
  for (const [k, n] of spare) {
    if (left <= 0 || !spareTotal) break;
    quota.set(k, quota.get(k) + Math.min(n, Math.floor((n / spareTotal) * Math.max(left, 0))));
  }
  let picked = [];
  for (const [k, list] of byBucket) picked.push(...list.slice(0, quota.get(k)));
  // Rounding leaves a few short; top up from whatever is left.
  const linkedSize = size - unlinkedPicked.length;
  const pickedIds = new Set(picked.map((p) => p.id));
  for (const b of linked) {
    if (picked.length >= linkedSize) break;
    if (!pickedIds.has(b.id)) { picked.push(b); pickedIds.add(b.id); }
  }
  picked = [...picked.slice(0, linkedSize), ...unlinkedPicked];

  const mix = {};
  for (const p of picked) mix[p.bucket] = (mix[p.bucket] || 0) + 1;
  const available = { ...Object.fromEntries([...byBucket].map(([k, l]) => [k, l.length])), UNLINKED: unlinked.length };
  await writeFile(out, JSON.stringify({ createdAt: new Date(), stats, available, mix, ids: picked.map((p) => p.id), picked }, null, 2));
  console.log(JSON.stringify({ stats, available, mix, sample: picked.length, out }, null, 2));
}

async function run(opts) {
  let ids;
  if (opts.bill) ids = [String(opts.bill)];
  else if (opts['ids-file']) ids = JSON.parse(await readFile(opts['ids-file'], 'utf8')).ids;
  else throw new Error('run needs --ids-file or --bill');
  if (opts.limit) ids = ids.slice(0, Number(opts.limit));

  const concurrency = Number(opts.concurrency || 3);
  const dryRun = Boolean(opts['dry-run']);
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

  if (!opts.force && !dryRun) {
    const done = await BillLineSet.find(
      { billId: { $in: objectIds }, extractorVersion: EXTRACTOR_VERSION, status: { $ne: 'FAILED' } },
      { billId: 1 },
    ).lean();
    const skip = new Set(done.map((d) => String(d.billId)));
    if (skip.size) console.log(`skipping ${skip.size} bill(s) already done at ${EXTRACTOR_VERSION}`);
    ids = ids.filter((id) => !skip.has(id));
  }
  if (!ids.length) { console.log('nothing to do'); return; }

  const provider = await getProvider();
  const runId = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 6)}`;
  const counts = { DONE: 0, NEEDS_REVIEW: 0, FAILED: 0 };
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (!dryRun) {
    await BillLineRun.create({
      runId, args: opts, billIds: ids.map((id) => new mongoose.Types.ObjectId(id)), startedAt: new Date(), counts, usage,
    });
  }
  console.log(`run ${runId}: ${ids.length} bill(s), ${concurrency} at a time${dryRun ? ' (dry run)' : ''}`);

  let n = 0;
  await pool(ids, concurrency, async (id) => {
    const bill = await purchaseBills().findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: BILL_PROJECTION });
    if (!bill) { n += 1; console.warn(`[${n}/${ids.length}] ${id}: not in PurchaseBills`); counts.FAILED += 1; return; }

    const doc = await processBill(bill, provider);
    n += 1;
    doc.runId = runId;
    counts[doc.status] += 1;
    for (const k of Object.keys(usage)) usage[k] += doc.usage?.[k] || 0;

    const goods = doc.lines.filter((l) => l.kind === 'GOODS');
    const sure = goods.filter((l) => l.suggestion?.confidence >= 0.85).length;
    console.log(`[${n}/${ids.length}] ${id} ${doc.status} link=${doc.link?.status ?? '-'} `
      + `lines=${goods.length} confident=${sure} $${(doc.usage?.costUsd ?? 0).toFixed(3)} ${doc.seconds}s`
      + `${doc.error ? ` error: ${doc.error}` : ''}${doc.reviewReasons.length ? ` | ${doc.reviewReasons.join('; ')}` : ''}`);

    if (dryRun) {
      if (ids.length === 1) console.log(JSON.stringify(doc, null, 2));
      return;
    }
    await BillLineSet.replaceOne({ billId: doc.billId }, doc, { upsert: true });
  });

  usage.costUsd = Math.round(usage.costUsd * 100) / 100;
  if (!dryRun) await BillLineRun.updateOne({ runId }, { $set: { finishedAt: new Date(), counts, usage } });
  console.log(JSON.stringify({ runId, counts, usage }, null, 2));
}

/** Re-pair saved lines with the current rules. No reading, no AI cost. */
async function rematchSaved(opts) {
  const match = { extractorVersion: EXTRACTOR_VERSION, status: { $ne: 'FAILED' }, ...(opts.run ? { runId: String(opts.run) } : {}) };
  const docs = await BillLineSet.find(match).lean();
  const moved = {};
  for (const doc of docs) {
    const before = doc.status;
    rematch(doc);
    moved[`${before}->${doc.status}`] = (moved[`${before}->${doc.status}`] || 0) + 1;
    await BillLineSet.updateOne(
      { _id: doc._id },
      { $set: { lines: doc.lines, reviewReasons: doc.reviewReasons, status: doc.status } },
    );
  }
  console.log(JSON.stringify({ rematched: docs.length, moved }, null, 2));
}

async function report(opts) {
  const match = { extractorVersion: EXTRACTOR_VERSION, ...(opts.run ? { runId: String(opts.run) } : {}) };
  const docs = await BillLineSet.find(match).lean();
  const n = docs.length;
  const pct = (x, of = n) => (of ? `${Math.round((x / of) * 1000) / 10}%` : '-');
  const count = (f) => docs.filter(f).length;

  const ok = docs.filter((d) => d.status !== 'FAILED');
  const goods = ok.flatMap((d) => d.lines.filter((l) => l.kind === 'GOODS').map((l) => ({ ...l, d })));
  const linkedGoods = goods.filter((l) => l.d.link?.status === 'LINKED');
  const reasons = {};
  for (const d of ok) for (const r of d.reviewReasons || []) {
    const key = r.replace(/^\d+ /, 'N ');
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const methods = {};
  for (const l of goods) {
    const k = l.suggestion?.method || 'NONE';
    methods[k] = (methods[k] || 0) + 1;
  }
  const byType = {};
  for (const l of linkedGoods) {
    const k = l.suggestion ? bucketOf(l.suggestion.itemGroupId) : 'UNMATCHED';
    if (!byType[k]) byType[k] = { lines: 0, confident: 0 };
    byType[k].lines += 1;
    if (l.suggestion?.confidence >= 0.85) byType[k].confident += 1;
  }
  const cost = docs.reduce((s, d) => s + (d.usage?.costUsd || 0), 0);
  const seconds = ok.map((d) => d.seconds || 0).sort((a, b) => a - b);

  console.log(JSON.stringify({
    bills: n,
    status: { DONE: count((d) => d.status === 'DONE'), NEEDS_REVIEW: count((d) => d.status === 'NEEDS_REVIEW'), FAILED: count((d) => d.status === 'FAILED') },
    link: Object.fromEntries(['LINKED', 'AMBIGUOUS', 'GRN_ONLY', 'NOT_FOUND'].map((s) => [s, count((d) => d.link?.status === s)])),
    linkedVia: {
      billKeys: count((d) => d.link?.status === 'LINKED' && d.link.via === 'BILL_KEYS'),
      readKeys: count((d) => d.link?.status === 'LINKED' && d.link.via === 'READ_KEYS'),
      gstinCorrected: count((d) => d.link?.status === 'LINKED' && d.link.gstinCorrected),
    },
    readCheck: {
      invoiceNoAgrees: pct(count((d) => d.checks?.invoiceNoAgrees), ok.length),
      linesAddUpToBill: pct(count((d) => d.checks?.totals?.bill?.ok), count((d) => d.checks?.totals?.bill)),
      linesAddUpToPi: pct(count((d) => d.checks?.totals?.pi?.ok), count((d) => d.checks?.totals?.pi)),
      readerProblemsLeft: pct(count((d) => d.checks?.readerProblems?.length), ok.length),
    },
    goodsLines: goods.length,
    onLinkedBills: linkedGoods.length,
    confidentOnLinked: pct(linkedGoods.filter((l) => l.suggestion?.confidence >= 0.85).length, linkedGoods.length),
    methods,
    byType,
    reviewReasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    cost: { totalUsd: Math.round(cost * 100) / 100, perBillUsd: n ? Math.round((cost / n) * 1000) / 1000 : null },
    secondsPerBill: seconds.length ? { median: seconds[Math.floor(seconds.length / 2)], max: seconds.at(-1) } : null,
    failures: docs.filter((d) => d.status === 'FAILED').slice(0, 10).map((d) => ({ billId: d.billId, error: d.error })),
  }, null, 2));
}

async function main() {
  const opts = args(process.argv.slice(2));
  const command = opts._[0];
  if (!['select', 'run', 'rematch', 'report'].includes(command)) {
    console.log('usage: bill-lines-run.js select|run|rematch|report [options]  (see the header of this file)');
    process.exitCode = 1;
    return;
  }
  await connectBillLines();
  try {
    if (command === 'select') await select(opts);
    if (command === 'run') await run(opts);
    if (command === 'rematch') await rematchSaved(opts);
    if (command === 'report') await report(opts);
  } finally {
    await closeBillLines();
    await closeWritePools().catch(() => {});
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
