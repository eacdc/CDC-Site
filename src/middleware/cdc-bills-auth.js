import { verifyToken } from '../lib/cdc-bills-users.js';
import { isSessionActive } from '../lib/cdc-bills-sessions.js';

function bearerToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export async function requireCdcBillsAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Tokens issued before single-session support have no sid.
  if (!user.sessionId) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  // Only one device per account: a newer login rotates the stored session id.
  try {
    const active = await isSessionActive(user.userKey, user.sessionId);
    if (!active) {
      return res.status(401).json({
        error: 'You were signed out because this account signed in on another device.',
        code: 'session_superseded',
      });
    }
  } catch (err) {
    console.error('[cdc-bills-auth] session check failed:', err?.message || err);
    return res.status(503).json({ error: 'Session store unavailable' });
  }

  req.cdcBillsUser = user;
  next();
}

export function requireCdcBillsAdmin(req, res, next) {
  if (!req.cdcBillsUser || req.cdcBillsUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireCdcBillsModify(req, res, next) {
  if (!req.cdcBillsUser || req.cdcBillsUser.role !== 'admin') {
    return res.status(403).json({ error: 'Modify access requires admin role' });
  }
  next();
}
