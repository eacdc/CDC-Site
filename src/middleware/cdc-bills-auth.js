import { verifyToken } from '../lib/cdc-bills-users.js';

function bearerToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export function requireCdcBillsAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
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
