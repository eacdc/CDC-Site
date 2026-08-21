/**
 * The vocabulary of paper and board, as CDC's suppliers actually write it.
 *
 * Assembled from CDC's own item master (~1,000 active items) and eight real
 * quotes received in August 2026: four Sudarshan price lists (Virgin, Recycled,
 * Maplitho, Coated), Krishna Vanijya, AKT's handwritten note, the NR mill rate
 * sheet, and a kraft quote from Natraj/Madhubati.
 *
 * The problem this exists to solve: every supplier writes the same paper
 * differently, and none of the spellings share a substring with the others.
 * Sudarshan writes `GB`; AKT writes `PGB`; KV heads a section `DUPLEX BOARD`.
 * All three are grey back. No similarity score finds that; only a table does.
 *
 * THREE KINDS OF KNOWLEDGE, DELIBERATELY SEPARATE
 *
 *   1. TYPE SYNONYMS — words that *mean* the type. `offset` means maplitho
 *      everywhere, for every supplier, forever. Universal and safe.
 *
 *   2. BRAND MAPPINGS — a product that *happens to be* that type. "Carte
 *      Lumina" is CBB because ITC makes it that way, not because the words
 *      mean anything. These are facts about products, confirmed one at a time,
 *      and most are learned rather than seeded here.
 *
 *   3. ATTRIBUTE MARKERS — modifiers that change the price without changing
 *      the type: natural shade, high bulk, sheet vs reel.
 *
 * Collapsing these would be a mistake. A brand mapping asserted as a synonym
 * would make "Prima" mean FBB even on a maplitho list.
 *
 * WHAT IS NOT HERE IS AS IMPORTANT AS WHAT IS. Several abbreviations appear in
 * the data whose meaning nobody has confirmed. They are listed in `UNCONFIRMED`
 * and resolve to null, because a wrong mapping merges two different papers into
 * one comparison and nothing in the result shows it happened.
 */

// ── 1. Paper types ──────────────────────────────────────────────────────────

/**
 * Canonical types and the words that mean them.
 *
 * `synonyms` are matched as whole words after punctuation is stripped, longest
 * first. They must be words that carry the meaning — never brand names.
 */
