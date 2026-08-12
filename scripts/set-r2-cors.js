/**
 * Apply the browser CORS policy to the R2 bucket.
 *
 * Why this exists
 * ---------------
 * The upload flow is direct-to-storage: the browser PUTs the file to
 * `https://<account>.r2.cloudflarestorage.com/...` using a presigned URL minted
 * by POST /api/purchase-bills/upload-url. That request never touches Express,
 * so the `cors()` middleware in src/server.js is irrelevant to it — the only
 * thing that can allow it is a CORS policy stored on the bucket itself.
 *
 * A fresh R2 bucket has NO CORS policy. S3-compatible endpoints answer the
 * browser's preflight `OPTIONS` with `403 Forbidden` and no
 * `Access-Control-Allow-Origin` header, which surfaces in the console as:
 *
 *   Access to fetch at 'https://<account>.r2.cloudflarestorage.com/...'
 *   from origin 'https://cdc-bills.onrender.com' has been blocked by CORS
 *   policy: No 'Access-Control-Allow-Origin' header is present ...
 *   PUT ... net::ERR_FAILED 403 (Forbidden)
 *
 * That is a bucket-configuration problem, not a signature problem — the
 * presigned URL is fine, the browser is simply never allowed to send it.
 *
 * Usage
 * -----
 *   node scripts/set-r2-cors.js                 # show current policy, no writes
 *   node scripts/set-r2-cors.js --apply         # write the policy
 *   node scripts/set-r2-cors.js --apply --origins https://a.com,https://b.com
 *
 * Origins resolve in this order: --origins flag, then R2_CORS_ORIGINS (comma
 * separated), then DEFAULT_ORIGINS below. Requires R2_RW_* credentials; the
 * read-only key cannot change bucket configuration.
 *
 * Idempotent: PutBucketCors replaces the whole policy, so re-running is safe.
 * This only affects browser JavaScript. Server-to-server calls (uploadBuffer,
 * confirmUpload, OpenAI fetching a signed view URL) are unaffected either way,
 * which is why those paths kept working while the browser upload did not.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Every origin that runs the bills UI. An origin is scheme + host + port and
 * must match exactly — `https://cdc-bills.onrender.com` does not cover
 * `http://`, a `www.` variant, or a custom domain. Add new frontends here (or
 * via R2_CORS_ORIGINS) rather than reaching for a wildcard: the presigned URL
 * is the only credential in play, and `*` would let any page that obtains one
 * spend it from the user's browser.
 */
const DEFAULT_ORIGINS = [
  'https://cdc-bills.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function parseArgs(argv) {
  const args = { apply: false, origins: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--origins') args.origins = argv[++i];
    else if (arg.startsWith('--origins=')) args.origins = arg.slice('--origins='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function resolveOrigins(flagValue) {
  const raw = flagValue || process.env.R2_CORS_ORIGINS || '';
  const listed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return listed.length ? listed : DEFAULT_ORIGINS;
}

function buildRules(origins) {
  return [
    {
      AllowedOrigins: origins,
      // PUT is the upload itself. GET/HEAD cover presigned view URLs read by
      // JavaScript (fetch/XHR) — <img src> needs no CORS, but the phash and
      // PDF paths do. POST is deliberately absent: nothing posts to R2.
      AllowedMethods: ['GET', 'HEAD', 'PUT'],
      // The preflight for the upload asks for `content-type`. `content-length`
      // is signed into the URL but the browser sets it itself and never lists
      // it in Access-Control-Request-Headers, so it needs no entry here.
      AllowedHeaders: ['content-type', 'content-length', 'cache-control'],
      // ETag is what a client would read back to verify the stored object.
      ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
      // Cache the preflight for an hour so a multi-page bill upload does not
      // pay an extra round trip per file.
      MaxAgeSeconds: 3600,
    },
  ];
}

async function readCurrent(client, bucket) {
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    return res.CORSRules || [];
  } catch (err) {
    // R2 reports an unconfigured bucket as NoSuchCORSConfiguration. That is the
    // expected state before this script has ever run — not an error.
    if (err?.name === 'NoSuchCORSConfiguration' || err?.Code === 'NoSuchCORSConfiguration') {
      return null;
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/set-r2-cors.js [--apply] [--origins https://a.com,https://b.com]'
    );
    return;
  }

  const bucket = process.env.R2_BUCKET;
  const accountId = process.env.R2_ACCOUNT_ID;
  const keyId = process.env.R2_RW_ACCESS_KEY_ID;
  const secret = process.env.R2_RW_SECRET_ACCESS_KEY;

  const missing = [
    ['R2_BUCKET', bucket],
    ['R2_ACCOUNT_ID', accountId],
    ['R2_RW_ACCESS_KEY_ID', keyId],
    ['R2_RW_SECRET_ACCESS_KEY', secret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Bucket configuration needs the read+write key, not the read-only one.');
    process.exitCode = 1;
    return;
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  const origins = resolveOrigins(args.origins);
  const rules = buildRules(origins);

  const current = await readCurrent(client, bucket);
  console.log(`Bucket: ${bucket} (account ${accountId})`);
  console.log(
    current === null
      ? 'Current CORS policy: none — browser uploads will fail preflight with 403.'
      : `Current CORS policy:\n${JSON.stringify(current, null, 2)}`
  );

  if (!args.apply) {
    console.log(`\nWould write:\n${JSON.stringify(rules, null, 2)}`);
    console.log('\nDry run. Re-run with --apply to write this policy.');
    return;
  }

  await client.send(
    new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } })
  );

  const written = await readCurrent(client, bucket);
  console.log(`\nApplied. Bucket CORS policy is now:\n${JSON.stringify(written, null, 2)}`);
  console.log(
    '\nPreflight results are cached by the browser; hard-reload the bills UI before retesting.'
  );
}

main().catch((err) => {
  console.error('set-r2-cors failed:', err?.message || err);
  process.exitCode = 1;
});
