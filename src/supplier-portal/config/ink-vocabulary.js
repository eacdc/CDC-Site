/**
 * The vocabulary of ink, coating and pressroom consumables.
 *
 * Assembled from three real documents received in July 2026, deliberately
 * chosen because they are shaped differently and all three have to work:
 *
 *   Print Sales   a dealer's PDF quotation. Sells DIC ink, DIC coating,
 *                 Boettcher chemicals and Capri plates, so the MANUFACTURER is
 *                 in the section header and never in the row. So is the unit:
 *                 "DIC UV INK - RATE PER KGS", "PRESS CHEMICALS - RATE PER
 *                 LTR.", "BOETTCHER CHEMICALS - RATE PER PC" — with per-row
 *                 overrides ("ANTI SET OFF VERN POWDER 375.00/KG").
 *
 *   Siegwerk      the manufacturer's own price list, an xlsx with no sections
 *                 at all: product code, description, and a five-column price
 *                 increase history.
 *
 *   CDC's list    sections, items, prices, and the unit hidden inside the item
 *                 name — "ECNO WASH KR (20 LTR)".
 *
 * WHAT THE COMPARISON KEY IS
 *
 * On board it was grade plus GSM. Here CDC's answer was explicit: compare on
 * CHEMISTRY plus COLOUR, across manufacturers. DIC's "RADICURE INTENSE 9000 PRO
 * CYAN" at 830/kg and Siegwerk's "SICURA PLAST 770HS PROCESS CYAN" at 810/kg
 * are the same purchase decision written two ways, and putting those side by
 * side is the reason this portal exists.
 *
 * Chemistry cannot be dropped from that key. In the Siegwerk sheet alone:
 *
 *     VEGA SPRINT PROCESS CYAN          conventional      292
 *     SICURA PLAST 770HS PROCESS CYAN   UV                810
 *
 * Same colour, 2.8x apart. Matched on colour alone the conventional ink looks
 * like a spectacular bargain on every screen, and nothing in the result shows
 * why.
 *
 * ROLE IS THE THIRD AXIS, and it is here because of a trap in the same data:
 *
 *     VEGA PRIME PROCESS BLACK PASTE 706   a Pantone mixing base    411
 *     VEGA SPRINT PROCESS BLACK            a press-ready ink        275
 *
 * Both conventional, both black. One goes on press; the other is a base you mix
 * a shade from. Compared against each other the base reads as 50% overpriced.
 *
 * THREE KINDS OF KNOWLEDGE, KEPT APART — the same discipline as paper:
 *
 *   1. MEANING WORDS  "matt" means matt on every quote, forever.
 *   2. PRODUCT FACTS  "Radicure Intense 9000" is a UV ink because DIC makes it
 *                     that way. Confirmed one at a time, mostly learned.
 *   3. UNIT AND PACK  what you are charged per, and what you must buy.
 *
 * And as with paper, what is NOT here matters: terms whose meaning nobody at
 * CDC has confirmed sit in `UNCONFIRMED_INK` and resolve to null, because a
 * wrong mapping merges two different products into one comparison silently.
 */

// ── 1. What kind of thing it is ─────────────────────────────────────────────

export const MATERIAL_CLASSES = [
  { canonical: 'INK', label: 'Ink' },
  { canonical: 'COATING', label: 'Coating / varnish' },
  { canonical: 'PRESS_CHEMICAL', label: 'Press chemical' },
  { canonical: 'PLATE', label: 'Plate' },
  { canonical: 'CONSUMABLE', label: 'Pressroom consumable' },
];

/**
 * Words that decide the material class.
 *
 * COATING IS TESTED BEFORE INK AND THAT ORDER IS LOAD-BEARING. DIC sells its
 * aqueous coatings under names ending in the word "ink":
 *
 *     AQUATIC ECO SMART OP INK           220.00
 *     NEUTRAL SEALER AQUATIC OP INK      276.00
 *     WATER BASED OPL-HIGH GLOSS         154
 *
 * "OP INK" is overprint — a coating, not an ink. Reading the trailing "INK"
 * would file every one of these as an ink and compare a 220 coating against an
 * 810 process colour.
 */
const CLASS_MARKERS = [
  {
    canonical: 'COATING',
    markers: [
      'OP INK', 'OPV', 'OPL', 'OVERPRINT VARNISH', 'OVERPRINT LACQUER', 'OVERPRINT',
      'VARNISH', 'VERNISH', 'COATING', 'LACQUER', 'SEALER', 'PRIMER',
    ],
  },
  {
    canonical: 'PRESS_CHEMICAL',
    /*
      Checked before PLATE — see PLATE_TRAP below.

      This list is deliberately thin, because the real one is CHEMICAL_FUNCTIONS
      further down and `resolveMaterialClass` consults that too. Keeping a second
      full copy here would guarantee the two drift: "BLANKET SAVER" and
      "CLEANFIX" are chemicals only the function table knows about, and a
      duplicate list is how one of them silently stops being one.
    */
    markers: [
      'WASH', 'CLEANER', 'KLEEN', 'CLEAN', 'REPLANISHER', 'REPLENISHER',
      'SHAMPOO', 'REDUCER', 'BENZENE', 'SOLVENT', 'ETCH',
    ],
  },
  { canonical: 'PLATE', markers: ['THERMAL PLATE', 'CTP PLATE', 'PLATE', 'PLATES'] },
  { canonical: 'INK', markers: ['INK', 'INKS'] },
  { canonical: 'CONSUMABLE', markers: ['SPONGE', 'POWDER', 'FORMULA GUIDE', 'GUIDE', 'CLOTH', 'ROLLER'] },
];

