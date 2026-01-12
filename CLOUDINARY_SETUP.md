# Cloudinary Integration Setup Guide

## Current Implementation

The backend now uploads audio files to Cloudinary when saving voice notes. The system stores both:
- **Audio blob** in MongoDB (backup)
- **Cloudinary URL** for CDN access

## Setup Steps

### 1. Install Cloudinary Package

```bash
cd "c:\Users\User\Desktop\CDC Site\backend"
npm install cloudinary
```

### 2. Configure Environment Variables

Add these to your `.env` file (local) and Render environment variables (production):

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

### 3. Get Cloudinary Credentials

1. Sign up at https://cloudinary.com/users/register/free
2. Go to Dashboard
3. Copy the credentials:
   - **Cloud Name**: Found at the top
   - **API Key**: Found in "Account Details"
   - **API Secret**: Click "reveal" next to API Secret

### 4. Add to Render Environment Variables

1. Go to your Render dashboard
2. Select your backend service
3. Go to "Environment" tab
4. Add three environment variables:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
5. Click "Save Changes"
6. Render will automatically redeploy

## Verification

### Test Cloudinary Configuration

Visit this endpoint to verify Cloudinary is configured:

```
GET https://cdcapi.onrender.com/api/test-cloudinary
```

Expected response:
```json
{
  "cloudinaryConfigured": true,
  "cloudName": "Set ✓",
  "apiKey": "Set ✓",
  "apiSecret": "Set ✓",
  "cloudinaryInstance": "Available ✓"
}
```

If any field shows `"Missing ✗"`, that environment variable is not set correctly.

### Check Backend Logs

When you save audio, look for these logs in Render:

**Successful upload:**
```
✅ Cloudinary configured successfully
📤 [CLOUDINARY] Starting upload to Cloudinary...
📤 [CLOUDINARY] Audio buffer size: XXXXX bytes
📤 [CLOUDINARY] Format: webm
📤 [CLOUDINARY] Public ID: voice-notes/job-XXXX-1234567890
✅ [CLOUDINARY] Audio uploaded successfully. URL: https://res.cloudinary.com/...
```

**Configuration missing:**
```
⚠️ Cloudinary credentials not found. Audio URLs will not be stored.
⚠️ [CLOUDINARY] Cloudinary credentials not configured. Skipping upload.
```

**Upload error:**
```
❌ [CLOUDINARY] Upload error: [error details]
⚠️ [CLOUDINARY] Error uploading to Cloudinary: [error message]
```

## Troubleshooting

### Cloudinary URL is blank

1. **Check environment variables are set:**
   - Visit `/api/test-cloudinary` endpoint
   - All three credentials must show "Set ✓"

2. **Check Render logs:**
   - Go to Render dashboard > Your service > Logs
   - Look for Cloudinary-related logs when saving audio
   - Check if configuration message appears on startup

3. **Verify credentials are correct:**
   - Log into Cloudinary dashboard
   - Copy credentials again
   - Make sure no extra spaces or quotes

4. **Restart the service:**
   - After adding environment variables in Render, the service should auto-restart
   - If not, manually trigger a restart

### Common Issues

**Issue:** "cloudinaryConfigured: false"
**Solution:** Environment variables not set in Render. Add them in Environment tab.

**Issue:** Upload errors in logs
**Solution:** Check API credentials are correct. Verify your Cloudinary account is active.

**Issue:** Package not found error
**Solution:** Make sure `npm install cloudinary` was run and `package.json` has the dependency.

## API Response Format

After successful upload, the save audio response includes:

```json
{
  "_id": "recording_id",
  "jobNumber": "JOB1001",
  "toDepartment": "printing",
  "audioMimeType": "audio/webm",
  "cloudinaryUrl": "https://res.cloudinary.com/your-cloud/video/upload/v1234/voice-notes/job-JOB1001-1234567890.webm",
  "createdBy": "username",
  "createdAt": "2024-01-04T00:00:00.000Z"
}
```

The batch endpoint (`/api/voice-note-tool/audio/jobs/batch`) returns `audioUrl` instead of `audioBlob`.

## Cloudinary Free Tier Limits

- **Storage**: 25 GB
- **Bandwidth**: 25 GB/month
- **Transformations**: 25,000 per month
- **Videos**: Unlimited uploads

This should be more than sufficient for voice notes.
