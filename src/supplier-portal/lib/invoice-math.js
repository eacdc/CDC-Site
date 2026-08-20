/**
 * Purchase-invoice arithmetic.
 *
 * Pure functions, verified against Krishna Vanijya invoice `KV/26-27/12945`
 * (18-Aug-2026), which is the reference trace the whole receiving module is
 * built to reproduce.
 *
 * The freight mechanism below looks wrong at first reading and is not. It is
 * replicated exactly because the ERP's own screens compute it this way, and
 * "correcting" it makes the portal's totals disagree with the ERP's for every
 * invoice that carries freight.
 */

/**
 * Apportion freight across invoice lines, pro-rata on gross amount.
 *
 * Freight is added to the taxable base **before** GST, so it is taxed at each
 * line's own HSN rate. That handles mixed-rate invoices correctly for free:
 * the freight on a 12% line is taxed at 12% and the freight on an 18% line at
 * 18%, without anyone having to split the freight by rate.
 *
 * The line's `netAmount` then **excludes** its freight share. This is the part
 * that looks like a bug. It is not: the header adds the freight back once, as
 * a charge row in `ItemPurchaseInvoiceTaxes`. Including it per line as well
 * would double-count it, and the totals drift.
 *
 * Verified on the reference invoice:
 *   gross 20,890.76 of 39,167.24  → share 0.53337
 *   freight share 629.38 → taxable 21,520.14
 *   CGST 1,936.81 → net 24,764.39
 *
 * @param {Array<{grossAmount: number, cgstPercentage?: number,
 *                sgstPercentage?: number, igstPercentage?: number}>} lines
 * @param {number} totalFreight
 * @returns {Array} the input lines with freight, taxable, tax and net added
 */
export function apportionFreight(lines = [], totalFreight = 0) {
  const totalGross = lines.reduce((sum, l) => sum + (Number(l.grossAmount) || 0), 0);
  const freight = Number(totalFreight) || 0;

  return lines.map((line, index) => {
    const gross = Number(line.grossAmount) || 0;

    // The last line takes the rounding remainder, so the shares always sum to
    // the freight actually charged. Distributing the remainder anywhere else
    // leaves the header and the lines a paisa apart.
    const isLast = index === lines.length - 1;
    const rawShare = totalGross > 0 ? freight * (gross / totalGross) : 0;
    const freightShare = isLast
      ? round(freight - lines.slice(0, -1).reduce(
          (sum, l) => sum + round(totalGross > 0 ? freight * ((Number(l.grossAmount) || 0) / totalGross) : 0, 2), 0,
        ), 2)
      : round(rawShare, 2);

    const taxableAmount = round(gross + freightShare, 2);

    const cgstRaw = taxableAmount * pct(line.cgstPercentage);
    const sgstRaw = taxableAmount * pct(line.sgstPercentage);
    const igstRaw = taxableAmount * pct(line.igstPercentage);

    return {
      ...line,
      grossAmount: round(gross, 2),
      freightShare,
      taxableAmount,
      cgstAmount: round(cgstRaw, 2),
      sgstAmount: round(sgstRaw, 2),
      igstAmount: round(igstRaw, 2),
      /**
       * Excludes the freight share, deliberately — see the note above.
       *
       * Summed from the UNROUNDED tax figures and rounded once. On the
       * reference invoice the two 1,936.8126 tax components sum with the gross
       * to 24,764.385, which the ERP shows as 24,764.39; adding the already
       * rounded 1,936.81 twice gives 24,764.38, a paisa low. Rounding once at
       * the end is what reproduces the ERP.
       */
      netAmount: round(gross + cgstRaw + sgstRaw + igstRaw, 2),
    };
  });
}

