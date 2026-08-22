/**
 * Answering "grey back 280 gsm".
 *
 * The question a buyer actually asks, and the one that looked impossible while
 * a board line was a product name. It is not a text search and never was: it is
 * a lookup over two fields, a grade and a number that has to fall inside a
 * band. Both come off the document.
 *
 * The two quotes this was built against are opposites, and both have to work:
 *
 *   Sudarshan's price list prints the columns outright —
 *     PRODUCT | GSM FROM | GSM TO | TYPE | CLASS | FORM | UNIT | FINAL PRICE
 *     "MEHALI ECO GREEN GB   230  249  ...  KGS  56.00"
 *
 *   AKT's is a photographed handwritten note with no GSM anywhere —
 *     "Devpriya PGB (Mill order) -> 48.25 / from stock 48.75"
 *
 * A row with no band is not a row that fails to match 280 gsm. It is a rate
 * quoted for the grade at large, and dropping it would hide a real price. It
 * matches, and says it was not banded.
 */

import { resolvePaperType as resolveGrade, paperTypeLabel as gradeLabel } from '../config/paper-vocabulary.js';

/**
 * Does `gsm` fall inside this row's band?
 *
 * Three cases, and the third is the one that matters:
 *   230-249  contains 240, not 280
 *   285-     "285 and above", an open top
 *   no band  applies to every GSM, because the document never narrowed it
 */
export function gsmMatches(gsm, { gsmFrom, gsmTo } = {}) {
  const wanted = num(gsm);
  if (wanted == null) return true; // no GSM asked for: everything matches

  const from = num(gsmFrom);
  const to = num(gsmTo);

  if (from == null && to == null) return true;
  if (from != null && wanted < from) return false;
  if (to != null && wanted > to) return false;
  return true;
}

/**
 * A number, or null for anything that is not one.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a missing band read
 * as a band of zero: "285 and above" became "285 to 0" and matched nothing,
 * and an unbanded handwritten rate was excluded from every search. An absent
 * value has to be absent, not zero.
 */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when this row's band actually constrained anything. */
export function isBanded(row) {
  return num(row?.gsmFrom) != null || num(row?.gsmTo) != null;
}

/**
 * The grade of a row, from its own field or read out of its product name.
 *
 * Falling back to the name is not a convenience: on Sudarshan's list the grade
 * lives in the last two characters of "MEHALI ECO GREEN GB", and the PRODUCT
 * TYPE column reads "All".
 */
export function rowGrade(row) {
  return resolveGrade(row?.grade)
    || resolveGrade(row?.productName)
    || resolveGrade(row?.shade)
    || null;
}

/**
 * Board rates matching a query, cheapest first.
 *
 * @param {Array} rows      quote lines, each with a rate and whatever specs were read
 * @param {Object} query
 * @param {string} [query.grade]  canonical or any known spelling — "GB", "grey back"
 * @param {number} [query.gsm]    a single GSM, e.g. 280
 * @param {string} [query.form]   REEL or SHEET
 * @param {string} [query.mill]
 * @param {string} [query.plant]
 * @param {string} [query.supplyMode]  MILL_ORDER or EX_STOCK
 * @returns {Array} matching rows, each annotated with grade, gradeLabel and banded
 */
export function searchBoardRates(rows = [], query = {}) {
  const wantGrade = query.grade ? (resolveGrade(query.grade) || query.grade.toUpperCase()) : null;
  const wantForm = query.form ? String(query.form).toUpperCase() : null;

  return rows
    .map((row) => ({ row, grade: rowGrade(row) }))
    .filter(({ row, grade }) => {
      if (wantGrade && grade !== wantGrade) return false;
      if (!gsmMatches(query.gsm, row)) return false;
      if (wantForm && String(row.productForm || '').toUpperCase() !== wantForm) return false;
      if (query.mill && !sameish(row.mill, query.mill)) return false;
      if (query.plant && !sameish(row.plant, query.plant)) return false;
      if (query.supplyMode && row.supplyMode !== query.supplyMode) return false;
      return true;
    })
    .map(({ row, grade }) => ({
      ...row,
      grade,
      gradeLabel: gradeLabel(grade),
      /*
        Whether the rate was quoted for this GSM specifically, or for the grade
        at large. A buyer comparing 42.00 against 48.25 needs to know that the
        first was banded 250-500 and the second was a handwritten note with no
        GSM on it at all — they are not quite the same claim.
      */
      banded: isBanded(row),
      rateValue: Number(String(row.rate ?? '').replace(/[^0-9.]/g, '')) || null,
    }))
    // Cheapest first, but a row with no readable rate sorts last rather than
    // to the top as a zero — a missing price is not the best price.
    .sort((a, b) => {
      if (a.rateValue == null) return 1;
      if (b.rateValue == null) return -1;
      return a.rateValue - b.rateValue;
    });
}

function sameish(a, b) {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}
