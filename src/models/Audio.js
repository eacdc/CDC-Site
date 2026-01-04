import mongoose from 'mongoose';
import { getVoiceNotesConnection } from '../db-voice-notes.js';

const audioRecordingSchema = new mongoose.Schema({
  audioBlob: {
    type: Buffer,
    required: true,
  },
  audioMimeType: {
    type: String,
    required: true,
  },
  toDepartment: {
    type: String,
    required: true,
    enum: ['prepress', 'postpress', 'printing'],
  },
  summary: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

const audioSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  createdBy: {
    type: String,
    required: true,
    trim: true,
  },
  recordings: [audioRecordingSchema],
}, {
  timestamps: true
});

// Compound index for faster queries by jobNumber and user
audioSchema.index({ jobNumber: 1, createdBy: 1 }, { unique: true });

// Create model using the voice notes connection
let Audio = null;

export default async function getAudioModel() {
  if (!Audio) {
    const connection = await getVoiceNotesConnection();
    Audio = connection.model('Audio', audioSchema);
  }
  return Audio;
}
