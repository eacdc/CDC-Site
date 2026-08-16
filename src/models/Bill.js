import mongoose from 'mongoose';

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
  opId: {
    type: String,
    trim: true,
    default: '',
  },
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
    trim: true,
    default: '',
  },
  clientName: {
    type: String,
    trim: true,
    default: '',
  },
  jobTitle: {
    type: String,
    trim: true,
    default: '',
  },
  isAdhoc: {
    type: Boolean,
    default: false,
  },
  adhocOrderId: {
    type: String,
    trim: true,
    default: '',
  },
  adhocLabel: {
    type: String,
    trim: true,
    default: '',
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
  // Stable link to the contractor. contractorName alone is ambiguous when two
  // contractors share a name, and it breaks when one is renamed — which left
  // bill reversals resolving to the wrong Contractor_WD document. Bills
  // created before this field exists fall back to matching by name.
  contractorId: {
    type: String,
    trim: true,
    default: '',
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
  // Composed contractor bill ref: mm_yy_<shortId>_<enteredNo> (e.g. 07_26_13_231)
  contractorBillNo: {
    type: String,
    trim: true,
    default: '',
  },
  roomRent: {
    type: Number,
    default: 0,
    min: 0,
  },
  isDeleted: {
    type: Number,
    default: 0,
    enum: [0, 1],
  },
  jobs: [jobSubSchema],
}, {
  collection: 'Bills',
  timestamps: true,
});

export default mongoose.model('Bill', billSchema);