export const PAPER_TYPES = [
  {
    canonical: 'MAPLITHO',
    label: 'Maplitho / uncoated',
    /*
      "Offset" and "woodfree" are the trade's other names for the same paper,
      confirmed by CDC. `SSP` is Ballarpur's brand of it and is in the item
      master often enough to be treated as a spelling. `MAP` appears abbreviated
      on KV's list ("TRUEPRINT ULTRA (HB) MAP").
    */
    synonyms: ['MAPLITHO', 'MAPPLITHO', 'OFFSET', 'WOODFREE', 'WOOD FREE', 'UNCOATED', 'SSP', 'MAP'],
  },
  {
    canonical: 'FBB',
    label: 'FBB (folding box board)',
    // GC1 and GC2 are the European folding-boxboard grades; AprilFine prints
    // them instead of the words.
    synonyms: ['FBB', 'FOLDING BOX BOARD', 'FOLDING BOXBOARD', 'GC1', 'GC2'],
  },
  {
    canonical: 'CBB',
    label: 'CBB (coated bleached board)',
    synonyms: ['CBB', 'COATED BLEACHED BOARD', 'SBS', 'SOLID BLEACHED SULPHATE', 'SOLID BLEACHED SULFATE'],
  },
  {
    canonical: 'GREY_BACK',
    label: 'Grey back',
    /*
      `DUPLEX` is here but it is not a synonym in the way the others are.

      Duplex is the trade's casual word for RECYCLED board, and both grey back
      and white back are duplex — confirmed by CDC. So it narrows rather than
      decides. The rule CDC gave, and the one `resolvePaperType` implements:

        duplex, and nothing else        -> grey back
        duplex alongside "white back"   -> white back

      KV's list is exactly this shape: one section headed "DUPLEX BOARD" holding
      BAHL GREY BACK 1000 at 49.50 beside BAHL WHITE BACK 1000 at 55.50, six
      rupees apart. Getting the default wrong would file the dearer paper as the
      cheaper one on every unlabelled row.
    */
    synonyms: [
      'GREY BACK', 'GREYBACK', 'GRAY BACK', 'GRAYBACK', 'DUPLEX GREY BACK',
      'PRIME GREY BACK', 'GB', 'PGB', 'DUPLEX',
    ],
  },
  {
    canonical: 'WHITE_BACK',
    label: 'White back',
    // DSWB is Divya Shakti's own initials welded onto the grade — confirmed by
    // CDC. It has to resolve to the same canonical value as "MEHALI ECO WHITE
    // WB" or the two would never be compared.
    synonyms: ['WHITE BACK', 'WHITEBACK', 'DUPLEX WHITE BACK', 'DIVYA SHAKTI WHITE BACK', 'WB', 'DSWB'],
  },
  {
    canonical: 'GLOSS_ART',
    label: 'Gloss art',
    // C2S = coated two sides. Sudarshan's Coated list spells it in full;
    // ABG is their abbreviation for art board gloss.
    synonyms: ['GLOSS ART', 'ART GLOSS', 'C2S GLOSS', 'ART PAPER C2S GLOSS', 'ART BOARD C2S GLOSS', 'ABG'],
  },
  {
    canonical: 'MATTE_ART',
    label: 'Matte art',
    synonyms: ['MATTE ART', 'MATT ART', 'ART MATT', 'C2S MATT', 'C2S MATTE', 'ART PAPER C2S MATT', 'ART BOARD C2S MATT'],
  },
  {
    canonical: 'CHROMO',
    label: 'Chromo (coated one side)',
    synonyms: ['CHROMO', 'CHROMO ART', 'CHROMO PAPER', 'C1S'],
  },
  {
    canonical: 'KRAFT',
    label: 'Kraft',
    synonyms: ['KRAFT', 'KRAFT PAPER'],
  },
  {
    canonical: 'KRAFT_BOARD',
    label: 'Kraft board',
    synonyms: ['KRAFT BOARD'],
  },
  {
    canonical: 'MILL_BOARD',
    label: 'Mill board / binding board',
    // Priced and specified by thickness in mm rather than GSM.
    synonyms: ['MILL BOARD', 'MILLBOARD', 'BINDING BOARD', 'HARD BOARD', 'HARDBOARD'],
  },
  {
    canonical: 'MG_BOARD',
    label: 'MG board',
    synonyms: ['MG BOARD'],
  },
  {
    canonical: 'NEWSPRINT',
    label: 'Newsprint',
    synonyms: ['NEWSPRINT', 'NEWS PRINT'],
  },
  {
    canonical: 'BIBLE_PAPER',
    label: 'Bible paper',
    synonyms: ['BIBLE PAPER', 'BIBLE'],
  },
  {
    canonical: 'CARRY_BAG',
    label: 'Carry bag paper',
    synonyms: ['CARRY BAG PAPER', 'CARRY BAG'],
  },
  {
    canonical: 'GUMMING_SHEET',
    label: 'Gumming sheet',
    synonyms: ['GUMMING SHEET', 'GUMMING'],
  },
  {
    canonical: 'SPECIALTY',
    label: 'Specialty / imported fine paper',
    /*
      Deliberately has no synonyms. The ~40 Cordenons products in the item
      master — Montblanc Extra White, Stardream Opal, Materica Gesso, Insize
      Modigliani — are identified by product name and mill, because there is no
      generic type underneath them. Asking "what paper type is Stardream Opal?"
      is a bad question. They are matched by brand, not by type.
    */
    synonyms: [],
  },
];

// ── 2. Brand mappings ───────────────────────────────────────────────────────

