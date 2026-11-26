import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBillDedupBase, buildBillDedupKey, dedupInvoiceNumber, financialYear, listSameYearDedupKeys,
} from './purchase-bill-dedup.js';
import { runVerificationChecks } from './purchase-bill-verification.js';
import { migrateBillDedupKeys, releaseDedupKeyIfDuplicate } from './purchase-bill-unique-keys.js';

const SUP = '19AACCT6050G1ZC';
const byId = (results, id) => results.find((r) => r.check_id === id);

test('invoice numbers match ignoring punctuation, spaces and leading zeros', () => {
  for (const v of ['SA/0009/26-27', 'SA/009/26-27', 'sa-9-26-27', 'SA 9 / 26 - 27', 'SA0009/26/27']) {
    assert.equal(dedupInvoiceNumber(v), 'SA-9-26-27', v);
  }
  assert.equal(dedupInvoiceNumber('0123'), '123');
  assert.equal(dedupInvoiceNumber('000'), '0');
  assert.notEqual(dedupInvoiceNumber('12/3'), dedupInvoiceNumber('1/23'));
  assert.notEqual(dedupInvoiceNumber('INV/10'), dedupInvoiceNumber('INV/1'));
  assert.equal(dedupInvoiceNumber(' / - '), null);
});

test('financial year runs April to March in Indian time', () => {
  assert.equal(financialYear(new Date('2026-04-01T00:00:00+05:30')), '2026-27');
  assert.equal(financialYear(new Date('2026-03-31T23:59:00+05:30')), '2025-26');
  assert.equal(financialYear('2027-01-15'), '2026-27');
  assert.equal(financialYear(null), null);
  assert.equal(financialYear('not a date'), null);
});

test('dedup key is supplier + normalised invoice + financial year', () => {
  const f = { supplier_gstin: SUP, invoice_number: 'SA/0009/26-27', invoice_date: '2026-06-10' };
  assert.equal(buildBillDedupBase(f), `${SUP}_SA-9-26-27`);
  assert.equal(buildBillDedupKey(f), `${SUP}_SA-9-26-27_2026-27`);
  assert.equal(buildBillDedupKey({ ...f, invoice_date: null }), `${SUP}_SA-9-26-27_NOFY`);
  // No GSTIN: the PAN is the supplier.
  assert.equal(
    buildBillDedupKey({ supplier_pan: 'AHEPA0785F', invoice_number: '7', invoice_date: '2026-06-10' }),
    'P:AHEPA0785F_7_2026-27',
  );
  // CDC's own GSTIN is never the supplier.
  assert.equal(buildBillDedupKey({ supplier_gstin: '24AABCC2946B1Z8', invoice_number: '7' }), null);
  // A known year also matches an earlier bill whose year was unknown.
  assert.deepEqual(listSameYearDedupKeys(f), [
    `${SUP}_SA-9-26-27_2026-27`, `${SUP}_SA-9-26-27_NOFY`,
    'P:AACCT6050G_SA-9-26-27_2026-27', 'P:AACCT6050G_SA-9-26-27_NOFY',
  ]);
  assert.deepEqual(listSameYearDedupKeys({ ...f, invoice_date: null }), []);
});

function bill(over = {}) {
  return {
    _id: 'new',
    set_type: 'non_grn',
    location: 'KOL',
    supplier_gstin: SUP,
    invoice_number: 'SA/009/26-27',
    invoice_date: new Date('2026-09-01'),
    slots: {
      tally_voucher: { pages: [{}], aggregated_fields: {} },
      supplier_invoice: { pages: [{}], aggregated_fields: {} },
      eway_bill: { pages: [], aggregated_fields: {} },
      grn_sheet: { pages: [], aggregated_fields: {} },
    },
    ...over,
  };
}

test('same supplier + invoice + year blocks; another year only warns', async () => {
  const original = { _id: 'orig', invoice_number: 'SA/0009/26-27', uploaded_by: 'Rina', uploaded_at: new Date('2026-06-23') };
  const dup = await runVerificationChecks(bill(), {
    findDuplicateOriginal: async () => original,
    findDedupOtherYears: async () => [],
  });
  const d = byId(dup, 'DUPLICATE_BILL_NUMBER');
  assert.equal(d.status, 'fail');
  assert.equal(d.level, 'blocking');
  assert.match(d.message, /already exists as SA\/0009\/26-27 for FY 2026-27/);
  assert.equal(byId(dup, 'DUPLICATE_BILL_NUMBER_OTHER_YEAR').status, 'pass');

  const other = await runVerificationChecks(bill(), {
    findDuplicateOriginal: async () => null,
    findDedupOtherYears: async () => [{ _id: 'old', invoice_number: 'SA/9', invoice_date: new Date('2025-05-01') }],
  });
  assert.equal(byId(other, 'DUPLICATE_BILL_NUMBER').status, 'pass');
  const w = byId(other, 'DUPLICATE_BILL_NUMBER_OTHER_YEAR');
  assert.equal(w.status, 'fail');
  assert.equal(w.level, 'warning');
  assert.match(w.message, /FY 2025-26/);

  const noDate = await runVerificationChecks(bill({ invoice_date: null }), {
    findDuplicateOriginal: async () => original,
  });
  assert.match(byId(noDate, 'DUPLICATE_BILL_NUMBER').message, /any year \(invoice date unknown\)/);
  assert.equal(byId(noDate, 'DUPLICATE_BILL_NUMBER_OTHER_YEAR').status, 'skipped');
});

