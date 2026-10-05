/**
 * Stock Issue Tool configuration.
 *
 * Read at call time rather than at import, because server.js loads .env after
 * its imports have been evaluated.
 *
 *   ISSUE_TOOL_COMPANY_ID       CompanyID the tool reads and writes. 2 for Kolkata.
 *   ISSUE_TOOL_COMPANY_ID_KOL   Optional per-site override (also _AHM). Both plant
 *                               databases run CompanyID 2 today.
 *   ISSUE_TOOL_ALLOW_WRITES     "true" to commit posts and deletes. Anything else
 *                               runs every post and delete as a dry run.
 *   ISSUE_TOOL_CORS_ORIGIN      The frontend's origin(s), comma-separated. Only
 *                               needed once CORS_ORIGINS restricts the server.
 *
 * The database itself comes from the shared settings in src/db.js
 * (DB_NAME_KOL / DB_NAME_AHM), chosen by the site on the user's session.
 */

export const SITES = ['KOL', 'AHM'];

const DEFAULT_COMPANY_ID = 2;

export function companyIdFor(site) {
	const perSite = Number(process.env[`ISSUE_TOOL_COMPANY_ID_${site}`]);
	if (Number.isInteger(perSite) && perSite > 0) return perSite;
	const shared = Number(process.env.ISSUE_TOOL_COMPANY_ID);
	if (Number.isInteger(shared) && shared > 0) return shared;
	return DEFAULT_COMPANY_ID;
}

export function writesEnabled() {
	return process.env.ISSUE_TOOL_ALLOW_WRITES === 'true';
}

export function corsOrigins() {
	return (process.env.ISSUE_TOOL_CORS_ORIGIN ?? '')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
}

/** Recent-issues window when the client gives no dates, and the widest allowed. */
export const RECENT_ISSUES_DEFAULT_DAYS = 3;
export const RECENT_ISSUES_MAX_DAYS = 62;

export const POST_PROC = 'dbo.usp_IssueTool_PostIssue';
export const DELETE_PROC = 'dbo.usp_IssueTool_DeleteIssue';
export const STOCK_REFRESH_PROC = 'dbo.UPDATE_ITEM_STOCK_VALUES';
