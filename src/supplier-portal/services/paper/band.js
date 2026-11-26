/**
 * Paper bands: how a paper quote line is approved.
 *
 * A paper quote prices a quality over a GSM band - "NR Power Fold FBB,
 * 250-284 GSM, Rs X/kg" - with no size. Indus has one item per quality, GSM
 * and size, so that one line is the price of dozens of items, sometimes
 * hundreds, and approving it as any single one of them would be wrong. The
 * reviewer approves the band instead: an Indus quality, the mills it covers
 * (none named means any), sheet or reel or both, and the GSM range. Every
 * Indus item inside it takes the line's rate. A per-kg rate does not depend on
 * the size, which is why the size can be left out.
 *
 * The reviewer can also untick items the rule covers (`excludeItemIds`) and
 * add ones it does not (`includeItemIds`). An Indus item created later that
 * fits the rule joins the band; an unticked one stays out.
 *
 * Pure: the caller loads the items.
 */

import { normaliseName } from '../../lib/text.js';
import { resolvePaperType, resolveMill, resolveAttributes } from '../../config/paper-vocabulary.js';
import { parseForm } from '../../lib/spec.js';

/** Indus item groups a band can cover: 2 is reel, 14 is sheet. */
export const PAPER_GROUP_IDS = [2, 14];
export const GROUP_LABEL = { 2: 'Reel', 14: 'Sheet' };

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const text = (v) => String(v ?? '').trim();
const same = (a, b) => normaliseName(a) === normaliseName(b);

/**
 * A reviewer's band, checked and in one shape, or a 400 saying what is wrong.
 * Mills are kept as Indus spells them, since that is what they are matched on.
 */
