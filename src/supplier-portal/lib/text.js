/**
 * Text normalisation and similarity for the matching engine.
 *
 * Names on both sides are dirty in different ways. CDC's are machine-generated
 * from attributes, so field order varies between items of the same schema.
 * Suppliers' are typed by people: `BROWN JEWEL TS` for `CrownJewel TS`,
 * `WASH DP` for `DP WASH`, `BÖTTCHER PRO ROL-O-PAST` for
 * `BOTTCHER- ROLL O PASTE`.
 *
 * Token-set similarity is used rather than edit distance precisely because of
 * the reordering: `WASH DP` and `DP WASH` share every token but are far apart
 * by Levenshtein. It is still only Tier 4 — the rate anchor in Tier 2 catches
 * all three examples above and text similarity catches none of them reliably.
 */

import { SUPPLIER_TOKEN_ALIASES, PANTONE_PATTERN } from '../config/constants.js';

/** Abbreviations seen on both sides, expanded before comparison. */
const ABBREVIATIONS = {
  MC: 'MACHINE',
  MCH: 'MACHINE',
  MTL: 'METAL',
  BLK: 'BLACK',
  WHT: 'WHITE',
  YLW: 'YELLOW',
  TRANS: 'TRANSPARENT',
  EXT: 'EXTENDER',
  PWD: 'POWDER',
  SOLN: 'SOLUTION',
  ADH: 'ADHESIVE',
  LAM: 'LAMINATION',
  GLS: 'GLOSS',
  // Deliberately no `MT` entry: in a product name it means matte, but in a
  // rate context it means metric tonne, and the cost of getting that wrong is
  // 1000x. Only the unambiguous spelling is expanded.
  MATT: 'MATTE',
  PLT: 'PLATE',
  BLNKT: 'BLANKET',
  QTY: 'QUANTITY',
};

/**
 * Upper-case, fold diacritics, strip punctuation, collapse whitespace.
 *
 * Diacritic folding is what lets `BÖTTCHER` meet `BOTTCHER`. Punctuation
 * stripping is what lets `ROL-O-PAST` meet `ROLL O PASTE` at the token level
 * (though not identically — the rate anchor does the real work there).
 */
