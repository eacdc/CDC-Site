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
 * Pure: the caller loads the items.
 */

import { normaliseName } from '../../lib/text.js';

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
  return { quality, mills, groupIds: groupIds.sort((a, b) => a - b), gsmFrom, gsmTo };
}

/** Is this Indus item inside the band? */
export function itemInBand(item = {}, band = {}) {
  if (!band?.quality) return false;
  if (!(band.groupIds?.length ? band.groupIds : PAPER_GROUP_IDS).includes(Number(item.ItemGroupID))) return false;
  const gsm = Number(item.GSM);
  if (!Number.isFinite(gsm) || gsm < band.gsmFrom || gsm > (band.gsmTo ?? band.gsmFrom)) return false;
  if (!same(item.Quality, band.quality)) return false;
  if (band.mills?.length && !band.mills.some((m) => same(m, item.Manufecturer))) return false;
  return true;
}

/** "FBB, ITC or Emami, sheet, 250-284 GSM": for the review page and the evidence. */
export function bandLabel(band = {}) {
  const groups = (band.groupIds?.length ? band.groupIds : PAPER_GROUP_IDS);
  const form = groups.length === 1 ? GROUP_LABEL[groups[0]].toLowerCase() : 'sheet or reel';
  const gsm = band.gsmTo && band.gsmTo !== band.gsmFrom ? `${band.gsmFrom}-${band.gsmTo}` : `${band.gsmFrom}`;
  return [band.quality, band.mills?.length ? band.mills.join(' or ') : 'any mill', form, `${gsm} GSM`].join(', ');
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
