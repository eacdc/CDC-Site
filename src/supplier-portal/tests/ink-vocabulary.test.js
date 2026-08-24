/**
 * "Which UV process cyan is cheapest" — the question this category exists for.
 *
 * Every string in this file is copied verbatim from one of the three documents
 * CDC supplied in July 2026: Print Sales' dealer PDF, Siegwerk's own xlsx price
 * list, and CDC's internal item list. Nothing is invented, because the whole
 * risk in this vocabulary is a real spelling nobody anticipated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMaterialClass, resolveChemistry, resolveRole, resolveColour, resolveFinish,
  resolveCoatingProperty, resolveChemicalFunction, resolveManufacturer, resolveFamily,
  resolveBaseNumber, resolveRateUom, parsePack, unconfirmedInkTokens, comparisonKey, inkLabel,
} from '../config/ink-vocabulary.js';

// ── The comparison the portal was built for ─────────────────────────────────

test('two makers\' UV process cyans land on the same key', () => {
  // DIC 830/kg via Print Sales, Siegwerk 810/kg direct. Different words, no
  // shared substring, same purchase decision. This is the entire point.
  const dic = { productName: 'RADICURE INTENSE 9000 PRO CYAN', rateUom: 'KG' };
  const siegwerk = { productName: 'SICURA PLAST 770HS PROCESS CYAN', rateUom: 'KG' };

  assert.equal(comparisonKey(dic), comparisonKey(siegwerk));
  assert.equal(comparisonKey(dic), 'INK|UV|PRESS_READY|CYAN|KG');
});

test('a conventional cyan never sits beside a UV one', () => {
  // Vega Sprint 292, Sicura Plast 810 — 2.8x apart, same colour. Without
  // chemistry in the key the conventional ink looks like a bargain on a screen
  // that gives no hint why.
  const conventional = { productName: 'VEGA SPRINT PROCESS CYAN', rateUom: 'KG' };
  const uv = { productName: 'SICURA PLAST 770HS PROCESS CYAN', rateUom: 'KG' };

  assert.notEqual(comparisonKey(conventional), comparisonKey(uv));
});

test('a mixing base never sits beside a press-ready ink', () => {
  // Vega Prime Process Black PASTE 706 at 411 against Vega Sprint Process Black
  // at 275. Both conventional, both black; one is a Pantone base you mix from.
  // Compared head to head the base reads as 50% overpriced.
  const base = { productName: 'VEGA PRIME PROCESS BLACK PASTE 706', rateUom: 'KG' };
  const ready = { productName: 'VEGA SPRINT PROCESS BLACK', rateUom: 'KG' };

  assert.equal(resolveRole(base.productName), 'MIXING_BASE');
  assert.equal(resolveRole(ready.productName), 'PRESS_READY');
  assert.notEqual(comparisonKey(base), comparisonKey(ready));
});

test('the same base under four product codes resolves to one number', () => {
  // Siegwerk prices FAST BLUE (R/S) PASTE 517 under 61-145226-9.1770,
  // 61-140152-2.2690, 61-147626-8.2020 and 61-146393-6.2660 — all at 514. The
  // base number is what ties them together; the codes never would.
  const names = [
    'VEGA PRIME FAST BLUE (R/S) PASTE 517',
    'VEGA PRIME FAST BLUE (R/S) PASTE 517(RM)',
  ];
  for (const name of names) {
    assert.equal(resolveBaseNumber(name), '517');
    assert.equal(resolveColour(name), 'FAST_BLUE');
  }
});

test('a series number in a press-ready ink is not read as a base number', () => {
  // "Radicure Intense 9000" and "Sicura Plast 770HS" carry numbers that mean
  // series, not Pantone base. Reading them as bases would merge every
  // 9000-series ink into one imaginary base.
  assert.equal(resolveBaseNumber('RADICURE INTENSE 9000 PRO CYAN'), null);
  assert.equal(resolveBaseNumber('SICURA PLAST 770HS PROCESS GREEN'), null);
});

test('rates in different units are never comparable', () => {
  // A plate at 382.44 a piece and a UV gloss at 410 a kg are two numbers that
  // must not be sorted against each other.
  const plate = { productName: 'CAPRI DOUBLE COATED THERMAL PLATE', rateUom: 'PC' };
  const coating = { productName: 'UV GLOSS', rateUom: 'KG' };
  assert.notEqual(comparisonKey(plate), comparisonKey(coating));
});

test('a row nothing can be said about gets no key at all', () => {
  // A key of mostly-nulls would pool every unreadable row into one bucket that
  // looks like a match.
  assert.equal(comparisonKey({ productName: 'SOMETHING NOBODY WROTE DOWN' }), null);
  assert.equal(comparisonKey({ productName: '' }), null);
});

// ── The two traps ───────────────────────────────────────────────────────────

test('DIC\'s aqueous coatings are coatings, despite being called ink', () => {
  // "OP INK" is overprint. Read as ink, a 220 coating gets compared against an
  // 810 process colour.
  assert.equal(resolveMaterialClass('AQUATIC ECO SMART OP INK'), 'COATING');
  assert.equal(resolveMaterialClass('NEUTRAL SEALER AQUATIC OP INK'), 'COATING');
  assert.equal(resolveMaterialClass('HIGH SLIP AQUATIC MATT OP INK'), 'COATING');
  assert.equal(resolveMaterialClass('WATER BASED OPL-HIGH GLOSS'), 'COATING');
});

test('a plate cleaner is a chemical, not a plate', () => {
  // Both carry the whole word PLATE. One is a 382/pc consumable sized in mm,
  // the other is what you clean it with at 185/ltr.
  assert.equal(resolveMaterialClass('PLATE CLEANER GP (5 LTR)'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('CAPRI (DOUBLE COATED THERMAL PLATES)'), 'PLATE');
});

test('a real ink is still an ink', () => {
  assert.equal(resolveMaterialClass('RADICURE INTENSE 9000 ABSOLUTE BLACK'), 'INK');
  assert.equal(resolveMaterialClass('WB CDC SPL BLACK 2024'), 'INK');
});

test('most ink never says the word "ink", and is still an ink', () => {
  // Not one of these contains it, and between them they are most of both
  // quotes. A colour with nothing else claiming it is an ink.
  assert.equal(resolveMaterialClass('RADICURE INTENSE 9000 PRO CYAN'), 'INK');
  assert.equal(resolveMaterialClass('VEGA SPRINT PROCESS CYAN'), 'INK');
  assert.equal(resolveMaterialClass('SICURA PLAST 770HS REFLEX BLUE'), 'INK');
});

test('most ink never states its chemistry either', () => {
  // "VEGA SPRINT PROCESS CYAN" carries no word meaning conventional. It is
  // conventional because Siegwerk makes it that way — a fact about a product,
  // confirmed once, not a meaning carried by a word.
  assert.equal(resolveChemistry('VEGA SPRINT PROCESS CYAN'), 'CONVENTIONAL');
  assert.equal(resolveChemistry('VEGA PRIME PROCESS BLUE PASTE 516'), 'CONVENTIONAL');
  assert.equal(resolveChemistry('VEGA ABSOLUTE BLACK PASTE'), 'CONVENTIONAL');
  assert.equal(resolveChemistry('SICURA PLAST 770HS PROCESS CYAN'), 'UV');
  assert.equal(resolveChemistry('AQUATIC VIVID OP INK', 'COATING'), 'WATER_BASED');
});

test('water-based ink is conventional ink, but aqueous coating is aqueous', () => {
  /*
    Confirmed by CDC. Water-based ink is real and they buy it, but they compare
    it against conventional ink; left as a chemistry of its own it would key
    separately and "WB CDC SPL BLACK 2024" (313/kg) would never appear beside
    the other blacks it actually competes with.

    Coatings keep the distinction, because aqueous versus UV is the entire
    difference between a 154 varnish and a 970 one.
  */
  assert.equal(resolveChemistry('WB CDC SPL BLACK 2024'), 'CONVENTIONAL');
  assert.equal(
    comparisonKey({ productName: 'WB CDC SPL BLACK 2024', rateUom: 'KG' }),
    comparisonKey({ productName: 'VEGA SPRINT INTENSIVE BLACK', rateUom: 'KG' }),
  );

  assert.equal(resolveChemistry('WATER BASED OPL-HIGH GLOSS'), 'WATER_BASED');
  assert.notEqual(
    comparisonKey({ productName: 'WATER BASED OPL-HIGH GLOSS', rateUom: 'KG' }),
    comparisonKey({ productName: 'SICURA UV TEXTURE MATT - HG', rateUom: 'KG' }),
  );
});