/**
 * THE PLATE TRAP, written out because whole-word matching alone does not solve
 * it and the failure is silent:
 *
 *     CAPRI DOUBLE COATED THERMAL PLATE   382.44/pc   a plate
 *     PLATE CLEANER GP (5 LTR)            185.00/ltr  a chemical
 *
 * Both contain the whole word PLATE. The chemical is what you clean the plate
 * with. Filed as a plate it would land in a category priced per piece by size,
 * where nothing about it makes sense. So the chemical markers are tested first
 * and a plate is only a plate when no chemical word appears with it.
 */

// ── 2. Chemistry ────────────────────────────────────────────────────────────

/**
 * The chemistry axis of the comparison key.
 *
 * CDC named four for ink — conventional, UV, web, additive. WATER_BASED is here
 * as a fifth because the Siegwerk sheet prices water-based inks that are not
 * coatings ("WB CDC SPL BLACK 2024", 313/kg) and they would otherwise have
 * nowhere to go. Drop it if CDC would rather those sat under conventional.
 *
 * ADDITIVE is a chemistry rather than a role because that is how CDC described
 * it, and it behaves like one: an additive has no colour, so the comparison
 * falls back to function.
 */
export const CHEMISTRIES = [
  { canonical: 'UV', label: 'UV', markers: ['UV', 'UV CURING', 'RADICURE', 'ULTRA VIOLET'] },
  {
    canonical: 'WATER_BASED',
    label: 'Water based / aqueous',
    /*
      A COATING CHEMISTRY ONLY. Water-based INKS exist — Siegwerk prices "WB CDC
      SPL BLACK 2024" at 313/kg — but CDC buys and compares them as conventional
      ink, so `resolveChemistry` folds them there. The value survives for
      coatings, where aqueous versus UV is the whole distinction.
    */
    markers: ['WATER BASED', 'WATERBASED', 'AQUEOUS', 'AQUATIC', 'AQUA', 'WB'],
  },
  { canonical: 'WEB', label: 'Web / heatset', markers: ['WEB', 'HEATSET', 'HEAT SET', 'COLDSET', 'COLD SET'] },
  {
    canonical: 'CONVENTIONAL',
    label: 'Conventional sheetfed',
    markers: ['CONVENTIONAL', 'SHEETFED', 'SHEET FED', 'OFFSET'],
  },
  {
    canonical: 'ADDITIVE',
    label: 'Ink additive',
    /*
      Multi-word on purpose. A bare "REDUCER" is a press chemical — Print Sales
      lists "DIC 975 REDUCER" under PRESS CHEMICALS — but a TACK reducer goes
      into the ink, and Siegwerk prices two of them at 885/kg alongside the
      inks. Filed as a solvent wash it would be compared against benzene at 170.
    */
    markers: ['TACK REDUCER', 'TACK REDUCING', 'ANTI SCUMMING', 'ANTI SKIN', 'RAPID DRIER', 'DRIER', 'ADDITIVE'],
  },
];

/**
 * A coating is aqueous or UV and nothing else, so its chemistry reads off the
 * same markers with a narrower answer. Kept as its own list because "OFFSET" on
 * a coating row would otherwise make a varnish conventional.
 */
export const COATING_CHEMISTRIES = ['UV', 'WATER_BASED'];

/**
 * The chemistry of a product family, where the name never says it.
 *
 * This is knowledge of the second kind — a fact about a product, not a meaning
 * carried by a word. "VEGA SPRINT PROCESS CYAN" contains nothing that says
 * conventional; it is conventional because Siegwerk makes it that way. Exactly
 * like `BRAND_TYPES` in the paper vocabulary, and just as much a thing to be
 * confirmed rather than inferred.
 *
 * It matters more here than the parallel did for paper, because chemistry is
 * half the comparison key. Without this table the majority of the Siegwerk
 * sheet has no chemistry, and a row with no chemistry gets no key at all —
 * meaning it silently never appears in any comparison.
 */
