/**
 * Additional charges on the purchase invoice: one freight row per ledger, as
 * the ERP's screen has them. Ledger names and tax percentages as the ERP held
 * them, July to October 2026: Inward Freight - Purchase 18% (960 rows, 18),
 * Inward Freight - Purchase 5% (148 rows, 18), Freight Charge (6 rows, 0).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { freightRows } from '../services/erp-receiving.js';

test('several freight rows, each on its own ledger', () => {
  const rows = freightRows({ freight: 850 }, {
    freightCharges: [
      { ledgerId: 101, amount: 600, taxPercentage: 18, name: 'Inward Freight - Purchase 18%' },
      { ledgerId: 10, amount: 250, taxPercentage: 0, name: 'Freight Charge' },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.ledgerId, r.amount, r.taxPercentage]), [[101, 600, 18], [10, 250, 0]]);
});

test('the rows must add up to the freight on the invoice', () => {
  assert.throws(() => freightRows({ freight: 900 }, { freightCharges: [{ ledgerId: 101, amount: 600 }] }), /come to 600 but the invoice carries 900/);
});

test('a row without a ledger is refused', () => {
  assert.throws(() => freightRows({ freight: 600 }, { freightCharges: [{ ledgerId: null, amount: 600 }] }), /no ledger/);
});

test('the one freight figure on the one chosen ledger still works', () => {
  assert.deepEqual(freightRows({ freight: 450 }, { freightLedgerId: 101 }), [{ ledgerId: 101, amount: 450, taxPercentage: 18, name: null }]);
  assert.throws(() => freightRows({ freight: 450 }, {}), /INV018/);
  assert.deepEqual(freightRows({ freight: 0 }, {}), []);
});

test('rows of 0 are dropped', () => {
  assert.deepEqual(freightRows({ freight: 0 }, { freightCharges: [{ ledgerId: 101, amount: 0 }] }), []);
});