test('a coating that never says varnish is still a coating', () => {
  assert.equal(resolveMaterialClass('SICURA UV TEXTURE MATT - HG'), 'COATING');
  assert.equal(resolveMaterialClass('SICURA GLOSS TEXTURE T2000'), 'COATING');
});

test('a tack reducer is an ink additive, not a solvent', () => {
  /*
    It contains REDUCER, which is a press-chemical word — Print Sales lists
    "DIC 975 REDUCER" under PRESS CHEMICALS. But a TACK reducer goes into the
    ink, costs 875/kg and sits among the inks. Filed as a solvent it would be
    compared against benzene at 170 a litre: different unit, different shelf,
    different thing.
  */
  assert.equal(comparisonKey({ productName: 'UV LIQUID TACK REDUCER', rateUom: 'KG' }), 'INK|ADDITIVE|PRESS_READY|NO_COLOUR|KG');
  assert.equal(comparisonKey({ productName: 'UV TACK REDUCING INK   RL', rateUom: 'KG' }), 'INK|ADDITIVE|PRESS_READY|NO_COLOUR|KG');
  assert.equal(comparisonKey({ productName: 'MOF RAPID DRIER RL', rateUom: 'KG' }), 'INK|ADDITIVE|PRESS_READY|NO_COLOUR|KG');
  // And a real solvent stays one.
  assert.equal(comparisonKey({ productName: 'BENZENE (5 LTR)', rateUom: 'LTR' }), 'PRESS_CHEMICAL|SOLVENT|LTR');
});

