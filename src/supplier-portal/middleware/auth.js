/**
 * Authentication and session context.
 *
 * Internal users and supplier users are separate identity spaces and the two
 * collections are never joined. A token identifies which space it belongs to,
 * and `requireAuth` refuses a supplier token on an internal route by
 * construction rather than by a check somebody has to remember to write.
 *
 * The session carries the receiving context — `{site, erpUserId,
 * employeeLedgerId, warehouseId}` — because `UserMaster` and `LedgerMaster`
 * are not linked in the ERP. A user logs in and states which employee ledger
 * they are acting as, exactly as they do in the ERP's own screens.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  ensureSupplierPortalReady, User, SupplierUser, Session,
} from '../db/mongo.js';
import { SITES } from '../config/constants.js';
import { erpUserByName } from '../services/erp-ledgers.js';

const SESSION_DAYS = Number(process.env.SP_SESSION_DAYS) || 7;

/**
 * Roles an ERP-authenticated account is given on first sign-in. Receiving
 * needs STORE; anything wider should be granted deliberately on the account.
 */
function erpLoginRoles() {
  const configured = (process.env.SP_ERP_LOGIN_ROLES || '').split(',')
    .map((r) => r.trim().toUpperCase()).filter(Boolean);
  return configured.length ? configured : ['STORE'];
}

/**
 * ERP sign-in is on unless explicitly turned off.
 *
 * It is passwordless by design, matching the Stock Issue Tool and the ERP's
 * own production entry tool. `SP_ERP_LOGIN=false` closes it on a server where
 * that is not wanted; the password path is unaffected either way.
 */
export function erpLoginEnabled() {
  return (process.env.SP_ERP_LOGIN ?? '').trim().toLowerCase() !== 'false';
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token.trim() : null;
}

/** Sign in an internal user. */
export async function loginUser({ email, password, site, employeeLedgerId, warehouseId, userAgent, ip }) {
  await ensureSupplierPortalReady();
  const user = await User.findOne({ email: String(email || '').toLowerCase().trim(), isActive: true });
  // The same message for an unknown email and a wrong password, so the
  // response does not confirm which accounts exist.
  const invalid = new Error('Email or password is incorrect.');
  invalid.status = 401;
  if (!user) throw invalid;
  // An ERP account's stored hash is random and matches nothing. Saying so
  // beats letting it fail as "wrong password" forever.
  if (user.authSource === 'ERP') {
    const err = new Error('This account signs in with its ERP user name, not a password.');
    err.status = 400;
    throw err;
  }
  if (!await bcrypt.compare(String(password || ''), user.passwordHash)) throw invalid;

  const chosenSite = site || user.defaultSite;
  if (!SITES.includes(chosenSite)) {
    const err = new Error(`Unknown site "${chosenSite}".`);
    err.status = 400;
    throw err;
  }
  if (!(user.allowedSites || []).includes(chosenSite)) {
    const err = new Error(`You do not have access to ${chosenSite}.`);
    err.status = 403;
    throw err;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);

  await Session.create({
    token,
    principalType: 'USER',
    principalId: user._id,
    context: {
      site: chosenSite,
      erpUserId: user.erpUserId ?? null,
      employeeLedgerId: employeeLedgerId ?? user.employeeLedgerId ?? null,
      warehouseId: warehouseId ?? user.warehouseId ?? null,
    },
    expiresAt,
    userAgent,
    ip,
  });

  user.lastLoginAt = new Date();
  await user.save();

  return {
    token,
    expiresAt,
    user: {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      allowedSites: user.allowedSites,
    },
    context: {
      site: chosenSite,
      erpUserId: user.erpUserId ?? null,
      employeeLedgerId: employeeLedgerId ?? user.employeeLedgerId ?? null,
      warehouseId: warehouseId ?? user.warehouseId ?? null,
    },
  };
}

