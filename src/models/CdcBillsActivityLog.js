import mongoose from 'mongoose';

const { Schema } = mongoose;

export const cdcBillsActivityLogSchema = new Schema({
  at: { type: Date, default: Date.now, index: true },
  userKey: { type: String, required: true, index: true },
  displayName: { type: String, required: true },
  role: { type: String, enum: ['admin', 'employee'], required: true },
  action: { type: String, required: true, index: true },
  billId: { type: String, default: null },
  details: { type: Schema.Types.Mixed, default: null },
}, {
  collection: 'CdcBillsActivityLogs',
});

cdcBillsActivityLogSchema.index({ at: -1 });
