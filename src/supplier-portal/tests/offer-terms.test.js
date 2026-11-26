/**
 * An approved price is shown with when it took effect and how soon the goods
 * come, so a buyer raising a PO can weigh the cheapest offer against one that
 * arrives in time for the job.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryDays, offerQuote } from '../services/proposals.js';

test('a delivery range counts as its upper end', () => {
  assert.equal(deliveryDays('Delivery within 7-10 days from PO'), 10);
  assert.equal(deliveryDays('7 to 10 days'), 10);
  assert.equal(deliveryDays('15 days'), 15);
  assert.equal(deliveryDays('2 working days'), 2);
});

test('weeks and months become days', () => {
  assert.equal(deliveryDays('3-4 weeks from order'), 28);
  assert.equal(deliveryDays('1 month'), 30);
});

test('ready stock is no wait, but a stated number wins', () => {
  assert.equal(deliveryDays('Ready stock'), 0);
  assert.equal(deliveryDays('Ex-stock, immediate dispatch'), 0);
  assert.equal(deliveryDays('Ex-stock, 2 days'), 2);
});

test('words with no number stay unknown rather than becoming zero', () => {
  assert.equal(deliveryDays('As per your schedule'), null);
  assert.equal(deliveryDays(''), null);
  assert.equal(deliveryDays(null), null);
});

test('an offer carries its quote date, effective date, delivery and credit', () => {
  const q = offerQuote({
    fileName: 'KV rates Nov.pdf',
    documentDate: '01-11-2026',
    effectiveFrom: '05-11-2026',
    terms: { freight: 'Free delivery', credit: 90, delivery: '7-10 days from PO' },
  });
  assert.deepEqual(q, {
    fileName: 'KV rates Nov.pdf',
    documentDate: '01-11-2026',
    effectiveFrom: '05-11-2026',
    delivery: '7-10 days from PO',
    deliveryDays: 10,
    credit: '90',
  });
});

test('a quote that states no delivery says so, and a missing quote is null', () => {
  const q = offerQuote({ fileName: 'x.pdf', terms: null });
  assert.equal(q.delivery, null);
  assert.equal(q.deliveryDays, null);
  assert.equal(q.effectiveFrom, null);
  assert.equal(offerQuote(null), null);
});
