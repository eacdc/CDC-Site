import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import router from '../routes-whatsapp-monitor.js';

/**
 * These routes expose every message the monitor has ever read. The one thing
 * that must never regress is that they are all behind auth - a route added
 * later without the middleware would leak the lot, and it would leak quietly.
 */
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp-monitor', router);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/whatsapp-monitor`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const READS = [
  '/health',
  '/groups',
  '/groups/120363000000000000@g.us',
  '/concerns',
  '/concerns/000000000000000000000000',
  '/runs',
  '/owners',
];

const WRITES = [
  ['PATCH', '/groups/120363000000000000@g.us'],
  ['POST', '/concerns/000000000000000000000000/acknowledge'],
  ['POST', '/concerns/000000000000000000000000/resolve'],
  ['PUT', '/owners/919000000001'],
  ['DELETE', '/owners/919000000001'],
  ['PUT', '/routing'],
  ['DELETE', '/routing?groupId=*&category=safety'],
];

test('every read route refuses an unauthenticated request', async () => {
  await withServer(async (base) => {
    for (const path of READS) {
      const res = await fetch(base + path);
      assert.equal(res.status, 401, `${path} should be 401, got ${res.status}`);
    }
  });
});

test('every write route refuses an unauthenticated request', async () => {
  await withServer(async (base) => {
    for (const [method, path] of WRITES) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      });
      assert.equal(res.status, 401, `${method} ${path} should be 401, got ${res.status}`);
    }
  });
});

test('a garbage bearer token is rejected, not treated as anonymous', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/groups`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.status, 401);
  });
});

test('an unknown path under the mount is a 404, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
