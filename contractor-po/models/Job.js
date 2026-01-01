const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  clientName: {
    type: String,
    required: true,
    trim: true
  },
  jobTitle: {
    type: String,
    required: true,
    trim: true
  },
  qty: {
    type: Number,
    required: true,
    min: 0
  },
  productCat: {
    type: String,
    trim: true
  },
  unitPrice: {
    type: Number,
    min: 0
  },
  operations: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobOperation'
  }]
}, {
  timestamps: true
});

module.exports = mongoose.model('Job', jobSchema);
