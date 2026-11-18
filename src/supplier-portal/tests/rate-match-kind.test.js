/**
 * A rate match is a coincidence when the names say different kinds of thing.
 * Each case is from CDC's first scheduled run (Siegwerk AHM, Print Sales).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { differentKind, corroborated } from '../services/matching.js';

test('a UV coating is not an aqueous one, however alike the rest of the name', () => {
  assert.equal(differentKind('TEXTURE MATT (DIC UV COATING)', 'Aq, NEW V POLY EMBOSS WHITE TEXTURE MATT 1018'), true);
  assert.equal(differentKind('UV TEXTURE MATT', 'Water based texture matt'), true);
  assert.equal(differentKind('GLOSS UV VARNISH MV --AB', 'UV, Gloss UV Varnish'), false);
});

test('a different series of the same brand is a different product', () => {
  assert.equal(differentKind('VEGA PRIME PROCESS BLACK PASTE 706', 'INK, Vega pro rich HG Black'), true);
  assert.equal(differentKind('VEGA ABSOLUTE BLACK PASTE', 'INK, Vega pro rich HG Black'), true);
});

test('names that only differ in colour, number or generic words are not told apart here', () => {
  assert.equal(differentKind('SICURA PLAST 770 HS VIOLET', 'Ink kitchen, Siegwork-Sicura-770 Hs-Violet(UV)'), false);
  assert.equal(differentKind('PROCESS BLACK', 'INK, Process Ink-Black'), false);
  assert.equal(differentKind('VEGA BLACK', 'INK, Vega Cyan'), false); // colours are the colour check's job
  assert.equal(differentKind('BLANKET VITALISER (1 LTR)', 'Blanket Vitalizer'), false); // spelling
  assert.equal(differentKind('SIDHARTH CRYSTAL WB', 'White Back, 350 GSM, SIDHARTH, NONE, 585 X 915 MM'), false);
});

test('the rate tier drops a candidate of a different kind', () => {
  const kept = corroborated([
    { ItemID: 6074, ItemName: 'INK, Vega pro rich HG Black' },
    { ItemID: 5943, ItemName: 'Ink kitchen, Siegwerk-706-L-Black' },
  ], 'VEGA PRIME PROCESS BLACK PASTE 706');
  assert.deepEqual(kept.map((c) => c.ItemID).filter((id) => id === 6074), []);
});
