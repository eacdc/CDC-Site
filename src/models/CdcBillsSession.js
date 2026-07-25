import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One row per user holding the *only* session id that is currently valid.
 * Logging in overwrites it, which invalidates the token held by every other
 * device for that account.
 *
 * Registered only on the billing DB connection — see `db-purchase-bills.js`.
 */
export const cdcBillsSessionSchema = new Schema({
  userKey: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true },
  displayName: String,
  role: { type: String, enum: ['admin', 'employee'] },
  loggedInAt: { type: Date, default: Date.now },
  userAgent: String,
  ip: String,
}, {
  collection: 'CdcBillsSessions',
  timestamps: true,
});