test('not every paste is a Pantone base', () => {
  // An additive supplied as a paste is not something a buyer mixes a shade
  // from, and must not appear among the ones that are.
  assert.equal(resolveRole('SICURA ANTI SCUMMING PASTE'), 'PRESS_READY');
  assert.equal(resolveRole('VEGA PRIME WARM RED PASTE 246'), 'MIXING_BASE');
});

// ── Colour ──────────────────────────────────────────────────────────────────

test('every maker\'s adjective for black lands on black', () => {
  assert.equal(resolveColour('RADICURE INTENSE 9000 ABSOLUTE BLACK'), 'BLACK');
  assert.equal(resolveColour('VEGA SPRINT INTENSIVE BLACK'), 'BLACK');
  assert.equal(resolveColour('SICURA PLAST 770HS PROCESS BLACK'), 'BLACK');
  assert.equal(resolveColour('VEGA ABSOLUTE BLACK PASTE'), 'BLACK');
});

test('a longer colour is never read as the shorter one inside it', () => {
  // RICH PALE GOLD is not GOLD (2,385 against 4,695), SILVER GREY is not
  // SILVER, WARM RED and RUBINE RED are not each other.
  assert.equal(resolveColour('RICH PALE GOLD INK 2025 RL'), 'PALE_GOLD');
  assert.equal(resolveColour('SUPER GLOSS RICH PALE GOLD INK'), 'PALE_GOLD');
  assert.equal(resolveColour('UV GOLD PASTE'), 'GOLD');
  assert.equal(resolveColour('UV DOLLAR SPL SILVER GREY'), 'SILVER_GREY');
  assert.equal(resolveColour('UV JAZZ SPL SILVER'), 'SILVER');
  assert.equal(resolveColour('VEGA PRIME WARM RED PASTE 246'), 'WARM_RED');
  assert.equal(resolveColour('VEGA PRIME PROCESS RUBINE RED PASTE 175'), 'RUBINE_RED');
  assert.equal(resolveColour('SICURA PLAST 770HS  RED 032'), 'RED_032');
});