/**
 * Products whose type CDC has confirmed, seeded because they already appear on
 * more than one supplier's list.
 *
 * These three matter disproportionately: ITC sells them through both Sudarshan
 * and Krishna Vanijya, so they are the first real cross-supplier comparison the
 * portal can make. Sudarshan quotes Carte Lumina at 80.50 a sheet and KV at
 * 81.00 — fifty paise, on a product neither list calls CBB anywhere.
 *
 * Everything else is learned. Sudarshan's Virgin list runs to ~28 products and
 * states a type for none of them; that is a conversation to have once, not a
 * table to write blind.
 */
export const BRAND_TYPES = [
  { brand: 'CARTE LUMINA', canonical: 'CBB', confirmedBy: 'CDC', note: 'ITC' },
  { brand: 'CYBER XL PAC', canonical: 'FBB', confirmedBy: 'CDC', note: 'ITC' },
  { brand: 'CYBER XLPAC', canonical: 'FBB', confirmedBy: 'CDC', note: 'ITC, Sudarshan spelling' },
  { brand: 'PEARL XL PAC', canonical: 'FBB', confirmedBy: 'CDC', note: 'ITC' },
];

// ── 3. Attribute markers ────────────────────────────────────────────────────

/**
 * Modifiers that change the price without changing the paper type.
 *
 * THE NS / NSS COLLISION is why every one of these is matched as a whole word
 * and never as a substring:
 *
 *     NS   natural shade        CENTURY DAZZLE PRINT NS      +Rs 2.00/kg
 *     NSS  non surface sized    SIRPUR NSS MAPLITHO (NON SS)  -Rs 1.00/kg
 *
 * One letter apart, opposite kinds of thing, and pointing in opposite price
 * directions. Substring matching would read every NSS as an NS.
 */
export const SHADE_MARKERS = [
  // Natural shade is dearer and is not substitutable for white — confirmed by
  // CDC, and visible as a flat +2.00/kg across every band of Century Dazzle.
  { value: 'NATURAL', markers: ['NATURAL SHADE', 'NATURAL', 'NS'] },
];

export const BULK_MARKERS = [
  /*
    "1 45 BULK" is not a typo. Tokenising strips punctuation, so the item
    master's "MAPLITHO 1.45 BULK" arrives as "MAPLITHO 1 45 BULK" and a marker
    written "1.45" would never match it.

    Note that a bare "BULK" is deliberately not a marker: FBB quotes print a
    bulk *value* — "NR POWER FOLD - FBB NATURAL FBB 1.40 - 1.45" — and reading
    that as high bulk would mark every board on the page.
  */
  { value: 'HIGH', markers: ['HIGH BULK', 'HI BULK', 'HI-BULK', 'HIBULK', 'HB', '1 45 BULK', '145 BULK'] },
];

/**
 * Sheet or reel, and it is priced: every RBD/RLS pair on Sudarshan's Virgin
 * list is exactly Rs 3.00/kg apart, on eleven products. AKT's premium is 3.50
 * and NR's stated rule is 1.00. So the gap varies by supplier but the
 * distinction always matters.
 *
 * RBD and RLS are CDC's own ERP vocabulary, so no translation is needed at the
 * far end.
 */
export const FORM_MARKERS = [
  { value: 'SHEET', markers: ['RBD', 'SHEET', 'SHEETS', 'DO SHEET'] },
  { value: 'REEL', markers: ['RLS', 'REEL', 'REELS', 'ROLL'] },
];

/**
 * Recorded because it is printed, but NOT part of the comparison key: CDC
 * treats surface-sized and non-surface-sized as interchangeable.
 *
 * Kept anyway so that a row reading "NON SS" is not silently filed as though
 * the document never said anything, and so the decision can be revisited
 * without re-reading every quote.
 */
export const SURFACE_MARKERS = [
  { value: 'NON_SS', markers: ['NON SS', 'NON-SS', 'NSS'] },
  { value: 'SS', markers: ['SS', 'SURFACE SIZED'] },
];

// ── 4. Mills ────────────────────────────────────────────────────────────────

