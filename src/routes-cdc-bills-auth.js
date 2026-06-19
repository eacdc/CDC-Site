/**
 * CDC Bills authentication routes.
 * Mounted at /api/cdc-bills/auth
 */
import { Router } from 'express';
import {
  ensurePurchaseBillsReady,
  CdcBillsUserPassword,
  CdcBillsActivityLog,
} from './db-purchase-bills.js';
import {
  CDC_BILLS_EMPLOYEES,
  listLoginUsers,
  verifyAdminCredentials,
  verifyEmployeeCredentials,
  issueToken,
  hashPassword,
} from './lib/cdc-bills-users.js';
import { logActivity } from './lib/cdc-bills-activity.js';
import {
  requireCdcBillsAuth,
  requireCdcBillsAdmin,
} from './middleware/cdc-bills-auth.js';

const router = Router();

// GET /login-users — public; no DB required
router.get('/login-users', (req, res) => {
  res.json({ users: listLoginUsers() });
});

router.use(async (req, res, next) => {
  try {
    await ensurePurchaseBillsReady();
    next();
  } catch (err) {
    console.error('[cdc-bills-auth] billing DB not available:', err?.message || err);
    res.status(503).json({ error: err?.message || 'Billing database unavailable' });
  }
});

// POST /login — public
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    let user = verifyAdminCredentials(username, password);
    if (!user) {
      user = await verifyEmployeeCredentials(username, password, CdcBillsUserPassword);
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = issueToken(user);
    logActivity({ user, action: 'login' });
    return res.json({ token, user });
  } catch (err) {
    console.error('[cdc-bills-auth] login error:', err);
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
});

// GET /me
router.get('/me', requireCdcBillsAuth, (req, res) => {
  res.json({ user: req.cdcBillsUser });
});

// POST /logout — client clears token; log for audit
router.post('/logout', requireCdcBillsAuth, (req, res) => {
  logActivity({ req, action: 'logout' });
  res.json({ ok: true });
});

// GET /employees — admin only
router.get('/employees', requireCdcBillsAuth, requireCdcBillsAdmin, async (req, res) => {
  try {
    const docs = await CdcBillsUserPassword.find(
      { userKey: { $in: CDC_BILLS_EMPLOYEES.map((e) => e.userKey) } },
      { userKey: 1, passwordHash: 1 },
    ).lean();
    const hashMap = new Map(docs.map((d) => [d.userKey, !!d.passwordHash]));
    const employees = CDC_BILLS_EMPLOYEES.map((e) => ({
      userKey: e.userKey,
      displayName: e.displayName,
      hasPassword: !!hashMap.get(e.userKey),
    }));
    return res.json({ employees });
  } catch (err) {
    console.error('[cdc-bills-auth] employees list error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list employees' });
  }
});

// POST /employees/set-password — admin only
router.post('/employees/set-password', requireCdcBillsAuth, requireCdcBillsAdmin, async (req, res) => {
  try {
    const { userKey, password } = req.body || {};
    const employee = CDC_BILLS_EMPLOYEES.find((e) => e.userKey === userKey);
    if (!employee) {
      return res.status(400).json({ error: 'Invalid employee userKey' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const passwordHash = await hashPassword(password);
    await CdcBillsUserPassword.findOneAndUpdate(
      { userKey: employee.userKey },
      {
        userKey: employee.userKey,
        displayName: employee.displayName,
        passwordHash,
        updatedBy: req.cdcBillsUser.userKey,
      },
      { upsert: true, new: true },
    );

    logActivity({
      req,
      action: 'set_employee_password',
      details: { targetUserKey: employee.userKey },
    });

    return res.json({ ok: true, userKey: employee.userKey });
  } catch (err) {
    console.error('[cdc-bills-auth] set-password error:', err);
    return res.status(500).json({ error: err.message || 'Failed to set password' });
  }
});

// GET /activity-log — admin only
router.get('/activity-log', requireCdcBillsAuth, requireCdcBillsAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = {};

    if (req.query.userKey) filter.userKey = String(req.query.userKey).trim();
    if (req.query.action) filter.action = String(req.query.action).trim();
    if (req.query.from || req.query.to) {
      filter.at = {};
      if (req.query.from) filter.at.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.at.$lte = to;
      }
    }

    const [rows, total] = await Promise.all([
      CdcBillsActivityLog.find(filter)
        .sort({ at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CdcBillsActivityLog.countDocuments(filter),
    ]);

    return res.json({ rows, total, page, limit });
  } catch (err) {
    console.error('[cdc-bills-auth] activity-log error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch activity log' });
  }
});

export default router;
