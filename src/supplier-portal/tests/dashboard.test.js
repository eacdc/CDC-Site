/**
 * The review page's dashboards: a pending rate is shown but never counts as
 * an approved price, and rates are compared only within one unit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  supplierKey, comparableRate, gapPct, lineStatus, lineTarget, lineRow, latestBySupplier,
  mainUom, paidRate, rankIn, itemSummary, supplierSummary,
} from '../services/dashboard.js';

const row = (supplier, status, comparable, { uom = 'KG', at = '2026-11-01', days = null, quoteId = `q-${supplier}-${at}`, itemId = 1 } = {}) => ({
  supplier: { name: supplier, key: supplier.toUpperCase() },
  status, comparable, uom, itemId, quoteId,
  receivedAt: new Date(at),
  quote: { deliveryDays: days, delivery: days == null ? null : `${days} days`, credit: '60 days' },
});

test('a line is approved, rejected, pending with an item or band, or unmapped', () => {
  assert.equal(lineStatus({ status: 'APPROVED' }), 'APPROVED');
  assert.equal(lineStatus({ status: 'REJECTED', proposal: { itemId: 5 } }), 'REJECTED');
  assert.equal(lineStatus({ status: 'UNAPPROVED', proposal: { itemId: 5 } }), 'PENDING');
  assert.equal(lineStatus({ status: 'UNAPPROVED', proposal: { band: { quality: 'FBB' } } }), 'PENDING');
  assert.equal(lineStatus({ status: 'UNAPPROVED', proposal: { method: 'NONE' } }), 'UNMAPPED');
});

test('an approved line is what the reviewer decided, not what was proposed', () => {
  const p = { status: 'APPROVED', proposal: { itemId: 5, itemName: 'A' }, decision: { itemId: 7, itemName: 'B' } };
  assert.deepEqual(lineTarget(p), { itemId: 7, itemName: 'B', band: null });
  assert.equal(lineTarget({ ...p, status: 'UNAPPROVED' }).itemId, 5);
});

test('lineRow keys a supplier by GSTIN, else by name, and keeps the quote terms', () => {
  assert.equal(supplierKey({ name: 'Sudarshan', gstin: '19abc' }), '19ABC');
  assert.equal(supplierKey({ name: ' Sudarshan ' }), 'SUDARSHAN');
  const r = lineRow(
    { _id: 'p1', autoQuoteId: 'q1', supplier: { name: 'X' }, line: { productName: 'FBB' }, rate: { rate: 64000, uom: 'KG', ratePerBaseUom: 64 }, status: 'UNAPPROVED', proposal: { itemId: 9 }, createdAt: new Date('2026-11-02') },
    { createdAt: new Date('2026-11-01'), terms: { delivery: '7-10 days', freight: 'Extra', gst: '18%' } },
  );
  assert.equal(r.status, 'PENDING');
  assert.equal(r.comparable, 64);
  assert.equal(r.quote.deliveryDays, 10);
  assert.equal(r.quote.freight, 'Extra');
  assert.deepEqual(r.receivedAt, new Date('2026-11-01'), 'received when the quote came, not when the line was refreshed');
});

test('a rate with no readable unit is not comparable', () => {
  assert.equal(comparableRate({ rate: 80 }), null);
  assert.equal(comparableRate({ rate: 80, uom: 'KG', ratePerBaseUom: 80 }), 80);
  assert.equal(gapPct(110, 100), 10);
  assert.equal(gapPct(90, 100), -10);
  assert.equal(gapPct(90, null), null);
});

test('each supplier counts once, by its newest quote', () => {
  const latest = latestBySupplier([row('A', 'APPROVED', 80, { at: '2026-10-01' }), row('A', 'APPROVED', 75, { at: '2026-11-01' }), row('B', 'APPROVED', 78)]);
  assert.deepEqual(latest.map((r) => [r.supplier.name, r.comparable]).sort(), [['A', 75], ['B', 78]]);
});

test('a PO rate per MT is set beside quotes per kg', () => {
  const paid = paidRate({ rate: 74000, uom: 'MT', date: '2026-10-01' });
  assert.equal(paid.uom, 'KG');
  assert.equal(paid.rate, 74);
  assert.equal(paid.rateAsPaid, 74000);
  assert.equal(paidRate({ rate: 10, uom: 'gibberish' }), null);
});

test('rank counts only other suppliers in the same unit; alone is 1 of 1', () => {
  const mine = row('A', 'APPROVED', 80);
  assert.deepEqual(rankIn(mine, [row('B', 'APPROVED', 70), row('C', 'APPROVED', 90), row('D', 'APPROVED', 10, { uom: 'NOS' })]),
    { rank: 2, of: 3, cheapestOther: 70, gapToCheapest: 14.3 });
  assert.deepEqual(rankIn(mine, []), { rank: 1, of: 1, cheapestOther: null, gapToCheapest: null });
  assert.equal(rankIn(row('A', 'APPROVED', null), []), null);
});

test('the item KPIs: a pending rate is never the best approved price', () => {
  const rows = [
    row('A', 'APPROVED', 80, { days: 10 }),
    row('B', 'APPROVED', 88, { days: 3 }),
    row('C', 'PENDING', 60),
    row('D', 'APPROVED', 5, { uom: 'NOS' }),
  ];
  const s = itemSummary(rows, { rate: 100, uom: 'KG' });
  assert.equal(s.uom, 'KG');
  assert.deepEqual([s.best.rate, s.best.supplier], [80, 'A']);
  assert.equal(s.bestVsPaid, -20);
  assert.deepEqual([s.bestPending.rate, s.bestPending.supplier, s.bestPendingVsPaid], [60, 'C', -40]);
  assert.equal(s.spread, 10, '88 is 10% above 80; the per-piece rate is left out');
  assert.deepEqual(s.fastest, { days: 3, text: '3 days', supplier: 'B' });
  assert.deepEqual(s.suppliers, { approved: 3, pending: 1, total: 4 });
  assert.equal(s.pending, 1);
});

test('the item KPIs leave the paid gap out when CDC paid in another unit', () => {
  const s = itemSummary([row('A', 'APPROVED', 80)], { rate: 3, uom: 'NOS' });
  assert.equal(s.bestVsPaid, null);
  assert.equal(mainUom([row('A', 'PENDING', null)]), null);
});

test('the supplier KPIs: status, rank buckets, gaps to paid and quotes per month', () => {
  const now = new Date('2026-11-21');
  const rows = [
    { ...row('A', 'APPROVED', 80, { quoteId: 'q1', at: '2026-11-10', days: 7 }), rank: { rank: 1, of: 3 }, paidGap: -5 },
    { ...row('A', 'APPROVED', 90, { quoteId: 'q1', at: '2026-11-10', days: 7, itemId: 2 }), rank: { rank: 2, of: 2 }, paidGap: 5 },
    { ...row('A', 'APPROVED', 70, { quoteId: 'q2', at: '2026-10-05', days: 14, itemId: 3 }), rank: { rank: 1, of: 1 } },
    { ...row('A', 'PENDING', 60, { quoteId: 'q2', at: '2026-10-05', itemId: 4 }), rank: { rank: 1, of: 2 }, paidGap: -20 },
    { ...row('A', 'UNMAPPED', 50, { quoteId: 'q2', at: '2026-10-05', itemId: null }) },
    { ...row('A', 'REJECTED', 50, { quoteId: 'q2', at: '2026-10-05', itemId: 9 }) },
  ];
  const s = supplierSummary(rows, { now, months: 3 });
  assert.equal(s.quotes, 2);
  assert.deepEqual(s.status, { APPROVED: 3, PENDING: 1, UNMAPPED: 1, REJECTED: 1 });
  assert.equal(s.items, 4, 'approved and pending items; not rejected or unmapped');
  assert.deepEqual(s.ranks, { first: 1, second: 1, third: 0, alone: 1 });
  assert.deepEqual(s.cheapest, { count: 1, compared: 2 }, 'a pending rank does not count');
  assert.equal(s.vsPaid, 0);
  assert.equal(s.vsPaidPending, -20);
  assert.equal(s.avgDeliveryDays, 10.5);
  assert.equal(s.credit, '60 days');
  assert.deepEqual(s.byMonth, [{ month: '2026-09', quotes: 0 }, { month: '2026-10', quotes: 1 }, { month: '2026-11', quotes: 1 }]);
});
