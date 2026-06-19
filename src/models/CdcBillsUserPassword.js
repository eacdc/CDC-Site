import mongoose from 'mongoose';

const { Schema } = mongoose;

export const cdcBillsUserPasswordSchema = new Schema({
  userKey: { type: String, required: true, unique: true, index: true },
  displayName: { type: String, required: true },
  passwordHash: { type: String, required: true },
  updatedBy: String,
}, {
  collection: 'CdcBillsUserPasswords',
  timestamps: true,
});