/**
 * One mill, however many ways CDC's own item master spells it.
 *
 * This was the surprise. Mill names are as inconsistent as paper types, and the
 * inconsistency is inside CDC's ERP rather than in the suppliers' documents —
 * `Importet` is a typo that has been entered hundreds of times.
 *
 * `origin` markers at the end are not mills at all. "Local", "Imported" and
 * "Imported - AKT" describe where the paper came from, and treating them as
 * mills would merge every importer's stock into one supplier.
 */
export const MILL_ALIASES = [
  { canonical: 'DEV PRIYA', aliases: ['DEV PRIYA', 'DEVPRIYA'] },
  { canonical: 'SAHOTA', aliases: ['SAHOTA', 'SAHUTA'] },
  { canonical: 'BAHL', aliases: ['BAHL', 'BHAL'] },
  { canonical: 'SILVERTONE', aliases: ['SILVERTONE', 'SILVERTON', 'SILVERTONE VISTA', 'SILVER VISTA'] },
  { canonical: 'SIDHARTH', aliases: ['SIDHARTH', 'SIDHARTHA'] },
  /*
    One mill. OGB and GSP are Khanna's own grade names, not separate mills —
    confirmed by CDC — and quotes state the grade properly, so it arrives as a
    brand rather than as part of the mill.
  */
  { canonical: 'KHANNA', aliases: ['KHANNA', 'KHANNA OGB', 'KHANNA GSP'] },
  {
    canonical: 'APRILFINE',
    // "Importet" is CDC's own long-standing typo, not a supplier's.
    aliases: ['APRILFINE', 'APRIL FINE', 'IMPORTED APRIL FINE', 'IMPORTED APRIL', 'IMPORTET APRIL', 'IMPORTED APRILFINE'],
  },
  { canonical: 'BALLARPUR', aliases: ['BALLARPUR', 'BILT'] },
  { canonical: 'WEST COAST', aliases: ['WEST COAST', 'WEST COAST PAPER'] },
  { canonical: 'ANDHRA', aliases: ['ANDHRA', 'ANDHRA PAPER MILL', 'ANDHRA PAPER'] },
  { canonical: 'RUCHIRA', aliases: ['RUCHIRA'] },
  { canonical: 'KRISHNA PRABHA', aliases: ['KRISHNA PRABHA'] },
  { canonical: 'UNI GLOBAL', aliases: ['UNI GLOBAL', 'UNIGLOBAL'] },
  { canonical: 'DIVYA SHAKTI', aliases: ['DIVYA SHAKTI', 'DIVYASHAKTI'] },
  { canonical: 'ITC', aliases: ['ITC'] },
  { canonical: 'JK', aliases: ['JK', 'JK PAPER'] },
  { canonical: 'TNPL', aliases: ['TNPL'] },
  { canonical: 'CENTURY', aliases: ['CENTURY'] },
  { canonical: 'EMAMI', aliases: ['EMAMI', 'EMAMI SOLITAIRE'] },
  { canonical: 'NR', aliases: ['NR'] },
  { canonical: 'ORIENT', aliases: ['ORIENT'] },
  { canonical: 'SIRPUR', aliases: ['SIRPUR'] },
  { canonical: 'NAINI', aliases: ['NAINI'] },
  { canonical: 'MEHALI', aliases: ['MEHALI'] },
  { canonical: 'GENUS', aliases: ['GENUS'] },
  { canonical: 'VISHAL', aliases: ['VISHAL'] },
  { canonical: 'ARIHANT', aliases: ['ARIHANT'] },
  { canonical: 'SPECTRA', aliases: ['SPECTRA'] },
  { canonical: 'MULTIWAL', aliases: ['MULTIWAL'] },
  { canonical: 'DIYAN', aliases: ['DIYAN'] },
  { canonical: 'KD', aliases: ['KD'] },
  { canonical: 'CORDENONS', aliases: ['CORDENONS'] },
  { canonical: 'ASIA SYMBOL', aliases: ['ASIA SYMBOL'] },
  { canonical: 'HANSOL', aliases: ['HANSOL'] },
  { canonical: 'SNOWLION', aliases: ['SNOWLION', 'SNOW LION'] },
  { canonical: 'SNOW EAGLE', aliases: ['SNOW EAGLE'] },
  { canonical: 'YUEYANG', aliases: ['YUEYANG'] },
  { canonical: 'EUCA', aliases: ['EUCA', 'EUCA PRO'] },
  { canonical: 'NATRAJ', aliases: ['NATRAJ', 'NATRAJ ELECTRO CASTING'] },
  { canonical: 'MADHUBATI', aliases: ['MADHUBATI', 'MADHUBATI PAPER'] },
  { canonical: 'TRIDENT', aliases: ['TRIDENT', 'TRIDENT PAPER'] },
  { canonical: 'SESHASAYEE', aliases: ['SESHASAYEE', 'SESHASHAI', 'SSPB'] },
  { canonical: 'RNG', aliases: ['RNG', 'RNG PAPER'] },
  { canonical: 'GODAVARI', aliases: ['GODAVARI'] },
  { canonical: 'SUNMARG', aliases: ['SUNMARG'] },
  { canonical: 'PAPERLINES', aliases: ['PAPERLINES'] },
];

