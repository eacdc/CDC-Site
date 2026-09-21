import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseIsFree } from './poller/lock.js';

/**
 * One database is polled by one process. A laptop left running `npm start`
 * alongside the deployed service classifies the same messages again, pays for
 * it again, races the same cursors, and can DM the same person twice - which
 * is exactly what happened, and was only noticed because the duplicate carried
 * an old message format.
 */

const NOW = new Date('2026-09-21T10:00:00Z');
const inMins = (n) => new Date(NOW.getTime() + n * 60_000);
const US = 'render-abc:42';
const THEM = 'DESKTOP-2A5SIL1:15088';

test('nobody has ever polled, so the lease is free', () => {
  assert.equal(leaseIsFree(null, US, NOW), true);
  assert.equal(leaseIsFree(undefined, US, NOW), true);
});

test('somebody else is mid-cycle, so we stand down', () => {
  assert.equal(leaseIsFree({ holder: THEM, expiresAt: inMins(5) }, US, NOW), false);
});

test('their lease has lapsed, so we take it', () => {
  // A process killed mid-run must not lock the system out for good.
  assert.equal(leaseIsFree({ holder: THEM, expiresAt: inMins(-1) }, US, NOW), true);
});

test('a lease expiring exactly now is lapsed', () => {
  assert.equal(leaseIsFree({ holder: THEM, expiresAt: NOW }, US, NOW), true);
});

test('our own lease never locks us out', () => {
  // A cycle that overran its own lease should carry on, not stop halfway.
  assert.equal(leaseIsFree({ holder: US, expiresAt: inMins(-30) }, US, NOW), true);
  assert.equal(leaseIsFree({ holder: US, expiresAt: inMins(5) }, US, NOW), true);
});

test('a lease with no expiry at all is treated as lapsed', () => {
  // Rather than holding for ever on a malformed document. Polling twice for one
  // cycle is recoverable; never polling again is not.
  assert.equal(leaseIsFree({ holder: THEM }, US, NOW), true);
});
