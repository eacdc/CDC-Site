import mongoose from 'mongoose';
import { getVoiceNotesConnection } from '../db-voice-notes.js';

const voiceNoteSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: true,
    trim: true,
  },
  toDepartment: {
    type: String,
    required: true,
    enum: ['prepress', 'postpress', 'printing', 'sales', 'post printing', 'packing and dispatch', 'other'],
  },
  voiceNote: {
    type: String,
    trim: true,
  },
  audioBlob: {
    type: Buffer,
  },
  audioMimeType: {
    type: String,
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

// Create model using the voice notes connection
let VoiceNote = null;

export default async function getVoiceNoteModel() {
  if (!VoiceNote) {
    const connection = await getVoiceNotesConnection();
    VoiceNote = connection.model('VoiceNote', voiceNoteSchema);
  }
  return VoiceNote;
}
