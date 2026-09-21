import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, concernUrl } from './router/alert.js';

/**
 * The frontend's routeParams(): the fragment first, the query as a fallback.
 * Copied rather than imported because it lives in the other repo - which is
 * exactly why these two drifted apart in the first place and every alert went
 * out with a link to a page that does not exist.
 */
function routeParams(url) {
  const u = new URL(url);
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  if ([...hash.keys()].length > 0) return hash;
  return u.searchParams;
}

const concern = {
  _id: '6aa96df1987b362e7f8b63f3',
  severity: 'high',
  category: 'machine_breakdown',
  summary: 'Machine stopped due to broken lock; production halted',
};

test('the link in an alert resolves to the concern the alert is about', () => {
  const link = formatAlert(concern, 'CDC Maintenance')
    .split('\n')
    .find((line) => line.startsWith('http'));

  assert.ok(link, 'the alert carries a link at all');
  assert.equal(routeParams(link).get('id'), String(concern._id));
});

test('the link points at a real file, not a rewrite', () => {
  // A rewrite only exists where serve.json does, and a fragment on a real path
  // cannot be caught by the cached 301 that made /concerns unreachable.
  assert.match(concernUrl('abc'), /\/concerns\.html#id=abc$/);
});

test('the alert says what the link is for', () => {
  // A WhatsApp DM has no button that expands in place, so the label is the
  // only thing telling someone the rest of the conversation is one tap away.
  assert.match(formatAlert(concern, 'CDC Maintenance'), /Read the full conversation/);
});

test('the alert still carries the summary and how to acknowledge', () => {
  const text = formatAlert(concern, 'CDC Maintenance');
  assert.match(text, /CDC Maintenance/);
  assert.match(text, /production halted/);
  assert.match(text, /Reply ACK/);
});

// --- the link has to be tappable ------------------------------------------
//
// WhatsApp only linkifies something that looks like a web address. A bare
// hostname with no dot does not, so a localhost base produces a DM with a line
// of plain text where the link should be - and the person who notices is the
// one who received it, not the one running the service.

import { config } from './config.js';

test('the dashboard base is a real host over https', () => {
  assert.match(config.dashboardBaseUrl, /^https:\/\/[^/]+\.[^/]+/);
});

test('the base carries no trailing slash', () => {
  // Every caller appends a path with its own leading slash. A URL pasted out
  // of an address bar usually brings one, and "...com//concerns.html" works
  // but reads as broken in a message to a manager.
  assert.doesNotMatch(config.dashboardBaseUrl, /\/$/);
  assert.doesNotMatch(concernUrl('abc'), /\/\/concerns/);
});

test('the built link has exactly one slash before the page', () => {
  assert.match(concernUrl('abc'), /^https:\/\/[^/]+\/concerns\.html#id=abc$/);
});
