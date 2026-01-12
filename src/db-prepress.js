import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Separate MongoDB connection for Prepress FMS
let prepressConnection = null;

export async function getPrepressConnection() {
  if (prepressConnection && prepressConnection.readyState === 1) {
    return prepressConnection;
  }

  const MONGODB_URI_APPROVAL = process.env.MONGODB_URI_Approval || process.env.MONGODB_URI_APPROVAL || 'mongodb://localhost:27017/prepress';
  
  try {
    prepressConnection = mongoose.createConnection(MONGODB_URI_APPROVAL);
    
    // Wait for connection to be ready
    await new Promise((resolve, reject) => {
      if (prepressConnection.readyState === 1) {
        console.log('✅ Connected to Prepress MongoDB (MONGODB_URI_Approval)');
        resolve();
      } else {
        prepressConnection.once('connected', () => {
          console.log('✅ Connected to Prepress MongoDB (MONGODB_URI_Approval)');
          resolve();
        });
        prepressConnection.once('error', (err) => {
          console.error('❌ Prepress MongoDB connection error:', err);
          reject(err);
        });
      }
    });
    
    return prepressConnection;
  } catch (error) {
    console.error('❌ Prepress MongoDB connection error:', error);
    throw error;
  }
}

export async function closePrepressConnection() {
  if (prepressConnection) {
    await prepressConnection.close();
    prepressConnection = null;
    console.log('Prepress MongoDB connection closed');
  }
}
