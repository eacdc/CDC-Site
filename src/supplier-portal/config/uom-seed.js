/**
 * UOM normalisation seed (§17).
 *
 * Group 6 alone carries six spellings of one unit. The canonical value drives
 * every comparison; the raw spelling is preserved on the line for display,
 * because a quote that says "Sq. Meter" should still read "Sq. Meter" when a
 * buyer checks it against the paper document.
 *
 * `factor` converts the raw unit into the canonical one. It is 1 for every
 * spelling variant and only differs where the raw unit is a genuinely
 * different magnitude (MT vs KG).
 */

export const UOM_SEED = [
  // Area
  { raw: 'SQ. METER', canonical: 'SQM', factor: 1 },
  { raw: 'SQ.METER', canonical: 'SQM', factor: 1 },
  { raw: 'SQ METER', canonical: 'SQM', factor: 1 },
  { raw: 'SQ.MTR', canonical: 'SQM', factor: 1 },
  { raw: 'SQM', canonical: 'SQM', factor: 1 },
  { raw: 'SQ M', canonical: 'SQM', factor: 1 },
  { raw: 'M2', canonical: 'SQM', factor: 1 },
  { raw: 'M²', canonical: 'SQM', factor: 1 },

  // Mass
  { raw: 'KG', canonical: 'KG', factor: 1 },
  { raw: 'KGS', canonical: 'KG', factor: 1 },
  { raw: 'KGS.', canonical: 'KG', factor: 1 },
  { raw: 'KILOGRAM', canonical: 'KG', factor: 1 },
  { raw: 'KILOGRAMS', canonical: 'KG', factor: 1 },
  // NR Agarwal quotes per metric tonne while everyone else quotes per kg.
  // A silent miss here is a 1000x error, which is why EXT005 exists.
  { raw: 'MT', canonical: 'KG', factor: 1000 },
  { raw: 'M.T.', canonical: 'KG', factor: 1000 },
  { raw: 'MTON', canonical: 'KG', factor: 1000 },
  { raw: 'TON', canonical: 'KG', factor: 1000 },
  { raw: 'TONNE', canonical: 'KG', factor: 1000 },
  { raw: 'GM', canonical: 'KG', factor: 0.001 },
  { raw: 'GRAM', canonical: 'KG', factor: 0.001 },

  // Count
  { raw: 'NOS', canonical: 'NOS', factor: 1 },
  { raw: 'NO', canonical: 'NOS', factor: 1 },
  { raw: 'NO.', canonical: 'NOS', factor: 1 },
  { raw: 'NUMBER', canonical: 'NOS', factor: 1 },
  { raw: 'UNIT', canonical: 'NOS', factor: 1 },
  { raw: 'PCS', canonical: 'PCS', factor: 1 },
  { raw: 'PC', canonical: 'PCS', factor: 1 },
  { raw: 'PIECE', canonical: 'PCS', factor: 1 },
  { raw: 'PIECES', canonical: 'PCS', factor: 1 },

  // Volume
  { raw: 'LTR', canonical: 'LTR', factor: 1 },
  { raw: 'LTRS', canonical: 'LTR', factor: 1 },
  { raw: 'LITRE', canonical: 'LTR', factor: 1 },
  { raw: 'LITRES', canonical: 'LTR', factor: 1 },
  { raw: 'LITERS', canonical: 'LTR', factor: 1 },
  { raw: 'LITER', canonical: 'LTR', factor: 1 },
  { raw: 'L', canonical: 'LTR', factor: 1 },
  { raw: 'ML', canonical: 'LTR', factor: 0.001 },

  // Sheets and rolls
  { raw: 'SHEET', canonical: 'SHEET', factor: 1 },
  { raw: 'SHEETS', canonical: 'SHEET', factor: 1 },
  { raw: 'SHT', canonical: 'SHEET', factor: 1 },
  { raw: 'ROLL', canonical: 'ROLL', factor: 1 },
  { raw: 'ROLLS', canonical: 'ROLL', factor: 1 },
  { raw: 'REEL', canonical: 'ROLL', factor: 1 },

  // Sets and packs
  { raw: 'SET', canonical: 'SET', factor: 1 },
  { raw: 'SETS', canonical: 'SET', factor: 1 },
  { raw: 'EACH', canonical: 'SET', factor: 1 },
  { raw: 'BOX', canonical: 'BOX', factor: 1 },
  { raw: 'BOXES', canonical: 'BOX', factor: 1 },
  { raw: 'CARTON', canonical: 'BOX', factor: 1 },

  // Length
  { raw: 'MTR', canonical: 'MTR', factor: 1 },
  { raw: 'METER', canonical: 'MTR', factor: 1 },
  { raw: 'METRE', canonical: 'MTR', factor: 1 },
  { raw: 'METERS', canonical: 'MTR', factor: 1 },
  { raw: 'M', canonical: 'MTR', factor: 1 },
];

/**
 * Units whose meaning cannot be settled from the spelling alone. These
 * resolve to null and raise EXT004 so a human decides, rather than the
 * extractor guessing between an area and a length.
 */
export const AMBIGUOUS_UOMS = ['SQ INCH', 'SQ.INCH', 'INCH', '"', 'IN'];

/** The canonical set. Anything outside it is a bug in the seed, not data. */
export const CANONICAL_UOMS = [
  'KG', 'LTR', 'PCS', 'NOS', 'ROLL', 'SET', 'SQM', 'MTR', 'BOX', 'SHEET',
];
