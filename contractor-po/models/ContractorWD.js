const mongoose = require('mongoose');

// Contractor_WD collection
//  - Contractor id (contractorId)
//  - JobID (jobId)
//  - OpsDone (array of subdocuments)
//      * Ops ID (opsId)
//      * Ops Done (opsDoneQty)
//      * CompletionDate (completionDate)

const opsDoneSubSchema = new mongoose.Schema({
  opsId: {
    type: String,
    required: true,
    trim: true,
  },
  opsName: {
    type: String,
    required: true,
    trim: true,
  },
  valuePerBook: {
    type: Number,
    required: true,
    min: 0,
  },
  opsDoneQty: {
    type: Number,
    required: true,
    min: 0,
  },
  completionDate: {
    type: Date,
    default: Date.now,
  },
}, { _id: false });

const contractorWDSchema = new mongoose.Schema({
  contractorId: {
    type: String,
    required: true,
    trim: true,
  },
  jobId: {
    type: String,
    required: true,
    trim: true,
  },
  opsDone: [opsDoneSubSchema],
}, {
  collection: 'Contractor_WD',
});

module.exports = mongoose.model('Contractor_WD', contractorWDSchema);