test('the expensive Pantone bases are told apart from the process colours', () => {
  // Inside one Siegwerk series: process 810, warm red 1,151, reflex blue 1,503,
  // rhodamine 1,825, violet 3,072. Colour is doing all the pricing work.
  assert.equal(resolveColour('SICURA PLAST 770HS REFLEX BLUE'), 'REFLEX_BLUE');
  assert.equal(resolveColour('SICURA PLAST 770 HS FAST RHODAMINE'), 'RHODAMINE');
  assert.equal(resolveColour('SICURA PLAST 770 HS VIOLET'), 'VIOLET');
  assert.equal(resolveColour('VEGA PRIME PROCESS BLUE PASTE 516'), 'PROCESS_BLUE');
  assert.equal(resolveColour('VEGA PRIME FAST VIOLET PASTE 616  RL'), 'VIOLET');
});

test('whites and transparents are kept apart', () => {
  assert.equal(resolveColour('SICURA XTR OPAQUE WHITE'), 'OPAQUE_WHITE');
  assert.equal(resolveColour('SICURA 770HS FLEXI OPAQUE WHITE PLUS'), 'OPAQUE_WHITE');
  assert.equal(resolveColour('RADICURE BRIGHT WHITE'), 'OPAQUE_WHITE');
  assert.equal(resolveColour('VEGA PRIME TRANSPARENT MEDIUM 228'), 'TRANSPARENT');
  assert.equal(resolveColour('SICURA 770 HS CLEAR TRANS. MEDIUM'), 'TRANSPARENT');
});

test('a chemical has no colour and that is not a failure', () => {
  assert.equal(resolveColour('ECNO WASH KR (20 LTR)'), null);
  assert.equal(resolveColour('STAR PLUS DEVELOPER (20 LTR)'), null);
});

// ── Coating finish ──────────────────────────────────────────────────────────

test('texture matt is not matt, and super matt is neither', () => {
  // On one Print Sales page: texture gloss 400, UV gloss 410, super matt 820,
  // texture matt 1,120. Read as plain matt, the dearest is compared against
  // something less than half its price.
  assert.equal(resolveFinish('SICURA UV TEXTURE MATT - HG'), 'TEXTURE_MATT');
  assert.equal(resolveFinish('UV TEXTURE MATT OPL (EC)'), 'TEXTURE_MATT');
  assert.equal(resolveFinish('UV SUPER MATT'), 'SUPER_MATT');
  assert.equal(resolveFinish('SICURA ANP SPL MATT VARNISH'), 'MATT');
});

test('gloss variants are told apart', () => {
  assert.equal(resolveFinish('TEXTURE GLOSS'), 'TEXTURE_GLOSS');
  assert.equal(resolveFinish('SICURA GLOSS TEXTURE T2000'), 'TEXTURE_GLOSS');
  assert.equal(resolveFinish('SICURA UV SPL GLOSS TEXTURE VARNISH'), 'TEXTURE_GLOSS');
  assert.equal(resolveFinish('WATER BASED OPL-HIGH GLOSS'), 'HIGH_GLOSS');
  assert.equal(resolveFinish('GLOSS UV VARNISH MV --AB'), 'GLOSS');
  assert.equal(resolveFinish('WB TOB OPV SOFT TOUCH'), 'SOFT_TOUCH');
});

test('primer and sealer are finishes of their own', () => {
  assert.equal(resolveFinish('AQUATIC ECO SMART PRIMER OP INK'), 'PRIMER');
  assert.equal(resolveFinish('NEUTRAL SEALER AQUATIC OP INK'), 'SEALER');
});

