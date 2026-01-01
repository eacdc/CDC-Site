const mongoose = require('mongoose');

// OperationMaster collection
// Fields:
//  - Ops ID (stored as opsId)
//  - Ops Name (opsName)
//  - Rate/unit (ratePerUnit)
//  - rateEffectiveDate
const operationMasterSchema = new mongoose.Schema({
  opsId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  opsName: {
    type: String,
    required: true,
    trim: true,
  },
  ratePerUnit: {
    type: Number,
    required: true,
    min: 0,
  },
  rateEffectiveDate: {
    type: Date,
    required: true,
  },
}, {
  collection: 'OperationMaster',
});

module.exports = mongoose.model('OperationMaster', operationMasterSchema);
