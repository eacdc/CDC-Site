import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Separate MongoDB connection for Voice Notes
let voiceNotesConnection = null;

export async function getVoiceNotesConnection() {
  if (voiceNotesConnection && voiceNotesConnection.readyState === 1) {
    return voiceNotesConnection;
  }

  const MONGODB_URI_VT = process.env.MONGODB_URI_VT || process.env.MONGODB_URI || 'mongodb://localhost:27017/voice-tool';
  
  try {
    voiceNotesConnection = mongoose.createConnection(MONGODB_URI_VT);
    
    // Wait for connection to be ready
    await new Promise((resolve, reject) => {
      if (voiceNotesConnection.readyState === 1) {
        console.log('✅ Connected to Voice Notes MongoDB');
        resolve();
      } else {
        voiceNotesConnection.once('connected', () => {
          console.log('✅ Connected to Voice Notes MongoDB');
          resolve();
        });
        voiceNotesConnection.once('error', (err) => {
          console.error('❌ Voice Notes MongoDB connection error:', err);
          reject(err);
        });
      }
    });
    
    return voiceNotesConnection;
  } catch (error) {
    console.error('❌ Voice Notes MongoDB connection error:', error);
    throw error;
  }
}

export async function closeVoiceNotesConnection() {
  if (voiceNotesConnection) {
    await voiceNotesConnection.close();
    voiceNotesConnection = null;
    console.log('Voice Notes MongoDB connection closed');
  }
}
