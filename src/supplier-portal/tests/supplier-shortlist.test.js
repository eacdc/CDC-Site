/**
 * Shortlisting a supplier from a name on a letterhead.
 *
 * These exist because of a real screen. A Print Sales quote was uploaded, and
 * the portal offered — as its neighbours for "PRINT SALES PRIVATE LIMITED" —
 * *Graphic Sales*, *India Sales Agency* and *Print India Solution*. None of
 * them are the supplier. `stripCorporateSuffixes` removes "Pvt", "Ltd",
 * "India", "Enterprises", "Trading"; once those are gone, unrelated firms
 * collapse toward each other on the one word they happen to share.
 *
 * That was tolerable as a shortlist and dangerous as an auto-link, which is
 * why linking now needs an exact name or a GSTIN and fuzzy only ever suggests.
 * What these tests pin is the part that still has to be right: the correct
 * supplier ranks **first**, and clearly, so the person confirming is agreeing
 * rather than searching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestGroups, suggestGroup, stripCorporateSuffixes } from '../services/supplier-groups.js';

/** The neighbourhood that actually appeared on screen. */
const SUPPLIERS = [
  { _id: 'a', name: 'Print Sales Pvt Ltd' },
  { _id: 'b', name: 'Graphic Sales' },
  { _id: 'c', name: 'India Sales Agency' },
  { _id: 'd', name: 'Print India Solution' },
  { _id: 'e', name: 'Siegwerk India Pvt Ltd' },
  { _id: 'f', name: 'CDC Printers (Ahmedabad)', isInternal: true },
];

const READ = 'PRINT SALES PRIVATE LIMITED';

test('the right supplier ranks first for the name on the letterhead', () => {
  const [best] = suggestGroups(READ, SUPPLIERS);
  assert.equal(best.group.name, 'Print Sales Pvt Ltd');
  assert.equal(best.score, 1, 'suffixes stripped, the names are identical');
});

test('the near-misses rank below it but still appear', () => {
  const names = suggestGroups(READ, SUPPLIERS).map((r) => r.group.name);
  assert.equal(names[0], 'Print Sales Pvt Ltd');
  // They belong on a shortlist — a reviewer glancing past them costs nothing,
  // whereas a missing right answer costs a search through 1,279 names. What
  // must never happen is one of them being *chosen*.
  assert.ok(names.includes('Graphic Sales'));
  assert.ok(names.slice(1).every((n) => n !== 'Print Sales Pvt Ltd'));
});

test('an unrelated supplier does not make the shortlist', () => {
  const names = suggestGroups(READ, SUPPLIERS).map((r) => r.group.name);
  assert.ok(!names.includes('Siegwerk India Pvt Ltd'));
});

test('CDC itself is never offered as a supplier', () => {
  // Ahmedabad appears as a supplier ledger on lamination film. That is an
  // inter-unit transfer, not a purchase.
  const names = suggestGroups('CDC PRINTERS PVT LTD', SUPPLIERS).map((r) => r.group.name);
  assert.ok(!names.some((n) => n.startsWith('CDC')));
});

test('the shortlist is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ _id: String(i), name: `Print Sales ${i}` }));
  assert.equal(suggestGroups(READ, many).length, 6);
});

test('an alias identifies as well as the name', () => {
  // The merge path writes the old name here, so a quote printing "Neographic"
  // after the merge still finds SR Graphic.
  const groups = [{ _id: 'a', name: 'SR Graphic', aliases: ['Neographic', 'Neographics'] }];
  const [best] = suggestGroups('NEOGRAPHICS PVT LTD', groups);
  assert.equal(best.group.name, 'SR Graphic');
  assert.equal(best.matchedOn, 'Neographics');
});

test('a name that reads as nothing but suffixes shortlists no one', () => {
  // "Enterprises Pvt Ltd" carries no identity at all. Scoring it against every
  // Indian company would rank the whole list at once.
  assert.deepEqual(stripCorporateSuffixes('Enterprises Pvt Ltd'), '');
  assert.deepEqual(suggestGroups('Enterprises Pvt Ltd', SUPPLIERS), []);
});

test('nothing resembling the name gives an empty shortlist, not a best guess', () => {
  assert.deepEqual(suggestGroups('Bombay Dyeing', SUPPLIERS), []);
});

test('suggestGroup returns the single best match, floor and all', () => {
  // Used by the sync path to describe a near-miss, never to link one.
  assert.equal(suggestGroup(READ, SUPPLIERS).group.name, 'Print Sales Pvt Ltd');

  // With no floor it always answers, even for a name nothing resembles — the
  // caller reports it as a near-miss rather than acting on it. Which of
  // several near-zero scores wins is a tie broken by list order and is not
  // worth pinning; that the score is far below the shortlist floor is.
  const distant = suggestGroup('Bombay Dyeing', SUPPLIERS);
  assert.ok(distant, 'answers rather than returning nothing');
  assert.ok(distant.score < 0.3, `expected a near-zero score, got ${distant.score}`);
});

test('a branch in parentheses does not stop the match', () => {
  const groups = [{ _id: 'a', name: 'Siegwerk (Haryana)' }];
  const [best] = suggestGroups('SIEGWERK INDIA PRIVATE LIMITED', groups);
  assert.ok(best, 'a branch suffix is not part of the identity');
  assert.equal(best.group.name, 'Siegwerk (Haryana)');
});
