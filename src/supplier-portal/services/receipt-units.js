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
  return finite(line.stockQty) ?? (finite(line.totalUnits) > 0 ? finite(line.totalUnits) : null)
    ?? stockQtyFromPurchase(line.qty, line);
}
