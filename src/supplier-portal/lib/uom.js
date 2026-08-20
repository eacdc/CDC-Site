/**
 * UOM normalisation and pack-size arithmetic.
 *
 * This is the highest-consequence pure module in the application. Rate basis
 * varies by orders of magnitude between suppliers — NR Agarwal quotes ₹74,342
 * per MT while everyone else quotes per kg — so a silent normalisation error
 * here is a 1000x error that looks entirely plausible on screen.
 *
 * Three rules the functions below enforce:
 *
 *  1. **Never infer UOM from a column header.** Print Sales' column reads
 *     "RATE PER LTR" while individual rows say `131.00/UNIT`, `160.00/PC` and
 *     `375.00/KG`. UOM is extracted per line, and the header is at best a
 *     fallback that has to be flagged.
 *  2. **Pack size hides inside names**, not in a pack column: `Technomelt Q
 *     970 - 26kg`, `GI Wire 26(15 kg Spool)`, `IPA 205 LTR`, `UNI GUM (5 LTR)`.
 *  3. **Ambiguity is not resolved by guessing.** An unresolvable unit returns
 *     null so the caller raises EXT004 and a human decides.
 */

import { UOM_SEED, AMBIGUOUS_UOMS, CANONICAL_UOMS } from '../config/uom-seed.js';
import { TOLERANCES } from '../config/constants.js';

/** Seed lookup, used when the Mongo table is not loaded (tests, jobs). */
const SEED_BY_RAW = new Map(UOM_SEED.map((u) => [u.raw.toUpperCase(), u]));
const AMBIGUOUS = new Set(AMBIGUOUS_UOMS.map((u) => u.toUpperCase()));

/** Strip everything that is not a letter or digit, upper-case the rest. */
function key(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const SEED_BY_KEY = new Map(UOM_SEED.map((u) => [key(u.raw), u]));
const AMBIGUOUS_KEYS = new Set(AMBIGUOUS_UOMS.map(key));

/**
 * Resolve a raw unit spelling to its canonical form and conversion factor.
 *
 * @param {string} raw
 * @param {Map<string, {canonical: string|null, factor: number, isAmbiguous: boolean}>} [overrides]
 *   The live `sp_uomNormalisation` table, keyed by raw spelling. The purchase
 *   team edits that table, so it wins over the seed.
 * @returns {{canonical: string|null, factor: number, isAmbiguous: boolean, raw: string}}
 */
export function normaliseUom(raw, overrides) {
  const text = String(raw ?? '').trim();
  if (!text) return { canonical: null, factor: 1, isAmbiguous: false, raw: text };

  if (overrides) {
    const hit = overrides.get(text.toUpperCase()) || overrides.get(key(text));
    if (hit) {
      return {
        canonical: hit.canonical ?? null,
        factor: Number(hit.factor) || 1,
        isAmbiguous: Boolean(hit.isAmbiguous || !hit.canonical),
        raw: text,
      };
    }
  }

  const upper = text.toUpperCase();
  if (AMBIGUOUS.has(upper) || AMBIGUOUS_KEYS.has(key(text))) {
    return { canonical: null, factor: 1, isAmbiguous: true, raw: text };
  }

  const seeded = SEED_BY_RAW.get(upper) || SEED_BY_KEY.get(key(text));
  if (seeded) {
    return { canonical: seeded.canonical, factor: seeded.factor, isAmbiguous: false, raw: text };
  }

  // An unknown spelling is not the same as an ambiguous one: it means the seed
  // is incomplete. Both go to a human, but they are different fixes.
  return { canonical: null, factor: 1, isAmbiguous: false, raw: text, unknown: true };
}

/** True when a canonical value is one this application knows how to compare. */
export function isCanonicalUom(uom) {
  return CANONICAL_UOMS.includes(String(uom ?? '').toUpperCase());
}

// ── Pack size parsing ───────────────────────────────────────────────────────

/**
 * Pack size patterns observed across the August 2026 quote batch. Ordered
 * most-specific first; the first match wins.
 *
 * Each pattern captures a quantity and a unit somewhere in the product name:
 *   `Technomelt Q 970 - 26kg`        → 26 KG
 *   `GI Wire 26(15 kg Spool)`        → 15 KG
 *   `IPA 205 LTR`                    → 205 LTR
 *   `UNI GUM (5 LTR)`                → 5 LTR
 *   `DEEP KLEEN SHAMPOO (500 ML)`    → 0.5 LTR
 */
const PACK_PATTERNS = [
  // Parenthesised, with an optional container word: "(15 kg Spool)", "(5 LTR)"
  /\(\s*(\d+(?:\.\d+)?)\s*(KGS?|KG|GMS?|GM|LTRS?|LTR|LITRES?|LITERS?|ML|MTRS?|MTR|PCS?|NOS?|SHEETS?|ROLLS?)\b[^)]*\)/i,
  // Trailing or embedded, after a dash or space: "- 26kg", "205 LTR"
  /[-–—\s](\d+(?:\.\d+)?)\s*(KGS?|KG|GMS?|GM|LTRS?|LTR|LITRES?|LITERS?|ML|MTRS?|MTR)\b/i,
];

