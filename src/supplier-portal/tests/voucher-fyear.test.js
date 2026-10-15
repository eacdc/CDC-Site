/**
 * The two financial-year forms, pinned apart.
 *
 * The ERP carries the financial year twice, in forms that look alike and are
 * not interchangeable:
 *
 *   FYear column    '2026-2027'   on ItemTransactionMain/Detail,
 *                                 ItemPurchaseInvoiceMain/Detail/Taxes
 *   voucher suffix  '_26_27'      the tail of REC04680_26_27
 *
 * Verified live on both databases, October 2026: PO03408_26_27 carries
 * FYear = '2026-2027'. Swapping them is silent and expensive — a WHERE on
 * '26_27' matches no rows, MAX(MaxVoucherNo) + 1 returns 1, and the voucher
 * posts as REC00001_26_27, which already exists in Kolkata.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { financialYearFor } from '../services/erp-voucher.js';
import {
  formatVoucherNo, VOUCHER, FYEAR_COLUMN_PATTERN, VOUCHER_SUFFIX_PATTERN,
} from '../config/constants.js';

test('both forms are returned, and they are not the same string', () => {
  const { fYear, suffix } = financialYearFor(new Date('2026-10-15T00:00:00Z'));
  assert.equal(fYear, '2026-2027', 'the FYear column form');
  assert.equal(suffix, '_26_27', 'the voucher-number suffix');
  assert.match(fYear, FYEAR_COLUMN_PATTERN);
  assert.match(suffix, VOUCHER_SUFFIX_PATTERN);
});

test('the financial year turns on 1 April, not 1 January', () => {
  // January belongs to the year that began the previous April.
  assert.deepEqual(financialYearFor(new Date('2027-01-09T00:00:00Z')),
    { fYear: '2026-2027', suffix: '_26_27' }, 'January is still 2026-2027');
  assert.deepEqual(financialYearFor(new Date('2027-03-31T00:00:00Z')),
    { fYear: '2026-2027', suffix: '_26_27' }, '31 March is the last day');
  assert.deepEqual(financialYearFor(new Date('2027-04-01T00:00:00Z')),
    { fYear: '2027-2028', suffix: '_27_28' }, '1 April rolls over');
});

test('it agrees with the Stock Issue Tool, which has had this right all along', async () => {
  const { financialYear } = await import('../../issue-tool/dates.js');
  for (const iso of ['2026-10-15', '2027-01-09', '2027-03-31', '2027-04-01']) {
    assert.deepEqual(financialYearFor(new Date(`${iso}T00:00:00Z`)), financialYear(iso), iso);
  }
});

test('a voucher number is built from the suffix', () => {
  const { suffix } = financialYearFor(new Date('2026-10-15T00:00:00Z'));
  // The live maxima on 15-Oct-2026 were REC 4679 and PI 4592, so these are the
  // numbers the next post should take.
  assert.equal(formatVoucherNo(VOUCHER.GRN, 4680, suffix), 'REC04680_26_27');
  assert.equal(formatVoucherNo(VOUCHER.PURCHASE_INVOICE, 4593, suffix), 'PI04593_26_27');
  assert.equal(formatVoucherNo(VOUCHER.PURCHASE_ORDER, 3447, suffix), 'PO03447_26_27');
});

test('passing the column form where a suffix belongs is refused', () => {
  const { fYear } = financialYearFor(new Date('2026-10-15T00:00:00Z'));
  assert.throws(() => formatVoucherNo(VOUCHER.GRN, 4680, fYear), /suffix must look like/);
  // The pre-fix bug: the bare short form with no leading underscore.
  assert.throws(() => formatVoucherNo(VOUCHER.GRN, 4680, '26_27'), /suffix must look like/);
});

test('an unknown voucher type has no prefix and must not be numbered', () => {
  assert.throws(() => formatVoucherNo(VOUCHER.ITEM_ISSUE, 1, '_26_27'), /No voucher prefix/);
});