export const FAMILY_CHEMISTRY = [
  { family: 'SICURA', chemistry: 'UV', confirmedBy: 'CDC', note: 'Siegwerk UV range' },
  { family: 'RADICURE', chemistry: 'UV', confirmedBy: 'CDC', note: 'DIC UV range' },
  { family: 'VEGA SPRINT', chemistry: 'CONVENTIONAL', confirmedBy: 'CDC', note: 'Siegwerk sheetfed' },
  { family: 'VEGA PRIME', chemistry: 'CONVENTIONAL', confirmedBy: 'CDC', note: 'Siegwerk Pantone bases' },
  { family: 'VEGA VIBRANT', chemistry: 'CONVENTIONAL', confirmedBy: 'CDC', note: 'Siegwerk sheetfed' },
  // Bare "VEGA" last, so the named sub-ranges above are matched first. It
  // catches rows like "VEGA ABSOLUTE BLACK PASTE" that name no sub-range.
  { family: 'VEGA', chemistry: 'CONVENTIONAL', confirmedBy: 'CDC', note: 'Siegwerk conventional range' },
  { family: 'AQUATIC', chemistry: 'WATER_BASED', confirmedBy: 'CDC', note: 'DIC aqueous range' },
];

// ── 3. Role ─────────────────────────────────────────────────────────────────

/**
 * What the product is for, within its chemistry and colour.
 *
 * Only compare like against like. A mixing base and a press-ready ink of the
 * same colour are not alternatives.
 */
export const INK_ROLES = [
  {
    canonical: 'MIXING_BASE',
    label: 'Mixing base (Pantone)',
    /*
      Siegwerk numbers its bases and the number is a better identity than the
      name: rubine 175, warm red 225/246, yellow 315, green 456, process blue
      516, fast blue 517, violet 616, black 706, opaque white 002/147,
      transparent medium 228. The same base arrives under four different product
      codes in this one sheet, and the number is what ties them together.
    */
    markers: ['MIXING BASE', 'BASE INK', 'PASTE'],
  },
  { canonical: 'EXTENDER', label: 'Extender / transparent', markers: ['EXTENDER', 'TRANSPARENT MEDIUM', 'TRANS MEDIUM', 'TRANS EXTENDER'] },
  { canonical: 'MEDIUM', label: 'Medium / blending', markers: ['BLENDING MEDIUM', 'MEDIUM', 'BLENDING'] },
  { canonical: 'PRESS_READY', label: 'Press-ready ink', markers: [] },
];

// ── 4. Colour ───────────────────────────────────────────────────────────────

/**
 * The other half of the comparison key.
 *
 * `family` separates the four process colours from the Pantone bases and the
 * metallics, because the price spread between those groups is enormous and a
 * screen that mixes them reads as noise. In one Siegwerk series:
 *
 *     process cyan / magenta / yellow / black    810
 *     warm red                                 1,151
 *     reflex blue                              1,503
 *     fast rhodamine                           1,825
 *     violet                                   3,072
 *     UV gold paste                            4,695
 *
 * Nearly 6x, inside one product family, decided entirely by colour.
 *
 * Longest needle first, so RICH PALE GOLD is not read as GOLD, SILVER GREY is
 * not read as SILVER, and RUBINE RED and WARM RED are not read as RED.
 */
export const COLOURS = [
  // Process
  { canonical: 'CYAN', label: 'Process cyan', family: 'PROCESS', synonyms: ['PROCESS CYAN', 'PRO CYAN', 'PROC CYAN', 'CYAN'] },
  { canonical: 'MAGENTA', label: 'Process magenta', family: 'PROCESS', synonyms: ['PROCESS MAGENTA', 'PRO MAGENTA', 'PROC MAGENTA', 'MAGENTA'] },
  { canonical: 'YELLOW', label: 'Process yellow', family: 'PROCESS', synonyms: ['PROCESS YELLOW', 'PRO YELLOW', 'PROC YELLOW', 'YELLOW'] },
  {
    canonical: 'BLACK',
    label: 'Black',
    family: 'PROCESS',
    // "Absolute", "intensive" and "process" are the makers' adjectives for the
    // same place on the press.
    synonyms: ['PROCESS BLACK', 'ABSOLUTE BLACK', 'INTENSIVE BLACK', 'PRO BLACK', 'BLACK'],
  },

  // Pantone bases and specials
  { canonical: 'REFLEX_BLUE', label: 'Reflex blue', family: 'BASE', synonyms: ['REFLEX BLUE', 'REFLEX'] },
  { canonical: 'PROCESS_BLUE', label: 'Process blue', family: 'BASE', synonyms: ['PROCESS BLUE'] },
  { canonical: 'FAST_BLUE', label: 'Fast blue', family: 'BASE', synonyms: ['FAST BLUE R S', 'FAST BLUE'] },
  { canonical: 'VIOLET', label: 'Violet', family: 'BASE', synonyms: ['FAST VIOLET', 'VIOLET'] },
  { canonical: 'RHODAMINE', label: 'Rhodamine', family: 'BASE', synonyms: ['FAST RHODAMINE', 'RHODAMINE'] },
  { canonical: 'RUBINE_RED', label: 'Rubine red', family: 'BASE', synonyms: ['RUBINE RED', 'RUBINE'] },
  { canonical: 'WARM_RED', label: 'Warm red', family: 'BASE', synonyms: ['FAST WARM RED', 'WARM RED'] },
  { canonical: 'RED_032', label: 'Red 032', family: 'BASE', synonyms: ['RED 032'] },
  { canonical: 'ORANGE', label: 'Orange', family: 'BASE', synonyms: ['ORANGE'] },
  { canonical: 'GREEN', label: 'Green', family: 'BASE', synonyms: ['PROCESS GREEN', 'GREEN'] },
  { canonical: 'OPAQUE_WHITE', label: 'Opaque white', family: 'BASE', synonyms: ['FLEXI OPAQUE WHITE PLUS', 'OPAQUE WHITE', 'BRIGHT WHITE', 'WHITE'] },
  { canonical: 'TRANSPARENT', label: 'Transparent', family: 'BASE', synonyms: ['TRANSPARENT WHITE', 'TRANSPARENT', 'TRANS', 'CLEAR'] },

  // Metallics
  { canonical: 'SILVER_GREY', label: 'Silver grey', family: 'METALLIC', synonyms: ['SPL SILVER GREY', 'SILVER GREY', 'SILVER GRAY'] },
  { canonical: 'PALE_GOLD', label: 'Pale gold', family: 'METALLIC', synonyms: ['RICH PALE GOLD', 'PALE GOLD'] },
  { canonical: 'GOLD', label: 'Gold', family: 'METALLIC', synonyms: ['GOLD'] },
  { canonical: 'SILVER', label: 'Silver', family: 'METALLIC', synonyms: ['SILVER'] },
];

