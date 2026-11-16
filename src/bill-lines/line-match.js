/**
 * Which ERP purchase-invoice line each supplier invoice line is.
 *
 * Phase 1 of Supplier Portal v2 learns the supplier's own names for CDC's
 * items. A GRN bill has already been posted in Indus, so its PI holds the
 * answer for every line; the work here is pairing the supplier's lines with
 * the PI's, and it is done on money and quantity, never on names - the names
 * are what is being learnt.
 *
 * Rate alone never pairs two lines. On a paper bill every line is often at the
 * same rate (AK Trading's PI04071_26_27: three Grey Back sizes, all 49.25/kg),
 * so a rate match there says nothing about which size is which.
 *
 * Everything returned is a SUGGESTION. Nothing is approved here.
 */

import { toNumber } from '../supplier-portal/services/extraction/invoice-review.js';

/** Relative slack on amounts and quantities: 0.5%, at least one rupee / unit. */
const AMOUNT_SLACK = 0.005;
const QTY_SLACK = 0.005;

/** Lines that are charges, not goods, and so have no PI item line. */
const CHARGE_WORDS = /\b(freight|cartage|transport|carriage|packing|forwarding|p\s*&\s*f|loading|unloading|insurance|handling|delivery charge|courier|round\s*off|tcs)\b/i;

const close = (a, b, slack, floor = 1) => (
  a !== null && b !== null && Math.abs(a - b) <= Math.max(floor, Math.abs(b) * slack)
);

/**
 * A supplier invoice number in the form both sides can compare: upper case,
 * no spaces or invisible characters. "2627 / 604" and "2627/604" are one
 * invoice; so are "4100173660" and the same digits with a zero-width space
 * pasted in from a PDF (seen on PI03966_26_27).
 */
export function normaliseInvoiceNo(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).normalize('NFKC').replace(/[\s​-‍﻿]/g, '').toUpperCase();
  return t || null;
}

/** The numbers on one extracted line, and whether it is a charge. */
export function lineNumbers(line = {}) {
  const qty = toNumber(line.qty);
  const rate = toNumber(line.rate);
  const amount = toNumber(line.amount);
  const discountAmount = toNumber(line.discountAmount);
  const taxableValue = toNumber(line.taxableValue);

  // The value CDC paid for the goods: after a line discount when one is printed.
  let value = taxableValue;
  if (value === null && amount !== null) value = discountAmount ? amount - Math.abs(discountAmount) : amount;
  if (value === null && qty !== null && rate !== null) value = qty * rate;

  // Services carry a SAC code starting 99 in the HSN column; goods never do.
  const hsn = String(line.hsn || '').trim();
  const isCharge = CHARGE_WORDS.test(String(line.description || '')) && (!hsn || hsn.startsWith('99'));
  return {
    qty, rate, amount, value,
    netRate: value !== null && qty ? value / qty : rate,
    isCharge,
  };
}

/**
 * Score one supplier line against one PI line.
 * @returns {{amount: boolean, qty: boolean, rate: boolean}}
 */
function evidence(n, pi) {
  const piQtys = [pi.qty, pi.challanQty].filter((q) => q !== null && q !== undefined);
  return {
    amount: close(n.value, pi.gross, AMOUNT_SLACK),
    qty: piQtys.some((q) => close(n.qty, q, QTY_SLACK, 0.01)),
    rate: close(n.netRate, pi.rate, AMOUNT_SLACK, 0.01),
  };
}

function grade(ev) {
  if (ev.amount && ev.qty) return { method: 'AMOUNT_QTY', confidence: 0.95 };
  if (ev.amount && ev.rate) return { method: 'AMOUNT_RATE', confidence: 0.9 };
  if (ev.amount) return { method: 'AMOUNT', confidence: 0.85 };
  if (ev.qty && ev.rate) return { method: 'QTY_RATE', confidence: 0.8 };
  // Quantity alone: raised below when the money differs by one discount on every line.
  if (ev.qty) return { method: 'QTY', confidence: 0.7 };
  return null;
}

const COLOURS = new Set([
  'cyan', 'magenta', 'yellow', 'black', 'white', 'gold', 'silver', 'rose', 'red', 'blue',
  'green', 'orange', 'violet', 'purple', 'pink', 'brown', 'grey', 'gray', 'copper', 'bronze',
]);
const STOP_WORDS = new Set(['mm', 'mtr', 'mtrs', 'kg', 'kgs', 'gsm', 'roll', 'rolls', 'pcs', 'nos', 'sheet', 'sheets', 'the', 'and', 'for', 'with', 'none']);

