import mongoose from 'mongoose';

const operationSchema = new mongoose.Schema({
  opsName: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['1:1', '1*x', '1/x'],
    required: true
  },
  ratePerUnit: {
    type: Number,
    required: true,
    min: 0
  }
}, {
  timestamps: true
});

export default mongoose.model('Operation', operationSchema);

