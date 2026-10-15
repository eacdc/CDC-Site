/**
 * Voucher number allocation.
 *
 * `MaxVoucherNo` is allocated as MAX + 1 for the voucher type. Under default
 * isolation, two sessions reading MAX at the same moment get the same number
 * and both insert it.
 *
 * `dbo.VoucherCounter` does exist, but it is not the series table for these:
 * checked live on both databases in October 2026 it held only `DN` and `FG`
 * rows (delivery notes and finished goods). `REC`, `PI` and `PO` have none, so
 * MAX + 1 is the mechanism here and nothing needs bumping on the way out. If a
 * future voucher type starts appearing in that table, this stops being true
 * for it.
 *
 * The fix is `UPDLOCK, HOLDLOCK` on the read, inside the same transaction as
 * the insert it numbers. `UPDLOCK` takes an update lock rather than a shared
 * one, so a second session blocks instead of reading; `HOLDLOCK` holds it to
 * the end of the transaction, so the gap the second session would insert into
 * is locked too. Neither alone is sufficient.
 *
 * Scope is CompanyID + FYear. The header carries `ProductionUnitID = 0` even
 * when the warehouse belongs to unit 2, so the allocation must NOT be scoped
 * by production unit — doing so would hand out numbers already in use.
 */

import { txQuery, sql } from '../db/mssql.js';
import {
  COMPANY_ID, formatVoucherNo, FYEAR_COLUMN_PATTERN, VOUCHER_SUFFIX_PATTERN,
} from '../config/constants.js';

/**
 * Allocate the next voucher number for a type, inside an open transaction.
 *
 * @param {import('mssql').Transaction} tx
 * @param {Object} opts
 * @param {number} opts.voucherId   e.g. -14 for a GRN
 * @param {string} opts.fYear       the FYear COLUMN value, e.g. '2026-2027'
 * @param {string} opts.suffix      the voucher-number suffix, e.g. '_26_27'
 * @param {'ItemTransactionMain'|'ItemPurchaseInvoiceMain'} [opts.table]
 * @returns {Promise<{maxVoucherNo: number, voucherNo: string}>}
 */
export async function allocateVoucherNo(tx, { voucherId, fYear, suffix, table = 'ItemTransactionMain' }) {
  if (!fYear) throw new Error('A financial year is required to allocate a voucher number.');
  if (!Number.isFinite(voucherId)) throw new Error('A voucher id is required.');
  // Asserted rather than coerced. The two forms are interchangeable to look at
  // and silently produce a duplicate voucher number if swapped, so the failure
  // belongs here rather than three tables later.
  if (!FYEAR_COLUMN_PATTERN.test(String(fYear))) {
    throw new Error(
      `FYear must be the column form "2026-2027", got "${fYear}". ` +
      'The short `26_27` form belongs only in the voucher number.',
    );
  }
  if (!VOUCHER_SUFFIX_PATTERN.test(String(suffix ?? ''))) {
    throw new Error(`Voucher number suffix must look like "_26_27", got "${suffix}".`);
  }
  if (!['ItemTransactionMain', 'ItemPurchaseInvoiceMain'].includes(table)) {
    throw new Error(`Refusing to allocate a voucher number against unexpected table "${table}".`);
  }

  const rows = await txQuery(tx, `
    SELECT ISNULL(MAX(MaxVoucherNo), 0) + 1 AS NextNo
    FROM ${table} WITH (UPDLOCK, HOLDLOCK)
    WHERE VoucherID = @voucherId
      AND CompanyID = @companyId
      AND FYear = @fYear
  `, {
    voucherId: { type: sql.Int, value: voucherId },
    companyId: { type: sql.Int, value: COMPANY_ID },
    fYear: { type: sql.NVarChar, value: fYear },
  });

  const maxVoucherNo = rows[0]?.NextNo;
  if (!Number.isFinite(maxVoucherNo)) {
    throw new Error(`Could not allocate a voucher number for VoucherID ${voucherId} in ${fYear}.`);
  }

  return { maxVoucherNo, voucherNo: formatVoucherNo(voucherId, maxVoucherNo, suffix) };
}

/**
 * The financial year of a date, in BOTH forms the ERP uses.
 *
 * The Indian financial year runs April to March, so January belongs to the
 * year that started the previous April.
 *
 *   fYear  → '2026-2027'  the `FYear` column on every voucher table
 *   suffix → '_26_27'     the tail of the voucher number
 *
 * This mirrors `financialYear` in `src/issue-tool/dates.js`, which has had it
 * right since the Stock Issue Tool shipped; the supplier portal duplicated the
 * computation and kept only the short form, which is what caused the bug.
 *
 * @returns {{fYear: string, suffix: string}}
 */
export function financialYearFor(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('financialYearFor needs a valid date.');
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const yy = (n) => String(n).slice(-2);
  return {
    fYear: `${startYear}-${startYear + 1}`,
    suffix: `_${yy(startYear)}_${yy(startYear + 1)}`,
  };
}