/**
 * What a name says about the item beyond its numbers: colours, widths and
 * sizes in mm, GSM, and its other words. A supplier line's sizes come from
 * the mm figures and the reader's size field only - "28 x 100 = 2800 Sheet"
 * is a pack count, not a size. An Indus name is regular, so "510 X 642" there
 * is a size. A quotation's product name is regular enough too ("CAPRI 576 X
 * 889"), but a pack can hide in it ("4 x 5 ltr"), so `sizePairs` takes only
 * pairs where neither number is a whole number under 10.
 */
export function nameFeatures(text, { gsm = null, size = null, indus = false, sizePairs = false } = {}) {
  const t = String(text || '').toLowerCase();
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const dims = new Set([...t.matchAll(/(\d+(?:\.\d+)?)\s*mm\b/g)].map((m) => Number(m[1])));
  // Kapoor writes a blanket's gripper side as "889Gx595": one letter may sit before the x.
  for (const m of (indus || sizePairs) ? t.matchAll(/(\d+(?:\.\d+)?)\s*[a-z]?\s*[x×*]\s*(\d+(?:\.\d+)?)/g) : []) {
    // "0.4x1.4" is a matrix's size; "4 x 5" a pack of whole tins.
    if (sizePairs && !indus && [m[1], m[2]].some((v) => Number(v) < 10 && !v.includes('.'))) continue;
    dims.add(Number(m[1])); dims.add(Number(m[2]));
  }
  // The reader copies sizes as printed: "56X77" is cm, "23X36" inches. Each may be any of the three.
  for (const m of String(size || '').matchAll(/\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    dims.add(v); dims.add(v * 10); dims.add(v * 25.4);
  }
  const gsms = new Set([...t.matchAll(/(\d+)\s*gsm\b/g)].map((m) => Number(m[1])));
  if (toNumber(gsm)) gsms.add(toNumber(gsm));
  return { colours: new Set(words.filter((w) => COLOURS.has(w))), dims, gsms, words: new Set(words) };
}

const shared = (a, b) => [...a].filter((x) => b.has(x)).length;
/** Sizes count as the same within 1.5%: 23 inches is 584 mm, which Indus calls 585. */
const sharedDims = (a, b) => [...b].filter((y) => [...a].some((x) => Math.abs(x - y) <= y * 0.015)).length;

/**
 * Does an Indus name contradict the supplier line? Different colours, no size
 * in common, or a different GSM - each only when both sides state one.
 */
export function contradicts(line, pi, { allSizes = false } = {}) {
  if (line.colours.size && pi.colours.size && (line.colours.size !== pi.colours.size || shared(line.colours, pi.colours) !== line.colours.size)) return 'colour';
  if (line.dims.size && pi.dims.size && !sharedDims(line.dims, pi.dims)) return 'size';
  // A quotation prints the whole size, so one side in common is not enough:
  // a blanket 889 x 595 is not the 889 x 612 one. (A bill's sizes are noisier
  // - one figure read three ways - and keep the looser test.)
  if (allSizes && line.dims.size >= 2 && pi.dims.size >= 2 && sharedDims(line.dims, pi.dims) < Math.min(line.dims.size, pi.dims.size)) return 'size';
  if (line.gsms.size && pi.gsms.size && !shared(line.gsms, pi.gsms)) return 'GSM';
  return null;
}

/**
 * Among PI lines the numbers cannot tell apart, the one the description
 * names: two UV inks at the same quantity and amount, one "MAGENTA" and one
 * "Yellow". Lines that contradict the description are out; of the rest, the
 * one sharing the most with it wins, and only when no other shares as much.
 * @returns index into `candidates`, or -1
 */
function textTieBreak(line, candidates) {
  const f = nameFeatures(line.description, { gsm: line.gsm, size: line.size });
  const scored = candidates.map((pi, k) => {
    const g = nameFeatures(pi.itemName, { indus: true });
    if (contradicts(f, g)) return null;
    return { k, score: shared(f.words, g.words) + sharedDims(f.dims, g.dims) + shared(f.gsms, g.gsms) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return -1;
  if (scored.length > 1 && scored[1].score === scored[0].score) return -1;
  return scored[0].k;
}

/** Largest number of PI lines one supplier line may stand for, and of PI lines searched. */
const GROUP_MAX = 4;
const GROUP_SEARCH_LIMIT = 12;

/**
 * The one set of unused PI lines that a supplier line adds up to, or null.
 *
 * Suppliers often bill one line per grade where the store posted one line per
 * size: Purv Flexipack billed "BOPP Film (NCL 10) 10mic. Glossy, 412.4 kg"
 * against two PI lines, 864 mm (201.4 kg) and 1030 mm (211 kg). Both quantity
 * and money must add up; more than one fitting set is no answer.
 */
function groupFor(n, piLines, unused) {
  const pool = unused.slice(0, GROUP_SEARCH_LIMIT);
  const fits = [];
  const walk = (start, chosen, qty, gross) => {
    if (fits.length > 1) return;
    if (chosen.length >= 2 && close(n.qty, qty, QTY_SLACK, 0.01) && close(n.value, gross, AMOUNT_SLACK)) {
      fits.push([...chosen]);
      return;
    }
    if (chosen.length === GROUP_MAX) return;
    for (let k = start; k < pool.length; k += 1) {
      const pi = piLines[pool[k]];
      if (pi.qty === null || pi.gross === null) continue;
      chosen.push(pool[k]);
      walk(k + 1, chosen, qty + pi.qty, gross + pi.gross);
      chosen.pop();
    }
  };
  if (n.qty !== null && n.value !== null) walk(0, [], 0, 0);
  return fits.length === 1 ? fits[0] : null;
}

/**
 * Pair each supplier line with at most one PI line, and each PI line with at
 * most one supplier line.
 *
 * Best evidence first: an amount-and-quantity pair is taken before an
 * amount-only one, so a weak pair never takes a PI line a strong one needed.
 * When two PI lines are equally good for one supplier line - two sizes billed
 * for the same amount - neither is chosen and both go to review.
 *
 * Last, a bill with exactly one goods line and a PI with exactly one line is
 * paired even when the money differs (a rate typo, a missed discount), but at
 * low confidence, so it is the first thing a reviewer checks.
 *
 * @param {Array} invoiceLines  extracted lines, as the reader returned them
 * @param {Array} piLines       { detailId, itemId, itemName, qty, challanQty, rate, gross }
 * @returns {Array} one entry per invoice line, in order
 */
export function suggestPiLines(invoiceLines = [], piLines = []) {
  const numbered = invoiceLines.map((line) => ({ line, n: lineNumbers(line) }));
  const results = numbered.map(({ line, n }) => ({
    lineNo: line.lineNo,
    kind: n.isCharge ? 'CHARGE' : 'GOODS',
    suggestion: null,
    candidates: [],
    reason: n.isCharge ? 'charge line, no item' : null,
  }));

  const pairs = [];
  numbered.forEach(({ n }, i) => {
    if (n.isCharge) return;
    piLines.forEach((pi, j) => {
      const ev = evidence(n, pi);
      const g = grade(ev);
      if (g) pairs.push({ i, j, ...g, ev });
    });
  });

  // Ties for one invoice line at its best grade make that line ambiguous.
  const best = new Map();
  for (const p of pairs) {
    const b = best.get(p.i);
    if (!b || p.confidence > b.confidence) best.set(p.i, { confidence: p.confidence, js: [p.j] });
    else if (p.confidence === b.confidence) b.js.push(p.j);
  }

  const usedPi = new Set();
  const sorted = [...pairs].sort((a, b) => b.confidence - a.confidence || a.i - b.i);
  for (const p of sorted) {
    const r = results[p.i];
    if (r.suggestion || usedPi.has(p.j)) continue;
    const top = best.get(p.i);
    if (p.confidence < top.confidence) continue;
    const open = top.js.filter((j) => !usedPi.has(j));
    if (open.length > 1) {
      const k = textTieBreak(numbered[p.i].line, open.map((j) => piLines[j]));
      if (k < 0) {
        r.candidates = open.map((j) => piLines[j].detailId);
        r.reason = `${open.length} PI lines fit equally (${p.method})`;
        continue;
      }
      r.suggestion = { ...pick(piLines[open[k]]), method: `${p.method}+TEXT`, confidence: p.confidence };
      r.candidates = [];
      r.reason = `${open.length} PI lines fit the numbers; the description names this one`;
      usedPi.add(open[k]);
      continue;
    }
    // The last of a tied set is left over, not chosen: the description must not contradict it.
    if (top.js.length > 1) {
      const why = contradicts(
        nameFeatures(numbered[p.i].line.description, { gsm: numbered[p.i].line.gsm, size: numbered[p.i].line.size }),
        nameFeatures(piLines[p.j].itemName, { indus: true }),
      );
      if (why) {
        r.candidates = [piLines[p.j].detailId];
        r.reason = `the numbers fit the one PI line left, but its ${why} differs from the description`;
        continue;
      }
    }
    r.suggestion = { ...pick(piLines[p.j]), method: p.method, confidence: p.confidence };
    usedPi.add(p.j);
  }

  /*
    Quantity-only pairs are trusted when every one of them is off by the same
    factor - one discount across the bill. Emami billed 98.55/kg and Indus
    holds 76.50/kg on all three lines of the same invoice (a 22.4% discount the
    printed lines do not show); the quantities pair one to one.
  */
  const qtyOnly = results.filter((r) => r.suggestion?.method === 'QTY');
  if (qtyOnly.length >= 2) {
    const ratios = qtyOnly.map((r) => {
      const n = numbered[results.indexOf(r)].n;
      const pi = piLines.find((p) => p.detailId === r.suggestion.piDetailId);
      return n.value && pi.gross ? pi.gross / n.value : null;
    });
    const first = ratios[0];
    if (first && ratios.every((x) => x !== null && Math.abs(x - first) <= first * AMOUNT_SLACK)) {
      for (const r of qtyOnly) {
        r.suggestion.method = 'QTY_COMMON_DISCOUNT';
        r.suggestion.confidence = 0.88;
        r.reason = `every quantity pairs; money differs by the same ${Math.round((1 - first) * 1000) / 10}% on each line`;
      }
    }
  }

  // Lines still open may stand for several PI lines between them.
  results.forEach((r, i) => {
    if (r.kind !== 'GOODS' || r.suggestion) return;
    const unused = piLines.map((_, j) => j).filter((j) => !usedPi.has(j));
    const group = groupFor(numbered[i].n, piLines, unused);
    if (!group) return;
    const items = group.map((j) => pick(piLines[j]));
    const groups = new Set(items.map((x) => x.itemGroupId));
    r.suggestion = {
      piDetailId: null, itemId: null,
      itemName: items.map((x) => x.itemName).join(' + '),
      itemGroupId: groups.size === 1 ? items[0].itemGroupId : null,
      method: 'GROUP', confidence: 0.85, group: items,
    };
    r.candidates = [];
    r.reason = `adds up to ${items.length} PI lines`;
    for (const j of group) usedPi.add(j);
  });

  /*
    And the other way round: several supplier lines posted as one PI line.
    Alapp billed UV blankets as 16 + 14 pieces against one PI line of 30;
    Sudarshan billed two ITC Cyber XLPac reels, 2,562 + 1,261 kg, posted as
    3,823 kg. Each line then names the same item, at its own quantity.
  */
  piLines.forEach((pi, j) => {
    if (usedPi.has(j) || pi.qty === null || pi.gross === null) return;
    const open = results.map((r, i) => i).filter((i) => results[i].kind === 'GOODS' && !results[i].suggestion);
    const split = groupFor(
      { qty: pi.qty, value: pi.gross },
      open.map((i) => ({ qty: numbered[i].n.qty, gross: numbered[i].n.value })),
      open.map((_, k) => k),
    );
    if (!split) return;
    for (const k of split) {
      const r = results[open[k]];
      r.suggestion = { ...pick(pi), method: 'SPLIT', confidence: 0.9 };
      r.candidates = [];
      r.reason = `${split.length} supplier lines add up to this PI line`;
    }
    usedPi.add(j);
  });

  const goods = results.filter((r) => r.kind === 'GOODS');
  if (goods.length === 1 && !goods[0].suggestion && piLines.length === 1 && !usedPi.size) {
    goods[0].suggestion = { ...pick(piLines[0]), method: 'ONLY_CANDIDATE', confidence: 0.6 };
    goods[0].reason = 'only line on both sides, but the money does not agree';
  }

  for (const r of results) {
    if (r.kind === 'GOODS' && !r.suggestion && !r.reason) r.reason = 'no PI line agrees on amount or quantity';
  }
  return results;
}

function pick(pi) {
  return { piDetailId: pi.detailId, itemId: pi.itemId, itemName: pi.itemName, itemGroupId: pi.itemGroupId ?? null };
}

/**
 * Do the goods lines add up to what the bill says, and to what the PI says?
 * `billGoodsValue` is the taxable value before freight, from the bill.
 */
export function totalsCheck(invoiceLines = [], { billGoodsValue = null, piGross = null } = {}) {
  const goods = invoiceLines.map(lineNumbers).filter((n) => !n.isCharge);
  const missing = goods.filter((n) => n.value === null).length;
  const linesTotal = Math.round(goods.reduce((s, n) => s + (n.value || 0), 0) * 100) / 100;
  const vs = (target) => (target === null || target === undefined ? null : {
    target,
    diff: Math.round((linesTotal - target) * 100) / 100,
    ok: close(linesTotal, target, AMOUNT_SLACK),
  });
  return { goodsLines: goods.length, missingValues: missing, linesTotal, bill: vs(billGoodsValue), pi: vs(piGross) };
}
