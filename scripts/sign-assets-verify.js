/**
 * Check every published signature image on the live static site.
 *
 *   node scripts/sign-assets-verify.js
 *   node scripts/sign-assets-verify.js --base-url https://cdc-assets.onrender.com
 *
 * Fetches each URL in sign-assets/published.json the way a mail client's
 * image proxy would — no cookies, non-browser user agent — and requires
 * 200, content-type image/png and the exact committed bytes. Cache-Control
 * without "immutable" is reported as a warning (fix it in Render's Headers).
 */

import { readManifest, sha256 } from './sign-assets-build.js';

const DEFAULT_BASE_URL = 'https://assets.cdcprinters.com';
const USER_AGENT = 'cdc-sign-assets-verify/1.0';

const i = process.argv.indexOf('--base-url');
const baseUrl = (i === -1 ? DEFAULT_BASE_URL : process.argv[i + 1] || '').replace(/\/+$/, '');

const entries = Object.entries(readManifest());
if (entries.length === 0) {
  console.error('sign-assets/published.json is empty. Run: npm run sign-assets:build');
  process.exit(1);
}

let failed = 0;
console.log(`Checking ${baseUrl} (no cookies, user agent "${USER_AGENT}"):\n`);

for (const [rel, expected] of entries) {
  const url = `${baseUrl}/${rel}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    const cache = res.headers.get('cache-control') || '';
    const body = Buffer.from(await res.arrayBuffer());

    const errors = [];
    if (res.status !== 200) errors.push(`status ${res.status}`);
    if (!type.startsWith('image/png')) errors.push(`content-type "${type}"`);
    if (res.status === 200 && sha256(body) !== expected.sha256) errors.push('bytes differ from the committed file');
    const warning = cache.includes('immutable') ? '' : `  (warning: cache-control "${cache}")`;

    if (errors.length) failed++;
    console.log(`${errors.length ? 'FAIL' : 'ok  '}  ${url}${errors.length ? '  ← ' + errors.join(', ') : ''}${warning}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${url}  ← ${err.cause?.code || err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} URL(s) failed. Do not put those in a signature yet.`);
  process.exit(1);
}
console.log('\nAll URLs good. Use exactly these in the signature.');
