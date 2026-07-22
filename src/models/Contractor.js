import mongoose from 'mongoose';

// Contractor collection
// Fields:
//  - ID (stored as contractorId)
//  - Name
//  - Creation date
const contractorSchema = new mongoose.Schema({
  contractorId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  // Human-facing 3-digit ID (001–999). Sparse so docs without it yet don't collide.
  shortId: {
    type: Number,
    min: 1,
    max: 999,
    unique: true,
    sparse: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  creationDate: {
    type: Date,
    default: Date.now,
  },
  password: {
    type: String,
    trim: true,
    default: '',
  },
  isdeleted: {
    type: Number,
    default: 0,
    enum: [0, 1],
  },
}, {
  collection: 'Contractor',
});

export default mongoose.model('Contractor', contractorSchema);
