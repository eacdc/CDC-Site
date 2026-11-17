/**
 * Paper trade names typed from CDC's own bills, from SKM's July 2026 list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBilledTypes } from '../services/paper/billed-types.js';
import { resolvePaperType } from '../config/paper-vocabulary.js';

const bill = (description, itemName) => ({ description, itemName });
const BILLS = [
  bill('JK ELEKTRA MAPLITHO 068JKELEKT-063.5*091.0', 'Maplitho, 68 GSM, JK, NONE, 635 X 915 MM'),
  bill('JK ELEKTRA 64 GSM ( 58.5X91) 17 KG', 'Maplitho, 64 GSM, JK, NONE, 585 X 915 MM'),
  bill('C2S ART PAPER 21 x 250 = 5250 Sheet', 'Gloss Art, 130 GSM, JK, NONE, 635 X 915 MM'),
  bill('ART PAPER 90 GSM', 'Gloss Art, 90 GSM, JK, NONE, 585 X 915 MM'),
  bill('JK COAT ART PAPER C2S MATT 150 GSM 51*76', 'Matte Art, 150 GSM, JK, NONE, 510 X 760 MM'),
  bill('myLeatherlike Classic White 120 Gsm', 'Leatherlike White Classic, 120 GSM, Cordenons, NONE, 720 X 1020 MM'),
  bill('WESCO CLASSIC DUPLEX 300', 'Grey Back, 300 GSM, Wesco, NONE, 635 X 965 MM'),
  bill('WRITECHOICE SS (ANDHRA)', 'Maplitho, 70 GSM, Andhra, NONE, 585 X 915 MM'),
];
const line = (productName, brand = null) => ({ lineNo: 1, productName, brand, paperType: null, paperTypeBasis: null });
const typeOf = (l) => applyBilledTypes({ lines: [l] }, BILLS).payload.lines[0];

test('a trade name the bills agree on is typed, and says so', () => {
  const out = typeOf(line('JK ELEKTRA', 'ELEKTRA'));
  assert.equal(out.paperType, 'MAPLITHO');
  assert.equal(out.paperTypeBasis, 'BILLED');
  assert.equal(out.paperTypeBilledAs, 'JK ELEKTRA');
});

test('a disagreement another word explains is not a disagreement', () => {
  // The matte bill says MATT; the bills where nothing else decided were gloss.
  assert.equal(typeOf(line('KINMARI IMPORTED ART PAPER', 'KINMARI')).paperType, 'GLOSS_ART');
});

test('a name the bills disagree on stays a question', () => {
  assert.equal(typeOf(line('WESCO CLASSIC', 'CLASSIC')).paperType, null);
});

test('one bill is not enough, and a mill is not a name', () => {
  assert.equal(typeOf(line('ANDHRA WRITECHOICE SS', 'WRITECHOICE')).paperType, null);
  assert.equal(typeOf(line('JK')).paperType, null);
});

test('a type already on the line is never replaced', () => {
  const out = typeOf({ ...line('JK ELEKTRA'), paperType: 'CHROMO', paperTypeBasis: 'TAUGHT' });
  assert.equal(out.paperType, 'CHROMO');
});

test('poster is a type of its own', () => {
  assert.equal(resolvePaperType('ANDHRA DLX POSTER'), 'POSTER');
  assert.equal(resolvePaperType('WESCO COLOUR POSTER'), 'POSTER');
  assert.equal(resolvePaperType('Poster'), 'POSTER');
});
