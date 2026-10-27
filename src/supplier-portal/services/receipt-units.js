/**
 * A GRN line's two quantities, as the ERP's GRN screen shows them: Receipt
 * Qty (P.U.) - what was ordered and is billed - and Receipt Qty (S.U.) - what
 * goes into stock. The ERP writes the first to ChallanWeight and the second
 * to ChallanQuantity / ReceiptQuantity.
 *
 * They differ only for paper bought by the kilo and stocked by the sheet: 1,539
 * of 5,614 GRN lines from July to October 2026, every one of them KG -> Sheet.
 * There the ERP links them by the item's weight per packing:
 *
 *   kg = sheets x WtPerPacking / UnitPerPacking
 *
 * REC04731_26_27, P00026: 1,500 sheets x 9.87743 / 100 = 148.161 kg. Every
 * other pair of units (PCS -> NOS included) carries the same number in both.
 */

const SHEET_UNITS = new Set(['SHEET', 'SHEETS']);

const unit = (u) => String(u ?? '').trim().toUpperCase();
const finite = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Per-unit kg when this line's units are kg bought, sheets stocked; else null. */
export function kgPerSheet({ purchaseUnit, stockUnit, wtPerPacking, unitPerPacking } = {}) {
  if (unit(purchaseUnit) !== 'KG' || !SHEET_UNITS.has(unit(stockUnit))) return null;
  const wt = finite(wtPerPacking);
  const per = finite(unitPerPacking);
  return wt > 0 && per > 0 ? wt / per : null;
}

const round = (v, places) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** Sheets from kg. Whole sheets, as the ERP stores them. */
export function stockQtyFromPurchase(qty, units) {
  const q = finite(qty);
  if (q === null) return null;
  const perSheet = kgPerSheet(units);
  return perSheet ? Math.round(q / perSheet) : q;
}

/** Kg from sheets, to three places, as the ERP stores ChallanWeight. */
export function purchaseQtyFromStock(stockQty, units) {
  const s = finite(stockQty);
  if (s === null) return null;
  const perSheet = kgPerSheet(units);
  return perSheet ? round(s * perSheet, 3) : s;
}

/**
 * The stock quantity a line should carry. Where both units are the same it is
 * always the purchase quantity. Where they differ, a count already on the line
 * wins - typed by a person, or read off the invoice as its sheet count - and
 * only failing that is it worked out from the kg.
 */
export function stockQtyFor(line = {}) {
  if (!kgPerSheet(line)) return finite(line.qty);
  const fromKg = stockQtyFromPurchase(line.qty, line);
  // Typed by a person: theirs.
  if (line.stockQtyByHand && finite(line.stockQty) !== null) return finite(line.stockQty);
  // Written on the invoice as the sheet total: "123 x 250 = 30750 Sheet".
  const written = sheetsWritten(line.description);
  if (written) return written;
  // The units column, only when it agrees with the kg. On Krishna Vanijya's
  // invoices "Total Units" is reams - 123 of them for 30,750 sheets - and
  // taken for sheets it would have put 123 sheets into stock.
  const units = finite(line.totalUnits);
  if (units > 0 && (fromKg === null || Math.abs(units - fromKg) <= fromKg * SHEET_AGREEMENT)) return units;
  return fromKg;
}

/** How close a printed sheet count must be to the kg's to be taken as sheets. */
const SHEET_AGREEMENT = 0.03;

/** A sheet total written out on the line: "59 x 500 = 29500 Sheet" -> 29500. */
export function sheetsWritten(text) {
  const m = String(text ?? '').match(/=\s*([\d,]+(?:\.\d+)?)\s*sheets?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
