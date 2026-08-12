/**
 * Diagnose R2 credentials and permissions from the server side.
 *
 * "Access Denied" from R2 is a single opaque string covering several distinct
 * causes — a token with read-only permission, a token scoped to a different
 * bucket, a mistyped or whitespace-padded secret, a bucket name that does not
 * exist under this account. This script separates them by exercising each
 * operation on its own and reporting which one fails.
 *
 * It is read-mostly: the only object it writes is a probe under
 * `_diagnostics/`, which it deletes again. Nothing else in the bucket is
 * touched.
 *
 *   node scripts/check-r2-access.js          # check RW and RO keys
 *   node scripts/check-r2-access.js --rw     # RW key only
 *   node scripts/check-r2-access.js --ro     # RO key only
 *
 * Expected result: the RW key passes head/put/get/delete, and the RO key
 * passes head/get but FAILS put and delete. A read-only key that can write is
 * over-permissioned; an RW key that cannot write is why uploads fail.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PROBE_BODY = Buffer.from('r2-access-probe');

function makeClient(accountId, keyId, secret) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

/** Run one operation and reduce it to pass/fail plus R2's own error code. */
async function attempt(label, fn) {
  try {
    await fn();
    return { label, ok: true };
  } catch (err) {
    return {
      label,
      ok: false,
      code: err?.name || err?.Code || 'Unknown',
      message: err?.message || String(err),
    };
  }
}

async function checkKey(role, { accountId, bucket, keyId, secret }) {
  console.log(`\n── ${role} key (${keyId.slice(0, 6)}…) ──`);

  // A trailing newline or space on a secret pasted into a dashboard field
  // produces SignatureDoesNotMatch, which reads like a wrong key.
  if (keyId !== keyId.trim() || secret !== secret.trim()) {
    console.log('  WARNING: credential has leading/trailing whitespace — signatures will fail.');
  }

  const client = makeClient(accountId, keyId.trim(), secret.trim());
  const probeKey = `_diagnostics/${randomUUID()}.txt`;

  const results = [];
  results.push(
    await attempt('head bucket', () => client.send(new HeadBucketCommand({ Bucket: bucket })))
  );
  results.push(
    await attempt('put object', () =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: probeKey,
          Body: PROBE_BODY,
          ContentType: 'text/plain',
        })
      )
    )
  );
  results.push(
    await attempt('get object', () =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: probeKey }))
    )
  );
  results.push(
    await attempt('delete object', () =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }))
    )
  );

  for (const r of results) {
    console.log(
      r.ok ? `  PASS  ${r.label}` : `  FAIL  ${r.label} — ${r.code}: ${r.message}`
    );
  }

  console.log(`\n  ${diagnose(role, results)}`);
  return results;
}

/**
 * Turn the pass/fail pattern into a cause. The distinction that matters is
 * whether reads work: a token that can read but not write is a permission
 * level, while a token that can do nothing at all is not attached to this
 * bucket in the first place — different fix, same "Access Denied" string.
 */
function diagnose(role, results) {
  const by = (label) => results.find((r) => r.label === label);
  const get = by('get object');
  const put = by('put object');
  const denied = (r) => r && !r.ok && /AccessDenied|Forbidden|403/i.test(`${r.code} ${r.message}`);
  const signature = results.find((r) => /SignatureDoesNotMatch/i.test(r?.code || ''));

  if (signature) {
    return (
      'The access key ID and secret do not match. They must come from the same\n' +
      '  R2 API token — re-copy both from one token, or issue a new one.'
    );
  }

  if (results.every((r) => r.ok)) {
    return role === 'R2_RO'
      ? 'Full access. Note this key is meant to be read-only but can also write.'
      : 'Full read+write access. This key is working correctly.';
  }

  if (denied(get) && denied(put)) {
    return (
      'Denied on reads AND writes — so this is not a read-only-token problem.\n' +
      '  A token with no access at all to this bucket means one of:\n' +
      '    • the token is not scoped to this bucket (most common — check its\n' +
      '      bucket list, or reissue it as "Apply to all buckets")\n' +
      '    • the token was deleted or revoked in the dashboard\n' +
      '    • the token belongs to a different Cloudflare account\n' +
      '  Cloudflare dashboard → R2 → Manage API Tokens, find the token whose\n' +
      '  Access Key ID matches the one above.'
    );
  }

  if (get?.ok && denied(put)) {
    return role === 'R2_RO'
      ? 'Read-only, as intended. Nothing to fix.'
      : 'Reads work, writes are denied — this token was issued with "Object Read\n' +
          '  only". Reissue it with "Object Read & Write" permission.';
  }

  return 'Mixed result — see the per-operation errors above.';
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyRw = argv.includes('--rw');
  const onlyRo = argv.includes('--ro');

  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !bucket) {
    console.error('Missing R2_ACCOUNT_ID or R2_BUCKET.');
    process.exitCode = 1;
    return;
  }

  console.log(`Bucket: ${bucket} (account ${accountId})`);
  console.log(`USE_R2 is ${process.env.USE_R2 === 'true' ? 'true' : `"${process.env.USE_R2 ?? 'unset'}" — the R2 code path is OFF`}`);

  const keys = [];
  if (!onlyRo) {
    keys.push(['R2_RW', process.env.R2_RW_ACCESS_KEY_ID, process.env.R2_RW_SECRET_ACCESS_KEY]);
  }
  if (!onlyRw && process.env.R2_RO_ACCESS_KEY_ID) {
    keys.push(['R2_RO', process.env.R2_RO_ACCESS_KEY_ID, process.env.R2_RO_SECRET_ACCESS_KEY]);
  }

  for (const [role, keyId, secret] of keys) {
    if (!keyId || !secret) {
      console.log(`\n── ${role} key ──\n  Not set.`);
      continue;
    }
    await checkKey(role, { accountId, bucket, keyId, secret });
  }
}

main().catch((err) => {
  console.error('check-r2-access failed:', err?.message || err);
  process.exitCode = 1;
});