/**
 * Bare parenthesised number with no unit — `SKT XUV-225 RC (20)`. Only trusted
 * when the caller supplies a default pack unit for that supplier or item,
 * because "(20)" could as easily be a grade as a pack size.
 */
const BARE_PACK_PATTERN = /\(\s*(\d+(?:\.\d+)?)\s*\)\s*$/;

/**
 * Pull a pack size out of a product name.
 *
 * @param {string} name
 * @param {{defaultPackUom?: string}} [opts]
 * @returns {{packQty: number, packUom: string, matched: string, assumedUom?: boolean}|null}
 */
export function parsePackSize(name, { defaultPackUom } = {}) {
  const text = String(name ?? '');
  if (!text) return null;

  for (const pattern of PACK_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const qty = Number(m[1]);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const unit = normaliseUom(m[2]);
    if (!unit.canonical) continue;
    return {
      packQty: qty * unit.factor,
      packUom: unit.canonical,
      matched: m[0].trim(),
    };
  }

  if (defaultPackUom) {
    const m = text.match(BARE_PACK_PATTERN);
    if (m) {
      const qty = Number(m[1]);
      if (Number.isFinite(qty) && qty > 0) {
        const unit = normaliseUom(defaultPackUom);
        return {
          packQty: qty * (unit.factor || 1),
          packUom: unit.canonical || String(defaultPackUom).toUpperCase(),
          matched: m[0].trim(),
          assumedUom: true,
        };
      }
    }
  }

  return null;
}

/**
 * Parse a rate cell that may carry its own unit: `131.00/UNIT`, `375.00/KG`,
 * `₹ 2,235`, `74,342 per MT`.
 *
 * @returns {{rate: number|null, uom: string|null, rawUom: string|null}}
 */
export function parseRateCell(cell) {
  const text = String(cell ?? '').trim();
  if (!text) return { rate: null, uom: null, rawUom: null };

  // Split on "/" or "per" — the unit, when present, follows it.
  const m = text.match(/^([^/]*?)(?:\s*(?:\/|per\s+)\s*([A-Za-z².\s]+))?$/i);
  const amountPart = m ? m[1] : text;
  const unitPart = m && m[2] ? m[2].trim() : null;

  const rate = parseAmount(amountPart);
  if (!unitPart) return { rate, uom: null, rawUom: null };

  const unit = normaliseUom(unitPart);
  return { rate, uom: unit.canonical, rawUom: unitPart };
}

/**
 * Parse an Indian-format money amount. Handles `₹`, thousands separators in
 * both Indian (`1,23,456.78`) and Western (`123,456.78`) grouping, and
 * trailing `/-`.
 */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '')
    .replace(/^\s*(?:₹|rs\.?|inr)\s*/i, '')  // leading currency marker only
    .replace(/\/-\s*$/, '')                  // trailing "/-"
    .replace(/(?<=\d),(?=\d)/g, '')          // separators between digits, either grouping
    .trim();
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// ── Rate normalisation ──────────────────────────────────────────────────────

/**
 * Normalise a quoted rate to a per-base-unit figure.
 *
 * Two distinct conversions happen here and they must not be confused:
 *
 *  - **Unit conversion**: ₹74,342/MT becomes ₹74.342/KG. The rate is divided
 *    by the factor because the factor converts the *quantity* upward.
 *  - **Pack division**: ₹2,235 for a 15 kg spool becomes ₹149/kg. This applies
 *    only when the quoted rate is for a whole pack, not already per unit.
 *
 * `perPack` says which of the two the quote means. `₹149/kg × 15 kg spool =
 * ₹2,235` is the verified Ultimate Logistix case: the supplier quoted per kg,
 * so `perPack` is false and the pack size is used to reconcile against CDC's
 * per-Nos last-paid rate rather than to divide the rate.
 *
 * @param {Object} input
 * @param {number} input.rate            rate exactly as quoted
 * @param {string} input.uom             unit as quoted (raw spelling is fine)
 * @param {number} [input.packQty]       pack size in `packUom`
 * @param {string} [input.packUom]
 * @param {boolean} [input.perPack]      true when `rate` prices a whole pack
 * @param {Map} [input.overrides]        live UOM table
 * @returns {{rate: number|null, uom: string|null, ratePerBaseUom: number|null,
 *            packQty: number|null, packUom: string|null, conversionNote: string,
 *            isAmbiguous: boolean}}
 */
