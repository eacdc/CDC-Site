/**
 * Checks each Maytapi endpoint in turn and reports status, size and timing.
 *
 *   npm run whatsapp:probe                 # session and group list only
 *   npm run whatsapp:probe -- "<groupId>"  # also both message-fetch routes
 *
 * Read-only - it sends nothing and writes nothing. Use it when the monitor
 * starts failing, to tell apart the three things that look identical from the
 * outside: bad credentials, a wedged session, and a genuinely broken endpoint.
 */
import { config, assertConfigured } from '../src/whatsapp-monitor/config.js';
import { maytapi } from '../src/whatsapp-monitor/maytapi/client.js';
import { normaliseMessages, normaliseGroups, isLoggedIn } from '../src/whatsapp-monitor/maytapi/normalise.js';

const groupId = process.argv[2];

try {
  assertConfigured();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`product ${config.maytapi.productId}`);
console.log(`phone   ${config.maytapi.phoneId}`);
console.log(`token   length ${config.maytapi.token.length}, starts ${config.maytapi.token.slice(0, 4)}\n`);

/** Never throws: a probe that dies on the first failure tells you the least. */
async function probe(label, fn, describe) {
  const started = Date.now();
  try {
    const body = await fn();
    const ms = Date.now() - started;
    const bytes = JSON.stringify(body ?? null).length;
    console.log(`ok    ${label.padEnd(26)} ${String(ms).padStart(6)}ms  ${String(bytes).padStart(8)} bytes  ${describe?.(body) ?? ''}`);
    return body;
  } catch (err) {
    const ms = Date.now() - started;
    const status = err?.status ? `HTTP ${err.status}` : err?.name ?? 'error';
    const detail = typeof err?.body === 'object' ? err.body?.message ?? '' : '';
    console.log(`FAIL  ${label.padEnd(26)} ${String(ms).padStart(6)}ms  ${status}  ${detail || err.message}`);
    return null;
  }
}

const status = await probe('status', () => maytapi.getStatus(), (b) =>
  `${isLoggedIn(b) ? 'logged in' : 'NOT logged in'}, number ${b?.number ?? '?'}`,
);
await probe('getGroups', () => maytapi.getGroups(), (b) => `${normaliseGroups(b).length} groups`);

if (groupId) {
  const count = config.maytapi.messageCount;
  const describe = (b) => `${normaliseMessages(b).length} messages`;

  // The two routes to the same payload. When the first fails and the second
  // works, the fallback is worth wiring into the poller.
  await probe('getMessages', () => maytapi.getMessages(groupId, { count }), describe);
  await probe('getConversations/:id', () => maytapi.getConversationMessages(groupId, { count }), describe);
} else {
  console.log('\nPass a group id to also test both message-fetch routes.');
}

if (status && !isLoggedIn(status)) {
  console.log('\nThe session is not logged in - re-pair the phone before reading anything else into this.');
}