// ── 5. Coating finish ───────────────────────────────────────────────────────

/**
 * The coating equivalent of colour, and priced just as hard. On the same Print
 * Sales page, per kg:
 *
 *     TEXTURE GLOSS    400        UV GLOSS       410
 *     UV SUPER MATT    820        TEXTURE MATT  1120
 *
 * A texture matt read as a plain matt would be compared against a coating less
 * than half its price.
 */
export const COATING_FINISHES = [
  { canonical: 'TEXTURE_MATT', label: 'Texture matt', synonyms: ['TEXTURE MATT', 'TEXTURED MATT', 'TEXTURE MATTE'] },
  { canonical: 'TEXTURE_GLOSS', label: 'Texture gloss', synonyms: ['TEXTURE GLOSS', 'GLOSS TEXTURE', 'TEXTURED GLOSS', 'SPL GLOSS TEXTURE'] },
  { canonical: 'SUPER_MATT', label: 'Super matt', synonyms: ['SUPER MATT', 'EXTRA MATT'] },
  { canonical: 'HIGH_GLOSS', label: 'High gloss', synonyms: ['HIGH GLOSS'] },
  { canonical: 'SOFT_TOUCH', label: 'Soft touch', synonyms: ['SOFT TOUCH', 'SOFTTOUCH', 'VELVET'] },
  { canonical: 'PRIMER', label: 'Primer', synonyms: ['PRIMER'] },
  { canonical: 'SEALER', label: 'Sealer', synonyms: ['NEUTRAL SEALER', 'SEALER'] },
  { canonical: 'MATT', label: 'Matt', synonyms: ['MATT', 'MATTE'] },
  { canonical: 'GLOSS', label: 'Gloss', synonyms: ['GLOSS'] },
];

/**
 * Recorded, but not part of the comparison key. "HIGH SLIP" describes how the
 * coated sheet behaves in the stack, not what finish it gives.
 */
export const COATING_PROPERTIES = [
  { value: 'HIGH_SLIP', markers: ['HIGH SLIP', 'HI SLIP'] },
  { value: 'FOIL_STAMPING', markers: ['FOIL STAMPING', 'FOIL STAMPABLE'] },
];

// ── 6. Press chemical function ──────────────────────────────────────────────

/**
 * What a chemical does — the comparison key for a category that has no colour
 * and no finish.
 *
 * Deliberately coarse. Nine buckets that a buyer would accept as "these are
 * alternatives to each other" beats thirty that each hold one product.
 */
export const CHEMICAL_FUNCTIONS = [
  { canonical: 'BLANKET_CARE', label: 'Blanket care', markers: ['BLANKET VITALISER', 'BLANKET SAVER', 'BLANKET'] },
  { canonical: 'ROLLER_CARE', label: 'Roller care', markers: ['ROL O PAST', 'ROL O GEL', 'CALCIUM FIX', 'CLEANFIX UV', 'CLEANFIX', 'PROTECTO', 'ROLLER'] },
  { canonical: 'PLATE_CARE', label: 'Plate care', markers: ['PLATE CLEANER', 'PLATE CLEAN', 'UNIFIN'] },
  { canonical: 'FOUNT', label: 'Fount / dampening', markers: ['FOUNT SYSTEM CLEANER', 'FOUNT', 'FOUNTAIN', 'DAMPENING'] },
  { canonical: 'GUM', label: 'Gum', markers: ['UNI GUM', 'GUM'] },
  { canonical: 'DEVELOPER', label: 'Developer / replenisher', markers: ['DEVELOPER', 'REPLANISHER', 'REPLENISHER', 'THERMOTECH'] },
  { canonical: 'ANTI_SET_OFF', label: 'Anti set-off', markers: ['ANTI SET OFF', 'SET OFF'] },
  { canonical: 'SOLVENT', label: 'Solvent / reducer', markers: ['BENZENE', 'REDUCER', 'SOLVENT', 'THINNER'] },
  { canonical: 'WASH', label: 'Wash / cleaner', markers: ['WASH', 'KLEEN', 'CLEANER', 'SHAMPOO'] },
];

