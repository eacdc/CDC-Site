/**
 * Matching engine tests.
 *
 * The rate-anchor cases are the ten verified pairs from the August 2026 batch.
 * Three of them — the typo, the reversed word order and the diacritic — are
 * also asserted to be unreachable by name similarity, which is the whole
 * argument for putting the rate anchor above it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rateAnchor, specTupleMatch, rank } from '../services/matching.js';
import { nameSimilarity, tokenSetRatio, normaliseName, hasBrandOrCodeToken } from '../lib/text.js';
import { parseGsmBand, gsmInBand, parseFilmType, parseMicron, buildSpecKey, itemMatchesSpecKey } from '../lib/spec.js';
import { TOLERANCES } from '../config/constants.js';

/** The verified rate-anchor pairs. */
const VERIFIED_ANCHORS = [
  ['Plate-CTP-790 X 1030', 382.44, 382.44],
  ['Plate-CTP-576 X 889', 240.67, 240.67],
  ['Boettcher S 3012', 189, 189],
  ['CALCIUMFIX', 1896, 1896],
  ['NOVA MET KLEEN', 288, 288],
  ['Web Blanket 578 Normal 889 X 647', 5077, 5077],
  ['GUM POWDER (CORRUGATION MACHINE)', 48, 48],
  ['PVA EMULSION KK GRIP KK-2102', 150.42, 150.42],
  ['Sewing Thread', 410, 410],
  ['Ink kitchen, Siegwerk-315-L Yellow', 522, 522],
];

test('every verified rate anchor resolves uniquely', () => {
  for (const [name, lastPaid, quoted] of VERIFIED_ANCHORS) {
    const candidates = [
      { ItemID: 1, ItemName: name, LastPaidRate: lastPaid },
      // Decoys at plausible but different rates.
      { ItemID: 2, ItemName: 'Something else', LastPaidRate: lastPaid * 1.4 },
      { ItemID: 3, ItemName: 'Another thing', LastPaidRate: lastPaid * 0.6 },
    ];
    const result = rateAnchor(candidates, quoted);
    assert.equal(result.unique, true, `${name} should anchor uniquely`);
    assert.equal(result.matches[0].ItemID, 1);
  }
});

test('the rate anchor survives what text matching cannot', () => {
  // These three are the argument for the tier ordering. Each pair is the same
  // product; each would be missed or mis-ranked by name similarity alone.
  const pairs = [
    ['CrownJewel TS', 'BROWN JEWEL TS'],            // supplier typo
    ['DP WASH', 'WASH DP'],                          // word order reversed
    ['BOTTCHER- ROLL O PASTE', 'BÖTTCHER PRO ROL-O-PAST'], // diacritic + truncation
  ];

  for (const [cdcName, supplierName] of pairs) {
    const candidates = [{ ItemID: 1, ItemName: cdcName, LastPaidRate: 500 }];
    // The rate anchor gets it every time.
    assert.equal(rateAnchor(candidates, 500).unique, true, `${supplierName} should anchor`);
  }

  // Word order is exactly what token-set similarity handles, so that one does
  // clear the threshold. The typo and the truncation do not — which is why
  // they must never depend on Tier 4.
  assert.ok(nameSimilarity('DP WASH', 'WASH DP') >= TOLERANCES.nameSimilarityAccept);
  assert.ok(
    nameSimilarity('CrownJewel TS', 'BROWN JEWEL TS') < TOLERANCES.nameSimilarityAccept,
    'a one-letter product-name typo should not auto-accept on text alone',
  );
});

test('several candidates at one rate is ambiguity, not a match', () => {
  // Usually CDC duplicate master rows for one product.
  const candidates = [
    { ItemID: 1, ItemName: 'Plate-CTP-790 X 1030', LastPaidRate: 382.44 },
    { ItemID: 2, ItemName: 'Plate CTP 790x1030', LastPaidRate: 382.44 },
  ];
  const result = rateAnchor(candidates, 382.44);
  assert.equal(result.unique, false);
  assert.equal(result.matches.length, 2);
});

test('the anchor tolerance is half a percent, not exact equality', () => {
  const candidates = [{ ItemID: 1, ItemName: 'x', LastPaidRate: 1000 }];
  assert.equal(rateAnchor(candidates, 1004).unique, true, '0.4% is within tolerance');
  assert.equal(rateAnchor(candidates, 1010).unique, false, '1% is a different price');
});

test('the anchor ignores candidates with no purchase history', () => {
  const candidates = [
    { ItemID: 1, ItemName: 'x', LastPaidRate: 0 },
    { ItemID: 2, ItemName: 'y', LastPaidRate: null },
  ];
  assert.equal(rateAnchor(candidates, 500).matches.length, 0);
});

test('diacritics, punctuation and case all fold away', () => {
  assert.equal(normaliseName('BÖTTCHER PRO ROL-O-PAST'), 'BOTTCHER PRO ROL O PAST');
  assert.equal(normaliseName('Plate-CTP-790 X 1030'), 'PLATE CTP 790 X 1030');
});

test('reversed word order scores high, a changed grade number does not', () => {
  assert.ok(tokenSetRatio('DP WASH', 'WASH DP') > 0.95);
  // SICURA 770 and SICURA 870 are different products; token overlap alone
  // scores them far too close.
  assert.ok(
    nameSimilarity('SICURA PLAST 770 HS', 'SICURA PLAST 870 HS') < TOLERANCES.nameSimilarityAccept,
    'a different grade number must not auto-accept',
  );
});

