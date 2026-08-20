/**
 * Splitting a quote that prices both plants.
 *
 * Some suppliers price Kolkata and Ahmedabad on one page — NR quotes three
 * board brands over eight GSM bands in two side-by-side rate columns, 48 rates
 * on a single sheet. The rest of the application assumes one document prices
 * one plant: `plantScope`, the approval, the PO check and the rate history all
 * hang off the document.
 *
 * So a two-plant file becomes two documents at extraction, one per plant, each
 * pointing at the same stored file. That keeps every downstream stage exactly
 * as it was, at the cost of two records to approve instead of one.
 *
 * The alternative — per-line plants on a single document — would have kept the
 * file and the record one-to-one, but every consumer of `plantScope` would
 * have had to learn that a document can straddle plants, and the rule that
 * rates never cross plants is enforced in those consumers. Splitting keeps that
 * rule structural.
 *
 * Nothing here touches the database: this module decides *what* the split is,
 * and `quotes.js` carries it out.
 */

import { PLANTS } from '../config/constants.js';

/**
 * Resolve a plant as written on a document to one of ours.
 *
 * Tangra and Panchla are both the Kolkata database — the two CDC units share
 * `IndusEnterprise` — so an address naming either is Kolkata. Anything we do
 * not recognise returns null and is treated as unplaced rather than guessed
 * at; filing a rate against the wrong plant is silent and permanent.
 */
export function normalisePlant(value) {
  const text = String(value ?? '').toUpperCase();
  if (!text.trim()) return null;
  if (/\bAHMEDABAD\b|\bAHM\b|\bGUJARAT\b/.test(text)) return PLANTS.AHM;
  if (/\bKOLKATA\b|\bCALCUTTA\b|\bKOL\b|\bTANGRA\b|\bPANCHLA\b|\bHOWRAH\b/.test(text)) {
    return PLANTS.KOL;
  }
  return null;
}

/**
 * Group extracted lines by the plant each one prices.
 *
 * Precedence is deliberate. A `plant` written on the line wins, because it came
 * from the rate column the row was actually in. `plantBlocks` is the fallback
 * for documents laid out as separate blocks. A line with neither is
 * **unplaced**, and unplaced lines are copied into *every* group rather than
 * dropped or assigned to the first: a note row or a band that only appears in
 * one column is far more likely to apply to both plants than to belong to one,
 * and losing a priced row silently is the worst outcome available.
 *
 * @param {Array} lines            extracted quote lines
 * @param {Array} [plantBlocks]    [{plant, lineNos}] from the extractor
 * @returns {{plants: string[], groups: Map<string, Array>, unplaced: Array}}
 */
export function groupLinesByPlant(lines = [], plantBlocks = null) {
  const byLineNo = new Map();
  for (const block of plantBlocks || []) {
    const plant = normalisePlant(block?.plant);
    if (!plant) continue;
    for (const lineNo of block.lineNos || []) byLineNo.set(Number(lineNo), plant);
  }

  const groups = new Map();
  const unplaced = [];

  for (const line of lines) {
    const plant = normalisePlant(line?.plant) || byLineNo.get(Number(line?.lineNo)) || null;
    if (!plant) {
      unplaced.push(line);
      continue;
    }
    if (!groups.has(plant)) groups.set(plant, []);
    groups.get(plant).push(line);
  }

  // Every group gets the unplaced rows. With only one group this is simply the
  // whole document, unchanged — which is the common case and must stay free.
  for (const rows of groups.values()) {
    if (unplaced.length) rows.push(...unplaced);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) => (Number(a?.lineNo) || 0) - (Number(b?.lineNo) || 0));
  }

  return { plants: [...groups.keys()], groups, unplaced };
}

/**
 * The split plan for one extraction, or null when there is nothing to split.
 *
 * Returns null for the ordinary single-plant document so the caller can keep
 * its existing path untouched — a split that fires on every upload would be a
 * far bigger change than the one this is meant to be.
 *
 * @returns {null | {keep: {plant, lines}, spawn: Array<{plant, lines}>}}
 */
export function planPlantSplit(lines = [], plantBlocks = null) {
  const { plants, groups } = groupLinesByPlant(lines, plantBlocks);
  if (plants.length < 2) return null;

  // Kolkata first when present, so the document the reviewer already has open
  // is the one whose plant matches their usual site rather than an arbitrary
  // winner of Map insertion order.
  const ordered = [...plants].sort((a, b) => {
    if (a === b) return 0;
    if (a === PLANTS.KOL) return -1;
    if (b === PLANTS.KOL) return 1;
    return a.localeCompare(b);
  });

  const [first, ...rest] = ordered;
  return {
    keep: { plant: first, lines: groups.get(first) },
    spawn: rest.map((plant) => ({ plant, lines: groups.get(plant) })),
  };
}
