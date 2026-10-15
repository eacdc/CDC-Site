/**
 * Authentication for the Stock Issue Tool.
 *
 * Same sign-in as the production entry tool: a username and a database
 * (KOL / AHM), no password. The username is looked up in the ERP's own
 * UserMaster for that database, so the ERP UserID every row needs (UserID,
 * CreatedBy, ModifiedBy, DeletedBy) comes straight from the ERP; there is no
 * separate user list to maintain.
 *
 * The production tool's GET /api/auth/login goes through
 * dbo.GetMachinesForUser, which only returns users who have machines; store
 * staff often have none, so this looks the user up in UserMaster directly.
 *
 *   POST /api/issue-tool/auth/login   { username, database }
 *   Authorization: Bearer <token>     on every other /api/issue-tool request
 *
 * The token is a JWT signed with the backend's JWT_SECRET and carries the
 * site and ERP user, so requests need no database round-trip to authenticate.
 * It expires after ISSUE_TOOL_SESSION_HOURS (default 12), and the frontend
 * then asks the user to sign in again without losing the form.
 */

import jwt from 'jsonwebtoken';
import { SITES, companyIdFor } from './config.js';
import { ApiError } from './errors.js';
import { query, sql } from './db.js';

const TOKEN_KIND = 'issue-tool';

function secret() {
	const s = process.env.JWT_SECRET;
	if (!s) throw new ApiError(500, 'AUTH_NOT_CONFIGURED', 'The server has no JWT_SECRET set, so it cannot sign you in.');
	return s;
}

function sessionHours() {
	const h = Number(process.env.ISSUE_TOOL_SESSION_HOURS);
	return Number.isFinite(h) && h > 0 ? h : 12;
}

/** Find the ERP user for a username: UserName or LoginUserName, any case. */
export async function findErpUser({ site, companyId, username }) {
	const rows = await query(site, `
		SELECT UserID, UserName, LoginUserName
		FROM dbo.UserMaster
		WHERE CompanyID = @companyId
		  AND ISNULL(IsDeletedUser, 0) = 0
		  AND ISNULL(IsBlocked, 0) = 0
		  AND (UPPER(LTRIM(RTRIM(UserName))) = UPPER(@username)
		    OR UPPER(LTRIM(RTRIM(ISNULL(LoginUserName, '')))) = UPPER(@username))
	`, {
		companyId: [sql.Int, companyId],
		username: [sql.NVarChar(255), username],
	});
	return pickUser(rows, username);
}

/** Pure: one match wins; an exact UserName match beats a LoginUserName match. */
export function pickUser(rows, username) {
	if (!rows.length) return null;
	if (rows.length === 1) return rows[0];
	const u = username.trim().toUpperCase();
	const byName = rows.filter((r) => String(r.UserName ?? '').trim().toUpperCase() === u);
	if (byName.length === 1) return byName[0];
	throw new ApiError(409, 'AMBIGUOUS_USERNAME', `More than one ERP user is called "${username}". Ask an admin to make the names unique.`);
}

export async function login({ username, database }) {
	const site = String(database || '').toUpperCase();
	if (!SITES.includes(site)) throw new ApiError(400, 'VALIDATION_FAILED', `database must be one of ${SITES.join(', ')}.`);
	const name = String(username || '').trim();
	if (!name) throw new ApiError(400, 'VALIDATION_FAILED', 'Enter your username.');

	const companyId = companyIdFor(site);
	const user = await findErpUser({ site, companyId, username: name });
	if (!user) throw new ApiError(401, 'UNKNOWN_USER', `No active ERP user "${name}" in ${site}.`);

	const expiresIn = Math.round(sessionHours() * 3600);
	const token = jwt.sign(
		{ kind: TOKEN_KIND, site, erpUserId: user.UserID, userName: user.UserName },
		secret(),
		{ expiresIn },
	);
	return {
		token,
		expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
		user: { userId: user.UserID, userName: user.UserName },
		site,
	};
}

/** Verify a token; returns its payload or throws a 401. */
export function verifyToken(token) {
	let payload;
	try {
		payload = jwt.verify(token, secret());
	} catch (err) {
		if (err instanceof ApiError) throw err;
		throw new ApiError(401, 'SESSION_EXPIRED', 'Session has expired. Sign in again.');
	}
	if (payload?.kind !== TOKEN_KIND || !SITES.includes(payload.site) || !payload.erpUserId) {
		throw new ApiError(401, 'SESSION_EXPIRED', 'Session has expired. Sign in again.');
	}
	return payload;
}

export function authenticate(req, res, next) {
	const header = req.headers.authorization || '';
	const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
	if (!token) return next(new ApiError(401, 'NOT_SIGNED_IN', 'Not signed in.'));
	try {
		const payload = verifyToken(token);
		req.issueTool = {
			site: payload.site,
			companyId: companyIdFor(payload.site),
			erpUserId: Number(payload.erpUserId),
			user: { userId: Number(payload.erpUserId), userName: payload.userName ?? null },
		};
		return next();
	} catch (err) {
		return next(err);
	}
}

/** Kept for the write routes: every session carries an ERP user, but be explicit. */
export function requireErpUser(req, res, next) {
	if (!req.issueTool?.erpUserId) {
		return next(new ApiError(403, 'ERP_USER_NOT_MAPPED', 'Your session has no ERP user. Sign in again.'));
	}
	return next();
}
