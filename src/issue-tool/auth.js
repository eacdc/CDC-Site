/**
 * Authentication for the Stock Issue Tool.
 *
 * Reuses the Supplier Portal's internal login rather than adding a second auth
 * system. It is the only login in this backend with a password, an expiring
 * bearer-token session, a per-site choice (KOL / AHM), and an ERP UserID on the
 * user record (`sp_users.erpUserId`), which every row this tool writes needs.
 *
 *   POST /api/supplier-portal/auth/login   { email, password, site }
 *   Authorization: Bearer <token>          on every /api/issue-tool request
 *
 * Users need the STORE role (ADMIN passes everything). Posting and deleting
 * additionally need erpUserId on their record; reads do not.
 */

import { requireAuth, requireRole } from '../supplier-portal/middleware/auth.js';
import { SITES, companyIdFor } from './config.js';
import { ApiError } from './errors.js';

function attachIssueToolContext(req, res, next) {
	const site = req.sp?.context?.site;
	if (!SITES.includes(site)) {
		return next(new ApiError(400, 'SITE_REQUIRED', `A site is required (${SITES.join(' | ')}). Sign in again and choose one.`));
	}
	const user = req.sp.user;
	// The live user record wins over the copy taken at login, so a mapping an
	// admin adds takes effect without signing everyone out.
	const erpUserId = Number(user?.erpUserId ?? req.sp.context?.erpUserId) || null;
	req.issueTool = {
		site,
		companyId: companyIdFor(site),
		erpUserId,
		user: {
			email: user?.email ?? null,
			displayName: user?.displayName ?? user?.email ?? null,
			roles: user?.roles ?? [],
		},
	};
	return next();
}

export const authenticate = [requireAuth, requireRole('STORE'), attachIssueToolContext];

/** Posting and deleting write the ERP UserID into the rows; refuse without one. */
export function requireErpUser(req, res, next) {
	if (!req.issueTool?.erpUserId) {
		return next(new ApiError(
			403,
			'ERP_USER_NOT_MAPPED',
			'Your login is not linked to an ERP user, so it cannot post or delete issues. Ask an admin to set your ERP UserID.',
		));
	}
	return next();
}
