/**
 * Which lines of a posted GRN have had stock issued from them.
 *
 * THE RULE: a GRN line that stock has been issued from cannot be deleted
 * until every issue line drawing on it is deleted first. Deleting it anyway
 * would leave issues pointing at stock that no longer exists, and the batch's
 * stock would go negative.
 *
 * How an issue points at the GRN line, verified live on Kolkata, 22 Oct 2026:
 * an Item Issue (-19) line carries the GRN line's own TransactionDetailID in
 * `BatchID` - true of all 14,248 issue lines of the previous 90 days - along
 * with the GRN as `ParentTransactionID` and the GRN line's `BatchNo`. BatchID
 * is the one that names a single line, so it is what this checks.
 * Example: REC04597_26_27 line 1 (7296) is drawn on by IS18211_26_27 (300),
 * line 4 (5560) by IS18087_26_27 (90); lines 2, 3 and 5 are free.
 *
 * GRN Creator does not yet delete posted GRN lines. This is the gate any such
 * delete must pass, and it is the same answer the page shows.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';

/**
 * Pure: which lines may be deleted, given the GRN's lines and the live issue
 * lines that draw on them.
 *
 * @param {Array} grnLines   [{ TransactionDetailID, TransID, ItemID, Qty }]
 * @param {Array} issueLines [{ BatchID, IssueNo, IssueDate, IssueQuantity }]
 */
export function deletableGrnLines(grnLines = [], issueLines = []) {
  const byLine = new Map();
  for (const issue of issueLines) {
    const id = Number(issue.BatchID);
    if (!byLine.has(id)) byLine.set(id, []);
    byLine.get(id).push({ issueNo: issue.IssueNo, issueDate: issue.IssueDate, qty: Number(issue.IssueQuantity) });
  }
  return grnLines.map((l) => {
    const issues = byLine.get(Number(l.TransactionDetailID)) || [];
    const issuedQty = issues.reduce((s, i) => s + (Number.isFinite(i.qty) ? i.qty : 0), 0);
    return {
      transactionDetailId: Number(l.TransactionDetailID),
      lineNo: Number(l.TransID),
      itemId: Number(l.ItemID),
      qty: Number(l.Qty),
      issues,
      issuedQty,
      deletable: issues.length === 0,
      reason: issues.length
        ? `Issued on ${issues.map((i) => i.issueNo).join(', ')} (${issuedQty}). Delete ${issues.length > 1 ? 'those issue lines' : 'that issue line'} first.`
        : null,
    };
  });
}

/** A posted GRN's lines, each with the issues drawing on it. Read-only. */
export async function grnLinesWithIssues(site, { grnTransactionId = null, voucherNo = null }) {
  assertSite(site);
  if (!grnTransactionId && !voucherNo) throw new Error('A GRN TransactionID or voucher number is needed.');

  const header = await query(site, `
    SELECT TOP 1 TransactionID, VoucherNo, VoucherDate, LedgerID
    FROM ItemTransactionMain
    WHERE CompanyID = @companyId AND VoucherID = @grn
      AND ${grnTransactionId ? 'TransactionID = @tid' : 'VoucherNo = @voucherNo'}
      AND ISNULL(IsDeletedTransaction,0) = 0
  `, {
    companyId: COMPANY_ID, grn: VOUCHER.GRN,
    tid: Number(grnTransactionId) || 0, voucherNo: String(voucherNo || ''),
  });
  if (!header.length) return null;
  const tid = Number(header[0].TransactionID);

  const [grnLines, issueLines] = await Promise.all([
    query(site, `
      SELECT ITD.TransactionDetailID, ITD.TransID, ITD.ItemID, ITD.ChallanWeight AS Qty, ITD.BatchNo
      FROM ItemTransactionDetail ITD
      WHERE ITD.CompanyID = @companyId AND ITD.TransactionID = @tid
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0 AND ISNULL(ITD.IsCancelled,0) = 0
      ORDER BY ITD.TransID
    `, { companyId: COMPANY_ID, tid }),
    query(site, `
      SELECT ID.BatchID, IM.VoucherNo AS IssueNo, IM.VoucherDate AS IssueDate, ID.IssueQuantity
      FROM ItemTransactionDetail ID
      JOIN ItemTransactionMain IM ON IM.TransactionID = ID.TransactionID AND IM.CompanyID = ID.CompanyID
      WHERE ID.CompanyID = @companyId AND IM.VoucherID = @issue
        AND ID.BatchID IN (SELECT TransactionDetailID FROM ItemTransactionDetail
                           WHERE CompanyID = @companyId AND TransactionID = @tid)
        AND ISNULL(IM.IsDeletedTransaction,0) = 0
        AND ISNULL(ID.IsDeletedTransaction,0) = 0 AND ISNULL(ID.IsCancelled,0) = 0
      ORDER BY IM.VoucherDate
    `, { companyId: COMPANY_ID, issue: VOUCHER.ITEM_ISSUE, tid }),
  ]);

  return { grn: header[0], lines: deletableGrnLines(grnLines, issueLines) };
}

/** Throws (status 409) if any of these GRN lines has been issued from. */
export async function assertGrnLinesDeletable(site, { grnTransactionId, transactionDetailIds }) {
  const result = await grnLinesWithIssues(site, { grnTransactionId });
  const wanted = new Set((transactionDetailIds || []).map(Number));
  const blocked = (result?.lines || []).filter((l) => wanted.has(l.transactionDetailId) && !l.deletable);
  if (blocked.length) {
    const err = new Error(blocked.map((l) => `GRN line ${l.lineNo}: ${l.reason}`).join(' '));
    err.status = 409;
    err.blocked = blocked;
    throw err;
  }
  return true;
}
