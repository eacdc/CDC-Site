/**
 * Voucher number allocation.
 *
 * The ERP has no series table: `MaxVoucherNo` is allocated as MAX + 1 for the
 * voucher type. Under default isolation, two sessions reading MAX at the same
 * moment get the same number and both insert it.
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
import { COMPANY_ID, formatVoucherNo } from '../config/constants.js';

/**
 * Allocate the next voucher number for a type, inside an open transaction.
 *
 * @param {import('mssql').Transaction} tx
 * @param {Object} opts
 * @param {number} opts.voucherId   e.g. -14 for a GRN
 * @param {string} opts.fYear       e.g. '26_27'
 * @param {'ItemTransactionMain'|'ItemPurchaseInvoiceMain'} [opts.table]
 * @returns {Promise<{maxVoucherNo: number, voucherNo: string}>}
 */
export async function allocateVoucherNo(tx, { voucherId, fYear, table = 'ItemTransactionMain' }) {
  if (!fYear) throw new Error('A financial year is required to allocate a voucher number.');
  if (!Number.isFinite(voucherId)) throw new Error('A voucher id is required.');
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

  return { maxVoucherNo, voucherNo: formatVoucherNo(voucherId, maxVoucherNo, fYear) };
}

/**
 * The financial year string for a date, in the ERP's `26_27` form.
 *
 * The Indian financial year runs April to March, so January belongs to the
 * year that started the previous April.
 */
export function fYearFor(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  return `${String(startYear).slice(-2)}_${String(startYear + 1).slice(-2)}`;
}
