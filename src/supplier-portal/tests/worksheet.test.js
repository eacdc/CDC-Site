/**
 * Worksheet extraction tests.
 *
 * Modelled on the Siegwerk workbook: five price columns and product codes
 * appearing several times at different prices. Neither can be resolved by a
 * rule, so what is tested is that both are detected and surfaced rather than
 * silently decided.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { extractWorkbook } from '../services/extraction/xlsx-extract.js';

/** Build an in-memory workbook from a grid. */
function workbook(rows, sheetName = 'Price List') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const SIEGWERK_LIKE = [
  ['SIEGWERK INDIA PVT LTD'],
  ['Price revision w.e.f. 01-Aug-2026'],
  [],
  ['Product Code', 'Product Description', 'UOM', 'Price Before Increase', 'First Increase Taken', 'Current Price', 'Proposed 2nd Increase', 'Price After Both'],
  ['71-000022-5.2690', 'SICURA PLAST 770 HS TRANS. EXTENDER', 'KG', '3082', '2600', '2400', '2500', '2600'],
  ['71-000031-1.1000', 'SICURA PLAST 770 HS VIOLET', 'KG', '3082', '2600', '2400', '2500', '2600'],
  ['71-000031-1.1000', 'SICURA PLAST 770 HS VIOLET', 'KG', '2590', '2590', '2590', '2650', '2650'],
  ['71-000044-2.3000', 'VEGA SPRINT BLACK', 'KG', '290', '275', '275', '285', '285'],
];

test('a multi-column worksheet refuses to guess the live price column', () => {
  const result = extractWorkbook(workbook(SIEGWERK_LIKE));
  assert.equal(result.needsColumnChoice, true);
  assert.ok(result.priceColumns.length >= 4, `found ${result.priceColumns.length} price columns`);
  assert.ok(result.priceColumns.includes('Current Price'));
  assert.equal(result.nominatedColumn, null, 'no column may be picked automatically');
});

test('nominating a column resolves the extraction', () => {
  const result = extractWorkbook(workbook(SIEGWERK_LIKE), { priceColumn: 'Current Price' });
  assert.equal(result.needsColumnChoice, false);
  assert.equal(result.nominatedColumn, 'Current Price');

  const extender = result.lines.find((l) => l.productCode === '71-000022-5.2690');
  assert.equal(extender.rate, '2400');
  assert.equal(extender.productName, 'SICURA PLAST 770 HS TRANS. EXTENDER');
});

test('the other price columns are carried as notes, not discarded', () => {
  // A reviewer comparing against last-paid needs the whole ladder without
  // having to open the file.
  const result = extractWorkbook(workbook(SIEGWERK_LIKE), { priceColumn: 'Current Price' });
  const line = result.lines[0];
  assert.match(line.notes, /Price Before Increase: 3082/);
  assert.match(line.notes, /Proposed 2nd Increase: 2500/);
});

test('duplicate product codes are surfaced rather than deduplicated', () => {
  // These are historical price points for one code. Which is live is decided
  // by comparison with CDC's last-paid rate, by a human.
  const result = extractWorkbook(workbook(SIEGWERK_LIKE), { priceColumn: 'Current Price' });
  const duplicate = result.duplicateCodes.find((d) => d.productCode === '71-000031-1.1000');
  assert.ok(duplicate, 'the repeated code should be reported');
  assert.equal(duplicate.occurrences.length, 2);
  assert.deepEqual(duplicate.occurrences.map((o) => o.rate).sort(), ['2400', '2590']);
  assert.equal(result.lines.filter((l) => l.productCode === '71-000031-1.1000').length, 2,
    'both rows are kept — dropping one would hide the ambiguity');
});

test('a header row below title rows is still found', () => {
  const result = extractWorkbook(workbook(SIEGWERK_LIKE), { priceColumn: 'Current Price' });
  assert.equal(result.lines.length, 4, 'the three title/blank rows are not data');
  assert.equal(result.lines[0].sourceRow, 5, 'source rows point back into the file');
});

test('a single-price worksheet needs no nomination', () => {
  const simple = [
    ['Item Description', 'UOM', 'Rate'],
    ['GUM POWDER (CORRUGATION MACHINE)', 'KG', '48'],
    ['Sewing Thread', 'KG', '410'],
  ];
  const result = extractWorkbook(workbook(simple));
  assert.equal(result.needsColumnChoice, false);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].rate, '48');
});

test('GSM band columns are picked up separately from the price', () => {
  const banded = [
    ['Product', 'GSM From', 'GSM To', 'Product Form', 'Rate'],
    ['Maplitho', '54', '55', 'RBD', '74342'],
    ['Maplitho', '90', '', 'RLS', '72000'],
  ];
  const result = extractWorkbook(workbook(banded));
  assert.equal(result.lines[0].gsmFrom, '54');
  assert.equal(result.lines[0].gsmTo, '55');
  assert.equal(result.lines[0].productForm, 'RBD');
  assert.equal(result.lines[0].rate, '74342');
});

test('an unreadable sheet returns no lines rather than inventing them', () => {
  const junk = [['just'], ['some'], ['text']];
  const result = extractWorkbook(workbook(junk));
  assert.deepEqual(result.lines, []);
});