test('web lookup is gated to lines carrying a brand or code token', () => {
  assert.equal(hasBrandOrCodeToken('Sicura 770HS'), true);
  assert.equal(hasBrandOrCodeToken('71-000022-5.2690'), true);
  assert.equal(hasBrandOrCodeToken('120000201834'), true);
  assert.equal(hasBrandOrCodeToken('XUV 225 RC'), true);
  // Searching this returns marketing copy, and marketing copy read as
  // evidence produces false confidence.
  assert.equal(hasBrandOrCodeToken('Aqueous Gloss Varnish'), false);
});

test('GSM bands parse in every shape the batch used', () => {
  assert.deepEqual(parseGsmBand('100-300'), { gsmFrom: 100, gsmTo: 300 });
  assert.deepEqual(parseGsmBand('54-55'), { gsmFrom: 54, gsmTo: 55 });
  // An open upper bound stays null rather than becoming a large number that
  // would later read as a real limit.
  assert.deepEqual(parseGsmBand('115 & ABOVE'), { gsmFrom: 115, gsmTo: null });
  assert.deepEqual(parseGsmBand('90+AB'), { gsmFrom: 90, gsmTo: null });
});

test('band containment is a range test, open bounds included', () => {
  assert.equal(gsmInBand(200, { gsmFrom: 100, gsmTo: 300 }), true);
  assert.equal(gsmInBand(350, { gsmFrom: 100, gsmTo: 300 }), false);
  assert.equal(gsmInBand(400, { gsmFrom: 115, gsmTo: null }), true);
  assert.equal(gsmInBand(100, { gsmFrom: 115, gsmTo: null }), false);
});

test('film type and micron parse regardless of field order', () => {
  // The ERP generates these names from attributes, so the order varies
  // between two items of the same schema.
  const a = 'BOPP Gloss, 587 MM, 10 MICRON, Indian';
  const b = 'BOPP Gloss, Indian, 1030 MM, 10 MICRON';
  assert.equal(parseFilmType(a), 'BOPP GLOSS');
  assert.equal(parseFilmType(b), 'BOPP GLOSS');
  assert.equal(parseMicron(a), 10);
  assert.equal(parseMicron(b), 10);
});

test('a film quote with no width keys on type and micron', () => {
  // Purv quotes "12 Micron Matte BOPP ₹250" with no width at all, while CDC
  // holds ~60 film ItemIDs differing only by width.
  const key = buildSpecKey({ filmType: 'BOPP MATTE', micron: 12 });
  assert.equal(key.kind, 'FILM_SPEC');
  assert.equal(key.filmType, 'BOPP MATTE');
  assert.equal(key.micron, 12);
  assert.equal('widthMm' in key, false, 'width must not be part of the key');
});

test('one film spec key expands across every width', () => {
  const key = { kind: 'FILM_SPEC', filmType: 'BOPP MATTE', micron: 12 };
  const widths = [587, 720, 1030].map((w) => ({
    ItemID: w, ItemGroupID: 5, ItemName: `BOPP Matte, ${w} MM, 12 MICRON, Indian`, SizeW: w, Thickness: 12,
  }));
  for (const item of widths) {
    assert.equal(itemMatchesSpecKey(item, key), true, `width ${item.SizeW} should be covered`);
  }
  // A different micron is a different product.
  assert.equal(itemMatchesSpecKey({
    ItemID: 9, ItemGroupID: 5, ItemName: 'BOPP Matte, 587 MM, 10 MICRON, Indian', Thickness: 10,
  }, key), false);
});

test('a spec match needs at least two agreeing attributes', () => {
  const quote = { filmType: 'BOPP GLOSS', micron: 10 };
  const candidates = [
    { ItemID: 1, ItemGroupID: 5, ItemName: 'BOPP Gloss, 587 MM, 10 MICRON', Thickness: 10 },
    { ItemID: 2, ItemGroupID: 5, ItemName: 'BOPP Matte, 587 MM, 10 MICRON', Thickness: 10 },
  ];
  const result = specTupleMatch(candidates, quote);
  assert.equal(result.unique, true);
  assert.equal(result.matches[0].candidate.ItemID, 1);
});

test('ranking boosts sub-group, supplier history and rate proximity', () => {
  const line = { raw: { productName: 'NOVA MET KLEEN' } };
  const candidates = [
    {
      ItemID: 1, ItemName: 'NOVA MET KLEEN', LastPaidRate: 288,
      PurchaseCount: 25, _suppliedByThisGroup: true, ItemSubGroupName: 'Chemicals',
    },
    {
      ItemID: 2, ItemName: 'NOVA MET KLEEN PLUS', LastPaidRate: 1850,
      PurchaseCount: 1, _suppliedByThisGroup: false,
    },
  ];

  const ranked = rank(candidates, { line, quoteRate: 288 });
  assert.equal(ranked[0].itemId, 1, 'the plausible rate and supplier history should win');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.match(ranked[0].rationale, /within|supplier|regularly/);
});

test('a rate implausibly far from last paid is penalised', () => {
  const line = { raw: { productName: 'WIDGET' } };
  const ranked = rank(
    [{ ItemID: 1, ItemName: 'WIDGET', LastPaidRate: 285, PurchaseCount: 5 }],
    { line, quoteRate: 1850 },
  );
  assert.match(ranked[0].rationale, /implausibly far/);
});