export function normaliseRate({ rate, uom, packQty, packUom, perPack = false, overrides } = {}) {
  const amount = typeof rate === 'number' ? rate : parseAmount(rate);
  const unit = normaliseUom(uom, overrides);
  const notes = [];

  if (amount === null || !Number.isFinite(amount)) {
    return {
      rate: null, uom: unit.canonical, ratePerBaseUom: null,
      packQty: packQty ?? null, packUom: packUom ?? null,
      conversionNote: 'Rate could not be parsed', isAmbiguous: unit.isAmbiguous,
    };
  }

  if (!unit.canonical) {
    return {
      rate: amount, uom: null, ratePerBaseUom: null,
      packQty: packQty ?? null, packUom: packUom ?? null,
      conversionNote: unit.isAmbiguous
        ? `Unit "${unit.raw}" is ambiguous and needs a human`
        : `Unit "${unit.raw}" is not in the normalisation table`,
      isAmbiguous: true,
    };
  }

  // Unit conversion: a rate quoted per MT is 1/1000th of that per KG.
  let perBase = amount;
  if (unit.factor !== 1) {
    perBase = amount / unit.factor;
    notes.push(`${amount} per ${unit.raw} = ${round(perBase, 4)} per ${unit.canonical}`);
  }

  // Pack division: only when the quoted figure prices a whole pack.
  if (perPack && Number.isFinite(packQty) && packQty > 0) {
    const before = perBase;
    perBase = perBase / packQty;
    notes.push(`${round(before, 2)} per pack ÷ ${packQty} ${packUom || unit.canonical} = ${round(perBase, 4)}`);
  }

  return {
    rate: amount,
    uom: unit.canonical,
    ratePerBaseUom: round(perBase, 6),
    packQty: Number.isFinite(packQty) ? packQty : null,
    packUom: packUom ?? null,
    conversionNote: notes.join('; '),
    isAmbiguous: false,
  };
}

/**
 * The pack-reconciliation case: the supplier prices per kg but CDC buys the
 * whole spool as one "Nos". `₹149/kg × 15 kg = ₹2,235`, which is exactly what
 * CDC last paid for `G.I WIRE SPOOL BIG 26`.
 */
export function packEquivalentRate({ ratePerBaseUom, packQty }) {
  if (!Number.isFinite(ratePerBaseUom) || !Number.isFinite(packQty) || packQty <= 0) return null;
  return round(ratePerBaseUom * packQty, 4);
}

/**
 * Magnitude guard (EXT005). A normalised rate more than 10x away from what CDC
 * last paid means the basis was read wrong — per-MT read as per-kg, or a pack
 * price read as a unit price. The line is blocked rather than queued, because
 * a plausible-looking wrong rate is worse than a missing one.
 *
 * Returns null when there is nothing to compare against; a missing last-paid
 * rate is not evidence of a problem.
 */
export function magnitudeCheck(normalisedRate, lastPaidRate, factor = TOLERANCES.uomMagnitudeFactor) {
  if (!Number.isFinite(normalisedRate) || normalisedRate <= 0) return null;
  if (!Number.isFinite(lastPaidRate) || lastPaidRate <= 0) return null;
  const ratio = normalisedRate / lastPaidRate;
  const off = ratio > factor || ratio < 1 / factor;
  return {
    passed: !off,
    ratio: round(ratio, 4),
    normalisedRate,
    lastPaidRate,
    /** The likeliest cause, offered to the reviewer as a starting point. */
    likelyCause: off
      ? (ratio > factor
          ? 'quoted per pack or per MT but normalised as per unit'
          : 'quoted per unit but normalised as per pack or per MT')
      : null,
  };
}

export function round(n, dp = 2) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Build a lookup Map from the `sp_uomNormalisation` rows, in the shape
 * `normaliseUom` expects.
 */
export function uomOverridesFrom(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const entry = {
      canonical: row.canonical ?? null,
      factor: Number(row.factor) || 1,
      isAmbiguous: Boolean(row.isAmbiguous),
    };
    map.set(String(row.raw).toUpperCase(), entry);
    map.set(key(row.raw), entry);
  }
  return map;
}
