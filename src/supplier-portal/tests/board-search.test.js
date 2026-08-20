/**
 * "Grey back 280 gsm" — the question a buyer actually asks.
 *
 * Built from two real quotes received on the same day, chosen because they are
 * opposites and both have to work:
 *
 *   Sudarshan  a machine-printed price list that prints the columns outright,
 *              with the grade hidden in the last two characters of the product
 *              name and a PRODUCT TYPE column that reads "All"
 *   AKT        a photographed handwritten note with no GSM anywhere on it, and
 *              two prices per board — mill order and ex-stock
 *
 * The point of pairing them: a text search finds neither from the other, and
 * a grade-plus-band lookup finds both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBoardRates, gsmMatches, rowGrade } from '../lib/board-search.js';
import { resolveGrade, resolveSupplyMode, unknownGradeTokens } from '../config/board-grades.js';

/** Sudarshan's recycled board list, verbatim. Rates are per KG. */
const SUDARSHAN = [
  { productName: 'MEHALI ECO GREEN GB', gsmFrom: '230', gsmTo: '249', uom: 'KGS', rate: '56.00' },
  { productName: 'MEHALI ECO GREEN GB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '54.00' },
  { productName: 'MEHALI ECO GREEN GB', gsmFrom: '285', gsmTo: '500', uom: 'KGS', rate: '52.50' },
  { productName: 'MEHALI ECO GREEN LITE GB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '51.50' },
  { productName: 'NIPPON GB PREMIUM', gsmFrom: '250', gsmTo: '500', uom: 'KGS', rate: '42.00' },
  { productName: 'SIDHARTH CLASSIC GB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '51.00' },
  { productName: 'SIDHARTH CYBER GB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '49.00' },
  { productName: 'SIDHARTH NOVA GB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '48.00' },
  { productName: 'VISHAL ALPINE GB', gsmFrom: '285', gsmTo: '319', uom: 'KGS', rate: '48.00' },
  { productName: 'VISHAL OPEL GB', gsmFrom: '230', gsmTo: '249', uom: 'KGS', rate: '48.00' },
  { productName: 'MEHALI ECO WHITE WB', gsmFrom: '230', gsmTo: '249', uom: 'KGS', rate: '59.50' },
  { productName: 'MEHALI ECO WHITE WB', gsmFrom: '250', gsmTo: '284', uom: 'KGS', rate: '57.50' },
];

/** AKT's handwritten note. No GSM on any row. */
const AKT = [
  { productName: 'Devpriya PGB', supplyMode: 'MILL_ORDER', rate: '48.25' },
  { productName: 'Devpriya PGB', supplyMode: 'EX_STOCK', rate: '48.75' },
  { productName: 'Devpriya Premium PGB', supplyMode: 'MILL_ORDER', rate: '49.25' },
  { productName: 'Devpriya Premium PGB', supplyMode: 'EX_STOCK', rate: '49.75' },
  { productName: 'Divya Shakti DSWB', supplyMode: 'EX_STOCK', rate: '55.25' },
  { productName: 'Devpriya White Back', supplyMode: 'MILL_ORDER', rate: '52.25' },
  { productName: 'Devpriya White Back', supplyMode: 'EX_STOCK', rate: '52.75' },
  { productName: 'TNPL FBB', supplyMode: 'MILL_ORDER', productForm: 'REEL', rate: '74' },
  { productName: 'TNPL CBB', supplyMode: 'MILL_ORDER', productForm: 'REEL', rate: '75' },
  { productName: 'TNPL FBB', supplyMode: 'MILL_ORDER', productForm: 'SHEET', rate: '77.5' },
];

// ── The vocabulary ──────────────────────────────────────────────────────────

test('the grade hides in the product name, and is found there', () => {
  // "MEHALI ECO GREEN GB" is a grey back because of its last two characters.
  // No similarity score against "grey back" would ever have discovered that.
  assert.equal(resolveGrade('MEHALI ECO GREEN GB'), 'GREY_BACK');
  assert.equal(resolveGrade('SIDHARTH CYBER GB'), 'GREY_BACK');
  assert.equal(resolveGrade('MEHALI ECO WHITE WB'), 'WHITE_BACK');
});

test('the same grade written in words matches the abbreviation', () => {
  // This is the whole trick. Sudarshan writes "GB"; AKT writes "White Back".
  assert.equal(resolveGrade('Devpriya White Back'), 'WHITE_BACK');
  assert.equal(resolveGrade('grey back'), 'GREY_BACK');
  assert.equal(resolveGrade('DUPLEX GREY BACK 280'), 'GREY_BACK');
});

test('an abbreviation inside a longer word is not a grade', () => {
  // "GB" must not match "GBOARD" or "BIGBEN". Whole words only.
  assert.equal(resolveGrade('GBOARD SPECIAL'), null);
  assert.equal(resolveGrade('WBX FILM'), null);
});

test('"white back" is not read as the words it contains', () => {
  // Longest synonym first, or "WHITE BACK" could be lost to a shorter match.
  assert.equal(resolveGrade('MEHALI ECO WHITE WB'), 'WHITE_BACK');
  assert.equal(resolveGrade('White Back'), 'WHITE_BACK');
});

test('a confirmed abbreviation compares against the spelled-out grade', () => {
  // PGB is Prime Grey Back and DSWB is Divya Shakti White Back, both confirmed
  // by CDC. Before that they resolved to null and were reported as unknown —
  // which is the workflow: the portal surfaces a word it does not know, a
  // person who buys board says what it means, and it becomes searchable.
  assert.equal(resolveGrade('Devpriya PGB'), 'GREY_BACK');
  assert.equal(resolveGrade('Premium PGB'), 'GREY_BACK');
  assert.equal(resolveGrade('DSWB'), 'WHITE_BACK');
  assert.deepEqual(unknownGradeTokens('Devpriya PGB'), []);
});

test('a mill prefix welded onto a grade does not stop it matching', () => {
  // "DSWB" carries Divya Shakti's initials; "MEHALI ECO WHITE WB" carries a
  // brand. Both are white backs, and if they did not resolve to the same
  // canonical value they would never be compared against each other.
  assert.equal(resolveGrade('DSWB'), resolveGrade('MEHALI ECO WHITE WB'));
});

test('an abbreviation still awaiting confirmation is reported, never guessed', () => {
  // DCB is priced a rupee below PGB on the same note, so it is plausibly a
  // grey back variant. Plausible is not good enough for a field that decides
  // which rates get compared: a wrong mapping merges two boards into one
  // comparison and nothing in the result shows it happened.
  assert.equal(resolveGrade('Devpriya DCB'), null);
  assert.deepEqual(unknownGradeTokens('Devpriya DCB'), ['DCB']);
});

test('a recognised grade reports no unknowns', () => {
  assert.deepEqual(unknownGradeTokens('MEHALI ECO GREEN GB'), []);
});

test('mill order and ex-stock are told apart', () => {
  assert.equal(resolveSupplyMode('Devpriya PGB (Mill order)'), 'MILL_ORDER');
  assert.equal(resolveSupplyMode('from stock'), 'EX_STOCK');
  assert.equal(resolveSupplyMode('DO BASED EX-STOCK PRICE LIST'), 'EX_STOCK');
  assert.equal(resolveSupplyMode('nothing stated here'), null);
});

// ── GSM bands ───────────────────────────────────────────────────────────────

test('280 falls in 250-284 and not in 230-249', () => {
  assert.equal(gsmMatches(280, { gsmFrom: '250', gsmTo: '284' }), true);
  assert.equal(gsmMatches(280, { gsmFrom: '230', gsmTo: '249' }), false);
  assert.equal(gsmMatches(280, { gsmFrom: '285', gsmTo: '500' }), false);
});

test('an open-topped band means "and above"', () => {
  assert.equal(gsmMatches(600, { gsmFrom: '285', gsmTo: null }), true);
  assert.equal(gsmMatches(200, { gsmFrom: '285', gsmTo: null }), false);
});

test('a row with no band matches every GSM', () => {
  // AKT's note quotes a rate for the grade at large. Dropping it from a 280
  // gsm search would hide a real price that genuinely applies.
  assert.equal(gsmMatches(280, {}), true);
  assert.equal(gsmMatches(280, { gsmFrom: null, gsmTo: null }), true);
});

// ── The question itself ─────────────────────────────────────────────────────

test('"grey back 280 gsm" returns the right seven rows, cheapest first', () => {
  const hits = searchBoardRates(SUDARSHAN, { grade: 'grey back', gsm: 280 });

  assert.deepEqual(
    hits.map((h) => `${h.productName} ${h.rate}`),
    [
      'NIPPON GB PREMIUM 42.00',
      'SIDHARTH NOVA GB 48.00',
      'SIDHARTH CYBER GB 49.00',
      'SIDHARTH CLASSIC GB 51.00',
      'MEHALI ECO GREEN LITE GB 51.50',
      'MEHALI ECO GREEN GB 54.00',
    ],
  );
});

test('the white backs are excluded, and so are the wrong bands', () => {
  const hits = searchBoardRates(SUDARSHAN, { grade: 'GB', gsm: 280 });
  assert.ok(hits.every((h) => h.grade === 'GREY_BACK'), 'no white back leaks in');
  assert.ok(!hits.some((h) => h.productName === 'VISHAL OPEL GB'), '230-249 does not contain 280');
  assert.ok(!hits.some((h) => h.productName === 'VISHAL ALPINE GB'), '285-319 does not contain 280');
});

test('the abbreviation and the words find the same rows', () => {
  const byWords = searchBoardRates(SUDARSHAN, { grade: 'grey back', gsm: 280 });
  const byAbbrev = searchBoardRates(SUDARSHAN, { grade: 'GB', gsm: 280 });
  assert.deepEqual(byWords.map((h) => h.rate), byAbbrev.map((h) => h.rate));
});

test('an unbanded handwritten rate is returned, and says it was unbanded', () => {
  // The AKT note has no GSM at all. Its white back rate still answers a
  // "white back 280 gsm" question — flagged, so the buyer knows the quote did
  // not narrow it rather than assuming it was priced for 280 specifically.
  const hits = searchBoardRates([...SUDARSHAN, ...AKT], { grade: 'white back', gsm: 280 });

  const akt = hits.filter((h) => h.productName.startsWith('Devpriya'));
  assert.equal(akt.length, 2, 'both mill order and ex-stock');
  assert.ok(akt.every((h) => h.banded === false));

  const sudarshan = hits.find((h) => h.productName === 'MEHALI ECO WHITE WB');
  assert.equal(sudarshan.banded, true);
  assert.equal(sudarshan.rate, '57.50');
});

test('mill order and ex-stock are separate answers, not one overwriting the other', () => {
  // Without a supply mode these two rows are the same product at two prices,
  // and which one survives depends on the order they happened to be read in.
  const mill = searchBoardRates(AKT, { grade: 'white back', supplyMode: 'MILL_ORDER' });
  const stock = searchBoardRates(AKT, { grade: 'white back', supplyMode: 'EX_STOCK' });
  assert.equal(mill[0].rate, '52.25');
  assert.equal(stock[0].rate, '52.75');
});

test('form separates a reel price from a sheet price', () => {
  const reel = searchBoardRates(AKT, { grade: 'FBB', form: 'REEL' });
  const sheet = searchBoardRates(AKT, { grade: 'FBB', form: 'SHEET' });
  assert.equal(reel[0].rate, '74');
  assert.equal(sheet[0].rate, '77.5');
});

test('a grey back search now spans both suppliers, printed and handwritten', () => {
  // The payoff. Sudarshan writes "GB" in a machine-generated price list;
  // AKT writes "PGB" by hand on a photographed note. Nothing in those two
  // strings is shared, and before the vocabulary existed no search could
  // return both.
  const hits = searchBoardRates([...SUDARSHAN, ...AKT], { grade: 'grey back', gsm: 280 });

  assert.ok(hits.some((h) => h.productName === 'NIPPON GB PREMIUM'), 'Sudarshan');
  assert.ok(hits.some((h) => h.productName === 'Devpriya PGB'), 'AKT');
  assert.ok(hits.every((h) => h.grade === 'GREY_BACK'));

  // Cheapest first across both, and the handwritten rows say they were not
  // banded so a buyer knows the note never mentioned 280 gsm.
  assert.equal(hits[0].rate, '42.00');
  assert.equal(hits.find((h) => h.productName === 'Devpriya PGB').banded, false);
});

test('a grade with nothing on file returns nothing, not everything', () => {
  assert.deepEqual(searchBoardRates(SUDARSHAN, { grade: 'kraft', gsm: 280 }), []);
});

test('no GSM given returns every band of the grade', () => {
  const hits = searchBoardRates(SUDARSHAN, { grade: 'grey back' });
  assert.equal(hits.length, 10, 'all ten grey back rows, across every band');
  assert.equal(hits[0].rate, '42.00', 'still cheapest first');
});

test('a row whose rate cannot be read sorts last, not first', () => {
  // A missing price is not the best price. Sorting it to the top would put a
  // blank at the head of a "who is cheapest" list.
  const rows = [...SUDARSHAN, { productName: 'MYSTERY GB', gsmFrom: '250', gsmTo: '284', rate: null }];
  const hits = searchBoardRates(rows, { grade: 'grey back', gsm: 280 });
  assert.equal(hits[hits.length - 1].productName, 'MYSTERY GB');
});

test('rows carry a label a person can read', () => {
  const [first] = searchBoardRates(SUDARSHAN, { grade: 'grey back', gsm: 280 });
  assert.equal(first.gradeLabel, 'Grey back');
});

test('rowGrade prefers an explicit grade field over the name', () => {
  assert.equal(rowGrade({ grade: 'FBB', productName: 'SOMETHING GB' }), 'FBB');
  assert.equal(rowGrade({ productName: 'SOMETHING GB' }), 'GREY_BACK');
});
