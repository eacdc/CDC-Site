const mongoose = require('mongoose');

// Bills collection
//  - Bill Number (billNumber) - 8 digit starting from 00000001
//  - Contractor Name (contractorName)
//  - Jobs (array of objects)
//      * Ops (array of objects)
//          - qtyBook
//          - rate
//          - qtyCompleted
//          - totalValue

const operationSubSchema = new mongoose.Schema({
  opsName: {
    type: String,
    required: true,
    trim: true,
  },
  qtyBook: {
    type: Number,
    required: true,
    min: 0,
  },
  rate: {
    type: Number,
    required: true,
    min: 0,
  },
  qtyCompleted: {
    type: Number,
    required: true,
    min: 0,
  },
  totalValue: {
    type: Number,
    required: true,
    min: 0,
  },
}, { _id: false });

const jobSubSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    trim: true,
  },
  ops: [operationSubSchema],
}, { _id: false });

const billSchema = new mongoose.Schema({
  billNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    match: /^\d{8}$/, // 8-digit validation
  },
  contractorName: {
    type: String,
    required: true,
    trim: true,
  },
  // Payment status for the bill: "Yes" (paid) / "No" (unpaid - default)
  paymentStatus: {
    type: String,
    enum: ['Yes', 'No'],
    default: 'No',
  },
  paymentDate: {
    type: Date,
    default: null,
  },
  jobs: [jobSubSchema],
}, {
  collection: 'Bills',
  timestamps: true,
});

module.exports = mongoose.model('Bill', billSchema);
