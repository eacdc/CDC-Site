/**
 * The GSTIN check character, and the distance used to find the ledger a
 * misread GSTIN belongs to. Real GSTINs from Kolkata's supplier ledgers;
 * misreadings from the October 2026 extractor run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidGstin, gstinCheckChar, gstinDistance, nearestGstins } from '../lib/gstin.js';

const REAL = ['19AABCC2946B1ZZ', '19AHEPA0785F1ZK', '19AAFCF9888F1ZX', '19AAACG4845N1Z5', '19AADCP6122G1ZI',
  '19ACYPL7024P1ZK', '19AFVPK0930P1ZP', '07APAPH3616N1ZW', '24AABCC2946B1Z8', '29AAACG4845N1Z4'];

test('real GSTINs carry the right check character', () => {
  for (const g of REAL) assert.equal(isValidGstin(g), true, g);
  assert.equal(gstinCheckChar('19AABCC2946B1Z'), 'Z');
});

test('the misreadings of the October run all fail it', () => {
  for (const g of ['19AADFR0768H1Z1', '19AACCA2812J1ZN', '19AADCP6122G1Z0', '19AAACK5777H1ZS', '19AAICG2283B1ZZ', '19AAACF1234A1Z5']) {
    assert.equal(isValidGstin(g), false, g);
  }
});

test('shape is checked as well as the character', () => {
  assert.equal(isValidGstin('19AABCC2946B1Z'), false);
  assert.equal(isValidGstin('AABCC2946B'), false);
  assert.equal(isValidGstin(' 19aabcc 2946b1zz '), true);
});

test('a swap of two neighbours is one mistake', () => {
  assert.equal(gstinDistance('19AABCC2946B1ZZ', '19AABCC2964B1ZZ'), 1);
  assert.equal(gstinDistance('19AADCP6122G1Z0', '19AADCP6122G1ZI'), 1);
});

test('nearest: the one ledger GSTIN close enough, ties reported, other states ignored', () => {
  assert.deepEqual(nearestGstins('19AADCP6122G1Z0', REAL), { distance: 1, gstins: ['19AADCP6122G1ZI'] });
  assert.deepEqual(nearestGstins('19AAACF1234A1Z5', REAL), { distance: null, gstins: [] });
  // 24AABCC2946B1Z8 is CDC Ahmedabad: one state code away from Kolkata's, not a misreading of it.
  assert.deepEqual(nearestGstins('19AABCC2946B1Z8', ['24AABCC2946B1Z8']).gstins, []);
  assert.deepEqual(nearestGstins('19AAAAA0000A1Z1', ['19AAAAA0000A1Z2', '19AAAAA0000A1Z3']).gstins.length, 2);
});