/** Not mills. Where the paper came from. */
export const ORIGIN_MARKERS = ['LOCAL', 'IMPORTED', 'INDIAN SPECIAL'];

// ── 5. What nobody has confirmed ────────────────────────────────────────────

/**
 * Seen in real data, meaning unconfirmed, deliberately unmapped.
 *
 * The list is meant to shrink. `PGB` and `DSWB` started here and moved into the
 * tables above once CDC said what they meant, which is the whole workflow: the
 * portal surfaces a word it does not know, somebody who buys paper says what it
 * is, and it becomes searchable. Guessing skips the one step that makes the
 * answer trustworthy.
 *
 * Several of these are *probably* obvious. That is exactly when guessing is
 * most tempting and most dangerous.
 */
export const UNCONFIRMED = [
  { token: 'DCB', seenIn: 'AKT handwritten note, Devpriya section', priced: '47.25, a rupee below PGB', guess: 'a grey back variant?' },
  { token: 'LWC', seenIn: 'Uni Global LWC (KV, under DUPLEX BOARD); Arihant LWC (item master)', priced: '43.50, cheapest duplex', guess: 'light weight coated — but of what?' },
  { token: 'PDB', seenIn: 'UNI GLOBAL PDB (KV, under DUPLEX BOARD)', priced: '46.50 / 45.00', guess: null },
  { token: 'HI KOTE', seenIn: 'KV section heading', priced: '110-112, far above art paper', guess: 'cast coated?' },
  { token: 'DIGIEDGE ABG', seenIn: 'SPB DIGIEDGE ABG (Sudarshan Coated), product class SWP not PG', priced: '82.50, dearest on the list', guess: 'digital art board gloss?' },
];

/**
 * Mills whose relationship CDC has not confirmed. Kept apart rather than
 * merged, because merging two mills that are actually distinct silently pools
 * their rate histories.
 */
export const UNCONFIRMED_MILLS = [
  { tokens: ['EMAMI', 'EMAMI SOLITAIRE'], question: 'Is Solitaire a brand of Emami, or a separate mill?' },
  { tokens: ['IK', 'IK WOODFREE'], question: 'Is IK a mill? It appears in the item master and as a KV section heading.' },
  { tokens: ['NEVIA', 'GOLDEN COIN LUXE'], question: 'Brands or mills? Both head KV sections.' },
];

// ── Resolution ──────────────────────────────────────────────────────────────

