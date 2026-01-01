const mongoose = require('mongoose');

// JobopsMaster collection
//  - JobID (jobId)
//  - Total Qty (totalQty)
//  - Ops (array of subdocuments)
//      * OpID (opId)
//      * Qty/book (qtyPerBook)
//      * totalOpsQty
//      * pendingOpsQty
//      * Value/book (valuePerBook)
//      * Creation date (creationDate)
//      * LastupdatedDate (lastUpdatedDate)

const jobOpSubSchema = new mongoose.Schema({
  opId: {
    type: String,
    required: true,
    trim: true,
  },
  qtyPerBook: {
    type: Number,
    required: true,
    min: 0,
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
  valuePerBook: {
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

const jobOpsMasterSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    trim: true,
  },
  totalQty: {
    type: Number,
    required: true,
    min: 0,
  },
  ops: [jobOpSubSchema],
}, {
  collection: 'JobopsMaster',
});

module.exports = mongoose.model('JobopsMaster', jobOpsMasterSchema);
