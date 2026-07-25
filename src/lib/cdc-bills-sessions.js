/**
 * Single-active-session enforcement for CDC Bills.
 *
 * JWTs are stateless, so we pin each token to a `sid` and keep exactly one
 * valid `sid` per user in Mongo. A fresh login overwrites that row, so tokens
 * issued to any other device stop validating on their next request.
 */
import { randomUUID } from 'node:crypto';
import { ensurePurchaseBillsReady, CdcBillsSession } from '../db-purchase-bills.js';

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req?.ip || null;
}

/** Replace the user's active session and return the new session id. */
export async function startSession(user, req) {
  await ensurePurchaseBillsReady();
  const sessionId = randomUUID();
  await CdcBillsSession.findOneAndUpdate(
    { userKey: user.userKey },
    {
      userKey: user.userKey,
      sessionId,
      displayName: user.displayName,
      role: user.role,
      loggedInAt: new Date(),
      userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
      ip: clientIp(req),
    },
    { upsert: true, new: true },
  );
  return sessionId;
}

/** True when `sessionId` is still the user's active session. */
export async function isSessionActive(userKey, sessionId) {
  if (!sessionId) return false;
  await ensurePurchaseBillsReady();
  const doc = await CdcBillsSession.findOne({ userKey }).select('sessionId').lean();
  return !!doc && doc.sessionId === sessionId;
}

/** Clear the session on explicit logout (only if it is still the active one). */
export async function endSession(userKey, sessionId) {
  await ensurePurchaseBillsReady();
  await CdcBillsSession.deleteOne({ userKey, sessionId });
}