// ── 7. Manufacturers ────────────────────────────────────────────────────────

/**
 * The maker, which on a dealer's quote is a section heading rather than a field.
 *
 * Separate from the supplier and always has been: Print Sales is a dealer, and
 * the same DIC ink could arrive through three of them. The whole point of the
 * comparison is that this field does NOT enter the key — but it has to be
 * recorded, or "who is cheapest on DIC Radicure" becomes unanswerable.
 */
export const MANUFACTURER_ALIASES = [
  { canonical: 'DIC', aliases: ['DIC', 'DIC INDIA', 'DAINIPPON'] },
  { canonical: 'SIEGWERK', aliases: ['SIEGWERK', 'SIEGWERK INDIA', 'SIEG WERK'] },
  // The umlaut survives some PDF text layers and not others, so both spellings.
  { canonical: 'BOETTCHER', aliases: ['BOETTCHER', 'BOTTCHER', 'BÖTTCHER', 'BOETTCHER CHEMICALS'] },
  { canonical: 'CAPRI', aliases: ['CAPRI'] },
  { canonical: 'PANTONE', aliases: ['PANTONE'] },
  { canonical: 'TOYO', aliases: ['TOYO', 'TOYO INK'] },
  { canonical: 'HUBER', aliases: ['HUBER', 'MICHAEL HUBER', 'HUBERGROUP', 'HUBER GROUP'] },
  { canonical: 'FLINT', aliases: ['FLINT', 'FLINT GROUP'] },
  { canonical: 'SAKATA', aliases: ['SAKATA', 'SAKATA INX'] },
  { canonical: 'FUJIFILM', aliases: ['FUJIFILM', 'FUJI FILM', 'FUJI'] },
  { canonical: 'KODAK', aliases: ['KODAK'] },
];

/**
 * Product families, seeded from what these two quotes actually price.
 *
 * A family is not part of the comparison key — it is how a buyer recognises the
 * row. "Sicura Plast 770HS" tells them which of their four UV blacks this is.
 */
export const PRODUCT_FAMILIES = [
  'SICURA PLAST 770HS', 'SICURA PLAST 770 HS', 'SICURA STAR', 'SICURA XTR', 'SICURA FLEX', 'SICURA ANP', 'SICURA',
  'VEGA SPRINT', 'VEGA PRIME', 'VEGA VIBRANT',
  'RADICURE INTENSE 9000', 'RADICURE',
  'AQUATIC ECO SMART', 'AQUATIC VIVID', 'AQUATIC',
  'STAR PLUS', 'DEEP KLEEN', 'INSTA KLEEN', 'MET KLEEN', 'ECNO WASH', 'BROWN JEWEL', 'NOVA NOL',
];

// ── 8. Units and packs ──────────────────────────────────────────────────────

/**
 * What you are charged per. Five bases appear across these three documents and
 * they are NOT interconvertible: a rate per kg and a rate per piece cannot be
 * compared, so the search only ever compares within one base.
 */
export const RATE_UOMS = ['KG', 'LTR', 'PC', 'M2', 'UNIT'];

const RATE_UOM_SYNONYMS = [
  ['M2', ['M2', 'SQM', 'SQ M', 'PER M2', 'M²', 'PER SQM']],
  ['KG', ['KG', 'KGS', 'KILO', 'KILOS', 'KILOGRAM', 'PER KG', 'PER KGS', 'RATE PER KGS', 'RATE PER KG']],
  ['LTR', ['LTR', 'LTRS', 'LITRE', 'LITRES', 'LITER', 'LITERS', 'L', 'PER LTR', 'RATE PER LTR']],
  ['PC', ['PC', 'PCS', 'PIECE', 'PIECES', 'NOS', 'NO', 'PER PC', 'RATE PER PC']],
  ['UNIT', ['UNIT', 'UNITS', 'PER UNIT']],
];

