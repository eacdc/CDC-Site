/**
 * A paper quote line prices a quality over a GSM band with no size, so it is
 * approved as that band and not as one Indus item: 310 of the first 611 lines
 * the scheduled run read could not be approved any other way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanBand, itemInBand, bandLabel, bandChoices,
} from '../services/paper/band.js';
import { decideProposal } from '../models/proposals.js';
import { proposalEvidence } from '../services/proposal-evidence.js';
import { matchLine } from '../services/matching.js';
import { RunPayloadSchema } from '../services/proposals.js';

const item = (ItemID, Quality, Manufecturer, GSM, ItemGroupID = 14) => ({
  ItemID, ItemName: `${Quality} ${GSM}`, Quality, Manufecturer, GSM, ItemGroupID,
});
const FBB_ITC_300 = item(1, 'FBB', 'ITC', 300);
const FBB_EMAMI_260 = item(2, 'FBB', 'Emami', 260);
const FBB_ITC_REEL_270 = item(3, 'FBB', 'ITC', 270, 2);
const GREY_260 = item(4, 'Grey Back', 'Emami', 260);
const ITEMS = [FBB_ITC_300, FBB_EMAMI_260, FBB_ITC_REEL_270, GREY_260];

test('a band covers its quality, mills, form and GSM range, and nothing else', () => {
  const band = cleanBand({ quality: 'fbb', gsmFrom: 250, gsmTo: 284, groupIds: [14] });
  assert.deepEqual(ITEMS.filter((it) => itemInBand(it, band)).map((it) => it.ItemID), [2]);
  const anyForm = cleanBand({ quality: 'FBB', gsmFrom: 250, gsmTo: 284 });
  assert.deepEqual(ITEMS.filter((it) => itemInBand(it, anyForm)).map((it) => it.ItemID), [2, 3], 'no form named means sheet and reel');
  const itcOnly = cleanBand({ quality: 'FBB', mills: ['itc'], gsmFrom: 250, gsmTo: 400 });
  assert.deepEqual(ITEMS.filter((it) => itemInBand(it, itcOnly)).map((it) => it.ItemID), [1, 3], 'mills match whatever the case');
});

test('a band without a quality or a sensible range is refused', () => {
  assert.throws(() => cleanBand({ gsmFrom: 250, gsmTo: 284 }), /quality/);
  assert.throws(() => cleanBand({ quality: 'FBB', gsmFrom: 300, gsmTo: 250 }), /GSM range/);
  assert.throws(() => cleanBand({ quality: 'FBB', gsmFrom: 250, gsmTo: 284, groupIds: [3] }), /sheets \(14\), reels \(2\)/);
  assert.equal(cleanBand({ quality: 'FBB', gsmFrom: 250 }).gsmTo, 250, 'one GSM is a band of one');
});

test('the choices for a range are its qualities, most items first, with their mills', () => {
  const choices = bandChoices(ITEMS);
  assert.equal(choices[0].quality, 'FBB');
  assert.deepEqual(choices[0].byGroup, { 14: 2, 2: 1 });
  assert.deepEqual(choices[0].mills, [{ mill: 'ITC', items: 2 }, { mill: 'Emami', items: 1 }]);
  assert.equal(bandLabel(cleanBand({ quality: 'FBB', mills: ['ITC'], groupIds: [14], gsmFrom: 250, gsmTo: 284 })), 'FBB, ITC, sheet, 250-284 GSM');
});

/** Just enough of a Mongoose model for decideProposal, recording the update. */
function fakeModel(current) {
  const calls = [];
  return {
    calls,
    findById: () => ({ lean: async () => (calls.length ? { ...current, ...calls.at(-1).$set } : current) }),
    updateOne: (filter, update) => ({ exec: async () => { calls.push(update); return { modifiedCount: 1 }; } }),
  };
}
const paperLine = { _id: 'p1', status: 'UNAPPROVED', line: { productName: 'NR Power Fold FBB', gsmFrom: 250, gsmTo: 284 }, proposal: { itemId: null } };
const BAND = { quality: 'FBB', mills: [], groupIds: [14], gsmFrom: 250, gsmTo: 284, itemCount: 43 };

test('a paper line is approved as a band, with no single item', async () => {
  const Model = fakeModel(paperLine);
  const decided = await decideProposal(Model, { id: 'p1', action: 'BAND', band: BAND, by: 'buyer@cdc' });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.decision.itemId, null);
  assert.deepEqual(decided.decision.band, BAND);
  await assert.rejects(decideProposal(fakeModel(paperLine), { id: 'p1', action: 'BAND', by: 'buyer@cdc' }), /needs the band/);
  await assert.rejects(decideProposal(fakeModel(paperLine), { id: 'p1', action: 'APPROVE', by: 'buyer@cdc' }), /no proposed item/,
    'a paper line with nothing proposed still cannot be approved blind');
});

test('a band proposed again from an earlier approval is approved as that band', async () => {
  const Model = fakeModel({ ...paperLine, proposal: { itemId: null, band: BAND, method: 'APPROVED_MAPPING' } });
  const decided = await decideProposal(Model, { id: 'p1', action: 'APPROVE', by: 'buyer@cdc' });
  assert.deepEqual(decided.decision.band, BAND);
  assert.equal(decided.decision.action, 'APPROVE');
});

const SUD = { name: 'Sudarshan Paper and Board', gstin: '19AAAAA0000A1Z5' };
const approvedBand = {
  site: 'KOL', supplier: SUD, line: { productName: 'NR Power Fold - FBB', gsmFrom: 250, gsmTo: 284 }, status: 'APPROVED',
  proposal: { itemId: null }, decision: { action: 'BAND', itemId: null, band: BAND, by: 'buyer@cdc', at: '2026-11-18' },
};

test("this supplier's approved band binds the same wording in the next quote", async () => {
  const line = { productName: 'NR Power Fold - FBB', gsmFrom: 250, gsmTo: 284 };
  const group = { name: SUD.name, gstins: [SUD.gstin] };
  const ev = proposalEvidence([approvedBand], { site: 'KOL', supplier: { gstins: [SUD.gstin], names: [SUD.name] }, line });
  assert.deepEqual(ev.bind.band, BAND);
  const m = await matchLine({ site: 'KOL', line: { raw: line, normalised: {} }, supplierItem: null, group, candidates: [], proposals: [approvedBand] });
  assert.equal(m.method, 'APPROVED_MAPPING');
  assert.equal(m.itemId, null);
  assert.deepEqual(m.band, BAND);
  const other = await matchLine({
    site: 'KOL', line: { raw: { ...line, gsmFrom: 285, gsmTo: 400 }, normalised: {} }, supplierItem: null, group, candidates: [], proposals: [approvedBand],
  });
  assert.equal(other.band ?? null, null, 'another GSM band of the same paper is a different line');
});

test('the run can send a band back, and only in its shape', () => {
  const base = {
    sha256: 'a'.repeat(64), fileName: 'q.pdf', site: 'KOL', rulesVersion: 'v', runId: 'r',
    lines: [{ line: { productName: 'NR Power Fold - FBB' }, proposal: { method: 'APPROVED_MAPPING', band: BAND } }],
  };
  assert.deepEqual(RunPayloadSchema.parse(base).lines[0].proposal.band, BAND);
  assert.throws(() => RunPayloadSchema.parse({ ...base, lines: [{ ...base.lines[0], proposal: { method: 'APPROVED_MAPPING', band: { gsmFrom: 250 } } }] }));
});