export function cleanBand(input = {}) {
  const quality = text(input.quality);
  if (!quality) throw fail('A paper band needs the Indus quality.');
  const gsmFrom = Number(input.gsmFrom);
  const gsmTo = Number(input.gsmTo ?? input.gsmFrom);
  if (!Number.isFinite(gsmFrom) || gsmFrom <= 0 || !Number.isFinite(gsmTo) || gsmTo < gsmFrom) {
    throw fail('A paper band needs a GSM range: from, and a "to" no lower than it.');
  }
  const groupIds = [...new Set((input.groupIds?.length ? input.groupIds : PAPER_GROUP_IDS).map(Number))];
  if (!groupIds.every((g) => PAPER_GROUP_IDS.includes(g))) throw fail('A paper band covers sheets (14), reels (2) or both.');
  const mills = [...new Set((input.mills || []).map(text).filter(Boolean))];
  const ids = (list) => [...new Set((list || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const excludeItemIds = ids(input.excludeItemIds);
  const out = new Set(excludeItemIds);
  const includeItemIds = ids(input.includeItemIds).filter((n) => !out.has(n));
  return {
    quality, mills, groupIds: groupIds.sort((a, b) => a - b), gsmFrom, gsmTo, excludeItemIds, includeItemIds,
  };
}

/** Does the band's rule (quality, form, GSM, mills) cover this item, before any item is ticked or unticked? */
export function itemInBandRule(item = {}, band = {}) {
  if (!band?.quality) return false;
  if (!(band.groupIds?.length ? band.groupIds : PAPER_GROUP_IDS).includes(Number(item.ItemGroupID))) return false;
  const gsm = Number(item.GSM);
  if (!Number.isFinite(gsm) || gsm < band.gsmFrom || gsm > (band.gsmTo ?? band.gsmFrom)) return false;
  if (!same(item.Quality, band.quality)) return false;
  if (band.mills?.length && !band.mills.some((m) => same(m, item.Manufecturer))) return false;
  return true;
}

/** Is this Indus item inside the band: its rule, less the unticked items, plus the added ones? */
export function itemInBand(item = {}, band = {}) {
  if (!band?.quality) return false;
  const id = Number(item.ItemID);
  if (band.excludeItemIds?.includes(id)) return false;
  if (band.includeItemIds?.includes(id)) return true;
  return itemInBandRule(item, band);
}

/** "FBB, ITC or Emami, sheet, 250-284 GSM": for the review page and the evidence. */
export function bandLabel(band = {}) {
  const groups = (band.groupIds?.length ? band.groupIds : PAPER_GROUP_IDS);
  const form = groups.length === 1 ? GROUP_LABEL[groups[0]].toLowerCase() : 'sheet or reel';
  const gsm = band.gsmTo && band.gsmTo !== band.gsmFrom ? `${band.gsmFrom}-${band.gsmTo}` : `${band.gsmFrom}`;
  const edits = [
    band.excludeItemIds?.length && `${band.excludeItemIds.length} left out`,
    band.includeItemIds?.length && `${band.includeItemIds.length} added`,
  ].filter(Boolean);
  return [band.quality, band.mills?.length ? band.mills.join(' or ') : 'any mill', form, `${gsm} GSM`].join(', ')
    + (edits.length ? ` (${edits.join(', ')})` : '');
}

/**
 * What a reviewer can choose from for a GSM range: each Indus quality in it,
 * the mills that make it, and how many items each covers as sheet and reel.
 * Most items first, so the likely quality is at the top.
 */
export function bandChoices(items = []) {
  const qualities = new Map();
  for (const it of items) {
    const quality = text(it.Quality);
    const group = Number(it.ItemGroupID);
    if (!quality || quality.toUpperCase() === 'NULL' || !PAPER_GROUP_IDS.includes(group)) continue;
    const key = normaliseName(quality);
    if (!qualities.has(key)) qualities.set(key, { quality, items: 0, byGroup: {}, mills: new Map() });
    const q = qualities.get(key);
    q.items += 1;
    q.byGroup[group] = (q.byGroup[group] || 0) + 1;
    const mill = text(it.Manufecturer);
    if (mill && mill.toUpperCase() !== 'NULL') q.mills.set(mill, (q.mills.get(mill) || 0) + 1);
  }
  return [...qualities.values()]
    .map((q) => ({ ...q, mills: [...q.mills].map(([mill, n]) => ({ mill, items: n })).sort((a, b) => b.items - a.items) }))
    .sort((a, b) => b.items - a.items);
}

/**
 * Indus's quality names for each paper type the vocabulary reads, in the
 * order they are tried. Natural shade maplitho is a quality of its own.
 */
const INDUS_QUALITIES = {
  MAPLITHO: ['Maplitho'],
  MAPLITHO_NATURAL: ['NS Maplitho'],
  FBB: ['FBB'],
  CBB: ['CBB'],
  GREY_BACK: ['Grey Back'],
  WHITE_BACK: ['White Back'],
  GLOSS_ART: ['Gloss Art'],
  MATTE_ART: ['Matte Art'],
  KRAFT: ['KRAFT', 'Kraft Paper (Brown)'],
  KRAFT_BOARD: ['Kraft Board (Brown)'],
  NEWSPRINT: ['News Print', 'Newsprint'],
  POSTER: ['Poster'],
  BIBLE_PAPER: ['Bible Paper'],
  GUMMING_SHEET: ['Gumming Sheet'],
};

/**
 * The band a paper quote line most likely is, for a reviewer to approve:
 * the Indus quality its paper type is filed as, the mill it names (any, when
 * it names none), sheet or reel when it says, and its GSM range. Null when
 * the line has a size (it prices one item), states no GSM, or its type has no
 * Indus quality in that range; the line is then left for a person.
 *
 * @param {Object} line   the read line: productName, brand, grade, gsmFrom, gsmTo, sizeText, notes
 * @param {Array}  items  Indus paper items in the line's GSM range (paperItemsInGsmRange)
 * @param {Object} [opts]
 * @param {string} [opts.paperType]  a type CDC's bills settled, over the one the words give
 * @returns {{ band, itemCount, rationale } | null}
 */
export function proposeBand(line = {}, items = [], { paperType = null } = {}) {
  if (text(line.sizeText)) return null;
  const gsmFrom = Number(line.gsmFrom ?? line.gsmTo);
  const gsmTo = Number(line.gsmTo ?? line.gsmFrom);
  if (!Number.isFinite(gsmFrom) || gsmFrom <= 0 || !Number.isFinite(gsmTo) || gsmTo < gsmFrom) return null;
  const words = [line.productName, line.brand, line.grade].filter(Boolean).join(' ');
  const type = paperType || resolvePaperType(words);
  if (!type) return null;
  const natural = type === 'MAPLITHO' && resolveAttributes(words).shade === 'NATURAL';
  items = items.filter((it) => Number(it.GSM) >= gsmFrom && Number(it.GSM) <= gsmTo);
  const choices = bandChoices(items);
  const choice = (INDUS_QUALITIES[natural ? 'MAPLITHO_NATURAL' : type] || [])
    .map((q) => choices.find((c) => same(c.quality, q)))
    .find(Boolean);
  if (!choice) return null;

  const form = parseForm([words, line.notes].filter(Boolean).join(' '));
  const groupIds = form === 'SHEET' ? [14] : form === 'REEL' ? [2] : PAPER_GROUP_IDS.filter((g) => choice.byGroup[g]);
  const mill = resolveMill(words);
  const mills = mill ? choice.mills.map((m) => m.mill).filter((m) => resolveMill(m) === mill) : [];
  const band = cleanBand({ quality: choice.quality, mills, groupIds, gsmFrom, gsmTo });
  const itemCount = items.filter((it) => itemInBand(it, band)).length;
  if (!itemCount) return null;
  const why = [
    `"${words}" is ${type.replace(/_/g, ' ').toLowerCase()}${paperType ? " (CDC's bills)" : ''}, filed in Indus as ${choice.quality}`,
    mill && !mills.length ? `the quote names ${mill}, but Indus has no ${choice.quality} of that mill in this range, so any mill` : null,
    `${itemCount} Indus items in ${bandLabel(band)}`,
  ].filter(Boolean);
  return { band, itemCount, rationale: `${why.join('; ')}.` };
}