/**
 * PACK SIZE IS NOT THE RATE UNIT, and conflating them is a 20x error.
 *
 *     ECNO WASH KR (20 LTR)    220.00     under "PRESS CHEMICALS - RATE PER LTR."
 *
 * That is Rs 220 a litre and Rs 4,400 a can — confirmed by CDC, who also said
 * the pack can be 5, 10, 20 or 50. Read as "Rs 220 for 20 litres" it becomes
 * Rs 11/litre, twenty times cheaper than the truth, and it would win every
 * comparison it appeared in.
 *
 * So the two live in different fields, and the pack is recorded even though it
 * never enters the arithmetic — a buyer ordering one litre of something sold
 * only in fifties needs to see that before raising the order.
 */
const PACK_PATTERN = /(\d+(?:\.\d+)?)\s*(KGS?|LTRS?|LITRES?|LITERS?|ML|GMS?|GRAMS?|PCS?|NOS?)\b/i;

const PACK_UOM_CANONICAL = [
  [/^KGS?$/i, 'KG', 1],
  [/^(LTRS?|LITRES?|LITERS?)$/i, 'LTR', 1],
  [/^ML$/i, 'LTR', 0.001],
  [/^(GMS?|GRAMS?)$/i, 'KG', 0.001],
  [/^(PCS?|NOS?)$/i, 'PC', 1],
];

// ── 9. What nobody has confirmed ────────────────────────────────────────────

/**
 * Seen in these quotes, meaning unconfirmed, deliberately unmapped.
 *
 * Same workflow as paper: the portal surfaces the word, somebody who buys ink
 * says what it is, and it becomes comparable. Guessing skips the step that
 * makes the answer trustworthy.
 */
export const UNCONFIRMED_INK = [
  { token: 'NOVA NOL', seenIn: 'Print Sales, press chemicals', priced: '220/ltr, same as Ecno Wash', guess: 'a wash?' },
  { token: 'BROWN JEWEL TS', seenIn: 'Print Sales, press chemicals', priced: '177/ltr', guess: null },
  { token: 'DOLLAR SPL', seenIn: 'Siegwerk, UV DOLLAR SPL SILVER GREY', priced: '2,200 — and its Current Price column reads 0', guess: 'a metallic series?' },
  { token: 'JAZZ SPL', seenIn: 'Siegwerk, UV JAZZ SPL SILVER', priced: '2,200', guess: 'a metallic series?' },
  { token: 'TA', seenIn: 'Siegwerk, WATER BASED PRIMER INK - TA and - TA M', priced: '285 / 295', guess: 'what does TA distinguish?' },
  { token: 'MV AB', seenIn: 'Siegwerk, GLOSS UV VARNISH MV --AB and SICURA FLEX MV ES', priced: '370 / 435', guess: 'machine or application code?' },
  { token: 'RL', seenIn: 'Siegwerk, several rows end in RL', priced: 'varies', guess: 'a pack or a plant?' },
];

// ── Resolution ──────────────────────────────────────────────────────────────

