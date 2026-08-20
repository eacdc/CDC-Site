/**
 * Sign-in for internal users and for supplier logins.
 *
 * The two live on separate paths against separate collections. Nothing here
 * looks a supplier up in the internal collection or the reverse.
 */

import { Router } from 'express';
import {
  loginUser, loginSupplierUser, logout, requireAuth, requireSupplierAuth,
} from '../middleware/auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, site, employeeLedgerId, warehouseId } = req.body || {};
    const result = await loginUser({
      email,
      password,
      site,
      employeeLedgerId: employeeLedgerId === undefined ? undefined : Number(employeeLedgerId),
      warehouseId: warehouseId === undefined ? undefined : Number(warehouseId),
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/supplier-login', async (req, res, next) => {
  try {
    const result = await loginSupplierUser({
      email: req.body?.email,
      password: req.body?.password,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token) await logout(token);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => {
  const { user, context } = req.sp;
  res.json({
    user: {
      id: user._id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      allowedSites: user.allowedSites,
      defaultSite: user.defaultSite,
    },
    context,
  });
});

router.get('/supplier-me', requireSupplierAuth, (req, res) => {
  const { supplierUser } = req.sp;
  res.json({
    supplierUser: {
      id: supplierUser._id,
      email: supplierUser.email,
      displayName: supplierUser.displayName,
      supplierGroupId: supplierUser.supplierGroupId,
    },
  });
});

/**
 * Change the receiving context without signing out.
 *
 * A store person moves between warehouses during a shift, and re-authenticating
 * to record that would guarantee they stop recording it.
 */
router.post('/context', requireAuth, async (req, res, next) => {
  try {
    const { Session } = await import('../db/mongo.js');
    const { site, employeeLedgerId, warehouseId } = req.body || {};
    const user = req.sp.user;

    if (site && !(user.allowedSites || []).includes(site)) {
      return res.status(403).json({ error: `You do not have access to ${site}.` });
    }

    const context = {
      site: site || req.sp.context.site,
      erpUserId: req.sp.context.erpUserId,
      employeeLedgerId: employeeLedgerId === undefined
        ? req.sp.context.employeeLedgerId
        : Number(employeeLedgerId),
      warehouseId: warehouseId === undefined
        ? req.sp.context.warehouseId
        : Number(warehouseId),
    };

    await Session.updateOne({ _id: req.sp.session._id }, { $set: { context } });
    return res.json({ context });
  } catch (err) { return next(err); }
});

export default router;
