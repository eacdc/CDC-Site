/**
 * Reviewers' decisions come first in matching, in layers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalEvidence } from '../services/proposal-evidence.js';
import { matchLine } from '../services/matching.js';

const HARE = { name: 'Hare krishna Trading', gstin: '06AXIPB8043M1ZB' };
const UNIC = { name: 'Unic Tech', gstin: '24AAAAA0000A1Z5' };
const p = (supplier, productName, status, { proposed = null, decided = null, action = null, at = '2026-11-10' } = {}) => ({
  site: 'KOL', supplier, line: { productName }, status,
  proposal: { itemId: proposed, itemName: proposed ? `Item ${proposed}` : null },
  decision: status === 'UNAPPROVED' ? undefined : { action: action || (status === 'APPROVED' ? 'APPROVE' : 'REJECT'), itemId: decided, itemName: decided ? `Item ${decided}` : null, by: 'buyer@cdc', at },
});
const asHare = { gstins: [HARE.gstin], names: [HARE.name] };

test("this supplier's approved mapping for the same wording binds", () => {
  const ev = proposalEvidence([p(HARE, 'Blue Patch Tape', 'APPROVED', { proposed: 5746, decided: 5746 })],
    { site: 'KOL', supplier: asHare, line: { productName: 'Blue Patch Tape' } });
  assert.equal(ev.bind.itemId, 5746);
});

test('the newest approval wins, and a change rejects the item first proposed', () => {
  const ev = proposalEvidence([
    p(HARE, 'Matrix 0.4x1.4', 'APPROVED', { proposed: 5738, decided: 5738, at: '2026-11-01' }),
    p(HARE, 'Matrix 0.4x1.4', 'APPROVED', { proposed: 5738, decided: 6833, action: 'CHANGE', at: '2026-11-12' }),
  ], { site: 'KOL', supplier: asHare, line: { productName: 'Matrix 0.4x1.4' } });
  assert.equal(ev.bind.itemId, 6833);
  assert.deepEqual(ev.excludeItemIds, [5738]);
});

test("another supplier's approval is evidence, not an answer", () => {
  const ev = proposalEvidence([p(UNIC, 'Blue Patch Tape', 'APPROVED', { proposed: 5746, decided: 5746 })],
    { site: 'KOL', supplier: asHare, line: { productName: 'Blue Patch Tape' } });
  assert.equal(ev.bind, null);
  assert.equal(ev.approvedElsewhere[0].itemId, 5746);
});

test('unapproved proposals are a backup, and rejected items never return', () => {
  const ev = proposalEvidence([
    p(HARE, 'Sponge', 'REJECTED', { proposed: 5869 }),
    p(UNIC, 'Sponge', 'UNAPPROVED', { proposed: 5869 }),
    p(UNIC, 'Sponge', 'UNAPPROVED', { proposed: 5813 }),
  ], { site: 'KOL', supplier: asHare, line: { productName: 'Sponge' } });
  assert.equal(ev.bind, null);
  assert.deepEqual(ev.excludeItemIds, [5869]);
  assert.deepEqual(ev.unapproved.map((u) => u.itemId), [5813]);
});

test('another site, or a GSM band that does not overlap, is not evidence', () => {
  const kolOnly = [{ ...p(HARE, 'JK ELEKTRA', 'APPROVED', { proposed: 1, decided: 1 }), line: { productName: 'JK ELEKTRA', gsmFrom: 58, gsmTo: 60 } }];
  assert.equal(proposalEvidence(kolOnly, { site: 'AHM', supplier: asHare, line: { productName: 'JK ELEKTRA' } }).bind, null);
  assert.equal(proposalEvidence(kolOnly, { site: 'KOL', supplier: asHare, line: { productName: 'JK ELEKTRA', gsmFrom: 68 } }).bind, null);
  assert.equal(proposalEvidence(kolOnly, { site: 'KOL', supplier: asHare, line: { productName: 'JK ELEKTRA', gsmFrom: 60 } }).bind.itemId, 1);
});

test('matchLine takes an approval before the bills and the rate', async () => {
  const r = await matchLine({
    site: 'KOL',
    line: { raw: { productName: 'blue' }, normalised: { rate: 2400, ratePerBaseUom: 240 } },
    supplierItem: null,
    group: { name: HARE.name, gstins: [HARE.gstin] },
    candidates: [{ ItemID: 5746, ItemName: 'Tape-Blue 6MMW.40mtr.X.03', LastPaidRate: 240 }],
    proposals: [p(HARE, 'blue', 'APPROVED', { proposed: 5746, decided: 9999, action: 'CHANGE' })],
  });
  assert.equal(r.method, 'APPROVED_MAPPING');
  assert.equal(r.itemId, 9999);
});

test('matchLine never offers an item a reviewer rejected for this wording', async () => {
  const r = await matchLine({
    site: 'KOL',
    line: { raw: { productName: 'Grey Rubber' }, normalised: { rate: 1800, ratePerBaseUom: 1800 } },
    supplierItem: null,
    group: { name: HARE.name, gstins: [HARE.gstin] },
    candidates: [{ ItemID: 10079, ItemName: 'GREY RUBBER SHEETS 500 X 500 X 7 MM', LastPaidRate: 1800 }],
    proposals: [p(HARE, 'Grey Rubber', 'REJECTED', { proposed: 10079 })],
  });
  assert.notEqual(r.itemId, 10079);
});
