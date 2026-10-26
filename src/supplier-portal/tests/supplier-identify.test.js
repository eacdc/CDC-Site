/**
 * Supplier identification, on the ledgers the ERP really holds.
 *
 * The Pranay Udyog rows are copied from live Kolkata (October 2026): one
 * GSTIN on five ledgers, only one of them a supplier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySupplierLedger, normaliseGstin, companyKey } from '../services/supplier-identify.js';

// The supplier ledger is LAST on purpose: the client and consignee ledgers
// carry the identical name, so without the supplier-type filter one of them
// would win the tie. Listed first, the test would pass with the filter broken.
const PRANAY = [
  { LedgerID: 6495, LedgerName: 'Pranay Udyog - S/Dr', LedgerType: 'Sundry Debtors', GSTNo: '19AHEPA0785F1ZK', ISLedgerActive: true },
  { LedgerID: 6707, LedgerName: 'Pranay Udyog - S/Dr', LedgerType: 'Consignee', GSTNo: '19AHEPA0785F1ZK', ISLedgerActive: true },
  { LedgerID: 9872, LedgerName: 'PRANAY UDYOG', LedgerType: 'Clients', GSTNo: '19AHEPA0785F1ZK', ISLedgerActive: true },
  { LedgerID: 9950, LedgerName: 'PRANAY UDYOG', LedgerType: 'Consignee', GSTNo: '19AHEPA0785F1ZK', ISLedgerActive: true },
  { LedgerID: 8535, LedgerName: 'Pranay Udyog', LedgerType: 'Suppliers', GSTNo: '19AHEPA0785F1ZK', ISLedgerActive: true },
];
const OTHERS = [
  { LedgerID: 7711, LedgerName: 'RNG Papers', LedgerType: 'Suppliers', GSTNo: '19AADFR9768H1ZI', ISLedgerActive: true },
  { LedgerID: 4001, LedgerName: 'Pranav Traders', LedgerType: 'Sundry Creditors', GSTNo: '19AAAAA0000A1Z5', ISLedgerActive: true },
];

test('GSTINs compare however they are written', () => {
  assert.equal(normaliseGstin(' 19ahepa0785f1zk '), '19AHEPA0785F1ZK');
  assert.equal(normaliseGstin('19 AHEPA 0785 F1ZK'), '19AHEPA0785F1ZK');
  assert.equal(normaliseGstin('not a gstin'), null);
  assert.equal(companyKey('M/s. Pranay Udyog Pvt. Ltd.'), 'PRANAY UDYOG');
});

test('the invoice GSTIN finds the one SUPPLIER ledger among five that share it', () => {
  const r = identifySupplierLedger({ ledgers: [...PRANAY, ...OTHERS], gstin: '19AHEPA0785F1ZK', name: 'PRANAY UDYOG' });
  assert.equal(r.ledgerId, 8535, 'not the debtor, client or consignee ledger');
  assert.equal(r.matchedBy, 'GSTIN');
});

test('when supplier ledgers share a GSTIN, the one with the latest PO wins', () => {
  const twin = [
    { LedgerID: 1, LedgerName: 'Krishna Vanijya Pvt Ltd', LedgerType: 'Suppliers', GSTNo: '19AAACK5777H1Z5', ISLedgerActive: true },
    { LedgerID: 2, LedgerName: 'Krishna Vanijya - Imported', LedgerType: 'Suppliers', GSTNo: '19AAACK5777H1Z5', ISLedgerActive: true },
  ];
  const lastPoDate = new Map([[1, Date.parse('2026-03-01')], [2, Date.parse('2026-10-10')]]);
  const r = identifySupplierLedger({ ledgers: twin, gstin: '19AAACK5777H1Z5', name: 'Krishna Vanijya', lastPoDate });
  assert.equal(r.ledgerId, 2);
  assert.match(r.evidence, /most recent PO/);
});

test("CDC's own GSTIN, read by mistake as the supplier's, is not used", () => {
  const r = identifySupplierLedger({ ledgers: [...PRANAY, ...OTHERS], gstin: '19AABCC2946B1ZZ', name: 'Pranay Udyog' });
  assert.equal(r.ledgerId, 8535);
  assert.equal(r.matchedBy, 'NAME');
  assert.match(r.evidence, /CDC's own/);
});

test('with no GSTIN, the name decides - ignoring M/s, Pvt and Ltd', () => {
  const r = identifySupplierLedger({ ledgers: [...PRANAY, ...OTHERS], name: 'M/s. PRANAY UDYOG PVT. LTD.' });
  assert.equal(r.ledgerId, 8535);
  assert.equal(r.matchedBy, 'NAME');
});

test('a name that is only similar is not enough to guess', () => {
  const r = identifySupplierLedger({ ledgers: [...PRANAY, ...OTHERS], name: 'Pranav Udyog Works' });
  assert.equal(r.ledgerId, null);
  assert.match(r.evidence, /^Could not tell/);
});

test('a GSTIN on no supplier ledger falls back to the name, and says so', () => {
  const r = identifySupplierLedger({ ledgers: OTHERS, gstin: '19AHEPA0785F1ZK', name: 'RNG Papers' });
  assert.equal(r.ledgerId, 7711);
  assert.match(r.evidence, /is on no supplier ledger/);
});

// GSTINs the extractor misread in October 2026, against the ledger GSTINs
// they were misreadings of.
const NEAR = [
  { LedgerID: 7802, LedgerName: 'Purv Flexipack Limited', LedgerType: 'Suppliers', GSTNo: '19AADCP6122G1ZI', ISLedgerActive: true },
  { LedgerID: 7803, LedgerName: 'GSN Udyog Private Limited', LedgerType: 'Suppliers', GSTNo: '19AAICG2285N1ZZ', ISLedgerActive: true },
];

test('a GSTIN one character off its check finds the ledger it was misread from', () => {
  const r = identifySupplierLedger({ ledgers: [...NEAR, ...OTHERS], gstin: '19AADCP6122G1Z0', name: 'Puryv Flexipack Limited' });
  assert.equal(r.ledgerId, 7802);
  assert.equal(r.matchedBy, 'GSTIN_NEAR');
  assert.equal(r.correctedGstin, '19AADCP6122G1ZI');
  assert.match(r.evidence, /fails the GSTIN check character/);
});

test('two characters off, the name must agree as well', () => {
  const ok = identifySupplierLedger({ ledgers: [...NEAR, ...OTHERS], gstin: '19AAICG2283B1ZZ', name: 'GSN Udyog Private Limited' });
  assert.equal(ok.matchedBy, 'GSTIN_NEAR');
  assert.equal(ok.ledgerId, 7803);
  const no = identifySupplierLedger({ ledgers: [...NEAR, ...OTHERS], gstin: '19AAICG2283B1ZZ', name: 'Somebody Else Traders' });
  assert.equal(no.ledgerId, null);
  assert.match(no.evidence, /fails the GSTIN check character/);
});

test('an invented GSTIN near nothing falls back to the name (Flamingo)', () => {
  const ledgers = [...OTHERS, { LedgerID: 7900, LedgerName: 'Flamingo Printers Pvt Ltd', LedgerType: 'Suppliers', GSTNo: '19AAFCF9888F1ZX', ISLedgerActive: true }];
  const r = identifySupplierLedger({ ledgers, gstin: '19AAACF1234A1Z5', name: 'FLAMINGO PRINTERS PVT LTD' });
  assert.equal(r.ledgerId, 7900);
  assert.equal(r.matchedBy, 'NAME');
});
