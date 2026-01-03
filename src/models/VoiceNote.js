import mongoose from 'mongoose';

const voiceNoteSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    trim: true,
  },
  toDepartment: {
    type: String,
    required: true,
    enum: ['prepress', 'postpress', 'printing'],
  },
  voiceNote: {
    type: String,
    required: true,
    trim: true,
  },
  createdBy: {
    type: String,
    required: true,
    trim: true,
  },
}, {
  timestamps: true
});

// Index for faster queries
voiceNoteSchema.index({ jobNumber: 1, createdAt: -1 });

export default mongoose.model('VoiceNote', voiceNoteSchema);
