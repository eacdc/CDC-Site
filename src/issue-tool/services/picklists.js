/**
 * Closing a picklist line: the ERP picklist screen's "Close" button.
 *
 * usp_IssueTool_ClosePicklistLine does the writing. Like posting and deleting,
 * it runs as a dry run (update, snapshot, roll back) unless
 * ISSUE_TOOL_ALLOW_WRITES is on. Closing touches no stock, so nothing is
 * refreshed afterwards.
 */

import { execute, sql } from '../db.js';
import { CLOSE_PICKLIST_LINE_PROC, writesEnabled } from '../config.js';
import { str } from '../queries/shared.js';
import { dryRunReason } from './issues.js';

export async function closePicklistLine({ site, companyId, erpUserId, picklistDetailId }) {
	const reason = dryRunReason({ requested: false, allowWrites: writesEnabled() });
	const dryRun = reason !== null;

	const result = await execute(site, CLOSE_PICKLIST_LINE_PROC, {
		CompanyID: [sql.Int, companyId],
		UserID: [sql.Int, erpUserId],
		PicklistDetailID: [sql.BigInt, picklistDetailId],
		DryRun: [sql.Bit, dryRun ? 1 : 0],
	});

	const s = result.recordset?.[0];
	if (!s) throw new Error('usp_IssueTool_ClosePicklistLine returned no status row.');

	const base = { picklistDetailId, picklistNo: str(s.PicklistNo) };
	if (dryRun) {
		let line = null;
		try {
			line = s.DryRunLineJson ? JSON.parse(s.DryRunLineJson) : null;
		} catch {
			line = null;
		}
		return { status: 'DRY_RUN', dryRun: true, dryRunReason: reason, ...base, wouldWrite: { line } };
	}
	return { status: 'CLOSED', dryRun: false, ...base };
}