/** Header totals from apportioned lines. */
export function invoiceTotals(lines = [], { freight = 0, roundOff = 0 } = {}) {
  const sum = (key) => round(lines.reduce((s, l) => s + (Number(l[key]) || 0), 0), 2);
  const totalBasic = sum('grossAmount');
  const totalTaxable = sum('taxableAmount');
  const cgst = sum('cgstAmount');
  const sgst = sum('sgstAmount');
  const igst = sum('igstAmount');

  return {
    totalBasicAmount: totalBasic,
    totalTaxableAmount: totalTaxable,
    totalCGSTTaxAmount: cgst,
    totalSGSTTaxAmount: sgst,
    totalIGSTTaxAmount: igst,
    totalTaxAmount: round(cgst + sgst + igst, 2),
    freight: round(Number(freight) || 0, 2),
    roundOffValue: round(Number(roundOff) || 0, 2),
    // Freight is added back exactly once, here.
    netAmount: round(totalBasic + (Number(freight) || 0) + cgst + sgst + igst + (Number(roundOff) || 0), 2),
  };
}

// ── Sheet ↔ kg reconciliation ───────────────────────────────────────────────

/**
 * Weight of a sheet stack, computed both ways.
 *
 * CDC's `WtPerPacking` uses rounded metric (585 × 915 mm) while suppliers bill
 * on the true inch size (23" × 36" = 584.2 × 914.4 mm). That is a systematic
 * **−0.21%** on every inch-sized sheet — not an error by either party, and not
 * something to reconcile away.
 *
 * Verified:
 *   ours:   5500 × 585   × 915   × 90 / 1e9 = 264.961 kg
 *   theirs: 5500 × 584.2 × 914.4 × 90 / 1e9 = 264.425 kg   (billed 264.44)
 *
 * The build spec quotes the second figure as 264.41. Recomputing it gives
 * 264.425; the difference is 15 grams and does not change any decision, but
 * the arithmetic is what is implemented here rather than the printed figure.
 * Either reading is 0.01% from the billed 264.44 and well inside tolerance.
 *
 * Both figures are stored rather than one silently overwriting the other.
 * Today the override is manual and leaves no trace, which is why nobody can
 * tell a rounding difference from a short delivery after the fact.
 */
export function sheetWeightKg({ sheets, widthMm, lengthMm, gsm }) {
  const n = Number(sheets); const w = Number(widthMm);
  const l = Number(lengthMm); const g = Number(gsm);
  if (![n, w, l, g].every((v) => Number.isFinite(v) && v > 0)) return null;
  return round((n * w * l * g) / 1e9, 3);
}

/** True inch dimensions for a nominal metric size, where one exists. */
const INCH_EQUIVALENTS = new Map([
  ['585x915', { widthMm: 584.2, lengthMm: 914.4, inches: '23 x 36' }],
  ['915x585', { widthMm: 914.4, lengthMm: 584.2, inches: '36 x 23' }],
  ['635x965', { widthMm: 635.0, lengthMm: 965.2, inches: '25 x 38' }],
  ['710x1010', { widthMm: 711.2, lengthMm: 1009.65, inches: '28 x 39.75' }],
  ['760x1010', { widthMm: 762.0, lengthMm: 1009.65, inches: '30 x 39.75' }],
]);

/**
 * Reconcile a billed weight against both computations.
 *
 * @returns {{computedOurs, computedTheirs, billed, deltaOursPct, deltaTheirsPct,
 *            withinTolerance, note}}
 */
export function reconcileSheetKg({
  sheets, widthMm, lengthMm, gsm, billedKg, wtPerPacking, unitPerPacking, tolerancePct = 0.01,
}) {
  const ours = sheetWeightKg({ sheets, widthMm, lengthMm, gsm });

  const key = `${Math.round(Number(widthMm))}x${Math.round(Number(lengthMm))}`;
  const inch = INCH_EQUIVALENTS.get(key);
  const theirs = inch
    ? sheetWeightKg({ sheets, widthMm: inch.widthMm, lengthMm: inch.lengthMm, gsm })
    : null;

  // Where the master carries a per-packing weight, that is CDC's own figure
  // and takes precedence over recomputing from dimensions.
  const fromMaster = Number.isFinite(Number(wtPerPacking)) && Number.isFinite(Number(unitPerPacking))
    && Number(unitPerPacking) > 0
    ? round((Number(sheets) / Number(unitPerPacking)) * Number(wtPerPacking), 3)
    : null;

  const billed = Number(billedKg);
  const reference = fromMaster ?? ours;

  const deltaOursPct = ratio(billed, reference);
  const deltaTheirsPct = ratio(billed, theirs);

  // The check passes if the billed weight agrees with EITHER computation. Both
  // are legitimate readings of the same delivery, and failing a supplier for
  // billing on true inches would fail almost every paper invoice.
  const withinTolerance = [deltaOursPct, deltaTheirsPct]
    .filter((d) => d !== null)
    .some((d) => Math.abs(d) <= tolerancePct);

  return {
    computedOurs: reference,
    computedTheirs: theirs,
    computedFromMaster: fromMaster,
    billed: Number.isFinite(billed) ? billed : null,
    deltaOursPct: deltaOursPct === null ? null : round(deltaOursPct * 100, 3),
    deltaTheirsPct: deltaTheirsPct === null ? null : round(deltaTheirsPct * 100, 3),
    inchEquivalent: inch?.inches ?? null,
    withinTolerance,
    note: inch
      ? `CDC computes on rounded metric ${key.replace('x', ' x ')} mm; the supplier bills on ${inch.inches} inches — a systematic -0.21%`
      : null,
  };
}

