import { CdcBillsActivityLog } from '../db-purchase-bills.js';

/**
 * Append an activity log entry (fire-and-forget).
 * @param {{ req?: import('express').Request, user?: { userKey: string, displayName: string, role: string }, action: string, billId?: string|null, details?: unknown }} opts
 */
export function logActivity({ req, user, action, billId = null, details = null }) {
  const u = user || req?.cdcBillsUser;
  if (!u || !CdcBillsActivityLog) return;

  CdcBillsActivityLog.create({
    at: new Date(),
    userKey: u.userKey,
    displayName: u.displayName,
    role: u.role,
    action,
    billId: billId ? String(billId) : null,
    details: details ?? null,
  }).catch((err) => {
    console.warn('[cdc-bills-activity] log failed:', err?.message || err);
  });
}
