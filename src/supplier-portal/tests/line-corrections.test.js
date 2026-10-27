/**
 * Review corrections keep what the page did not send. KV/26-27/19508's GSM
 * and size were blanked by "Match to POs", and nothing matched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { correctedLine } from '../services/line-corrections.js';

const FIELDS = ['lineNo', 'description', 'hsn', 'gsm', 'size', 'unitWt', 'bundles', 'totalUnits', 'qty', 'stockQty', 'uom', 'rate', 'amount', 'poRef'];
const READ = { lineNo: 1, description: 'NI KOTE PAPER', hsn: '48101900', gsm: 170, size: '20X30', unitWt: 16.46, totalUnits: 123, qty: 2024.58, uom: 'KGS', rate: 78, amount: 157917.24 };

test('a field the page did not send keeps what the reader found', () => {
  const sent = { lineNo: 1, description: 'HI KOTE PAPER', hsn: '48101900', qty: 2024.58, uom: 'KGS', rate: 78, amount: 157917.24, poRef: null };
  const out = correctedLine(sent, READ, FIELDS);
  assert.equal(out.description, 'HI KOTE PAPER', 'a correction is taken');
  assert.equal(out.gsm, 170);
  assert.equal(out.size, '20X30');
  assert.equal(out.unitWt, 16.46);
  assert.equal(out.totalUnits, 123);
});

test('a field sent empty is cleared - that is a correction too', () => {
  const out = correctedLine({ lineNo: 1, gsm: null, size: '' }, READ, FIELDS);
  assert.equal(out.gsm, null);
  assert.equal(out.size, '');
});
