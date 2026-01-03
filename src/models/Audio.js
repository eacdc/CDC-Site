import mongoose from 'mongoose';
import { getVoiceNotesConnection } from '../db-voice-notes.js';

const audioSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  toDepartment: {
    type: String,
    required: true,
    enum: ['prepress', 'postpress', 'printing'],
  },
  audioBlob: {
    type: Buffer,
    required: true,
  },
  audioMimeType: {
    type: String,
    required: true,
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
audioSchema.index({ jobNumber: 1, createdAt: -1 });
audioSchema.index({ toDepartment: 1, createdAt: -1 });

// Create model using the voice notes connection
let Audio = null;

export default async function getAudioModel() {
  if (!Audio) {
    const connection = await getVoiceNotesConnection();
    Audio = connection.model('Audio', audioSchema);
  }
  return Audio;
}
