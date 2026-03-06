const mongoose = require('mongoose');

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

module.exports = mongoose.models['Contractor'] || mongoose.model('Contractor', contractorSchema);