/**
 * The validation that would have prevented the known error.
 *
 * On 19-Aug-2026 a GRN was entered as 3000 sheets when the PO and the invoice
 * both said 1500. The money was right, so nothing downstream complained; the
 * stock is double to this day.
 *
 * Two independent conditions, both hard blocks:
 *   1. sheets × weight-per-sheet must agree with the billed kg
 *   2. received quantity must not exceed PO pending quantity beyond tolerance
 */
export function receiptSanity({
  sheets, billedKg, wtPerPacking, unitPerPacking, receivedQty, poPendingQty,
  weightTolerancePct = 0.01, receiptTolerancePct = 0.10,
}) {
  const results = { weightAgrees: null, withinPoTolerance: null, details: {} };

  if (Number.isFinite(Number(sheets)) && Number.isFinite(Number(billedKg))
      && Number.isFinite(Number(wtPerPacking)) && Number(unitPerPacking) > 0) {
    const expected = round((Number(sheets) / Number(unitPerPacking)) * Number(wtPerPacking), 3);
    const delta = ratio(Number(billedKg), expected);
    results.weightAgrees = delta !== null && Math.abs(delta) <= weightTolerancePct;
    results.details.expectedKg = expected;
    results.details.billedKg = Number(billedKg);
    results.details.weightDeltaPct = delta === null ? null : round(delta * 100, 3);
  }

  if (Number.isFinite(Number(receivedQty)) && Number.isFinite(Number(poPendingQty))) {
    const pending = Number(poPendingQty);
    const received = Number(receivedQty);
    const limit = pending * (1 + receiptTolerancePct);
    results.withinPoTolerance = received <= limit;
    results.details.receivedQty = received;
    results.details.poPendingQty = pending;
    results.details.maxAllowed = round(limit, 3);
    results.details.overByPct = pending > 0 ? round(((received - pending) / pending) * 100, 2) : null;
  }

  return results;
}

/**
 * Expected tax type from the two states.
 *
 * Place of supply for goods follows **delivery**, not billing — CDC bills to
 * Kolkata but consigns to Panchla or Ahmedabad, so the ship-to state decides.
 *
 * This is only ever a warning. The supplier decided the tax type when they
 * filed, and input credit has to match GSTR-2B; overriding it here would
 * create a mismatch that costs the credit. What the portal does is flag the
 * disagreement early enough to ask for a corrected invoice.
 */
export function expectedTaxType({ supplierState, shipToState }) {
  const a = normaliseState(supplierState);
  const b = normaliseState(shipToState);
  if (!a || !b) return null;
  return a === b ? 'CGST_SGST' : 'IGST';
}

/** The first two digits of a GSTIN are the state code. */
export function stateCodeFromGstin(gstin) {
  const t = String(gstin ?? '').trim().toUpperCase();
  return /^\d{2}/.test(t) ? t.slice(0, 2) : null;
}

function normaliseState(state) {
  const t = String(state ?? '').trim().toUpperCase();
  return t || null;
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : 0;
}

function ratio(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected === 0) return null;
  return (actual - expected) / expected;
}

export function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
