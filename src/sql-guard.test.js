import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySelect } from './sql-guard.js';

test('accepts select on allowlisted tables', () => {
  const sql = `
    SELECT TOP (20) pm.ProductMasterID
    FROM ProductMaster pm
    LEFT JOIN LedgerMaster lm ON pm.LedgerID = lm.LedgerID;
  `;
  const result = validateReadOnlySelect(sql);
  assert.equal(result.ok, true);
});

test('rejects non select statement', () => {
  const sql = 'DELETE FROM ProductMaster WHERE ProductMasterID = 1';
  const result = validateReadOnlySelect(sql);
  assert.equal(result.ok, false);
  assert.match(result.reason, /start with SELECT|Forbidden token/i);
});

test('rejects multiple statements', () => {
  const sql = 'SELECT * FROM ProductMaster; SELECT * FROM LedgerMaster;';
  const result = validateReadOnlySelect(sql);
  assert.equal(result.ok, false);
  assert.match(result.reason, /one SQL statement/i);
});

test('rejects non allowlisted table', () => {
  const sql = 'SELECT * FROM JobBookingJobCard';
  const result = validateReadOnlySelect(sql);
  assert.equal(result.ok, false);
  assert.match(result.reason, /allowlisted/i);
});

test('rejects select into', () => {
  const sql = 'SELECT * INTO TmpTable FROM ProductMaster';
  const result = validateReadOnlySelect(sql);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SELECT INTO/i);
});

