/**
 * Worksheet extraction.
 *
 * A spreadsheet is read as a grid rather than as an image: the numbers are
 * already exact, and putting them through a vision model would only introduce
 * transcription risk.
 *
 * The Siegwerk workbook is the shape this has to handle. It carries five price
 * columns — Price Before Increase, First Increase Taken, Current Price,
 * Proposed 2nd Increase, Price After Both — and five product codes appearing
 * several times at different prices, which are historical price points for one
 * code rather than five products.
 *
 * Neither of those can be resolved by a rule, so this module does not try. It
 * detects them, surfaces them, and blocks approval (EXT007) until a human
 * nominates the live column.
 */

import * as XLSX from 'xlsx';

/** Header cells that look like a price column. */
const PRICE_HEADER = /\b(price|rate|amount|mrp|cost)\b/i;
/** Header cells that identify the product. */
const NAME_HEADER = /\b(product|item|description|material|particular|name)\b/i;
const CODE_HEADER = /\b(code|sku|article|material\s*no|part)\b/i;
const UOM_HEADER = /\b(uom|unit|per|pack)\b/i;
const GSM_FROM_HEADER = /gsm\s*(from|min)|from\s*gsm/i;
const GSM_TO_HEADER = /gsm\s*(to|max)|to\s*gsm/i;
const FORM_HEADER = /\b(form|type)\b/i;

/**
 * Read a workbook buffer into a normalised extraction.
 *
 * @param {Buffer} buffer
 * @param {Object} opts
 * @param {string} [opts.priceColumn]  header text the human nominated
 * @param {string} [opts.sheetName]
 * @returns {{sheets: string[], sheetName: string, priceColumns: string[],
 *            needsColumnChoice: boolean, duplicateCodes: Array, lines: Array}}
 */
export function extractWorkbook(buffer, { priceColumn = null, sheetName = null } = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = workbook.SheetNames;
  const chosenSheet = sheetName && sheets.includes(sheetName) ? sheetName : sheets[0];
  if (!chosenSheet) {
    return { sheets: [], sheetName: null, priceColumns: [], needsColumnChoice: false, duplicateCodes: [], lines: [] };
  }

  // Blank rows are kept so a row index still maps to the row number a
  // reviewer sees in Excel. Dropping them makes `sourceRow` point at the
  // wrong line, which is worse than useless when someone is checking a figure.
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[chosenSheet], {
    header: 1, blankrows: true, defval: null, raw: false,
  });

  const headerRowIndex = findHeaderRow(grid);
  if (headerRowIndex < 0) {
    return { sheets, sheetName: chosenSheet, priceColumns: [], needsColumnChoice: false, duplicateCodes: [], lines: [] };
  }

  const headers = (grid[headerRowIndex] || []).map((h) => String(h ?? '').trim());
  const columns = mapColumns(headers, grid, headerRowIndex);
  const priceColumns = columns.price.map((i) => headers[i]).filter(Boolean);

  // More than one price column means the workbook is a price-change history,
  // not a price list. Which column is live cannot be inferred from the sheet.
  const needsColumnChoice = priceColumns.length > 1 && !priceColumn;
  const priceIndex = resolvePriceIndex(columns.price, headers, priceColumn);

  const lines = [];
  for (let r = headerRowIndex + 1; r < grid.length; r += 1) {
    const row = grid[r] || [];
    const productName = cell(row, columns.name);
    const productCode = cell(row, columns.code);
    if (!productName && !productCode) continue;

    const rate = priceIndex === null ? null : cell(row, priceIndex);
    if (!rate && !productName) continue;

    // Every other price column is carried as a note, so a reviewer comparing
    // against last-paid can see the whole ladder without opening the file.
    const otherPrices = columns.price
      .filter((i) => i !== priceIndex)
      .map((i) => `${headers[i]}: ${cell(row, i) ?? '—'}`)
      .filter(Boolean);

    lines.push({
      lineNo: lines.length + 1,
      productName: productName || null,
      productCode: productCode || null,
      packSize: cell(row, columns.uom) || null,
      uom: cell(row, columns.uom) || null,
      rate: rate === null ? null : String(rate),
      gsmFrom: cell(row, columns.gsmFrom) || null,
      gsmTo: cell(row, columns.gsmTo) || null,
      productForm: cell(row, columns.form) || null,
      width: null,
      micron: null,
      gstNote: null,
      notes: otherPrices.length ? otherPrices.join(' | ') : null,
      text: row.map((c) => (c === null ? '' : String(c))).join(' | ').trim(),
      confidence: needsColumnChoice ? 0.3 : 0.95,
      sourceRow: r + 1,
    });
  }

  return {
    sheets,
    sheetName: chosenSheet,
    priceColumns,
    needsColumnChoice,
    nominatedColumn: priceIndex === null ? null : headers[priceIndex],
    duplicateCodes: findDuplicateCodes(lines),
    lines,
  };
}

