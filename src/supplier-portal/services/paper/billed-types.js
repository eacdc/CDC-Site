/**
 * Paper trade names, typed by what CDC's own bills posted them to.
 *
 * A mill's trade name says nothing about the paper on its face - "JK ELEKTRA",
 * "ANDHRA SPLENDOR" - so the reader asks, one question per name. SKM's list
 * asked 24. But CDC has bought some of these before, and every bill paired the
 * supplier's wording with an Indus item whose quality is the answer: nine bills
 * say "JK ELEKTRA ..." and all nine were posted as Maplitho. Asking a person
 * what the ledger already records is a question with no information in it.
 *
 * WHEN THE BILLS DISAGREE, THE NAME IS NOT A TYPE. "CLASSIC" was posted as
 * leatherlike, linen and grey back; it is a word, not a paper, and stays a
 * question. A disagreement explained by another word on the bill is not a
 * disagreement about this one: "JK COAT ART PAPER C2S MATT" is matte because
 * it says MATT, so it says nothing about what a bare "ART PAPER" means - and
 * the bills where nothing else decided it were all gloss.
 *
 * Two bills at least. One bill is one coordinator's posting, and a wrong type
 * merges two papers into one comparison with nothing on the screen to show it.
 *
 * Pure: the caller loads the bill history.
 */

import { resolvePaperType, resolveMill } from '../../config/paper-vocabulary.js';

const MIN_BILLS = 2;
const MAX_WORDS = 4;

/** Words that are in a paper's name without being its name. */
const NOT_A_NAME = new Set(['PAPER', 'PAPERS', 'BOARD', 'IMPORTED', 'INDIAN', 'COL', 'COLOUR', 'COLOR', 'WHITE',
  'WT', 'DLX', 'DELUXE', 'SHEET', 'SHEETS', 'REEL', 'REELS', 'RBD', 'RLS', 'GSM', 'AND', 'ABOVE', 'PLUS', 'SUPER',
  'PRIME', 'NEW', 'THE', 'OF', 'X', 'NATURAL', 'SHADE', 'NS', 'SS', 'HB',
  // Uses, not names: "WESCO NOVA PRINT" was typed maplitho on the word PRINT.
  'PRINT', 'PRINTING', 'WRITING', 'COPIER', 'TEXT', 'COVER', 'BOND', 'COATED', 'COAT', 'COTE', 'LAID', 'SMOOTH']);

const words = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const padded = (ws) => ` ${ws.join(' ')} `;

/** The quality an Indus paper item is filed under: "Maplitho, 64 GSM, JK, ..." -> Maplitho. */
function indusQuality(itemName) {
  return String(itemName ?? '').split(',').map((s) => s.trim()).find((s) => s && s !== '0') || '';
}

/**
 * Bill lines that can teach a type: paper items, with the canonical type their
 * Indus quality resolves to. A quality with no canonical type (Montblanc, a
 * kraft BF) still counts, as a type of its own, so that it can disagree.
 */
export function paperEvidence(entries = []) {
  return entries
    .filter((e) => /\bGSM\b/i.test(e.itemName || '') && e.description)
    .map((e) => {
      const quality = indusQuality(e.itemName);
      return { text: padded(words(e.description)), type: resolvePaperType(quality) || `INDUS:${quality.toUpperCase()}` };
    });
}

/** The type the bills give a phrase, or null when they do not settle it. */
function typeForPhrase(phrase, evidence) {
  const needle = ` ${phrase} `;
  const hits = evidence.filter((e) => e.text.includes(needle));
  if (hits.length < MIN_BILLS) return null;
  const types = new Set(hits.map((h) => h.type));
  if (types.size > 1) {
    // Keep only the bills whose type nothing else on them explains.
    const bare = hits.filter((h) => resolvePaperType(h.text.replace(needle, ' ')) !== h.type);
    const bareTypes = new Set(bare.map((h) => h.type));
    if (bare.length < MIN_BILLS || bareTypes.size !== 1) return null;
    types.clear();
    types.add([...bareTypes][0]);
  }
  const [type] = types;
  return type.startsWith('INDUS:') ? null : { type, bills: hits.length };
}

/** Phrases of a product name worth looking up, longest first. */
function phrases(productName) {
  const ws = words(productName);
  const out = [];
  for (let n = Math.min(MAX_WORDS, ws.length); n >= 1; n -= 1) {
    for (let i = 0; i + n <= ws.length; i += 1) {
      const gram = ws.slice(i, i + n);
      // A phrase must carry a word of its own: not a mill, a number or filler.
      if (gram.every((w) => NOT_A_NAME.has(w) || /^\d/.test(w) || resolveMill(w))) continue;
      out.push(gram.join(' '));
    }
  }
  return out;
}

/**
 * Type the lines the bills can settle. Never overwrites a type already set.
 *
 * @param {Object} payload   the paper reader's payload
 * @param {Array}  entries   from loadBillHistory()
 * @returns {{ payload, resolved: number }}
 */
export function applyBilledTypes(payload, entries = []) {
  const evidence = paperEvidence(entries);
  if (!evidence.length) return { payload, resolved: 0 };

  const cache = new Map();
  const lookup = (phrase) => {
    if (!cache.has(phrase)) cache.set(phrase, typeForPhrase(phrase, evidence));
    return cache.get(phrase);
  };

  let resolved = 0;
  const lines = (payload?.lines || []).map((line) => {
    if (line.paperType) return line;
    const text = [line.productName, line.brand].filter(Boolean).join(' ');
    // Longest phrase first: "NATURAL SHADE" is decided before "NATURAL" is tried.
    for (const phrase of phrases(text)) {
      const hit = lookup(phrase);
      if (!hit) continue;
      resolved += 1;
      return { ...line, paperType: hit.type, paperTypeBasis: 'BILLED', paperTypeBilledAs: phrase };
    }
    return line;
  });
  return { payload: { ...payload, lines }, resolved };
}
