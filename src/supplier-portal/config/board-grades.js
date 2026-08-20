/**
 * The vocabulary of board grades.
 *
 * This is the piece that makes "grey back 280 gsm" answerable, and it is the
 * one thing no amount of extraction can supply: every supplier writes the same
 * board differently, and only a person who buys board knows which spellings
 * mean the same thing.
 *
 * From two real quotes received on the same day:
 *
 *   Sudarshan  MEHALI ECO GREEN GB      grey back, machine-printed price list
 *   Sudarshan  MEHALI ECO WHITE WB      white back
 *   AKT        Devpriya PGB             grey back, handwritten
 *   AKT        Devpriya White Back      white back, written in words
 *   AKT        TNPL FBB / CBB           folding box board / coated
 *
 * A search that matched on text would find none of these from the others. A
 * search over a canonical grade finds all of them.
 *
 * Editing this file is the intended way to teach the portal a new spelling.
 * Unrecognised grade words are reported rather than guessed at — see
 * `unknownGradeTokens` — because a wrong synonym silently merges two different
 * boards into one comparison, and nothing about the result looks wrong.
 */

/**
 * Canonical grades and the spellings that mean them.
 *
 * `synonyms` are matched as whole words after punctuation is stripped, so "GB"
 * matches "MEHALI ECO GREEN GB" but not "GBOARD". Longer synonyms are tried
 * first, so "WHITE BACK" is not read as the two separate words it contains.
 */
export const BOARD_GRADES = [
  {
    canonical: 'GREY_BACK',
    label: 'Grey back',
    synonyms: ['GREY BACK', 'GREYBACK', 'GRAY BACK', 'GRAYBACK', 'DUPLEX GREY BACK', 'GB'],
  },
  {
    canonical: 'WHITE_BACK',
    label: 'White back',
    synonyms: ['WHITE BACK', 'WHITEBACK', 'DUPLEX WHITE BACK', 'WB'],
  },
  {
    canonical: 'FBB',
    label: 'FBB (folding box board)',
    synonyms: ['FBB', 'FOLDING BOX BOARD', 'FOLDING BOXBOARD'],
  },
  {
    canonical: 'SBS',
    label: 'SBS',
    synonyms: ['SBS', 'SOLID BLEACHED SULPHATE', 'SOLID BLEACHED SULFATE'],
  },
  {
    canonical: 'CBB',
    label: 'CBB (coated bleached board)',
    synonyms: ['CBB', 'COATED BLEACHED BOARD'],
  },
  {
    canonical: 'KRAFT',
    label: 'Kraft',
    synonyms: ['KRAFT', 'KRAFT PAPER', 'KRAFT BOARD'],
  },
  {
    canonical: 'MAPLITHO',
    label: 'Maplitho',
    synonyms: ['MAPLITHO', 'MAPLITHO PAPER', 'MAPPLITHO'],
  },
  {
    canonical: 'ART_PAPER',
    label: 'Art paper / art card',
    synonyms: ['ART PAPER', 'ART CARD', 'GLOSS ART', 'MATT ART', 'ARTBOARD', 'ART BOARD'],
  },
];

/**
 * Abbreviations seen on real quotes whose meaning has not been confirmed.
 *
 * Deliberately NOT mapped. PGB is very likely a grey back and DSWB is very
 * likely Divya Shakti's white back, but "very likely" is not good enough for a
 * field that decides which rates get compared against each other: a wrong
 * mapping merges two boards into one comparison and there is nothing in the
 * result to show it happened.
 *
 * They are listed so the review screen can say "this grade was not recognised"
 * and name it, instead of silently filing the row as ungraded.
 */
export const UNCONFIRMED_GRADE_TOKENS = [
  'PGB', 'DCB', 'DSWB', 'PG', 'DIVPAK', 'DIVBOX', 'ECOSTRONG',
];

/**
 * How the board is supplied, which is a second price on the same product.
 *
 * The AKT note prices every board twice — "Devpriya PGB (Mill order) 48.25"
 * against "from stock 48.75" — and the two are 50 paise apart. Without this
 * field one of them silently overwrites the other, and which one wins depends
 * on the order the rows happened to be read in.
 */
export const SUPPLY_MODES = ['MILL_ORDER', 'EX_STOCK'];

const SUPPLY_MODE_SYNONYMS = [
  ['EX_STOCK', ['FROM STOCK', 'EX STOCK', 'EX-STOCK', 'READY STOCK', 'STOCK']],
  ['MILL_ORDER', ['MILL ORDER', 'MILL-ORDER', 'MILL DIRECT', 'DO BASED', 'DO']],
];

/** Punctuation out, single spaces, upper case — the form everything matches in. */
function tokenised(text) {
  return ` ${String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
}

/** Longest synonyms first, so "WHITE BACK" beats a bare "BACK" or "WB". */
const GRADE_LOOKUP = BOARD_GRADES
  .flatMap((g) => g.synonyms.map((s) => ({ canonical: g.canonical, needle: tokenised(s).trim() })))
  .sort((a, b) => b.needle.length - a.needle.length);

/**
 * The canonical grade named anywhere in `text`, or null.
 *
 * Reads the whole product string — "MEHALI ECO GREEN GB" is a grey back
 * because of its last two characters, and no amount of similarity against
 * "grey back" would ever have found that.
 */
export function resolveGrade(text) {
  const haystack = tokenised(text);
  if (haystack.trim() === '') return null;
  const hit = GRADE_LOOKUP.find((g) => haystack.includes(` ${g.needle} `));
  return hit ? hit.canonical : null;
}

/** The supply mode named in `text`, or null. */
export function resolveSupplyMode(text) {
  const haystack = tokenised(text);
  for (const [mode, synonyms] of SUPPLY_MODE_SYNONYMS) {
    if (synonyms.some((s) => haystack.includes(` ${tokenised(s).trim()} `))) return mode;
  }
  return null;
}

/**
 * Grade-like words in `text` that we do not recognise.
 *
 * Feeds the "we could not grade this row" message, and over time tells the
 * purchase team which spellings are worth adding above.
 */
export function unknownGradeTokens(text) {
  if (resolveGrade(text)) return [];
  const haystack = tokenised(text);
  return UNCONFIRMED_GRADE_TOKENS.filter((t) => haystack.includes(` ${t} `));
}

/** The label a person reads, for a canonical grade. */
export function gradeLabel(canonical) {
  return BOARD_GRADES.find((g) => g.canonical === canonical)?.label || canonical || null;
}