test('a flagged copy gives up its key so the original is not flagged back', () => {
  const dup = { check_id: 'DUPLICATE_BILL_NUMBER', status: 'fail', actual: { existing_bill_id: 'orig' } };
  const b = { bill_dedup_key: 'k', check_results: [dup] };
  assert.equal(releaseDedupKeyIfDuplicate(b), true);
  assert.equal(b.bill_dedup_key, undefined);

  const ok = { bill_dedup_key: 'k', check_results: [{ check_id: 'DUPLICATE_BILL_NUMBER', status: 'pass' }] };
  assert.equal(releaseDedupKeyIfDuplicate(ok), false);
  assert.equal(ok.bill_dedup_key, 'k');

  // Missing GSTIN/PAN also fails the check, but there is no original to defer to.
  const noKey = { bill_dedup_key: 'k', check_results: [{ check_id: 'DUPLICATE_BILL_NUMBER', status: 'fail', actual: {} }] };
  assert.equal(releaseDedupKeyIfDuplicate(noKey), false);
});

function fakeCollection(rows) {
  const byIdMap = new Map(rows.map((r) => [r._id, r]));
  const writes = [];
  return {
    rows,
    writes,
    find: () => ({ sort: () => rows.map((r) => ({ ...r })) }),
    findOne: async ({ _id }) => byIdMap.get(_id),
    bulkWrite: async (ops) => {
      for (const { updateOne: { filter, update } } of ops) {
        writes.push(filter._id);
        const r = byIdMap.get(filter._id);
        Object.assign(r, update.$set || {});
        for (const k of Object.keys(update.$unset || {})) delete r[k];
      }
    },
    updateOne: async ({ _id }, update) => { Object.assign(byIdMap.get(_id), update.$set); },
  };
}

test('migration re-keys old bills, flags later copies, and is a no-op the second time', async () => {
  const row = (id, invoice, date, extra) => ({
    _id: id, supplier_gstin: SUP, invoice_number: invoice, invoice_date: new Date(date),
    verification_status: 'verified', check_results: [], ...extra,
  });
  const coll = fakeCollection([
    row('a', 'SA/0009/26-27', '2026-06-10', { bill_dedup_key: `${SUP}_SA/0009/26-27` }),
    row('b', 'SA/009/26-27', '2026-09-01', {
      bill_dedup_key: `${SUP}_SA/009/26-27`,
      check_results: [{ check_id: 'DUPLICATE_BILL_NUMBER', level: 'blocking', status: 'pass' }],
    }),
    // Same number, next year: a different bill.
    row('c', 'SA/9/26-27', '2027-05-01', { bill_dedup_key: `${SUP}_SA/9/26-27` }),
    // Already a copy from before (no key): only gets a base.
    row('d', 'SA/0009/26-27', '2026-06-10', { verification_status: 'needs_review' }),
    // Misread GSTIN saved by older code: no key under today's rules, keeps its old one.
    row('e', 'AKT262700005', '2026-04-01', { supplier_gstin: '19AACB2812J1ZN', bill_dedup_key: '19AACB2812J1ZN_AKT262700005' }),
  ]);
  await migrateBillDedupKeys(coll);
  const [a, b, c, d, e] = coll.rows;
  assert.equal(e.bill_dedup_key, '19AACB2812J1ZN_AKT262700005');

  assert.equal(a.bill_dedup_key, `${SUP}_SA-9-26-27_2026-27`);
  assert.equal(a.verification_status, 'verified');

  assert.equal(b.bill_dedup_key, undefined);
  assert.equal(b.bill_dedup_base, `${SUP}_SA-9-26-27`);
  assert.equal(b.verification_status, 'needs_review');
  assert.equal(b.blocking_failures_count, 1);
  const flag = b.check_results.filter((r) => r.check_id === 'DUPLICATE_BILL_NUMBER');
  assert.equal(flag.length, 1);
  assert.equal(flag[0].status, 'fail');
  assert.equal(flag[0].actual.existing_bill_id, 'a');

  assert.equal(c.bill_dedup_key, `${SUP}_SA-9-26-27_2027-28`);
  assert.equal(c.verification_status, 'verified');

  assert.equal(d.bill_dedup_key, undefined);
  assert.equal(d.bill_dedup_base, `${SUP}_SA-9-26-27`);

  coll.writes.length = 0;
  await migrateBillDedupKeys(coll);
  assert.deepEqual(coll.writes, []);
});
