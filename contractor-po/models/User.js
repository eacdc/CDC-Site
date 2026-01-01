const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // userid
  userId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  // username (display name)
  username: {
    type: String,
    required: true,
    trim: true,
  },
  // passkey
  passkey: {
    type: String,
    required: true,
  },
  // optional extra fields
  name: {
    type: String,
    trim: true,
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user',
  },
}, {
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);
