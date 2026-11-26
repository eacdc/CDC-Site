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
import { rateAnchor, specTupleMatch, rank, quoteReadings, corroborated, withinStatedGsm, matchLine } from '../services/matching.js';
import { billHistoryMatch, historyEntries, sameSupplier } from '../services/bill-history.js';
import { nameSimilarity, tokenSetRatio, normaliseName, hasBrandOrCodeToken, letterOverlap } from '../lib/text.js';
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

test('the anchor reconciles a per-kg quote against a per-pack last-paid rate', () => {
  /**
   * The verified Ultimate Logistix case, and the one an earlier version of
   * this engine missed. The supplier quotes GI wire at ₹149/kg; CDC buys the
   * 15 kg spool as one "Nos" and last paid ₹2,235. Same price — 149 × 15 =
   * 2235 — but anchoring on the per-kg figure alone finds nothing.
   */
  const candidates = [{ ItemID: 5501, ItemName: 'G.I WIRE SPOOL BIG 26', LastPaidRate: 2235 }];
  const quote = { ratePerBaseUom: 149, packQty: 15, packUom: 'KG' };

  const result = rateAnchor(candidates, quote);
  assert.equal(result.unique, true, 'the pack-equivalent reading must be tried');
  assert.equal(result.matches[0]._anchoredOn, 'PER_PACK');
  assert.equal(result.matches[0]._anchorRate, 2235);

  // A bare per-unit rate cannot reach it, which is exactly why the object form
  // exists.
  assert.equal(rateAnchor(candidates, 149).unique, false);
});

test('both readings of a quote are offered, and only when they differ', () => {
  assert.deepEqual(
    quoteReadings({ ratePerBaseUom: 149, packQty: 15 }),
    [{ rate: 149, basis: 'PER_UNIT' }, { rate: 2235, basis: 'PER_PACK' }],
  );
  // A pack of one is not a second reading.
  assert.deepEqual(
    quoteReadings({ ratePerBaseUom: 500, packQty: 1 }),
    [{ rate: 500, basis: 'PER_UNIT' }],
  );
  assert.deepEqual(quoteReadings(410), [{ rate: 410, basis: 'PER_UNIT' }]);
  assert.deepEqual(quoteReadings(null), []);
});

