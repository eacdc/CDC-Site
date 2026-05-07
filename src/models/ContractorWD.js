import mongoose from 'mongoose';

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
  savedInBill: {
    type: String,
    enum: ['Yes', 'No'],
    default: 'No',
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
    required: false,
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
  opsDone: [opsDoneSubSchema],
}, {
  collection: 'Contractor_WD',
});

export default mongoose.model('Contractor_WD', contractorWDSchema);
