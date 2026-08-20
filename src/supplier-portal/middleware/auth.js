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

const SESSION_DAYS = Number(process.env.SP_SESSION_DAYS) || 7;

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
