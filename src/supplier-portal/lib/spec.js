/**
 * Spec tuple parsing.
 *
 * CDC item names are generated from attributes by `ItemGroupMaster.ItemNameFormula`,
 * so two items of the same schema can print their fields in different orders:
 * `BOPP Gloss, 587 MM, 10 MICRON, Indian` and
 * `BOPP Gloss, Indian, 1030 MM, 10 MICRON` are the same schema, differently
 * ordered. Fuzzy-matching those raw strings is guesswork; parsing both sides to
 * a tuple and comparing fields is not.
 *
 * This module also produces the **spec keys** that film, foil and paper rates
 * are stored against. Purv quotes `12 Micron Matte BOPP ₹250` with no width at
 * all, while CDC holds ~60 film ItemIDs differing only by width — one quote
 * line is ~15 items. Storing that per item means maintaining 140 identical
 * numbers, and they drift.
 */

import { normaliseName } from './text.js';

// ── Field extractors ────────────────────────────────────────────────────────

/** `10 MICRON`, `10µ`, `10 MIC`, `10MU`. */
export function parseMicron(text) {
  const t = String(text ?? '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:MICRON|MICRONS|MIC\b|MU\b|µ|μ)/i);
  return m ? Number(m[1]) : null;
}

/** `587 MM`, `1030MM`, `SizeW: 587`. Returned in millimetres. */
export function parseWidthMm(text) {
  const t = String(text ?? '');
  const mm = t.match(/(\d+(?:\.\d+)?)\s*MM\b/i);
  if (mm) return Number(mm[1]);
  const inch = t.match(/(\d+(?:\.\d+)?)\s*(?:INCH|INCHES|")/i);
  if (inch) return round(Number(inch[1]) * 25.4, 1);
  return null;
}

/** `90 GSM`, `GSM 90`, `GSM:90`. */
export function parseGsm(text) {
  const t = String(text ?? '');
  const m = t.match(/GSM\s*[:\s]\s*(\d+(?:\.\d+)?)/i) || t.match(/(\d+(?:\.\d+)?)\s*GSM\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * GSM bands, quoted in every shape the August batch used:
 *   Sudarshan     — separate GSM FROM / GSM TO columns
 *   Krishna Vanijya — "100-300", "115 & ABOVE"
 *   NR Agarwal    — "54-55", "90+AB"
 *
 * Lookup is a band-containment test, so an open upper bound is stored as null
 * rather than as a large number that would later read as a real limit.
 */
export function parseGsmBand(text) {
  const t = normaliseName(text);
  if (!t) return null;

  // "115 & ABOVE", "90 AB", "90+AB", "150 AND ABOVE"
  const above = t.match(/(\d+(?:\.\d+)?)\s*(?:AND\s*)?(?:ABOVE|AB|PLUS|UP)\b/);
  if (above) return { gsmFrom: Number(above[1]), gsmTo: null };

  // "BELOW 100", "UPTO 90"
  const below = t.match(/(?:BELOW|UNDER|UPTO|UP TO)\s*(\d+(?:\.\d+)?)/);
  if (below) return { gsmFrom: null, gsmTo: Number(below[1]) };

  // "100-300", "54 55"
  const range = t.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to >= from) return { gsmFrom: from, gsmTo: to };
  }

  const single = t.match(/(\d+(?:\.\d+)?)/);
  if (single) return { gsmFrom: Number(single[1]), gsmTo: Number(single[1]) };
  return null;
}

/** Is `gsm` inside the band? An open bound means unbounded on that side. */
export function gsmInBand(gsm, { gsmFrom, gsmTo } = {}) {
  if (!Number.isFinite(gsm)) return false;
  if (Number.isFinite(gsmFrom) && gsm < gsmFrom) return false;
  if (Number.isFinite(gsmTo) && gsm > gsmTo) return false;
  return Number.isFinite(gsmFrom) || Number.isFinite(gsmTo);
}

/**
 * Product form. Sudarshan uses RBD (sheet) and RLS (reel); other suppliers
 * write the words. Both resolve to the same two values so the form-premium
 * rule can be applied uniformly.
 */
export function parseForm(text) {
  const t = normaliseName(text);
  if (!t) return null;
  if (/\bRBD\b|\bSHEET\b|\bSHEETS\b/.test(t)) return 'SHEET';
  if (/\bRLS\b|\bREEL\b|\bREELS\b|\bROLL\b/.test(t)) return 'REEL';
  return null;
}

/** Film type from a supplier line or a CDC item name. */
const FILM_TYPES = [
  { pattern: /\bMET\s*PET\b|\bMETPET\b|\bMETALLI[SZ]ED\s*PET\b/i, type: 'MET PET' },
  { pattern: /\bBOPP\b.*\bMATTE?\b|\bMATTE?\b.*\bBOPP\b/i, type: 'BOPP MATTE' },
  { pattern: /\bBOPP\b.*\bGLOSS?Y?\b|\bGLOSS?Y?\b.*\bBOPP\b/i, type: 'BOPP GLOSS' },
  { pattern: /\bBOPP\b.*\bTHERMAL\b|\bTHERMAL\b.*\bBOPP\b/i, type: 'BOPP THERMAL' },
  { pattern: /\bPOLYESTER\b.*\bGLOSS?Y?\b|\bGLOSS?Y?\b.*\bPOLYESTER\b/i, type: 'POLYESTER GLOSS' },
  { pattern: /\bPOLYESTER\b.*\bMATTE?\b|\bMATTE?\b.*\bPOLYESTER\b/i, type: 'POLYESTER MATTE' },
  { pattern: /\bPOLYESTER\b|\bPET\b/i, type: 'POLYESTER' },
  { pattern: /\bBOPP\b/i, type: 'BOPP' },
  { pattern: /\bNYLON\b/i, type: 'NYLON' },
];

export function parseFilmType(text) {
  const raw = String(text ?? '');
  for (const { pattern, type } of FILM_TYPES) {
    if (pattern.test(raw)) {
      // `MET PET UV Coated` is a distinct grade from plain MET PET.
      if (type === 'MET PET' && /\bUV\b/i.test(raw)) return 'MET PET UV COATED';
      return type;
    }
  }
  return null;
}

/**
 * Foil grade. Nearly all Shring foil is one rate regardless of colour or
 * width, and Kurz is a different band entirely — 80 purchased foil items
 * collapse to roughly six price points. The grade is the identity; the width
 * is not.
 */
export function parseFoilGrade(text) {
  const t = normaliseName(text);
  if (!t) return null;
  const m = t.match(/\b(?:GRADE|SERIES)\s*([A-Z0-9]+)\b/);
  if (m) return m[1];
  // Common grade tokens seen on foil lines.
  const known = t.match(/\b(ALUFIN|LUXOR|COLORIT|DIAMOND|HOLOGRAM|PIGMENT|METALLIC|MATT|GLOSS)\b/);
  return known ? known[1] : null;
}

// ── Spec tuples ─────────────────────────────────────────────────────────────

/**
 * Parse a CDC item into a comparable attribute tuple. Master columns are used
 * where they are populated and trustworthy; the name is parsed to fill in what
 * they do not carry — group 14 (Paper) has no sub-group on any item, group 6
 * (Foil) has a blank `ManufecturerItemCode` in its own name formula.
 *
 * @param {Object} item  a row from erp-items.js
 * @returns {Object} tuple with nulls for absent fields
 */
export function itemSpecTuple(item = {}) {
  const name = [item.ItemName, item.ItemDescription].filter(Boolean).join(' ');
  return {
    groupId: item.ItemGroupID ?? null,
    quality: cleanish(item.Quality) || null,
    // Group 8's Quality is a byte-for-byte copy of ItemName, so it carries no
    // independent information there.
    qualityIsCopyOfName: item.ItemGroupID === 8,
    gsm: numberOr(item.GSM) ?? parseGsm(name),
    micron: numberOr(item.Thickness) ?? parseMicron(name),
    widthMm: numberOr(item.SizeW) ?? parseWidthMm(name),
    lengthMm: numberOr(item.SizeL) ?? null,
    bf: numberOr(item.BF) ?? null,
    filmType: parseFilmType(name),
    foilGrade: parseFoilGrade(name),
    form: parseForm(name),
    certification: cleanish(item.CertificationType) || null,
    // Only group 3 may read Manufecturer as a brand: elsewhere it is an origin
    // ("Imported") or, on the ERP grid, the supplier.
    brand: item.ItemGroupID === 3 ? cleanish(item.Manufecturer) || null : null,
    origin: [2, 14].includes(item.ItemGroupID) ? cleanish(item.Manufecturer) || null : null,
  };
}

/** Parse a supplier quote line into the same shape. */
export function quoteSpecTuple(line = {}) {
  const raw = line.raw || line;
  const text = [raw.productName, raw.text, raw.notes].filter(Boolean).join(' ');
  const band = raw.gsmFrom || raw.gsmTo
    ? { gsmFrom: numberOr(raw.gsmFrom), gsmTo: numberOr(raw.gsmTo) }
    : parseGsmBand(text);
  return {
    quality: null,
    gsm: parseGsm(text),
    gsmFrom: band?.gsmFrom ?? null,
    gsmTo: band?.gsmTo ?? null,
    micron: numberOr(raw.micron) ?? parseMicron(text),
    widthMm: numberOr(raw.width) ?? parseWidthMm(text),
    filmType: parseFilmType(text),
    foilGrade: parseFoilGrade(text),
    form: parseForm(raw.productForm || text),
  };
}

/**
 * Compare two tuples field by field, ignoring fields absent on either side.
 *
 * Absent is not the same as different: a supplier who omits the width has not
 * said the width differs. Only fields both sides state are compared, and the
 * count of those is returned so a caller can refuse a "match" made on one
 * weak field.
 *
 * @returns {{matched: number, compared: number, mismatches: string[], score: number}}
 */
export function compareSpecTuples(a = {}, b = {}, fields = SPEC_COMPARE_FIELDS) {
  let matched = 0;
  let compared = 0;
  const mismatches = [];

  for (const field of fields) {
    const av = a[field];
    const bv = b[field];
    if (av === null || av === undefined || bv === null || bv === undefined) continue;
    compared += 1;
    if (valuesAgree(av, bv)) matched += 1;
    else mismatches.push(`${field}: ${av} vs ${bv}`);
  }

  return {
    matched,
    compared,
    mismatches,
    score: compared === 0 ? 0 : round(matched / compared, 4),
  };
}

export const SPEC_COMPARE_FIELDS = [
  'filmType', 'micron', 'widthMm', 'gsm', 'foilGrade', 'form', 'quality', 'brand',
];

function valuesAgree(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    // Dimensions are printed rounded on quotes and precisely in the master.
    const tolerance = Math.max(Math.abs(a), Math.abs(b)) * 0.01;
    return Math.abs(a - b) <= Math.max(tolerance, 0.001);
  }
  return normaliseName(a) === normaliseName(b);
}

// ── Spec keys ───────────────────────────────────────────────────────────────

/**
 * Build the spec key a rate is stored against, or null when the line prices a
 * specific item rather than a spec band.
 *
 * @param {Object} tuple      from `quoteSpecTuple`
 * @param {number} groupId    CDC item group the line belongs to, if known
 */
export function buildSpecKey(tuple = {}, groupId) {
  // Lamination film: keyed on {filmType, micron}, expanded to ItemIDs at query
  // time. Width is deliberately excluded — the supplier did not quote one.
  if (tuple.filmType && Number.isFinite(tuple.micron)) {
    return { kind: 'FILM_SPEC', filmType: tuple.filmType, micron: tuple.micron };
  }

  // Foil: keyed on grade. Width and colour do not move the price.
  if (groupId === 6 || tuple.foilGrade) {
    if (tuple.foilGrade) return { kind: 'FOIL_GRADE', foilGrade: tuple.foilGrade };
  }

  // Paper and reel: a GSM band plus form, not an SKU.
  if (Number.isFinite(tuple.gsmFrom) || Number.isFinite(tuple.gsmTo)) {
    return {
      kind: 'PAPER_BAND',
      quality: tuple.quality || null,
      gsmFrom: tuple.gsmFrom ?? null,
      gsmTo: tuple.gsmTo ?? null,
      form: tuple.form || null,
    };
  }

  return { kind: 'ITEM' };
}

/** Stable string form of a spec key, for grouping and `isCurrent` scoping. */
export function specKeyString(specKey) {
  if (!specKey || specKey.kind === 'ITEM') return 'ITEM';
  const parts = [specKey.kind];
  for (const field of ['filmType', 'micron', 'foilGrade', 'quality', 'gsmFrom', 'gsmTo', 'form']) {
    if (specKey[field] !== null && specKey[field] !== undefined) {
      parts.push(`${field}=${specKey[field]}`);
    }
  }
  return parts.join('|');
}

/**
 * Does a CDC item fall under a spec key? This is what expands one film quote
 * line into the ~15 ItemIDs it actually prices.
 */
export function itemMatchesSpecKey(item, specKey) {
  if (!specKey || specKey.kind === 'ITEM') return false;
  const tuple = itemSpecTuple(item);

  if (specKey.kind === 'FILM_SPEC') {
    return tuple.filmType === specKey.filmType
      && Number.isFinite(tuple.micron)
      && Math.abs(tuple.micron - specKey.micron) < 0.51;
  }

  if (specKey.kind === 'FOIL_GRADE') {
    return normaliseName(tuple.foilGrade) === normaliseName(specKey.foilGrade);
  }

  if (specKey.kind === 'PAPER_BAND') {
    if (!gsmInBand(tuple.gsm, specKey)) return false;
    if (specKey.quality && normaliseName(tuple.quality) !== normaliseName(specKey.quality)) return false;
    if (specKey.form && tuple.form && tuple.form !== specKey.form) return false;
    return true;
  }

  return false;
}

function numberOr(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function cleanish(value) {
  const t = String(value ?? '').trim();
  return t && t.toUpperCase() !== 'NULL' ? t : '';
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
