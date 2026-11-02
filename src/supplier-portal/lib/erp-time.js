/**
 * The ERP's clock: India time, stored as it reads on the wall.
 *
 * The ERP writes CreatedDate, ModifiedDate and DeletedDate in India time (its
 * server's clock), and VoucherDate as the India date at midnight - 5,032 of
 * the 5,046 GRNs of 2026-27 had no time of day. The mssql driver sends a Date
 * as UTC, so `new Date()` was stored 5½ hours early: REC04812_26_27, deleted
 * at 16:13 on 28 Oct 2026, says DeletedDate 10:43. A voucher saved before
 * 05:30 would have been dated the day before - on 1 April, in the previous
 * financial year.
 *
 * These return a Date whose UTC reading is India's wall clock, so the driver
 * stores exactly that, and reads it back the way it reads the ERP's own.
 */

const IST_OFFSET_MS = 330 * 60000;

/** Now, as the ERP's CreatedDate / ModifiedDate / DeletedDate. */
export function erpNow(at = new Date()) {
  return new Date(at.getTime() + IST_OFFSET_MS);
}

/** Today's date in India at midnight, as the ERP's VoucherDate. */
export function erpToday(at = new Date()) {
  const d = erpNow(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
