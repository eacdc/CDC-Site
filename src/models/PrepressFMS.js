import mongoose from 'mongoose';
import { getPrepressConnection } from '../db-prepress.js';

const prepressFMSSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['packaging', 'commercial'],
    index: true,
  },
  // Packaging fields
  clientName: {
    type: String,
    trim: true,
  },
  executive: {
    type: String,
    trim: true,
  },
  category: {
    type: String,
    trim: true,
  },
  itemName: {
    type: String,
    trim: true,
  },
  remarks: {
    type: String,
    trim: true,
    default: '',
  },
  newRevised: {
    type: String,
    enum: ['new', 'revised'],
  },
  prepressPerson: {
    type: String,
    trim: true,
  },
  softcopyRequired: {
    type: Boolean,
    default: false,
  },
  hardcopyRequired: {
    type: Boolean,
    default: false,
  },
  // Commercial fields (shared fields use same names as packaging)
  // clientName, executive, category, remarks, newRevised, prepressPerson, softcopyRequired, hardcopyRequired are shared
  fileDetails: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: String,
    trim: true,
    default: 'admin',
  },
}, {
  timestamps: true
});

// Index for faster queries
prepressFMSSchema.index({ type: 1, createdAt: -1 });
prepressFMSSchema.index({ clientName: 1 });
prepressFMSSchema.index({ prepressPerson: 1 });
prepressFMSSchema.index({ fileDetails: 1 });

// Create model using the prepress connection (MONGODB_URI_Approval)
let PrepressFMS = null;

export default async function getPrepressFMSModel() {
  if (!PrepressFMS) {
    const connection = await getPrepressConnection();
    PrepressFMS = connection.model('PrepressFMS', prepressFMSSchema);
  }
  return PrepressFMS;
}
