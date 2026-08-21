/**
 * The paper vocabulary, tested against product strings taken verbatim from
 * eight real quotes and CDC's item master.
 *
 * Every string below was actually printed on a document. Where a price is
 * quoted in a comment it is the real one, because the prices are what make the
 * distinctions matter: two papers a rupee apart that should never be compared
 * do more damage than two that are obviously different.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePaperType, resolveMill, resolveAttributes, unconfirmedTokens,
  canonicalPaperTypes, paperTypeLabel,
} from '../config/paper-vocabulary.js';

// ── The collision that shapes the whole file ────────────────────────────────

test('NS is natural shade and NSS is non surface sized', () => {
  // One letter apart, opposite kinds of thing, pointing in opposite price
  // directions: NS is +2.00/kg, NON SS is -1.00/kg. Substring matching would
  // read every NSS as an NS.
  assert.equal(resolveAttributes('CENTURY DAZZLE PRINT NS').shade, 'NATURAL');
  assert.equal(resolveAttributes('SIRPUR NSS MAPLITHO NON SS').shade, null);
  assert.equal(resolveAttributes('SIRPUR NSS MAPLITHO NON SS').surfaceSized, 'NON_SS');
});

test('a plain product has no shade marker at all', () => {
  // CENTURY DAZZLE PRINT is 74.50; the NS version is 76.50. If the plain one
  // picked up a shade marker the two would compare as the same paper.
  assert.equal(resolveAttributes('CENTURY DAZZLE PRINT').shade, null);
});

test('natural shade is found however it is written', () => {
  assert.equal(resolveAttributes('ITC SS MAPLITHO (NS)').shade, 'NATURAL');
  assert.equal(resolveAttributes('SIRPUR NATURA SS (NS)').shade, 'NATURAL');
  assert.equal(resolveAttributes('ANDHRA NATURAL SHADE').shade, 'NATURAL');
  assert.equal(resolveAttributes('18 BF 140-180 GSM NS').shade, 'NATURAL', 'kraft uses NS too');
});

// ── Type synonyms ───────────────────────────────────────────────────────────

test('the four spellings of grey back all resolve', () => {
  // Sudarshan writes GB, AKT writes PGB, KV heads a section DUPLEX BOARD,
  // the item master writes it in full. No two share a substring.
  assert.equal(resolvePaperType('MEHALI ECO GREEN GB'), 'GREY_BACK');
  assert.equal(resolvePaperType('Devpriya PGB'), 'GREY_BACK');
  assert.equal(resolvePaperType('Grey Back, 300 GSM, Dev Priya'), 'GREY_BACK');
  assert.equal(resolvePaperType('DUPLEX BOARD'), 'GREY_BACK');
});

test('duplex means recycled: alone it is grey back, with white back it is white back', () => {
  // CDC's rule, verbatim. Duplex is the trade's casual word for recycled and
  // both backs are duplex, so it narrows rather than decides.
  assert.equal(resolvePaperType('DUPLEX BOARD'), 'GREY_BACK');
  assert.equal(resolvePaperType('UNI GLOBAL DUPLEX'), 'GREY_BACK');
  assert.equal(resolvePaperType('DUPLEX WHITE BACK'), 'WHITE_BACK');

  // KV's actual layout: one DUPLEX BOARD section holding both, six rupees
  // apart. Defaulting wrong would file the dearer paper as the cheaper one on
  // every unlabelled row.
  assert.equal(resolvePaperType('DUPLEX BOARD ITC ECO POLAR WHITE BACK'), 'WHITE_BACK');
});

test('white back beats duplex and beats grey back', () => {
  // KV files both under one "DUPLEX BOARD" heading, six rupees apart:
  // BAHL GREY BACK 1000 at 49.50, BAHL WHITE BACK 1000 at 55.50.
  assert.equal(resolvePaperType('BAHL WHITE BACK 1000'), 'WHITE_BACK');
  assert.equal(resolvePaperType('ITC ECO POLAR WHITE BACK'), 'WHITE_BACK');
  assert.equal(resolvePaperType('MEHALI ECO WHITE WB'), 'WHITE_BACK');
  assert.equal(resolvePaperType('DSWB'), 'WHITE_BACK');
});

test('offset and woodfree mean maplitho', () => {
  assert.equal(resolvePaperType('APRILFINE PAPERONE OFFSET'), 'MAPLITHO');
  assert.equal(resolvePaperType('ASIA SYMBOL RUIYIN OFFSET'), 'MAPLITHO');
  assert.equal(resolvePaperType('IK WOODFREE'), 'MAPLITHO');
  assert.equal(resolvePaperType('ORIENT PLATINUM MAPLITHO'), 'MAPLITHO');
  assert.equal(resolvePaperType('TRUEPRINT ULTRA (HB) MAP'), 'MAPLITHO');
  assert.equal(resolvePaperType('SSP, 120 GSM, Ballarpur'), 'MAPLITHO');
});

test('GC1 and GC2 are FBB', () => {
  // AprilFine prints the European grade codes instead of the words.
  assert.equal(resolvePaperType('APRILFINE BOARDONE GC1 HI-BULK'), 'FBB');
  assert.equal(resolvePaperType('APRILFINE BOARDONE GC2'), 'FBB');
});

test('C2S gloss and matt separate cleanly', () => {
  assert.equal(resolvePaperType('HANSOL ART PAPER C2S GLOSS'), 'GLOSS_ART');
  assert.equal(resolvePaperType('JK COTE ART PAPER C2S MATT'), 'MATTE_ART');
  assert.equal(resolvePaperType('SNOWLION ART BOARD C2S GLOSS'), 'GLOSS_ART');
  assert.equal(resolvePaperType('XPLORE CHROMO PAPER (C1S)'), 'CHROMO');
});

// ── Brand mappings ──────────────────────────────────────────────────────────

test('the three ITC products CDC confirmed resolve without a type word', () => {
  // The payoff. Neither Sudarshan's Virgin list nor KV's "FBB & SBS" section
  // states a type for any of these, and one of the three is not even the type
  // its section heading implies.
  assert.equal(resolvePaperType('ITC CARTE LUMINA'), 'CBB');
  assert.equal(resolvePaperType('ITC CYBER XL PAC'), 'FBB');
  assert.equal(resolvePaperType('ITC CYBER XLPAC'), 'FBB', "Sudarshan's spelling");
  assert.equal(resolvePaperType('ITC PEARL XL PAC'), 'FBB');
});

test('a confirmed brand outranks a stray type word in its name', () => {
  // Carte Lumina sits under a heading reading "FBB & SBS" and is CBB. What CDC
  // confirmed about the product beats what the page happens to say around it.
  assert.equal(resolvePaperType('FBB & SBS — ITC CARTE LUMINA'), 'CBB');
});

// ── Form, and the premium that proves it matters ────────────────────────────

test('RBD is sheet and RLS is reel', () => {
  // Eleven products on Sudarshan's Virgin list carry both, every pair exactly
  // Rs 3.00/kg apart. AKT's premium is 3.50, NR's stated rule is 1.00.
  assert.equal(resolveAttributes('APRILFINE BOARDONE GC2 All All RBD').form, 'SHEET');
  assert.equal(resolveAttributes('APRILFINE BOARDONE GC2 All All RLS').form, 'REEL');
  assert.equal(resolveAttributes('Do sheet TNPL FBB').form, 'SHEET');
});

test('high bulk is recognised in all its spellings', () => {
  assert.equal(resolveAttributes('APRILFINE BOARDONE GC1 HI-BULK').bulk, 'HIGH');
  assert.equal(resolveAttributes('GENUS MAPLITHO PRIMA HI BULK').bulk, 'HIGH');
  assert.equal(resolveAttributes('SIRPUR HB PLUS SS').bulk, 'HIGH');
  assert.equal(resolveAttributes('MAPLITHO 1.45 BULK').bulk, 'HIGH');
});

// ── Mills ───────────────────────────────────────────────────────────────────

test('one mill, however CDC spelled it', () => {
  // These variants are inside CDC's own item master, not in supplier documents.
  assert.equal(resolveMill('Dev Priya'), resolveMill('Devpriya'));
  assert.equal(resolveMill('SAHOTA'), resolveMill('SAHUTA'));
  assert.equal(resolveMill('Bhal'), resolveMill('BAHL'));
  assert.equal(resolveMill('Silvertone Vista'), resolveMill('Silverton'));
  assert.equal(resolveMill('Sidhartha'), resolveMill('SIDHARTH'));
});

test("CDC's long-standing typo still finds the mill", () => {
  // "Importet" has been entered hundreds of times.
  assert.equal(resolveMill('Importet - April'), 'APRILFINE');
  assert.equal(resolveMill('Imported (April Fine)'), 'APRILFINE');
  assert.equal(resolveMill('AprilFine'), 'APRILFINE');
});

test('BILT and Ballarpur are the same company', () => {
  assert.equal(resolveMill('BILT'), resolveMill('Ballarpur'));
});

test('Khanna is one mill; OGB and GSP are its grades', () => {
  // Confirmed by CDC. Treating them as three mills would split one supplier's
  // rate history three ways and hide every price movement across it.
  assert.equal(resolveMill('Khanna'), 'KHANNA');
  assert.equal(resolveMill('Khanna OGB'), 'KHANNA');
  assert.equal(resolveMill('Khanna GSP'), 'KHANNA');
});

test('the kraft mills resolve', () => {
  assert.equal(resolveMill('M/s Natraj Electro Casting, Panagargh'), 'NATRAJ');
  assert.equal(resolveMill('M/s Madhubati Paper, Uluberia'), 'MADHUBATI');
});

test('an unknown mill is null rather than a near-miss', () => {
  assert.equal(resolveMill('Some Mill Nobody Has Heard Of'), null);
});

// ── What we refuse to guess ─────────────────────────────────────────────────

test('unconfirmed abbreviations resolve to nothing and are reported', () => {
  // DCB is priced a rupee below PGB on the same handwritten note, which makes
  // "grey back variant" a plausible guess. Plausible is exactly when guessing
  // is most tempting and most dangerous: a wrong mapping merges two papers
  // into one comparison and nothing in the result shows it happened.
  assert.equal(resolvePaperType('Devpriya DCB'), null);
  assert.deepEqual(unconfirmedTokens('Devpriya DCB'), ['DCB']);

  assert.equal(resolvePaperType('UNI GLOBAL PDB'), null);
  assert.deepEqual(unconfirmedTokens('UNI GLOBAL PDB'), ['PDB']);
});

test('a recognised product reports no unconfirmed tokens', () => {
  assert.deepEqual(unconfirmedTokens('MEHALI ECO GREEN GB'), []);
});

test('an unrecognised product is null, not a best guess', () => {
  // Sudarshan's Virgin list states a type for none of its ~28 products. Each
  // is a question to ask once, not a guess to make silently.
  assert.equal(resolvePaperType('CENTURY PRIMA FOLD'), null);
  assert.equal(resolvePaperType('ITC SAFIRE GRAPHIK'), null);
  assert.equal(resolvePaperType('APRILFINE SILVERPACK'), null);
});

// ── Guards against over-matching ────────────────────────────────────────────

test('an abbreviation inside a longer word is not a match', () => {
  assert.equal(resolvePaperType('GBOARD SPECIAL'), null);
  assert.equal(resolvePaperType('WBX FILM'), null);
});

test('"PRINT" in a brand name is not a paper type', () => {
  // Dazzle Print, Enova Print, Super Print, Perfect Print, Mirror Print — the
  // word is everywhere and means nothing about the paper.
  assert.equal(resolvePaperType('NAINI SUPER PRINT'), null);
  assert.equal(resolvePaperType('CENTURY ENOVA PRINT'), null);
});

test('specialty papers carry no type, by design', () => {
  // Asking "what paper type is Stardream Opal?" is a bad question. The ~40
  // Cordenons products are matched by brand and mill.
  assert.equal(resolvePaperType('Montblanc Extra White'), null);
  assert.equal(resolvePaperType('Stardream Opal'), null);
  assert.equal(resolveMill('Stardream Opal, 285 GSM, Cordenons'), 'CORDENONS');
});

test('empty input resolves to nothing', () => {
  assert.equal(resolvePaperType(''), null);
  assert.equal(resolvePaperType(null), null);
  assert.equal(resolveMill(undefined), null);
  assert.deepEqual(resolveAttributes(''), { shade: null, bulk: null, form: null, surfaceSized: null });
});

// ── The list the agent will choose from ─────────────────────────────────────

test('every canonical type has a readable label', () => {
  const types = canonicalPaperTypes();
  assert.ok(types.length >= 15);
  assert.ok(types.every((t) => t.canonical && t.label));
  assert.equal(paperTypeLabel('GREY_BACK'), 'Grey back');
  assert.equal(paperTypeLabel('FBB'), 'FBB (folding box board)');
});