test('slip is recorded but does not decide the finish', () => {
  // "WB OPL - HIGH GLOSS HIGH SLIP" and "WATER BASED OPL-HIGH GLOSS" are both
  // 154. Slip describes the stack, not the finish.
  const name = 'WB OPL - HIGH GLOSS HIGH SLIP';
  assert.equal(resolveFinish(name), 'HIGH_GLOSS');
  assert.equal(resolveCoatingProperty(name), 'HIGH_SLIP');
  assert.equal(resolveCoatingProperty('SICURA GLOSS VARNISH FOIL STAMPING'), 'FOIL_STAMPING');
});

test('a coating named "offset" would not become conventional', () => {
  // Coatings are aqueous or UV and nothing else.
  assert.equal(resolveChemistry('SOME OFFSET VARNISH', 'COATING'), null);
  assert.equal(resolveChemistry('SICURA UV TEXTURE MATT - HG', 'COATING'), 'UV');
  assert.equal(resolveChemistry('WATER BASED OPL-HIGH GLOSS', 'COATING'), 'WATER_BASED');
});

// ── Press chemicals ─────────────────────────────────────────────────────────

test('chemicals compare by what they do', () => {
  assert.equal(resolveChemicalFunction('ECNO WASH KR (20 LTR)'), 'WASH');
  assert.equal(resolveChemicalFunction('DEEP KLEEN SHAMPOO (500 ML)'), 'WASH');
  assert.equal(resolveChemicalFunction('BLANKET VITALISER (1 LTR)'), 'BLANKET_CARE');
  assert.equal(resolveChemicalFunction('PLATE CLEANER GP (5 LTR)'), 'PLATE_CARE');
  assert.equal(resolveChemicalFunction('FOUNT SYSTEM CLEANER (5 LTR)'), 'FOUNT');
  assert.equal(resolveChemicalFunction('UNI GUM (5 LTR)'), 'GUM');
  assert.equal(resolveChemicalFunction('STAR PLUS REPLANISHER (20 LTR)'), 'DEVELOPER');
  assert.equal(resolveChemicalFunction('ANTI SET OFF VERN POWDER'), 'ANTI_SET_OFF');
  assert.equal(resolveChemicalFunction('BENZENE (5 LTR)'), 'SOLVENT');
  assert.equal(resolveChemicalFunction('CALCIUM FIX'), 'ROLLER_CARE');
});

