import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGroups } from './maytapi/import.js';

/**
 * Groups enter the database one way: an import from Maytapi. Until there was a
 * button for it, a group the CDC number had just been added to was invisible
 * until somebody ran a script on a machine that, once this moved to Render,
 * nobody had.
 */

const existing = [
  { _id: 'g1', name: 'CDC Maintenance', monitored: true },
  { _id: 'g2', name: 'CDC Tangra Production', monitored: false },
];

test('a group WhatsApp knows about and we do not is new', () => {
  const out = compareGroups([{ id: 'g3', name: 'CDC x New Customer' }], existing);
  assert.deepEqual(out.added, [{ id: 'g3', name: 'CDC x New Customer' }]);
});

test('a group renamed in WhatsApp is reported, not re-added', () => {
  const out = compareGroups([{ id: 'g1', name: 'CDC Maintenance & Repairs' }], existing);
  assert.equal(out.added.length, 0);
  assert.deepEqual(out.renamed, [
    { id: 'g1', from: 'CDC Maintenance', to: 'CDC Maintenance & Repairs' },
  ]);
});

test('a group we know about and WhatsApp does not is missing, never deleted', () => {
  // The number has left it, or was removed - or Maytapi had a bad minute. A
  // group with months of concerns behind it must not vanish over one API call.
  const out = compareGroups([{ id: 'g1', name: 'CDC Maintenance' }], existing);
  assert.deepEqual(out.missing, [{ id: 'g2', name: 'CDC Tangra Production', monitored: false }]);
});

test('a MONITORED group going missing is flagged as such', () => {
  // It will never see another message, and nothing else would say so.
  const out = compareGroups([], existing);
  assert.equal(out.missing.find((g) => g.id === 'g1').monitored, true);
});

test('nothing changed is an answer, and says so quietly', () => {
  const out = compareGroups(
    [{ id: 'g1', name: 'CDC Maintenance' }, { id: 'g2', name: 'CDC Tangra Production' }],
    existing,
  );
  assert.deepEqual(out, { found: 2, added: [], renamed: [], missing: [] });
});

test('the very first import makes everything new', () => {
  const out = compareGroups([{ id: 'g1', name: 'CDC Maintenance' }], []);
  assert.equal(out.added.length, 1);
  assert.equal(out.missing.length, 0);
});
