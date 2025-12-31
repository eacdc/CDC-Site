import mongoose from 'mongoose';

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

export default mongoose.model('Series', seriesSchema);