/**
 * The header row is the first row where at least two columns look like
 * headers. Worksheets routinely open with a title row, a blank row and a
 * "w.e.f." line before the table starts, so row 0 is rarely it.
 */
function findHeaderRow(grid) {
  for (let r = 0; r < Math.min(grid.length, 25); r += 1) {
    const row = (grid[r] || []).map((c) => String(c ?? ''));
    const hits = row.filter((c) => PRICE_HEADER.test(c) || NAME_HEADER.test(c) || CODE_HEADER.test(c)).length;
    if (hits >= 2) return r;
  }
  return -1;
}

function mapColumns(headers, grid = [], headerRowIndex = 0) {
  const price = [];
  const unclassified = [];
  let name = null; let code = null; let uom = null;
  let gsmFrom = null; let gsmTo = null; let form = null;

  headers.forEach((header, i) => {
    if (!header) return;
    if (GSM_FROM_HEADER.test(header)) { gsmFrom = i; return; }
    if (GSM_TO_HEADER.test(header)) { gsmTo = i; return; }
    if (PRICE_HEADER.test(header)) { price.push(i); return; }
    if (code === null && CODE_HEADER.test(header)) { code = i; return; }
    if (name === null && NAME_HEADER.test(header)) { name = i; return; }
    if (uom === null && UOM_HEADER.test(header)) { uom = i; return; }
    if (form === null && FORM_HEADER.test(header)) { form = i; return; }
    unclassified.push(i);
  });

  /**
   * A price column need not say "price".
   *
   * The Siegwerk workbook has "First Increase Taken" and "Proposed 2nd
   * Increase" sitting between columns that do. Missing them would drop two
   * price points from a ladder a reviewer needs to see whole, and — worse —
   * would make a five-column workbook look like a three-column one, which
   * changes what the human is asked to nominate.
   *
   * So a leftover column also counts as a price column when its values are
   * overwhelmingly numeric. Identifier columns are excluded by the same test:
   * a product code like `71-000022-5.2690` does not parse as a number.
   */
  for (const i of unclassified) {
    if (looksNumeric(grid, headerRowIndex, i)) price.push(i);
  }
  price.sort((a, b) => a - b);

  return { price, name, code, uom, gsmFrom, gsmTo, form };
}

/** Are this column's data cells predominantly plain numbers? */
function looksNumeric(grid, headerRowIndex, columnIndex, minRows = 2) {
  let populated = 0;
  let numeric = 0;

  for (let r = headerRowIndex + 1; r < grid.length; r += 1) {
    const value = grid[r]?.[columnIndex];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    populated += 1;
    const text = String(value).trim().replace(/(?<=\d),(?=\d)/g, '');
    if (/^-?\d+(\.\d+)?$/.test(text)) numeric += 1;
  }

  if (populated < minRows) return false;
  return numeric / populated >= 0.8;
}

/**
 * Which price column to read.
 *
 * With one price column there is no choice to make. With several, the human's
 * nomination is required — no heuristic picks it, because "Current Price" is
 * as often stale as "Proposed" is live, and the workbook itself is the
 * evidence a reviewer needs to decide.
 */
function resolvePriceIndex(priceIndexes, headers, nominated) {
  if (!priceIndexes.length) return null;
  if (nominated) {
    const found = priceIndexes.find(
      (i) => headers[i] && headers[i].trim().toLowerCase() === String(nominated).trim().toLowerCase(),
    );
    if (found !== undefined) return found;
  }
  if (priceIndexes.length === 1) return priceIndexes[0];
  return null;
}

/**
 * Product codes appearing more than once. In the Siegwerk workbook these are
 * historical price points for a single code — Sicura 770 HS Violet appears at
 * 3082, 2600 and 2400, and CDC last paid 2590. The live rate is the one
 * closest to last-paid, but that comparison belongs to the reviewer with the
 * ERP figure in front of them, so this only reports the collision.
 */
function findDuplicateCodes(lines) {
  const byCode = new Map();
  for (const line of lines) {
    if (!line.productCode) continue;
    const k = String(line.productCode).trim().toUpperCase();
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push({ lineNo: line.lineNo, rate: line.rate, name: line.productName });
  }
  return [...byCode.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([code, rows]) => ({ productCode: code, occurrences: rows }));
}

function cell(row, index) {
  if (index === null || index === undefined) return null;
  const value = row[index];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}