test('ranking measures against the closest legitimate reading', () => {
  // Scoring the wire spool as "93% away" because the supplier prices per kg
  // and CDC per spool would bury the right answer under the wrong one.
  const ranked = rank(
    [{ ItemID: 5501, ItemName: 'G.I WIRE SPOOL BIG 26', LastPaidRate: 2235, PurchaseCount: 12 }],
    { line: { raw: { productName: 'G.I WIRE SPOOL BIG 26' } }, quote: { ratePerBaseUom: 149, packQty: 15 } },
  );
  assert.equal(ranked[0].matchedBasis, 'PER_PACK');
  assert.equal(ranked[0].deltaVsLastPaidPct, 0);
  assert.match(ranked[0].rationale, /as a pack of 15/);
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

// ── August 2026 quotes: rate matches need the name, and the bills come first ──

test('the anchor pairs share their letters, the coincidences do not', () => {
  // Right: each was the same product at the same price.
  for (const [quote, item] of [
    ['CALCIUM FIX', 'CALCIUMFIX'], ['ROL O GEL', 'Rollo Gel'], ['BÖTTCHER PROTECTO', 'Protecto'],
    ['BÖTTCHER PRO ROL-O-PAST', 'BOTTCHER- ROLL O PASTE'], ['KK EASY BOND', 'EAZY BOND'],
  ]) assert.ok(letterOverlap(quote, item) >= 0.3, `${quote} ~ ${item}`);
  // Wrong: an unrelated item last bought within half a percent of the quote.
  for (const [quote, item] of [
    ['Gum Powder - Pasting', 'Matrix-Cito-4 X 1.4'], ['SICURA PLAST 770HS REFLEX BLUE', 'Servo Greese MP3'],
    ['ISO PROPYL ALCOHOL', 'Nova Nol'], ['Glazekleen', 'Ribbon Quater'], ['TEXTURE GLOSS', 'Technomelt 970N'],
  ]) assert.ok(letterOverlap(quote, item) < 0.3, `${quote} !~ ${item}`);
});

test('a rate match with a contradicting size or unrelated name is dropped', () => {
  const matches = [
    { ItemID: 1, ItemName: 'Web Blanket 546(1) Orient 889 x 612', LastPaidRate: 5077 },
    { ItemID: 2, ItemName: 'Ink kitchen, UV Gold Paste', LastPaidRate: 5077 },
  ];
  assert.deepEqual(corroborated(matches, 'Rubber Blanket EX6000 1.68 (889Gx595) With bar').map((c) => c.ItemID), []);
  assert.deepEqual(corroborated(matches, 'Web Blanket 889 X 612').map((c) => c.ItemID), [1]);
});

test('a tie at one rate no longer stops the search', async () => {
  // CAPRI 576 x 889 at 240.67 tied with a varnish and a tape; the name decides.
  const candidates = [
    { ItemID: 5874, ItemName: 'Plate-CTP-576 X 889', LastPaidRate: 240 },
    { ItemID: 3633, ItemName: 'UV, Aqueous Matt Varnish', LastPaidRate: 240.5 },
    { ItemID: 5866, ItemName: 'SOLVENT TISSUE TAPE 24 MM X 50 MTR', LastPaidRate: 240.3 },
  ];
  const line = { raw: { productName: 'Plate CTP 576 X 889' }, normalised: { rate: 240.67 } };
  const r = await matchLine({ site: 'KOL', line, supplierItem: null, group: null, candidates, allowLlm: false });
  assert.equal(r.itemId, 5874);
  assert.equal(r.method, 'RATE_ANCHOR');
});

const BILLS = historyEntries([{
  site: 'KOL',
  bill: { supplierName: 'HENKEL ADHESIVES TECHNOLOGIES INDIA PVT LTD', supplierGstin: '19AAACH0000A1Z5', invoiceDate: new Date('2026-07-01') },
  lines: [
    { kind: 'GOODS', description: 'TECHNOMELT Q 718', suggestion: { itemId: 5668, itemName: 'Art Paper - Main Glue', confidence: 0.95 } },
    { kind: 'GOODS', description: 'TECHNOMELT Q 970N', suggestion: { itemId: 9931, itemName: 'Technomelt 970N', confidence: 0.95 } },
    { kind: 'GOODS', description: 'WEB BLANKET 889X612', suggestion: { itemId: 5728, itemName: 'Web Blanket 546(1) Orient 889 x 612', confidence: 0.95 } },
    { kind: 'GOODS', description: 'GUESS', suggestion: { itemId: 1, itemName: 'x', confidence: 0.5 } },
  ],
}]);
const HENKEL = { gstins: ['19AAACH0000A1Z5'], names: ['Henkel'] };

test('bill history names what neither name nor rate could', () => {
  assert.equal(BILLS.length, 3, 'an unconfident pairing is not history');
  const m = billHistoryMatch(BILLS, { site: 'KOL', supplier: HENKEL, line: { raw: { productName: 'Technomelt Q 718 - 26kg', productCode: 'Q 718' } } });
  assert.equal(m?.itemId, 5668);
});

test('bill history is the supplier\'s own, on the same site, and respects size', () => {
  const line = { raw: { productName: 'Technomelt Q 718' } };
  assert.equal(billHistoryMatch(BILLS, { site: 'AHM', supplier: HENKEL, line }), null);
  assert.equal(billHistoryMatch(BILLS, { site: 'KOL', supplier: { gstins: ['24ZZZ'], names: ['Bindwel'] }, line }), null);
  // The 889 x 576 blanket is not the 889 x 612 one, however alike the words.
  assert.equal(billHistoryMatch(BILLS, { site: 'KOL', supplier: HENKEL, line: { raw: { productName: 'WEB BLANKET 889X576' } } }), null);
  // A GSM band is a paper price, not an item.
  assert.equal(billHistoryMatch(BILLS, { site: 'KOL', supplier: HENKEL, line: { raw: { productName: 'Technomelt Q 718', gsmFrom: 60, gsmTo: 90 } } }), null);
});

test('a supplier without a GSTIN on file is known by every distinctive word', () => {
  const e = { supplierName: 'N.R. AGARWAL INDUSTRIES LTD', gstin: null };
  // Initials are too short to count either way, so the surname carries it.
  assert.equal(sameSupplier(e, { names: ['NR Agarwal'] }), true);
  assert.equal(sameSupplier(e, { names: ['Agarwal Industries'] }), true);
  assert.equal(sameSupplier({ supplierName: 'PRINT SALES', gstin: null }, { names: ['Print Sales Pvt Ltd'] }), true);
  assert.equal(sameSupplier({ supplierName: 'SALES CORPORATION', gstin: null }, { names: ['Print Sales'] }), false);
});

test('a word of the trade does not make two firms one', () => {
  const akt = { supplierName: 'A.K.TRADING (PAPER) PRIVATE LIMITED', gstin: null };
  assert.equal(sameSupplier(akt, { names: ['SKM PAPER AND PACK LLP'] }), false);
  assert.equal(sameSupplier(akt, { names: ['AK Trading'] }), true);
});

test('initials stand for the words they abbreviate', () => {
  const hare = { supplierName: 'Hare Krishna Trading', gstin: null };
  assert.equal(sameSupplier(hare, { names: ['Hk Trading'] }), true);
  assert.equal(sameSupplier(hare, { names: ['H.K. TRADING'] }), true);
  // Two letters and nothing else in common is a coincidence, not a firm.
  assert.equal(sameSupplier(hare, { names: ['HK Paper Mart'] }), false);
});

test('matchLine takes the bills before the rate', async () => {
  const candidates = [{ ItemID: 7000, ItemName: 'Servo Greese MP3', LastPaidRate: 300 }];
  const line = { raw: { productName: 'Technomelt Q 970N' }, normalised: { rate: 300 } };
  const r = await matchLine({
    site: 'KOL', line, supplierItem: null, group: { name: 'Henkel', gstins: HENKEL.gstins },
    candidates, billHistory: BILLS, allowLlm: false,
  });
  assert.equal(r.method, 'BILL_HISTORY');
  assert.equal(r.itemId, 9931);
});

test('a rate match outside the quoted GSM band does not settle the line', async () => {
  const candidates = [
    { ItemID: 8101, ItemName: 'Devpriya PGB 390 GSM 700X1000', GSM: 390, LastPaidRate: 52 },
    { ItemID: 8102, ItemName: 'Devpriya PGB 270 GSM 700X1000', GSM: 270, LastPaidRate: 61 },
  ];
  const band = { raw: { productName: 'Devpriya PGB', gsmFrom: 250, gsmTo: 284 }, normalised: { rate: 52 } };
  assert.deepEqual(withinStatedGsm(candidates, band).map((c) => c.ItemID), [8102]);
  const r = await matchLine({ site: 'KOL', line: band, supplierItem: null, group: null, candidates, allowLlm: false });
  assert.notEqual(r.method, 'RATE_ANCHOR');
  assert.notEqual(r.itemId, 8101);
  // Inside the band the anchor still works.
  const inBand = { raw: { productName: 'Devpriya PGB', gsmFrom: 250, gsmTo: 284 }, normalised: { rate: 61 } };
  const ok = await matchLine({ site: 'KOL', line: inBand, supplierItem: null, group: null, candidates, allowLlm: false });
  assert.equal(ok.method, 'RATE_ANCHOR');
  assert.equal(ok.itemId, 8102);
  // No GSM stated: nothing to check against.
  assert.equal(withinStatedGsm(candidates, { raw: { productName: 'GUM POWDER' } }).length, 2);
});

test('a different model number or matrix size is not the same product', () => {
  const near = [{ ItemID: 10601, ItemName: 'Technomelt COOL 4530', LastPaidRate: 300 }];
  assert.deepEqual(corroborated(near, 'Technomelt COOL 4515 - 26kg'), []);
  assert.equal(corroborated(near, 'Technomelt COOL 4530 - 26kg').length, 1);
  const matrix = [{ ItemID: 5738, ItemName: 'Premium Matrix 0.4 x 1.3 mm', LastPaidRate: 50 }];
  assert.deepEqual(corroborated(matrix, 'Matrix 0.4x1.4 Short Run'), []);
  // A brand code beside a machine number is not two model numbers.
  const blanket = [{ ItemID: 5730, ItemName: 'Web Blanket 578 Normal 889 X 647 X 1.7 MM', LastPaidRate: 5077 }];
  assert.equal(corroborated(blanket, 'Rubber Blanket EX6000 1.68 (889GX647) With bar').length, 1);
});