/** Punctuation out, single spaces, upper case — the form everything matches in. */
function tokenised(text) {
  return ` ${String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
}

/** Longest-first lookup, so multi-word terms beat the words inside them. */
function lookupFor(entries, valueKey, listKey) {
  return entries
    .flatMap((e) => (e[listKey] || []).map((s) => ({ value: e[valueKey], needle: tokenised(s).trim() })))
    .filter((e) => e.needle)
    .sort((a, b) => b.needle.length - a.needle.length);
}

const CLASS_LOOKUP = CLASS_MARKERS.map((c) => ({
  canonical: c.canonical,
  lookup: lookupFor([c], 'canonical', 'markers'),
}));
const CHEMISTRY_LOOKUP = lookupFor(CHEMISTRIES, 'canonical', 'markers');
const FAMILY_CHEMISTRY_LOOKUP = FAMILY_CHEMISTRY
  .map((f) => ({ value: f.chemistry, needle: tokenised(f.family).trim() }))
  .sort((a, b) => b.needle.length - a.needle.length);
const ROLE_LOOKUP = lookupFor(INK_ROLES, 'canonical', 'markers');
const COLOUR_LOOKUP = lookupFor(COLOURS, 'canonical', 'synonyms');
const FINISH_LOOKUP = lookupFor(COATING_FINISHES, 'canonical', 'synonyms');
const PROPERTY_LOOKUP = lookupFor(COATING_PROPERTIES, 'value', 'markers');
const FUNCTION_LOOKUP = lookupFor(CHEMICAL_FUNCTIONS, 'canonical', 'markers');
const MANUFACTURER_LOOKUP = lookupFor(MANUFACTURER_ALIASES, 'canonical', 'aliases');
const FAMILY_LOOKUP = PRODUCT_FAMILIES
  .map((f) => ({ value: f, needle: tokenised(f).trim() }))
  .sort((a, b) => b.needle.length - a.needle.length);
const RATE_UOM_LOOKUP = RATE_UOM_SYNONYMS
  .flatMap(([value, syns]) => syns.map((s) => ({ value, needle: tokenised(s).trim() })))
  .filter((e) => e.needle)
  .sort((a, b) => b.needle.length - a.needle.length);
const UNCONFIRMED_TOKENS = UNCONFIRMED_INK.map((u) => tokenised(u.token).trim());

/** First whole-word hit from a longest-first lookup, or null. */
function resolve(lookup, text) {
  const haystack = tokenised(text);
  if (haystack.trim() === '') return null;
  const hit = lookup.find((e) => haystack.includes(` ${e.needle} `));
  return hit ? hit.value : null;
}

/**
 * INK, COATING, PRESS_CHEMICAL, PLATE, CONSUMABLE, or null.
 *
 * Order decides two collisions that whole-word matching cannot: a coating named
 * "OP INK" is a coating, and a "PLATE CLEANER" is a chemical. Both are checked
 * before the class whose word they contain.
 */
export function resolveMaterialClass(text) {
  /*
    Additives are settled first, because the press-chemical markers would
    otherwise claim them. "UV LIQUID TACK REDUCER" (875/kg, sold beside the
    inks) contains REDUCER, and filed as a solvent it would be compared against
    benzene at 170/ltr — a different unit, a different shelf, a different thing.
  */
  if (resolve(CHEMISTRY_LOOKUP, text) === 'ADDITIVE') return 'INK';

  for (const { canonical, lookup } of CLASS_LOOKUP) {
    if (resolve(lookup, text)) return canonical;
    /*
      A chemical is anything the function table recognises. Boettcher and DIC
      name their chemicals after nothing in particular — CLEANFIX, ROL-O-GEL,
      THERMOTECH, UNIFIN, BLANKET SAVER — so there is no generic word to match
      and the function table is the only thing that knows them.
    */
    if (canonical === 'PRESS_CHEMICAL' && resolve(FUNCTION_LOOKUP, text)) return canonical;
  }

  /*
    MOST INK NEVER SAYS "INK". Not one of "RADICURE INTENSE 9000 PRO CYAN",
    "VEGA SPRINT PROCESS CYAN" or "SICURA PLAST 770HS REFLEX BLUE" contains the
    word, and between them they are most of both quotes. A colour with no
    coating, chemical or plate word beside it is an ink — which is safe only
    because this runs last, after "OP INK" has already been claimed as a
    coating and "PLATE CLEANER" as a chemical.
  */
  if (resolve(COLOUR_LOOKUP, text)) return 'INK';

  /*
    Two more silences, both from the Siegwerk sheet:

      SICURA UV TEXTURE MATT - HG      a coating that never says varnish
      SICURA ANTI SCUMMING PASTE       an additive that never says ink

    A finish with no colour is a coating; an additive is something you put in
    ink. Both run after the colour fallback, so "SUPER GLOSS RICH PALE GOLD
    INK" — which carries a finish AND a colour — stays an ink.
  */
  if (resolve(FINISH_LOOKUP, text)) return 'COATING';
  return null;
}

/**
 * The chemistry, narrowed by class where the class constrains it.
 *
 * A coating is only ever aqueous or UV, so a varnish whose name happens to
 * carry "offset" does not become conventional.
 */
export function resolveChemistry(text, materialClass = null) {
  const found = resolve(CHEMISTRY_LOOKUP, text) || resolve(FAMILY_CHEMISTRY_LOOKUP, text);
  if (!found) return null;

  const klass = materialClass || resolveMaterialClass(text);

  if (klass === 'COATING') {
    // Coatings are aqueous or UV and nothing else, so a varnish whose name
    // happens to carry "offset" does not become conventional.
    return COATING_CHEMISTRIES.includes(found) ? found : null;
  }

  /*
    Water-based ink is real and CDC buys it, but they compare it as
    conventional — confirmed by CDC. Left as its own chemistry it would key
    separately and "WB CDC SPL BLACK 2024" would never appear beside the other
    blacks it competes with.
  */
  if (found === 'WATER_BASED') return 'CONVENTIONAL';
  return found;
}

/**
 * PRESS_READY, MIXING_BASE, EXTENDER or MEDIUM.
 *
 * Press-ready is the answer when nothing says otherwise, and that default is
 * safe in the direction that matters: a base wrongly called press-ready is
 * visible to anyone reading the row, whereas a press-ready ink hidden under
 * MIXING_BASE simply never appears in the comparison a buyer is making.
 */
export function resolveRole(text) {
  /*
    Not every paste is a Pantone base. "SICURA ANTI SCUMMING PASTE" is an
    additive that happens to be supplied as one, and reading it as a mixing
    base would file a press aid among the colours a buyer mixes shades from.
    An additive has no role in this sense, so it takes the default.
  */
  if (resolve(CHEMISTRY_LOOKUP, text) === 'ADDITIVE') return 'PRESS_READY';
  return resolve(ROLE_LOOKUP, text) || 'PRESS_READY';
}

/** The colour named in `text`, or null — additives and chemicals have none. */
export function resolveColour(text) {
  return resolve(COLOUR_LOOKUP, text);
}

/** The coating finish, or null. */
export function resolveFinish(text) {
  return resolve(FINISH_LOOKUP, text);
}

/** Coating behaviour that is recorded but never compared on. */
export function resolveCoatingProperty(text) {
  return resolve(PROPERTY_LOOKUP, text);
}

/** What a press chemical does, or null. */
export function resolveChemicalFunction(text) {
  return resolve(FUNCTION_LOOKUP, text);
}

export function resolveManufacturer(text) {
  return resolve(MANUFACTURER_LOOKUP, text);
}

/** The product family, for recognition rather than for matching. */
export function resolveFamily(text) {
  return resolve(FAMILY_LOOKUP, text);
}

/**
 * The Pantone base number, where the product carries one.
 *
 * Only meaningful on a mixing base, and only claimed there: a bare number in a
 * press-ready ink's name is far more likely to be a series ("Radicure Intense
 * 9000", "Sicura Plast 770HS") than a base number, and reading it as one would
 * merge every 9000-series ink into a single imaginary base.
 */
export function resolveBaseNumber(text) {
  if (resolveRole(text) !== 'MIXING_BASE') return null;
  const match = tokenised(text).match(/\bPASTE\s+(\d{2,3})\b/);
  return match ? match[1] : null;
}

/** KG, LTR, PC, M2, UNIT, or null. */
export function resolveRateUom(text) {
  return resolve(RATE_UOM_LOOKUP, text);
}

/**
 * The pack a product is sold in — `{ size, uom, inBaseUom }` — or null.
 *
 * "(500 ML)" becomes half a litre and "(250 ML)" a quarter, so pack sizes
 * remain comparable to each other without ever touching the rate.
 */
export function parsePack(text) {
  const match = String(text ?? '').match(PACK_PATTERN);
  if (!match) return null;

  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return null;

  const entry = PACK_UOM_CANONICAL.find(([pattern]) => pattern.test(match[2]));
  if (!entry) return null;

  const [, uom, factor] = entry;
  return { size, uom, inBaseUom: Number((size * factor).toFixed(6)) };
}

/** Unconfirmed terms present in `text`, for the reviewer to settle. */
export function unconfirmedInkTokens(text) {
  const haystack = tokenised(text);
  return UNCONFIRMED_TOKENS.filter((t) => haystack.includes(` ${t} `));
}

/**
 * The key two rows must share to be worth showing side by side.
 *
 * This is the whole design in one function. It is deliberately narrow, and the
 * manufacturer is deliberately absent — DIC's Radicure cyan and Siegwerk's
 * Sicura cyan produce the same key, which is exactly what CDC asked for.
 *
 * Returns null when the row is not comparable to anything: without a class
 * there is nothing to say, and a key of mostly-nulls would pool every
 * unreadable row into one bucket that looks like a match.
 */
export function comparisonKey(line = {}) {
  const materialClass = line.materialClass || resolveMaterialClass(line.productName);
  if (!materialClass) return null;

  const parts = [materialClass];

  if (materialClass === 'INK') {
    const chemistry = line.chemistry || resolveChemistry(line.productName, materialClass);
    const colour = line.colour || resolveColour(line.productName);
    const role = line.role || resolveRole(line.productName);
    if (!chemistry) return null;
    parts.push(chemistry, role, colour || 'NO_COLOUR');
  } else if (materialClass === 'COATING') {
    const chemistry = line.chemistry || resolveChemistry(line.productName, materialClass);
    const finish = line.finish || resolveFinish(line.productName);
    if (!chemistry) return null;
    /*
      A coating that never states its finish gets its own bucket rather than no
      key at all. DIC's "AQUATIC ECO SMART OP INK" (220/kg) is a general-purpose
      aqueous coating and the quote says nothing about gloss or matt. Refusing
      it a key drops it from every screen; pooling it with the gloss coatings
      would compare it against something it may not be. NO_FINISH does neither,
      and it is a question the reading layer can put to a person.
    */
    parts.push(chemistry, finish || 'NO_FINISH');
  } else if (materialClass === 'PRESS_CHEMICAL') {
    const fn = line.chemicalFunction || resolveChemicalFunction(line.productName);
    if (!fn) return null;
    parts.push(fn);
  } else {
    // Plates and consumables are compared by product, not by spec.
    const name = tokenised(line.productName).trim();
    if (!name) return null;
    parts.push(name);
  }

  /*
    The rate unit closes the key because the bases do not convert. A plate at
    382 per piece and a varnish at 400 per kg are two numbers that must never
    be sorted against each other.
  */
  const uom = line.rateUom || null;
  if (uom) parts.push(uom);

  return parts.join('|');
}

/** The label a person reads, for any canonical value in this vocabulary. */
export function inkLabel(canonical) {
  if (!canonical) return null;
  const found = [...MATERIAL_CLASSES, ...CHEMISTRIES, ...INK_ROLES, ...COLOURS, ...COATING_FINISHES, ...CHEMICAL_FUNCTIONS]
    .find((e) => e.canonical === canonical);
  return found?.label || canonical;
}
