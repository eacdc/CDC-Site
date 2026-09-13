import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMessages, normaliseGroups, isLoggedIn } from './maytapi/normalise.js';

/**
 * A redacted copy of a real getMessages response. The field names here are the
 * contract — if Maytapi changes them, this is where it shows up first.
 */
const FIXTURE = {
  success: true,
  data: {
    users: {
      '919000000001@c.us': { id: '919000000001@c.us', name: 'Ravi', phone: '919000000001' },
      '919000000002@c.us': { id: '919000000002@c.us', name: 'Sunil', phone: '919000000002' },
    },
    messages: [
      {
        timestamp: 1786299731,
        uid: '919000000001@c.us',
        fromMe: false,
        message: { type: 'text', text: 'Kolbus band hai, urgent', id: 'AAA', _serialized: 'AAA' },
      },
      {
        timestamp: 1786299800,
        uid: '919000000002@c.us',
        fromMe: true,
        message: { type: 'text', text: 'maintenance ko bola', id: 'BBB', _serialized: 'BBB' },
        quotedMsg: { type: 'text', text: 'Kolbus band hai, urgent', id: 'AAA', timestamp: 1786299731 },
      },
      {
        timestamp: 1786299900,
        uid: '919000000003@c.us',
        fromMe: false,
        message: { type: 'text', text: 'ok', id: 'CCC', _serialized: 'CCC' },
      },
      {
        timestamp: 1786301339,
        uid: '919000000002@c.us',
        fromMe: true,
        message: { id: 'DDD', type: 'info', subtype: 'group/leave' },
      },
    ],
  },
};

test('drops system "info" rows (group/add, group/leave, group/name)', () => {
  const out = normaliseMessages(FIXTURE);
  assert.equal(out.length, 3);
  assert.equal(out.some((m) => m.type === 'info'), false);
});

test('reads the sender from uid, not from the message body', () => {
  assert.equal(normaliseMessages(FIXTURE)[0].senderId, '919000000001@c.us');
});

test('resolves the sender name through the data.users map', () => {
  const out = normaliseMessages(FIXTURE);
  assert.equal(out[0].senderName, 'Ravi');
  assert.equal(out[1].senderName, 'Sunil');
});

test('leaves senderName null when the sender is absent from data.users', () => {
  assert.equal(normaliseMessages(FIXTURE)[2].senderName, null);
});

test('takes msgId from message.id and converts epoch seconds', () => {
  const m = normaliseMessages(FIXTURE)[0];
  assert.equal(m.msgId, 'AAA');
  assert.equal(m.ts.toISOString(), '2026-08-09T18:22:11.000Z');
  assert.equal(m.text, 'Kolbus band hai, urgent');
  assert.equal(m.fromMe, false);
});

test('reads the quoted message id from the top-level quotedMsg', () => {
  const out = normaliseMessages(FIXTURE);
  assert.equal(out[1].quotedMsgId, 'AAA');
  assert.equal(out[0].quotedMsgId, null);
});

test('returns an empty array rather than throwing on junk', () => {
  assert.deepEqual(normaliseMessages(null), []);
  assert.deepEqual(normaliseMessages({ success: false }), []);
  assert.deepEqual(normaliseMessages({ data: { messages: 'nope' } }), []);
});

test('normaliseGroups falls back to the id when a group has no name', () => {
  const out = normaliseGroups({
    data: [{ id: 'g1@g.us', name: 'CDC Tangra Production' }, { id: 'g2@g.us' }],
  });
  assert.deepEqual(out, [
    { id: 'g1@g.us', name: 'CDC Tangra Production' },
    { id: 'g2@g.us', name: 'g2@g.us' },
  ]);
});

test('isLoggedIn recognises live and dead sessions', () => {
  assert.equal(isLoggedIn({ success: true, status: { state: 'online' } }), true);
  assert.equal(isLoggedIn({ data: { loggedIn: true } }), true);
  assert.equal(isLoggedIn({ status: { state: 'qr-screen' } }), false);
  assert.equal(isLoggedIn({ data: { loggedIn: false } }), false);
  assert.equal(isLoggedIn(null), false);
});

test('getMessages builds count and page into the query string', async () => {
  // The parameter is `count`, not `limit` - a `limit` is silently ignored, which
  // is why the response kept growing before this was pinned down.
  const seen = [];
  const { maytapi } = await import('./maytapi/client.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{"success":true,"data":{"messages":[]}}', { status: 200 });
  };
  try {
    await maytapi.getMessages('120363000000000000@g.us', { count: 100, page: 2 });
    await maytapi.getMessages('120363000000000000@g.us');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.match(seen[0], /getMessages\/120363000000000000%40g\.us\?count=100&page=2$/);
  assert.doesNotMatch(seen[1], /\?/, 'no query string when no options are given');
});

test('unset options never reach the query string', async () => {
  // `?count=undefined` would be sent verbatim and silently change the result.
  const seen = [];
  const { maytapi } = await import('./maytapi/client.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{"success":true,"data":[]}', { status: 200 });
  };
  try {
    await maytapi.getMessages('g@g.us', { count: 50 });
    await maytapi.getConversations({ days: 1 });
    await maytapi.getConversations();
    await maytapi.getConversationMessages('g@g.us', { count: 50, page: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.match(seen[0], /\?count=50$/, 'omits page when unset');
  assert.match(seen[1], /getConversations\?days=1$/);
  assert.doesNotMatch(seen[2], /\?/, 'no query string at all when nothing is passed');
  // page=0 is a real value and must survive - it is the first page, not "unset".
  assert.match(seen[3], /getConversations\/g%40g\.us\?count=50&page=0$/);
  assert.doesNotMatch(seen.join(' '), /undefined|null/);
});
