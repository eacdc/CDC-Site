/**
 * Publish the built signature images to the PUBLIC R2 bucket and verify them.
 *
 *   node scripts/sign-assets-build.js            # first: build sign-icons/dist/
 *   node scripts/sign-assets-upload.js           # upload to sign/v1/, then verify
 *   node scripts/sign-assets-upload.js --version v2
 *   node scripts/sign-assets-upload.js --verify-only
 *
 * Keys are sign/<version>/<name>.png. Gmail's image proxy caches hard, so a
 * published key is never overwritten:
 *
 *   key absent                    → uploaded
 *   key present, identical bytes  → skipped (safe to re-run)
 *   key present, different bytes  → refused; publish with --version v2 and
 *                                   point the signature at the new URLs
 *
 * Verification fetches each public URL the way a mail client's image proxy
 * would — no cookies, non-browser user agent — and requires 200 with
 * content-type image/png.
 *
 * Needs R2_ACCOUNT_ID, R2_PUBLIC_BUCKET, R2_PUBLIC_BASE_URL and write
 * credentials for that bucket (R2_PUBLIC_RW_* or R2_RW_*). See README.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Imported after dotenv: r2-storage reads its env at module load.
const { headPublicObject, putPublicObject } = await import('../src/lib/r2-storage.js');

const DIST_DIR = path.join(__dirname, '..', 'sign-icons', 'dist');
const NAMES = ['facebook', 'instagram', 'youtube', 'linkedin', 'certifications'];
const USER_AGENT = 'cdc-sign-assets-verify/1.0';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const version = arg('--version') || 'v1';
const verifyOnly = process.argv.includes('--verify-only');
const baseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!/^v\d+$/.test(version)) {
  console.error(`--version must look like v1, v2, ... (got "${version}")`);
  process.exit(1);
}
if (!baseUrl) {
  console.error('R2_PUBLIC_BASE_URL is not set, e.g. https://assets.cdcprinters.com');
  process.exit(1);
}

const files = NAMES
  .map((name) => ({ name, file: path.join(DIST_DIR, `${name}.png`) }))
  .filter((f) => fs.existsSync(f.file));

if (files.length === 0) {
  console.error('Nothing in sign-icons/dist/. Run: node scripts/sign-assets-build.js');
  process.exit(1);
}

let failed = 0;

if (!verifyOnly) {
  for (const { name, file } of files) {
    const key = `sign/${version}/${name}.png`;
    const buffer = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const existing = await headPublicObject(key);

    if (existing) {
      if (existing.etag === md5) {
        console.log(`same     ${key} (already published)`);
      } else {
        console.error(`REFUSED  ${key} exists with different content. Publish with --version v${Number(version.slice(1)) + 1}.`);
        failed++;
      }
      continue;
    }

    await putPublicObject({ key, buffer, contentType: 'image/png' });
    console.log(`uploaded ${key} (${buffer.length} bytes)`);
  }
}

console.log('\nVerifying public URLs (no cookies, non-browser user agent):');
for (const { name, file } of files) {
  const url = `${baseUrl}/sign/${version}/${name}.png`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    const cache = res.headers.get('cache-control') || '';
    const body = Buffer.from(await res.arrayBuffer());
    const expected = fs.readFileSync(file);
    const problems = [];
    if (res.status !== 200) problems.push(`status ${res.status}`);
    if (!type.startsWith('image/png')) problems.push(`content-type "${type}"`);
    if (res.status === 200 && !body.equals(expected)) problems.push('body differs from local build');
    if (!cache.includes('immutable')) problems.push(`cache-control "${cache}" (warning)`);

    const fatal = problems.filter((p) => !p.endsWith('(warning)'));
    if (fatal.length) failed++;
    console.log(`${fatal.length ? 'FAIL' : 'ok  '}  ${url}${problems.length ? '  ← ' + problems.join(', ') : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${url}  ← ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} problem(s). Nothing above marked FAIL is safe to put in a signature.`);
  process.exit(1);
}
console.log('\nAll URLs good. Use exactly these in the signature.');