test('chemicals named after nothing at all are still recognised', () => {
  // Boettcher and DIC name their chemicals after no generic word: CLEANFIX,
  // ROL-O-GEL, THERMOTECH, UNIFIN, BLANKET SAVER. The function table is the
  // only thing that knows them, so the material class consults it rather than
  // keeping a second list that would drift out of step with it.
  assert.equal(resolveMaterialClass('CLEANFIX'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('BÖTTCHER PRO ROL-O-PAST'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('ROL O GEL'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('THERMOTECH (5 LTR)'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('UNIFIN (5 LTR)'), 'PRESS_CHEMICAL');
  assert.equal(resolveMaterialClass('BLANKET SAVER (250 ML)'), 'PRESS_CHEMICAL');
});

test('a coating with no stated finish gets its own bucket, not oblivion', () => {
  /*
    DIC's general-purpose aqueous coating says nothing about gloss or matt.
    Refusing it a key drops it from every screen; pooling it with the gloss
    coatings compares it against something it may not be. NO_FINISH does
    neither, and leaves a question the reading layer can put to a person.
  */
  const vague = comparisonKey({ productName: 'AQUATIC ECO SMART OP INK', rateUom: 'KG' });
  assert.equal(vague, 'COATING|WATER_BASED|NO_FINISH|KG');
  assert.notEqual(vague, comparisonKey({ productName: 'WATER BASED OPL-HIGH GLOSS', rateUom: 'KG' }));
});

test('the rows that get no key are exactly the ones worth asking about', () => {
  /*
    Run over both real quotes, 76 of Siegwerk's 82 rows and 35 of Print Sales'
    39 resolve unaided. What is left over is not a gap in the tables — it is
    the set of genuine questions, and each falls into one of three kinds:

      1. a metallic or Pantone ink whose chemistry the sheet never states
      2. a row whose chemistry is in a section header, not the row itself
      3. a term nobody at CDC has confirmed

    None of them should be guessed, and the third kind must not be, so the
    right behaviour is no key and a question — never a plausible default.
  */
  // 1 — chemistry unstated on a metallic.
  assert.equal(comparisonKey({ productName: 'RICH PALE GOLD INK 2025 RL', rateUom: 'KG' }), null);
  assert.equal(comparisonKey({ productName: 'BLENDING MEDIUM FOR SILVER PASTE', rateUom: 'KG' }), null);

  // 2 — "TEXTURE MATT" is a UV coating only because it sits under the heading
  // "DIC UV COATING". Alone it is a finish with no chemistry.
  assert.equal(comparisonKey({ productName: 'TEXTURE MATT', rateUom: 'KG' }), null);
  // With the header supplied, it resolves.
  assert.equal(
    comparisonKey({ productName: 'TEXTURE MATT', chemistry: 'UV', rateUom: 'KG' }),
    'COATING|UV|TEXTURE_MATT|KG',
  );

  // 3 — unconfirmed, and deliberately so.
  assert.equal(comparisonKey({ productName: 'NOVA NOL (20 LTR)', rateUom: 'LTR' }), null);
  assert.deepEqual(unconfirmedInkTokens('NOVA NOL (20 LTR)'), ['NOVA NOL']);
});

test('the same wash from two suppliers compares directly', () => {
  // CDC's own list has Ecno Wash KR at 205; Print Sales quotes 220. Same
  // product, both per litre — the easiest comparison in the whole category, and
  // it has to keep working.
  const mine = { productName: 'ECNO WASH KR (20 LTR)', rateUom: 'LTR' };
  const theirs = { productName: 'ECNO WASH KR (20 LTR)', rateUom: 'LTR' };
  assert.equal(comparisonKey(mine), comparisonKey(theirs));
  assert.equal(comparisonKey(mine), 'PRESS_CHEMICAL|WASH|LTR');
});

// ── Units and packs ─────────────────────────────────────────────────────────

test('the rate unit is read from a section header or a row override', () => {
  assert.equal(resolveRateUom('DIC UV INK RATE PER KGS'), 'KG');
  assert.equal(resolveRateUom('PRESS CHEMICALS RATE PER LTR.'), 'LTR');
  assert.equal(resolveRateUom('BOETTCHER CHEMICALS RATE PER PC'), 'PC');
  assert.equal(resolveRateUom('375.00/KG'), 'KG');
  assert.equal(resolveRateUom('131.00/UNIT'), 'UNIT');
  assert.equal(resolveRateUom('(470.00/m²)'), 'M2');
});

test('the pack size is not the rate unit', () => {
  /*
    ECNO WASH KR (20 LTR) at 220 under "RATE PER LTR." is Rs 220 a litre and
    Rs 4,400 a can — confirmed by CDC. Read as "220 for 20 litres" it becomes
    Rs 11 a litre, twenty times cheaper than the truth, and wins every
    comparison it appears in.
  */
  assert.deepEqual(parsePack('ECNO WASH KR (20 LTR)'), { size: 20, uom: 'LTR', inBaseUom: 20 });
  assert.equal(resolveRateUom('PRESS CHEMICALS RATE PER LTR.'), 'LTR');
});

test('a pack keeps the unit the document printed', () => {
  /*
    ML WAS FOLDED INTO LTR HERE, and the size was not. So "(500 ML)" came back
    as { size: 500, uom: 'LTR' } and the review table offered a reviewer "500
    LTR pack" for a half-litre bottle — a number that is wrong by a thousand and
    reads as perfectly ordinary.

    The size and the unit must agree with each other and with the page. The
    conversion lives beside them in `inBaseUom`, where it is clearly derived and
    can be checked.
  */
  assert.deepEqual(parsePack('DEEP KLEEN SHAMPOO (500 ML)'), { size: 500, uom: 'ML', inBaseUom: 0.5 });
  assert.deepEqual(parsePack('BLANKET SAVER (250 ML)'), { size: 250, uom: 'ML', inBaseUom: 0.25 });
  assert.deepEqual(parsePack('IN/AL5354-45 AQUA MATT (20 KG)'), { size: 20, uom: 'KG', inBaseUom: 20 });

  // And packs in different units stay comparable to each other through the
  // base figure: a 250 ML bottle is a quarter of a litre against a 20 LTR can.
  assert.equal(parsePack('BLANKET SAVER (250 ML)').inBaseUom * 80, parsePack('ECNO WASH KR (20 LTR)').inBaseUom);
});

test('a product with no stated pack has none, rather than a guessed one', () => {
  assert.equal(parsePack('ANTI SET OFF VERN POWDER'), null);
  assert.equal(parsePack('SICURA PLAST 770HS PROCESS CYAN'), null);
});

// ── Makers, families and what nobody has confirmed ──────────────────────────

test('the maker is read even when only a section header names it', () => {
  assert.equal(resolveManufacturer('DIC UV INK'), 'DIC');
  assert.equal(resolveManufacturer('BOETTCHER CHEMICALS'), 'BOETTCHER');
  assert.equal(resolveManufacturer('BÖTTCHER PRO ROL-O-PAST'), 'BOETTCHER');
  assert.equal(resolveManufacturer('CAPRI (DOUBLE COATED THERMAL PLATES)'), 'CAPRI');
  assert.equal(resolveManufacturer('PANTONE PLUS FORMULA GUIDE'), 'PANTONE');
});

test('the maker is not part of the comparison key', () => {
  // Stated as a test because it is the design decision most likely to be
  // undone by accident.
  const a = comparisonKey({ productName: 'RADICURE INTENSE 9000 PRO CYAN', rateUom: 'KG' });
  const b = comparisonKey({ productName: 'SICURA PLAST 770HS PROCESS CYAN', rateUom: 'KG' });
  assert.equal(a, b);
  assert.ok(!a.includes('DIC'));
  assert.ok(!a.includes('SIEGWERK'));
});

test('the family is recognised for the reader, not for matching', () => {
  assert.equal(resolveFamily('SICURA PLAST 770HS PROCESS CYAN'), 'SICURA PLAST 770HS');
  assert.equal(resolveFamily('VEGA SPRINT PRO-YELLOW'), 'VEGA SPRINT');
  assert.equal(resolveFamily('RADICURE INTENSE 9000 PRO MAGENTA'), 'RADICURE INTENSE 9000');
  assert.equal(resolveFamily('AQUATIC ECO SMART OP INK'), 'AQUATIC ECO SMART');
});

test('unconfirmed terms are surfaced, never guessed', () => {
  // Same workflow as paper: the portal asks, somebody who buys ink answers, and
  // the term becomes comparable. A plausible guess would merge two products
  // and nothing in the result would show it happened.
  assert.deepEqual(unconfirmedInkTokens('NOVA NOL (20 LTR)'), ['NOVA NOL']);
  assert.deepEqual(unconfirmedInkTokens('BROWN JEWEL TS (20 LTR)'), ['BROWN JEWEL TS']);
  assert.deepEqual(unconfirmedInkTokens('SICURA PLAST 770HS PROCESS CYAN'), []);
});

test('labels exist for everything a person will see', () => {
  assert.equal(inkLabel('TEXTURE_MATT'), 'Texture matt');
  assert.equal(inkLabel('MIXING_BASE'), 'Mixing base (Pantone)');
  assert.equal(inkLabel('WATER_BASED'), 'Water based / aqueous');
  assert.equal(inkLabel('ANTI_SET_OFF'), 'Anti set-off');
  assert.equal(inkLabel(null), null);
});
