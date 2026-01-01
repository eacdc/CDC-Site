const mongoose = require('mongoose');

const jobOperationSchema = new mongoose.Schema({
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  operation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Operation',
    required: true
  },
  qtyPerBook: {
    type: Number,
    required: true,
    min: 0
  },
  rate: {
    type: Number,
    required: true,
    min: 0
  },
  ratePerBook: {
    type: Number,
    required: true,
    min: 0
  },
  contractorWork: [{
    contractor: {
      type: String,
      required: true
    },
    completedQty: {
      type: Number,
      default: 0,
      min: 0
    }
  }]
}, {
  timestamps: true
});

module.exports = mongoose.model('JobOperation', jobOperationSchema);
