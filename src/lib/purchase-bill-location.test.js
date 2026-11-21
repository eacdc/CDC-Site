import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCdcGstin, locationConfig, parseLocation } from '../config/cdc.js';
import { runVerificationChecks } from './purchase-bill-verification.js';
import { uniqueConflictInfo, formatDuplicateSaveError } from './purchase-bill-unique-keys.js';

const KOL_GSTIN = '19AABCC2946B1ZZ';
const AHM_GSTIN = '24AABCC2946B1Z8';

function bill({ location, buyerGstin, supplierState = 'Gujarat', voucher = 'PUR/70/26-27' }) {
  return {
    _id: 'b1',
    set_type: 'non_grn',
    location,
    tally_voucher_number: voucher,
    invoice_number: 'INV-1',
    supplier_gstin: '24AAACX1234A1Z5',
    grand_total: 150000,
    slots: {
      tally_voucher: { pages: [{}], aggregated_fields: {} },
      supplier_invoice: {
        pages: [{}],
        aggregated_fields: { buyer_gstin: buyerGstin, supplier_state: supplierState, grand_total: 150000 },
      },
      eway_bill: { pages: [], aggregated_fields: {} },
      grn_sheet: { pages: [], aggregated_fields: {} },
    },
  };
}

const byId = (results, id) => results.find((r) => r.check_id === id);

test('parseLocation accepts known codes only', () => {
  assert.equal(parseLocation('ahm'), 'AHM');
  assert.equal(parseLocation(' KOL '), 'KOL');
  assert.equal(parseLocation('BOM'), null);
  assert.equal(parseLocation(undefined), null);
  assert.equal(locationConfig(undefined).label, 'Kolkata');
});

test('both CDC GSTINs count as CDC', () => {
  assert.ok(isCdcGstin(KOL_GSTIN));
  assert.ok(isCdcGstin(AHM_GSTIN));
});

test('voucher dedup looks only at the bill location', async () => {
  const seen = [];
  const helpers = {
    findByTallyVoucher: async (no, _id, location) => {
      seen.push([no, location]);
      return location === 'KOL' ? { _id: 'kol-bill' } : null;
    },
  };

  const ahm = await runVerificationChecks(bill({ location: 'AHM', buyerGstin: AHM_GSTIN }), helpers);
  assert.equal(byId(ahm, 'DUPLICATE_TALLY_VOUCHER').status, 'pass');

  const kol = await runVerificationChecks(bill({ location: 'KOL', buyerGstin: KOL_GSTIN }), helpers);
  assert.equal(byId(kol, 'DUPLICATE_TALLY_VOUCHER').status, 'fail');

  assert.deepEqual(seen, [['PUR/70/26-27', 'AHM'], ['PUR/70/26-27', 'KOL']]);
});

test('buyer GSTIN from the other location is flagged', async () => {
  const ok = await runVerificationChecks(bill({ location: 'AHM', buyerGstin: AHM_GSTIN }));
  assert.equal(byId(ok, 'BUYER_GSTIN_IS_CDC').status, 'pass');
  assert.equal(byId(ok, 'BUYER_GSTIN_MATCHES_LOCATION').status, 'pass');

  const wrong = await runVerificationChecks(bill({ location: 'KOL', buyerGstin: AHM_GSTIN }));
  const check = byId(wrong, 'BUYER_GSTIN_MATCHES_LOCATION');
  assert.equal(check.status, 'fail');
  assert.equal(check.level, 'warning');
});

test('intra-state is judged against the bill location state', async () => {
  // Gujarat supplier → intra-state for AHM, inter-state for KOL.
  const ahm = await runVerificationChecks(bill({ location: 'AHM', buyerGstin: AHM_GSTIN }));
  assert.equal(byId(ahm, 'EWAY_REQUIRED_INTRASTATE').status, 'fail');
  assert.equal(byId(ahm, 'EWAY_REQUIRED_INTERSTATE').status, 'skipped');

  const kol = await runVerificationChecks(bill({ location: 'KOL', buyerGstin: KOL_GSTIN }));
  assert.equal(byId(kol, 'EWAY_REQUIRED_INTERSTATE').status, 'fail');
});

test('a per-location voucher conflict reports the voucher, not the location', () => {
  const err = {
    code: 11000,
    keyPattern: { location: 1, tally_voucher_number: 1 },
    keyValue: { location: 'AHM', tally_voucher_number: 'PUR/70/26-27' },
  };
  const info = uniqueConflictInfo(err);
  assert.equal(info.field, 'tally_voucher_number');
  assert.equal(info.value, 'PUR/70/26-27');
  assert.equal(info.location, 'AHM');
  assert.equal(
    formatDuplicateSaveError(err),
    'Duplicate tally_voucher_number=PUR/70/26-27 already exists. Extracted data was kept for review.',
  );
});

test('index repair backfills KOL and swaps the global voucher index for a per-location one', async () => {
  const calls = [];
  let indexes = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'bill_dedup_key_1', key: { bill_dedup_key: 1 }, unique: true, partialFilterExpression: { bill_dedup_key: { $type: 'string' } } },
    { name: 'tally_voucher_number_1', key: { tally_voucher_number: 1 }, unique: true, partialFilterExpression: { tally_voucher_number: { $type: 'string' } } },
  ];
  const coll = {
    indexes: async () => indexes,
    dropIndex: async (name) => { calls.push(['drop', name]); indexes = indexes.filter((i) => i.name !== name); },
    createIndex: async (key, opts) => { calls.push(['create', opts.name]); indexes.push({ key, ...opts }); },
    updateMany: async (filter, update) => {
      if (update.$set?.location) calls.push(['backfill', update.$set.location]);
      return { modifiedCount: 0 };
    },
  };
  const { repairPurchaseBillUniqueIndexes } = await import('./purchase-bill-unique-keys.js');
  await repairPurchaseBillUniqueIndexes({ collection: coll });

  assert.deepEqual(calls, [
    ['backfill', 'KOL'],
    ['drop', 'tally_voucher_number_1'],
    ['create', 'location_1_tally_voucher_number_1'],
  ]);
  const created = indexes.find((i) => i.name === 'location_1_tally_voucher_number_1');
  assert.deepEqual(created.key, { location: 1, tally_voucher_number: 1 });
  assert.deepEqual(created.partialFilterExpression, { tally_voucher_number: { $type: 'string' } });

  // Second start: nothing left to change.
  calls.length = 0;
  await repairPurchaseBillUniqueIndexes({ collection: coll });
  assert.deepEqual(calls, [['backfill', 'KOL']]);
});
