/**
 * Shows what Maytapi actually sends for voice notes, images and videos.
 *
 *   npm run whatsapp:media-probe -- "<groupId>"
 *
 * Read-only: it fetches messages and, for any URL-looking field, asks for the
 * bytes. It sends nothing to the group and writes nothing to Mongo.
 *
 * This exists because the media fields in normalise.js (`msg.url`, `msg.media`)
 * were a guess - there is no media message in the pinned fixture, and
 * transcription needs a URL that can actually be fetched. Guessing Maytapi's
 * shape is how the sender came out null for a week.
 *
 * It prints raw message objects, so the output contains real message content.
 * The auth token is never printed.
 */
import { config, assertConfigured } from '../src/whatsapp-monitor/config.js';
import { maytapi } from '../src/whatsapp-monitor/maytapi/client.js';

const groupId = process.argv[2];
if (!groupId) {
  console.error('usage: npm run whatsapp:media-probe -- "<groupId>"');
  console.error('Run `npm run whatsapp:groups` to list them.');
  process.exit(1);
}

try {
  assertConfigured();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const raw = await maytapi.getMessages(groupId, { count: config.maytapi.messageCount });
const rows = raw?.data?.messages ?? [];
console.log(`${rows.length} message(s) fetched from ${groupId}\n`);

// --- which types are actually in use -------------------------------------

const counts = new Map();
for (const row of rows) {
  const type = row?.message?.type ?? '(none)';
  counts.set(type, (counts.get(type) ?? 0) + 1);
}
console.log('TYPES IN USE');
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${type}`);
}

// --- one raw sample per non-text type ------------------------------------

const TEXT_LIKE = new Set(['text', 'chat', 'info', 'notification', 'e2e_notification', 'gp2']);
const samples = new Map();
for (const row of rows) {
  const type = row?.message?.type;
  if (!type || TEXT_LIKE.has(type) || samples.has(type)) continue;
  samples.set(type, row);
}

if (samples.size === 0) {
  console.log('\nNo media messages in the last page. Try a larger --count, or a group with recent voice notes.');
  process.exit(0);
}

const urlish = [];

console.log('\nRAW MESSAGE OBJECTS (one per media type)');
for (const [type, row] of samples) {
  console.log(`\n--- type: ${type} ---`);
  // The whole envelope minus the parts already understood, so nothing about
  // the shape is filtered out by an assumption.
  const { message, quotedMsg, ...envelope } = row;
  console.log('envelope keys:', Object.keys(envelope).join(', '));
  console.log('message:', JSON.stringify(message, null, 2));
  if (quotedMsg) console.log('quotedMsg keys:', Object.keys(quotedMsg).join(', '));

  for (const [key, value] of Object.entries(message ?? {})) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      urlish.push({ type, key, url: value });
    }
  }
}

// --- can the media actually be fetched? ----------------------------------

if (urlish.length === 0) {
  console.log('\nNo http(s) URL on any media message. Transcription would need a different route');
  console.log('(a download endpoint, or base64 in the payload) - the message objects above say which.');
  process.exit(0);
}

console.log('\nFETCHING THE MEDIA');
for (const { type, key, url } of urlish) {
  for (const withAuth of [false, true]) {
    const label = `${type}.${key} ${withAuth ? 'with' : 'without'} key`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: withAuth ? { 'x-maytapi-key': config.maytapi.token } : {},
      });
      const bytes = (await res.arrayBuffer()).byteLength;
      console.log(
        `  ${label.padEnd(42)} HTTP ${res.status}  ${String(bytes).padStart(9)} bytes  ` +
          `${res.headers.get('content-type') ?? 'no content-type'}  ${Date.now() - started}ms`,
      );
    } catch (err) {
      console.log(`  ${label.padEnd(42)} FAILED  ${err.message}`);
    }
  }
}

console.log('\nWhat matters: a 200 with an audio/* content-type and a sensible byte count.');
console.log('If only the "with key" row works, the downloader has to send the header too.');