/** Punctuation out, single spaces, upper case — the form everything matches in. */
function tokenised(text) {
  return ` ${String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
}

/** Build a longest-first lookup so multi-word terms beat the words inside them. */
function lookupFor(entries, valueKey, listKey) {
  return entries
    .flatMap((e) => e[listKey].map((s) => ({ value: e[valueKey], needle: tokenised(s).trim() })))
    .filter((e) => e.needle)
    .sort((a, b) => b.needle.length - a.needle.length);
}

const TYPE_LOOKUP = lookupFor(PAPER_TYPES, 'canonical', 'synonyms');
const BRAND_LOOKUP = BRAND_TYPES
  .map((b) => ({ value: b.canonical, needle: tokenised(b.brand).trim() }))
  .sort((a, b) => b.needle.length - a.needle.length);
const MILL_LOOKUP = lookupFor(MILL_ALIASES, 'canonical', 'aliases');
const SHADE_LOOKUP = lookupFor(SHADE_MARKERS, 'value', 'markers');
const BULK_LOOKUP = lookupFor(BULK_MARKERS, 'value', 'markers');
const FORM_LOOKUP = lookupFor(FORM_MARKERS, 'value', 'markers');
const SURFACE_LOOKUP = lookupFor(SURFACE_MARKERS, 'value', 'markers');
const UNCONFIRMED_TOKENS = UNCONFIRMED.map((u) => tokenised(u.token).trim());

/** First whole-word hit from a longest-first lookup, or null. */
function resolve(lookup, text) {
  const haystack = tokenised(text);
  if (haystack.trim() === '') return null;
  const hit = lookup.find((e) => haystack.includes(` ${e.needle} `));
  return hit ? hit.value : null;
}

/**
 * The paper type named in `text`, or null.
 *
 * A brand mapping beats a type synonym. "ITC CARTE LUMINA" contains no type
 * word at all, and a product whose brand CDC has confirmed should not be
 * second-guessed by a stray word in its name.
 */
export function resolvePaperType(text) {
  const byBrand = resolve(BRAND_LOOKUP, text);
  if (byBrand) return byBrand;

  /*
    Duplex means recycled, and both backs are duplex. Where "white back" also
    appears it decides; duplex on its own is grey back.

    Longest-first ordering happens to give the same answer today, because
    "WHITE BACK" is the longer needle. That is accidental correctness — adding
    a longer grey-back spelling later would silently flip it, and the failure
    would be a dearer paper filed as a cheaper one. So the rule is written out.
  */
  const haystack = tokenised(text);
  if (haystack.includes(' DUPLEX ')) {
    const white = resolve(lookupFor([PAPER_TYPES.find((t) => t.canonical === 'WHITE_BACK')], 'canonical', 'synonyms'), text);
    return white || 'GREY_BACK';
  }

  return resolve(TYPE_LOOKUP, text);
}

export function resolveMill(text) {
  return resolve(MILL_LOOKUP, text);
}

/**
 * Shade, bulk, form and surface sizing, read off one product string.
 *
 * Surface sizing is checked before shade so that "NSS" is claimed by NON_SS
 * before "NS" can match it — belt as well as the braces of whole-word matching.
 */
export function resolveAttributes(text) {
  const surface = resolve(SURFACE_LOOKUP, text);
  return {
    shade: resolve(SHADE_LOOKUP, text) || null,
    bulk: resolve(BULK_LOOKUP, text) || null,
    form: resolve(FORM_LOOKUP, text) || null,
    surfaceSized: surface,
  };
}

/**
 * Unconfirmed abbreviations present in `text`, for the reviewer to settle.
 *
 * Empty once the type is known, even if an unconfirmed token is still in the
 * string. "SPB DIGIEDGE ABG" types as gloss art through `ABG`; also asking what
 * DIGIEDGE means would be a question with no consequence attached, and a
 * screen that asks those trains people to dismiss the ones that matter.
 */
export function unconfirmedTokens(text) {
  if (resolvePaperType(text)) return [];
  const haystack = tokenised(text);
  return UNCONFIRMED_TOKENS.filter((t) => haystack.includes(` ${t} `));
}

/** The label a person reads, for a canonical type. */
export function paperTypeLabel(canonical) {
  return PAPER_TYPES.find((t) => t.canonical === canonical)?.label || canonical || null;
}

/** Every canonical type, for the agent to choose from and for a dropdown. */
export function canonicalPaperTypes() {
  return PAPER_TYPES.map((t) => ({ canonical: t.canonical, label: t.label }));
}
