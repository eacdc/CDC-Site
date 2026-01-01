const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Login
router.post('/login', async (req, res) => {
  try {
    const { userId, passkey } = req.body;

    if (!userId || !passkey) {
      return res.status(400).json({ error: 'User ID and passkey are required' });
    }

    // Find user
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // For now, simple comparison (in production, use bcrypt)
    // If passkey is already hashed, use: const isValid = await bcrypt.compare(passkey, user.passkey);
    const isValid = passkey === user.passkey || await bcrypt.compare(passkey, user.passkey);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.userId, id: user._id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        userId: user.userId,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Register (for initial setup)
router.post('/register', async (req, res) => {
  try {
    const { userId, passkey, name, role } = req.body;

    if (!userId || !passkey) {
      return res.status(400).json({ error: 'User ID and passkey are required' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash passkey
    const hashedPasskey = await bcrypt.hash(passkey, 10);

    // Create user
    const user = new User({
      userId,
      passkey: hashedPasskey,
      name: name || userId,
      role: role || 'user'
    });

    await user.save();

    res.status(201).json({ message: 'User created successfully', userId: user.userId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

module.exports = router;
