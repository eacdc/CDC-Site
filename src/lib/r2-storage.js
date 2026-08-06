/**
 * r2-storage.js — read and write access to a PRIVATE R2 bucket.
 *
 *   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * Two credentials, deliberately:
 *   R2_RW_*  — read+write. Only on backends that accept uploads.
 *   R2_RO_*  — read only.   On backends that merely display images.
 * Falls back to RW if RO is not set.
 *
 * The browser never sees either one. It only ever receives short-lived
 * presigned URLs that your server chose to mint.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const BUCKET = process.env.R2_BUCKET;
const ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const makeClient = (keyId, secret) =>
  new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    // AWS SDK v3.729+ defaults to WHEN_SUPPORTED, which bakes an
    // x-amz-checksum-crc32 into presigned PUT URLs. At signing time there is
    // no body, so the value is the CRC32 of empty content — and the real
    // upload then fails the integrity check. WHEN_REQUIRED keeps checksums for
    // the operations that mandate them and leaves presigned PUTs alone.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

const rw = makeClient(process.env.R2_RW_ACCESS_KEY_ID, process.env.R2_RW_SECRET_ACCESS_KEY);
const ro = process.env.R2_RO_ACCESS_KEY_ID
  ? makeClient(process.env.R2_RO_ACCESS_KEY_ID, process.env.R2_RO_SECRET_ACCESS_KEY)
  : rw;

// ------------------------------------------------------------------ policy

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a phone photo of an invoice

// ------------------------------------------------------------------ reading

export function viewUrl(key, expiresIn = 3600) {
  return getSignedUrl(ro, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

export function downloadUrl(key, filename, expiresIn = 300) {
  const name = (filename || key.split('/').pop()).replace(/"/g, '');
  return getSignedUrl(
    ro,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${name}"`,
    }),
    { expiresIn }
  );
}

export async function viewUrls(keys, expiresIn = 3600) {
  return Promise.all(keys.map(async (key) => ({ key, url: await viewUrl(key, expiresIn) })));
}

// ------------------------------------------------------------------ writing

/**
 * Server-side key generation. Random, date-partitioned, collision-free.
 * Because the name is a UUID, an upload can never overwrite an existing
 * object — which is exactly what you want for immutable records.
 */
function newKey(folder, contentType) {
  const ext = ALLOWED_TYPES[contentType];
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeFolder = String(folder).replace(/[^a-zA-Z0-9/_-]/g, '');
  return `${safeFolder}/${yyyy}/${mm}/${randomUUID()}.${ext}`;
}

/**
 * Mint a one-shot upload URL. Call this from an authenticated route —
 * check the user's session BEFORE calling it.
 *
 * The client must PUT with exactly the contentType and contentLength it
 * declared; both are signed into the URL, so a mismatch is rejected by R2.
 * That is what stops someone declaring a 1 MB JPEG and sending a 4 GB file.
 *
 * @returns {{ key: string, url: string, expiresIn: number }}
 */
export async function createUploadUrl({ folder = 'uploads', contentType, contentLength }) {
  if (!ALLOWED_TYPES[contentType]) {
    throw new Error(`Rejected content type: ${contentType}`);
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > MAX_BYTES) {
    throw new Error(`Rejected size: ${contentLength} (max ${MAX_BYTES})`);
  }

  const key = newKey(folder, contentType);
  const url = await getSignedUrl(
    rw,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
    { expiresIn: 600 }
  );

  return { key, url, expiresIn: 600 };
}

/**
 * Call AFTER the browser reports a successful PUT, BEFORE you write the
 * database row. Confirms the object really landed at the expected size.
 * Without this, a failed upload leaves you with a DB record pointing at
 * nothing — the single most common bug in direct-to-storage flows.
 */
export async function confirmUpload(key, expectedBytes) {
  const head = await rw.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  if (expectedBytes && head.ContentLength !== expectedBytes) {
    throw new Error(`Size mismatch: expected ${expectedBytes}, stored ${head.ContentLength}`);
  }
  return { key, bytes: head.ContentLength, contentType: head.ContentType };
}

/**
 * Server-side upload, for when the file already lives on your server —
 * a WhatsApp webhook payload, a scheduled import, a scanner drop folder.
 */
export async function uploadBuffer({ folder = 'uploads', buffer, contentType }) {
  if (!ALLOWED_TYPES[contentType]) throw new Error(`Rejected content type: ${contentType}`);
  if (buffer.length > MAX_BYTES) throw new Error(`Rejected size: ${buffer.length}`);

  const key = newKey(folder, contentType);
  await rw.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return { key, bytes: buffer.length };
}
