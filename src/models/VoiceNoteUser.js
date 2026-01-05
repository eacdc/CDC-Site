import mongoose from 'mongoose';
import { getVoiceNotesConnection } from '../db-voice-notes.js';

const voiceNoteUserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
    // Storing as plain text as per user requirement
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Create model using the voice notes connection
let VoiceNoteUser = null;

export default async function getVoiceNoteUserModel() {
  if (!VoiceNoteUser) {
    const connection = await getVoiceNotesConnection();
    VoiceNoteUser = connection.model('VoiceNoteUser', voiceNoteUserSchema);
  }
  return VoiceNoteUser;
}
