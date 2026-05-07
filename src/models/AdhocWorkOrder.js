import mongoose from 'mongoose';

const adhocOpSubSchema = new mongoose.Schema({
  opId: {
    type: String,
    required: true,
    trim: true,
  },
  opsName: {
    type: String,
    required: true,
    trim: true,
  },
  totalOpsQty: {
    type: Number,
    required: true,
    min: 0,
  },
  pendingOpsQty: {
    type: Number,
    required: true,
    min: 0,
  },
  rate: {
    type: Number,
    required: true,
    min: 0,
  },
  creationDate: {
    type: Date,
    default: Date.now,
  },
  lastUpdatedDate: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const adhocWorkOrderSchema = new mongoose.Schema({
  adhocId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    match: /^adhoc_\d{6}_\d{3}$/,
  },
  description: {
    type: String,
    trim: true,
    default: '',
  },
  ops: [adhocOpSubSchema],
}, {
  collection: 'AdhocWorkOrders',
  timestamps: true,
});

export default mongoose.model('AdhocWorkOrder', adhocWorkOrderSchema);