export function normaliseName(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Tokenise a normalised name, expanding known abbreviations and supplier
 * shorthand (`SKT` → `SAKATA`).
 */
export function tokenise(input) {
  const normalised = normaliseName(input);
  if (!normalised) return [];
  return normalised.split(' ').map((token) => (
    SUPPLIER_TOKEN_ALIASES[token] || ABBREVIATIONS[token] || token
  ));
}

/**
 * Token-set ratio: the share of tokens the two names have in common, measured
 * against the smaller set so that a long CDC name and a short supplier name
 * can still score highly when one is a subset of the other.
 *
 * A pure Jaccard would punish `BOTTCHER ROLL O PASTE` against
 * `BOTTCHER PRO ROL O PAST` for the extra tokens on each side; the
 * min-cardinality denominator is more forgiving of truncation, which is the
 * common failure on supplier documents.
 *
 * @returns {number} 0..1
 */
export function tokenSetRatio(a, b) {
  const setA = new Set(tokenise(a));
  const setB = new Set(tokenise(b));
  if (!setA.size || !setB.size) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;

  const minSize = Math.min(setA.size, setB.size);

  // Blend coverage of the smaller set with overall overlap, so a two-token
  // name fully contained in a ten-token name does not score a flat 1.0.
  const coverage = shared / minSize;
  const jaccard = shared / (setA.size + setB.size - shared);
  return round(0.7 * coverage + 0.3 * jaccard, 4);
}

/**
 * Similarity that also rewards numeric agreement. Two chemical names differing
 * only in a grade number — `SICURA 770` vs `SICURA 870` — are different
 * products, and plain token overlap scores them far too close.
 */
export function nameSimilarity(a, b) {
  const base = tokenSetRatio(a, b);
  const numsA = numbersIn(a);
  const numsB = numbersIn(b);
  if (!numsA.length || !numsB.length) return base;

  const shared = numsA.filter((n) => numsB.includes(n)).length;
  const numAgreement = shared / Math.max(numsA.length, numsB.length);
  // A total numeric disagreement caps the score below the auto-accept
  // threshold, forcing the pair to a human rather than through Tier 4.
  if (shared === 0) return round(Math.min(base, 0.6), 4);
  return round(0.75 * base + 0.25 * numAgreement, 4);
}

/** Units and filler that every name in a group shares, so agreeing on them says nothing. */
const LETTER_NOISE = /\b(LTR|LTRS|ML|KG|KGS|GM|MTR|MTRS|METER|METERS|MM|CM|MIC|MICRON|X|WITH|BAR|AND|THE|INK|PAPER|BOARD|NONE|GSM)\b/g;

/**
 * Do two names share their letters, whatever the spacing? The share of
 * three-letter runs of the shorter name, with spaces, digits and units taken
 * out, found in the longer one.
 *
 * Token similarity misses the pairs a supplier spells differently: CALCIUM FIX
 * and CALCIUMFIX share no token, nor do ROL O GEL and Rollo Gel. It is the test
 * a rate match has to pass: on the August 2026 quotes, every rate match that
 * scored under 0.3 here was a coincidence (Gum Powder at the price of a Matrix
 * Cito, a Siegwerk ink at the price of a grease).
 */
export function letterOverlap(a, b) {
  const grams = (s) => {
    const t = normaliseName(s).replace(/\d+(\.\d+)?/g, ' ').replace(LETTER_NOISE, ' ').replace(/\s+/g, '');
    const out = new Set();
    for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return round(shared / Math.min(A.size, B.size), 4);
}

/**
 * Do two names give one product word different model numbers? "Technomelt
 * COOL 4515" and "Technomelt COOL 4530" share every letter and are different
 * glues. Only a bare number straight after a word both names use counts:
 * "Blanket EX6000" against "Blanket 578" is a brand code against a machine,
 * not two model numbers.
 */
export function differentModelNumber(a, b) {
  const after = (s) => {
    const tokens = normaliseName(s).split(' ');
    const out = new Map();
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      // "Blanket 889 X 612" opens a size, not a model number.
      if (/^[A-Z]{3,}$/.test(tokens[i]) && /^\d{3,}$/.test(tokens[i + 1]) && tokens[i + 2] !== 'X') {
        out.set(tokens[i], tokens[i + 1]);
      }
    }
    return out;
  };
  const A = after(a);
  const B = after(b);
  for (const [word, n] of A) if (B.has(word) && B.get(word) !== n) return true;
  return false;
}

/**
 * Numbers embedded in a name. Leading zeros are dropped by the ERP —
 * `Matrix-Cito-4 X 1.4` means 0.4 x 1.4 — so a bare digit that follows a
 * separator is also recorded in its decimal reading.
 */
export function numbersIn(input) {
  const text = normaliseName(input);
  const out = [];
  for (const m of text.matchAll(/\d+(?:\s\d+)?/g)) {
    const raw = m[0];
    // "1 4" in a normalised "1.4" — punctuation stripping turned the dot into
    // a space, so both readings are kept.
    if (raw.includes(' ')) {
      out.push(Number(raw.replace(' ', '.')));
      raw.split(' ').forEach((part) => out.push(Number(part)));
    } else {
      out.push(Number(raw));
    }
  }
  return out.filter((n) => Number.isFinite(n));
}

/**
 * Extract a Pantone code.
 *
 * `InkColour` and `PantoneCode` are frequently swapped in the master, and the
 * literal string "PANTONE" turns up in colour fields, so the search runs over
 * the concatenation of name, colour and code rather than trusting any one
 * column.
 */
export function extractPantone({ itemName, inkColour, pantoneCode } = {}) {
  const haystack = [itemName, inkColour, pantoneCode].filter(Boolean).join(' ');
  const m = haystack.match(PANTONE_PATTERN);
  if (!m) return null;
  return m[0].replace(/\s+/g, '').toUpperCase();
}

/**
 * Does this line carry a brand or product-code token worth a web lookup?
 *
 * Online enrichment runs only when it does. Searching a generic name like
 * "Aqueous Gloss Varnish" returns marketing copy, and marketing copy read as
 * evidence produces false confidence.
 */
export function hasBrandOrCodeToken(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  // A long digit run is a catalogue number: 120000201834.
  if (/\d{6,}/.test(raw)) return true;
  // Dotted or dashed alphanumeric codes: 71-000022-5.2690, CMC 41517N.
  if (/\b[A-Z0-9]{2,}[-.][A-Z0-9]{2,}(?:[-.][A-Z0-9]+)*\b/i.test(raw)) return true;
  // A word followed by a 2-4 digit grade with an optional suffix: XUV 225 RC,
  // Sicura 770HS, EXC90214.
  if (/\b[A-Z]{2,}\s?\d{2,5}\s?[A-Z]{0,3}\b/.test(raw.toUpperCase())) return true;
  return false;
}

/** Longest common token prefix, used to group near-identical master rows. */
export function commonPrefixTokens(a, b) {
  const ta = tokenise(a);
  const tb = tokenise(b);
  const out = [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i += 1) {
    if (ta[i] !== tb[i]) break;
    out.push(ta[i]);
  }
  return out;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
