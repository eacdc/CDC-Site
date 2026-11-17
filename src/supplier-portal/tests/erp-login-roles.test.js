import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRoles } from '../middleware/auth.js';

/** Runs `fn` with SP_ERP_LOGIN_ROLES set (or deleted, for undefined), then restores it. */
function withRoles(value, fn) {
  const before = process.env.SP_ERP_LOGIN_ROLES;
  if (value === undefined) delete process.env.SP_ERP_LOGIN_ROLES;
  else process.env.SP_ERP_LOGIN_ROLES = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.SP_ERP_LOGIN_ROLES;
    else process.env.SP_ERP_LOGIN_ROLES = before;
  }
}

test('everyone signed in with an ERP name may approve, including accounts made before', () => {
  withRoles(undefined, () => {
    const older = { authSource: 'ERP', roles: ['STORE'] };
    assert.deepEqual(effectiveRoles(older).sort(), ['APPROVER', 'STORE']);
  });
});

test('the env var takes approving back from every ERP account at once', () => {
  withRoles('STORE', () => {
    assert.deepEqual(effectiveRoles({ authSource: 'ERP', roles: ['VIEWER'] }).sort(), ['STORE', 'VIEWER']);
  });
});

test('password accounts keep exactly the roles granted on them', () => {
  withRoles(undefined, () => {
    assert.deepEqual(effectiveRoles({ roles: ['BUYER'] }), ['BUYER']);
    assert.deepEqual(effectiveRoles({ authSource: 'PASSWORD', roles: [] }), []);
  });
});
