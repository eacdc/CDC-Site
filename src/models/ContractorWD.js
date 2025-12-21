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

export default mongoose.model('Contractor_WD', contractorWDSchema);

