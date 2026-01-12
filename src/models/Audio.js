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
  cloudinaryUrl: {
    type: String,
    default: '',
  },
  cloudinaryPublicId: {
    type: String,
    default: '',
  },
  toDepartment: {
    type: String,
    required: true,
    enum: ['prepress', 'postpress', 'printing', 'sales', 'post printing', 'packing and dispatch', 'other'],
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
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VoiceNoteUser',
    index: true,
  },
  recordings: [audioRecordingSchema],
}, {
  timestamps: true
});

// Compound index for faster queries by jobNumber and userId
audioSchema.index({ jobNumber: 1, userId: 1 }, { unique: true });

// Create model using the voice notes connection
let Audio = null;

export default async function getAudioModel() {
  if (!Audio) {
    const connection = await getVoiceNotesConnection();
    Audio = connection.model('Audio', audioSchema);
  }
  return Audio;
}