/**
 * Sign in with an ERP user name, the way the Stock Issue Tool does.
 *
 * No password: the name is looked up in the ERP's own `UserMaster` for that
 * site, exactly as the production entry tool does it. That is deliberate and
 * is the house pattern - the ERP is the user list, and the `UserID` every
 * written row needs (`UserID`, `CreatedBy`, `ModifiedBy`) comes straight from
 * it rather than from a second list somebody has to keep in step.
 *
 * The account is provisioned in `sp_users` on first sign-in so that
 * `requireAuth`, `requireRole` and the audit log keep working unchanged. It is
 * keyed per site, which is correct rather than convenient: KOL and AHM are
 * separate databases and `UserID` 7 in one is a different person from
 * `UserID` 7 in the other.
 *
 * `employeeLedgerId` is NOT derived from `UserMaster.EmployeeId` - that column
 * is null on every active user - so the caller still states which employee
 * ledger they are receiving as.
 */
export async function loginErpUser({
  username, site, employeeLedgerId, warehouseId, userAgent, ip,
}) {
  await ensureSupplierPortalReady();

  if (!erpLoginEnabled()) {
    const err = new Error('ERP sign-in is turned off on this server (SP_ERP_LOGIN=false).');
    err.status = 403;
    throw err;
  }

  const chosenSite = String(site || '').toUpperCase();
  if (!SITES.includes(chosenSite)) {
    const err = new Error(`Unknown site "${site}". Expected one of ${SITES.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const name = String(username || '').trim();
  if (!name) {
    const err = new Error('Enter your ERP user name.');
    err.status = 400;
    throw err;
  }

  const erpUser = await erpUserByName(chosenSite, name);
  if (!erpUser) {
    const err = new Error(`No active ERP user "${name}" in ${chosenSite}.`);
    err.status = 401;
    throw err;
  }

  // A synthetic, stable key - never a mailbox, and it cannot collide with a
  // real address because no CDC mail domain is `erp.kol` or `erp.ahm`.
  const key = `${String(erpUser.UserName).trim().toLowerCase().replace(/\s+/g, '.')}@erp.${chosenSite.toLowerCase()}`;

  let user = await User.findOne({ email: key });
  if (!user) {
    user = await User.create({
      email: key,
      // Unusable by construction: nothing bcrypt-compares equal to a random
      // hex string, and the password path refuses ERP accounts before it
      // would ever get here.
      passwordHash: crypto.randomBytes(32).toString('hex'),
      displayName: erpUser.UserName,
      roles: erpLoginRoles(),
      defaultSite: chosenSite,
      allowedSites: [chosenSite],
      erpUserId: erpUser.UserID,
      erpUserName: erpUser.UserName,
      authSource: 'ERP',
    });
  } else {
    if (!user.isActive) {
      const err = new Error('Account is no longer active.');
      err.status = 403;
      throw err;
    }
    // The ERP is the source of truth; re-reading it on each sign-in means a
    // renamed or re-numbered user corrects itself without an admin step.
    user.erpUserId = erpUser.UserID;
    user.erpUserName = erpUser.UserName;
    user.displayName = erpUser.UserName;
    if (!(user.allowedSites || []).includes(chosenSite)) {
      user.allowedSites = (user.allowedSites || []).concat(chosenSite);
    }
  }

  // Remember the receiving context, so the next sign-in starts filled in.
  if (employeeLedgerId !== undefined && employeeLedgerId !== null) user.employeeLedgerId = employeeLedgerId;
  if (warehouseId !== undefined && warehouseId !== null) user.warehouseId = warehouseId;
  user.lastLoginAt = new Date();
  await user.save();

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await Session.create({
    token,
    principalType: 'USER',
    principalId: user._id,
    context: {
      site: chosenSite,
      erpUserId: erpUser.UserID,
      employeeLedgerId: employeeLedgerId ?? user.employeeLedgerId ?? null,
      warehouseId: warehouseId ?? user.warehouseId ?? null,
    },
    expiresAt,
    userAgent,
    ip,
  });

  return {
    token,
    expiresAt,
    user: {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      allowedSites: user.allowedSites,
      authSource: 'ERP',
      erpUserName: erpUser.UserName,
    },
    context: {
      site: chosenSite,
      erpUserId: erpUser.UserID,
      employeeLedgerId: employeeLedgerId ?? user.employeeLedgerId ?? null,
      warehouseId: warehouseId ?? user.warehouseId ?? null,
    },
  };
}

/** Sign in a supplier user. Separate collection, separate principal type. */
export async function loginSupplierUser({ email, password, userAgent, ip }) {
  await ensureSupplierPortalReady();
  const supplierUser = await SupplierUser.findOne({
    email: String(email || '').toLowerCase().trim(), isActive: true,
  });
  const invalid = new Error('Email or password is incorrect.');
  invalid.status = 401;
  if (!supplierUser) throw invalid;
  if (!await bcrypt.compare(String(password || ''), supplierUser.passwordHash)) throw invalid;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);

  await Session.create({
    token,
    principalType: 'SUPPLIER_USER',
    principalId: supplierUser._id,
    context: {},
    expiresAt,
    userAgent,
    ip,
  });

  supplierUser.lastLoginAt = new Date();
  await supplierUser.save();

  return {
    token,
    expiresAt,
    supplierUser: {
      id: supplierUser._id,
      email: supplierUser.email,
      displayName: supplierUser.displayName,
      supplierGroupId: supplierUser.supplierGroupId,
    },
  };
}

export async function logout(token) {
  await ensureSupplierPortalReady();
  await Session.deleteOne({ token });
}

/**
 * Require an internal user.
 *
 * Populates `req.sp = {user, context, session}`. A supplier token is rejected
 * here rather than being allowed through to a controller that might forget to
 * scope its query.
 */
export async function requireAuth(req, res, next) {
  try {
    await ensureSupplierPortalReady();
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    const session = await Session.findOne({ token }).lean();
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session has expired. Sign in again.' });
    }
    if (session.principalType !== 'USER') {
      return res.status(403).json({ error: 'This endpoint is for CDC users.' });
    }

    const user = await User.findById(session.principalId).lean();
    if (!user?.isActive) return res.status(401).json({ error: 'Account is no longer active.' });

    // The client may switch site per request within what the user is allowed.
    const requestedSite = req.get('X-SP-Site') || req.query.site || session.context?.site;
    if (requestedSite && !(user.allowedSites || []).includes(requestedSite)) {
      return res.status(403).json({ error: `You do not have access to ${requestedSite}.` });
    }

    req.sp = {
      user,
      session,
      context: { ...session.context, site: requestedSite || session.context?.site },
      actor: user.email,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Require a supplier user, and scope every downstream query to their group.
 *
 * `req.sp.supplierGroupId` is set here and is the only supplier id a supplier
 * route may use. Scoping at this layer rather than in each controller is what
 * keeps one supplier from ever seeing another's rates.
 */
export async function requireSupplierAuth(req, res, next) {
  try {
    await ensureSupplierPortalReady();
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    const session = await Session.findOne({ token }).lean();
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session has expired. Sign in again.' });
    }
    if (session.principalType !== 'SUPPLIER_USER') {
      return res.status(403).json({ error: 'This endpoint is for supplier logins.' });
    }

    const supplierUser = await SupplierUser.findById(session.principalId).lean();
    if (!supplierUser?.isActive) return res.status(401).json({ error: 'Account is no longer active.' });

    req.sp = {
      supplierUser,
      session,
      supplierGroupId: supplierUser.supplierGroupId,
      actor: supplierUser.email,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Require one of the given roles. ADMIN passes everything. */
export function requireRole(...roles) {
  return (req, res, next) => {
    const held = req.sp?.user?.roles || [];
    if (held.includes('ADMIN') || roles.some((r) => held.includes(r))) return next();
    return res.status(403).json({
      error: `This action needs one of: ${roles.join(', ')}.`,
    });
  };
}

/**
 * Require a site on the request.
 *
 * Site never defaults, at any layer. A request that does not say which
 * database it means is a bug, and answering it from Kolkata by default is how
 * an Ahmedabad GRN ends up in the wrong place.
 */
export function requireSite(req, res, next) {
  const site = req.get('X-SP-Site') || req.query.site || req.body?.site || req.sp?.context?.site;
  if (!site || !SITES.includes(site)) {
    return res.status(400).json({
      error: `A site is required (${SITES.join(' | ')}). Send it as the X-SP-Site header or a "site" parameter.`,
    });
  }
  req.sp = { ...(req.sp || {}), site };
  return next();
}

/** Hash a password for seeding and for the admin user-creation screen. */
export async function hashPassword(plain) {
  if (!plain || String(plain).length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  return bcrypt.hash(String(plain), 10);
}
