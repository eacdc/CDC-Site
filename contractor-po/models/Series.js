const mongoose = require('mongoose');

const seriesSchema = new mongoose.Schema({
  jobNumbers: [{
    type: String,
    required: true,
    trim: true
  }],
  savedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Series', seriesSchema);

