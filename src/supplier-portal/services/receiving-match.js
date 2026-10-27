/**
 * Matching supplier-invoice lines to open PO lines — the whole invoice at once.
 *
 * Every rule below fixes a failure observed on a real invoice: Pranay Udyog
 * PU/26-27/0710, which CDC's store booked by hand as REC04597_26_27. Replayed
 * against the PO book as it stood before that booking, the previous matcher
 * (word overlap plus a rate bonus, one line at a time) got the item right on
 * all five lines but put line 5 on the wrong PO, and once the right PO lines
 * were closed it confidently matched a different box altogether.
 *
 *  1. THE PRINTED PO NUMBER DECIDES. Suppliers write CDC's PO number against
 *     the line ("PO NO = 3232"). When a candidate's PO carries that number it
 *     outranks everything else, including whether it has room — an
 *     over-delivery against the PO the supplier named is INV003's to block,
 *     not the matcher's to quietly move to another PO. The header's "Buyer's
 *     Order No." list narrows the field when a line names none.
 *
 *  2. A REJECTION FLOOR. Shared words never make a match on their own: "5 PLY
 *     BOX 450" is in a dozen box names. A candidate needs a strong signal — the
 *     printed PO number, the exact PO rate, or the exact size — and must not
 *     be contradicted by a size that differs or a rate far off. With neither,
 *     the honest answer is "no open PO", which the reviewer can act on; a
 *     plausible-looking wrong PO is worse, because it reads as done.
 *
 *  3. THE WHOLE INVOICE SHARES THE PO BOOK. Pending quantity is spent as
 *     lines are placed, so two lines for the same box at the same rate do not
 *     both land on a PO line with room for one. Lines that name their PO are
 *     placed first, so an unnamed line cannot take capacity a named one needs.
 *     Among candidates with room, the oldest PO wins — the house rule.
 *
 * Pure and synchronous: everything arrives as arguments, so the rules can be
 * tested against real PO data without a database.
 */

import { normaliseName } from '../lib/text.js';
import { TOLERANCES } from '../config/constants.js';

export const MATCH_RULES = {
  /** Invoice rate within this fraction of the PO rate counts as the PO rate. */
  rateExactPct: TOLERANCES.rateAnchorPct,
  /** Further off than this, with no matching size, is a different item. */
  rateFarPct: 0.10,
  /** Even a strong signal needs this much of the item's name in the line. */
  minCoverage: 0.3,
  /** How far over pending a line may go and still count as fitting. */
  receiptOverPct: TOLERANCES.receiptOverPct,
};

// ── reading the signals ─────────────────────────────────────────────────────

/** The first run of 3+ digits: "PO NO = 3232 - 5/10 = 818 PCS" -> 3232. */
export function poNumberFrom(text) {
  const m = String(text ?? '').match(/\d{3,}/);
  return m ? Number(m[0]) : null;
}

/** Every 3+ digit run in the header list: ["2420, 3232", "3342"] -> [2420, 3232, 3342]. */
export function poNumbersFrom(list) {
  const out = new Set();
  for (const entry of [].concat(list || [])) {
    for (const m of String(entry ?? '').matchAll(/\d{3,}/g)) out.add(Number(m[0]));
  }
  return out;
}

/** The number in a PO's voucher: "PO03232_26_27" -> 3232. */
export function poNumberOfVoucher(voucherNo) {
  const m = String(voucherNo ?? '').match(/^PO0*(\d+)_/i);
  return m ? Number(m[1]) : null;
}

/**
 * A size such as 450X340X230, 450 x 340 x 230 or 635 X 914, as sorted numbers.
 *
 * Sorted because suppliers do not always print length, width and height in
 * CDC's order. Two to four digits per side keeps "5 PLY" and the inch figures
 * the item master appends ("21.65 x, 10.23 x") out of it: the comma after the
 * x breaks the pattern.
 */
export function sizeFrom(text) {
  const printed = sizeAsPrinted(text);
  return printed ? [...printed].sort((a, b) => a - b) : null;
}

/** The same size in the order it was printed - for showing a person. */
export function sizeAsPrinted(text) {
  const m = firstSize(text);
  return m ? [m[1], m[2], m[3]].filter(Boolean).map(Number) : null;
}

const SIZE_RE = /(\d{2,4}(?:\.\d+)?)\s*[x×*]\s*(\d{2,4}(?:\.\d+)?)(?:\s*[x×*]\s*(\d{2,4}(?:\.\d+)?))?/gi;

/**
 * The first size in the text - skipping arithmetic. "123 x 250 = 30750 Sheet"
 * is a sheet count worked out, not a 123 x 250 sheet; taken for a size it made
 * every paper line look like the wrong item.
 */
function firstSize(text) {
  const t = String(text ?? '');
  for (const m of t.matchAll(SIZE_RE)) {
    if (/^\s*=/.test(t.slice(m.index + m[0].length))) continue;
    return m;
  }
  return null;
}

/**
 * A size with the unit printed right after it, if any: "600X360X335 mm",
 * "( 320 X 225 X 285 )MM", "20X30" (none). A unit further along belongs to
 * something else - in "63.5X091.4-1.9 MM" the MM is the caliper.
 */
export function sizeWithUnit(text) {
  const t = String(text ?? '');
  const m = firstSize(t);
  if (!m) return null;
  const after = t.slice(m.index + m[0].length);
  const u = after.match(/^\s*\)?\s*(mm|cm|inches|inch|in\b|")/i);
  const unit = !u ? null : /mm/i.test(u[1]) ? 'mm' : /cm/i.test(u[1]) ? 'cm' : 'inch';
  const shown = [m[1], m[2], m[3]].filter(Boolean).map(Number);
  return { dims: [...shown].sort((a, b) => a - b), shown, unit };
}

/** mm per unit, and the slack a conversion is allowed. */
const UNIT_MM = { mm: 1, cm: 10, inch: 25.4 };

/**
 * Compare a size as printed on the invoice with the item's size in mm.
 *
 * Suppliers print sizes in mm, cm or inches, and CDC's item master holds mm:
 * 20 x 30 in is the 508 x 762 mm sheet, 63.5 x 91.4 cm the 635 x 914 mm board.
 * When the unit is printed it is used; when it is not, each unit is tried and
 * the size matches if one of them fits.
 *
 * In the same unit the size is still digit for digit - a box 2 mm off is a
 * different box. A converted size gets the slack its rounding needs: CDC
 * writes 23 x 36 in as 585 x 915, which is 584.2 x 914.4.
 *
 * @returns {{result: 'exact'|'mismatch'|'unknown', unit?: string}}
 */
export function compareSizeUnits(printed, itemMm) {
  if (!printed || !itemMm || printed.dims.length !== itemMm.length) return { result: 'unknown' };
  const units = printed.unit ? [printed.unit] : ['mm', 'cm', 'inch'];
  for (const unit of units) {
    const f = UNIT_MM[unit];
    const fits = printed.dims.every((v, i) => {
      const mm = v * f;
      const slack = f === 1 ? 0 : f === 10 ? 1 : Math.max(2, itemMm[i] * 0.006);
      return Math.abs(mm - itemMm[i]) <= slack + 1e-9;
    });
    if (fits) return { result: 'exact', unit };
  }
  return { result: 'mismatch' };
}

/** The item's size in mm, sorted: its own name, else the master's SizeW x SizeL. */
function itemSizeMm(item, po) {
  const fromName = sizeFrom(item.ItemName) || sizeFrom(po.ItemDescription);
  if (fromName) return fromName;
  const w = num(item.SizeW);
  const l = num(item.SizeL);
  return w > 0 && l > 0 ? [w, l].sort((a, b) => a - b) : null;
}

/** GSM as a number: the line's own field, else "170 GSM" in its wording. */
function gsmOf(value, text) {
  const n = num(String(value ?? '').replace(/^0+(?=\d)/, ''));
  if (n !== null && n > 0) return n;
  const m = String(text ?? '').match(/(\d{2,4})\s*GSM/i);
  return m ? Number(m[1]) : null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** How much of the item's name appears in the invoice line — the old score. */
function wordCoverage(lineText, itemText) {
  const tokens = normaliseName(itemText).split(' ').filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const hits = tokens.filter((t) => lineText.includes(t)).length;
  return hits / tokens.length;
}

function fmtSize(size) {
  return size ? size.join('×') : null;
}

/**
 * Closed means either of two things: the ERP marked the line complete (often
 * within tolerance, with a little still pending), or it is simply fully
 * received. Both mean nothing more can be received against it.
 */
export function isClosed(po) {
  return po.IsCompleted === true || po.IsCompleted === 1 || (num(po.PendingQty) ?? 0) <= 0;
}

function closedNote(po) {
  const ordered = num(po.PurchaseOrderQuantity);
  const received = num(po.ReceivedQty);
  const pending = num(po.PendingQty) ?? 0;
  if (pending > 0) return `PO line closed in the ERP with ${pending} still pending`;
  if (ordered !== null && received !== null) return `PO line fully received (${received} of ${ordered})`;
  return 'PO line closed';
}

const receiptKey = (transactionId, itemId) => `${Number(transactionId)}:${Number(itemId)}`;

// ── judging one candidate ───────────────────────────────────────────────────

/**
 * Everything known about one invoice line against one PO line, and whether
 * it clears the floor. Returns the reasons as well as the verdict, because a
 * reviewer looking at "no open PO" needs to know what was considered and why
 * it was turned down.
 */
export function assessCandidate(line, po, { items, headerPoNumbers, receivedFromInvoice = new Map() }) {
  const item = items.get(po.ItemID) || {};
  const lineText = normaliseName(line.description || '');

  const closed = isClosed(po);
  // The ERP's own record that this very invoice was received on this PO line.
  const receipt = receivedFromInvoice.get(receiptKey(po.TransactionID, po.ItemID)) || null;
  const receivedHere = Boolean(receipt);

  const poNo = poNumberOfVoucher(po.PoVoucherNo);
  const linePoNo = poNumberFrom(line.poRef);
  const poRefMatch = linePoNo !== null && poNo === linePoNo;
  const headerPoMatch = !poRefMatch && poNo !== null && headerPoNumbers.has(poNo);

  const rate = num(line.rate);
  const poRate = num(po.PurchaseRate);
  let rateExact = false;
  let rateFar = false;
  if (rate !== null && poRate !== null && poRate > 0) {
    const delta = Math.abs(rate - poRate);
    rateExact = delta <= Math.max(0.01, poRate * MATCH_RULES.rateExactPct);
    rateFar = delta / poRate > MATCH_RULES.rateFarPct;
  }

  // The size from the line's own size field first - the reader puts a paper
  // invoice's "20X30" there, not in the description - then its wording.
  const linePrinted = sizeWithUnit(line.size) || sizeWithUnit(line.description);
  const poSize = itemSizeMm(item, po);
  const size = compareSizeUnits(linePrinted, poSize);
  const sizeExact = size.result === 'exact';
  const sizeMismatch = size.result === 'mismatch';

  // GSM tells paper apart: one PO can carry 128 and 210 GSM in the same size
  // at the same rate. A different GSM is a different item.
  const lineGsm = gsmOf(line.gsm, line.description);
  const itemGsm = gsmOf(item.GSM, item.ItemName);
  const gsmExact = lineGsm !== null && itemGsm !== null && lineGsm === itemGsm;
  const gsmMismatch = lineGsm !== null && itemGsm !== null && lineGsm !== itemGsm;

  // Name and PO description scored apart, best taken. Joined, the description's
  // labels (Quality:, SizeL:, NoOfPly:, ManufecturerItemCode:) dilute the share
  // of real words and push a correct match towards the floor.
  const coverage = Math.max(
    wordCoverage(lineText, item.ItemName),
    wordCoverage(lineText, po.ItemDescription),
  );

  // The floor. Strong evidence is needed - the printed PO number, the PO rate
  // or the size - and nothing may contradict it. The same contradictions apply
  // with a printed PO number: it picks the PO, it does not excuse the wrong box
  // on it. Without this a PO with five lines would hand any of them to a line
  // that named it.
  // A receipt of this invoice on the line is a fact, not a guess, so it counts
  // as strong. It does not lift the contradictions: the same invoice puts
  // several boxes on one PO, and each line must still be the right box.
  const strong = poRefMatch || rateExact || sizeExact || receivedHere;
  const contradicted = (rateFar && !sizeExact) || (sizeMismatch && !rateExact) || gsmMismatch;
  // Paper suppliers print their own trade names ("HI KOTE PAPER" for CDC's
  // "Gloss Art"), so a name share is not required when the specification
  // itself agrees: the size, and the GSM where there is one.
  const specAgrees = sizeExact && (gsmExact || (lineGsm === null && rateExact));
  const accepted = strong && !contradicted && (coverage >= MATCH_RULES.minCoverage || specAgrees);

  const score = (poRefMatch ? 3 : 0) + (headerPoMatch ? 0.5 : 0)
    + (rateExact ? 1.5 : 0) + (sizeExact ? 1.5 : 0) + (gsmExact ? 1 : 0) + coverage;

  const reasons = [];
  if (poRefMatch) reasons.push(`PO ${linePoNo} printed on the invoice`);
  else if (headerPoMatch) reasons.push(`PO ${poNo} listed in the invoice header`);
  if (rateExact) reasons.push(`rate ₹${rate} equals the PO rate`);
  else if (rate !== null && poRate !== null) {
    reasons.push(`rate ₹${rate} vs PO ₹${Math.round(poRate * 100) / 100}`);
  }
  // Compared sorted, shown as printed: "450×340×230", not "230×340×450".
  const lineShown = linePrinted ? linePrinted.shown : null;
  const poShown = sizeAsPrinted(item.ItemName) || sizeAsPrinted(po.ItemDescription) || poSize;
  if (sizeExact) {
    reasons.push(size.unit === 'mm'
      ? `size ${fmtSize(lineShown)} matches`
      : `size ${fmtSize(lineShown)} ${size.unit === 'inch' ? 'in' : size.unit} = ${fmtSize(poShown)} mm`);
  } else if (sizeMismatch) reasons.push(`size ${fmtSize(lineShown)} vs ${fmtSize(poShown)}`);
  if (gsmExact) reasons.push(`${lineGsm} GSM matches`);
  else if (gsmMismatch) reasons.push(`${lineGsm} GSM vs ${itemGsm} GSM`);
  if (receivedHere) reasons.push(`already received from this invoice on ${receipt.GrnVoucherNo} (${num(receipt.ReceivedQty)})`);
  if (closed) reasons.push(closedNote(po));

  return {
    po, item, accepted, score, poRefMatch, headerPoMatch, closed, receivedHere, receipt,
    rateExact, rateFar, sizeExact, sizeMismatch, gsmExact, gsmMismatch, coverage, reasons,
  };
}

// ── placing the whole invoice ───────────────────────────────────────────────

/**
 * Place every invoice line on an open PO line, or on none.
 *
 * @param {Object} input
 * @param {Array}  input.lines      invoice lines: description, qty, rate, poRef
 * @param {Array}  input.poLines    open PO lines, as erp-po.openPoLines returns them
 * @param {Map}    input.items      ItemID -> item master row (ItemName)
 * @param {Array}  [input.poNumbers] the header's "Buyer's Order No." list
 * @param {boolean} [input.includeClosed] also consider closed PO lines - to see
 *        where an invoice belonged, never to receive against. A closed match
 *        comes back flagged, and INV002 blocks it from posting.
 * @param {Array}  [input.receipts] GRN lines already booked against this
 *        invoice (erp-po.receiptsForInvoice). Only used with includeClosed.
 * @param {Array}  [input.fixed] lines a person placed by hand: [{ index, po }].
 *        They keep their PO line, and their quantity is spent from it first, so
 *        automatic placement works around a person's choice, never over it.
 * @returns {Array<{po: Object|null, basis: string|null, closed: boolean, manual?: true}>}
 *          one per line, in line order; a hand-placed line has basis null
 */
export function matchInvoiceLines({
  lines = [], poLines = [], items = new Map(), poNumbers = [],
  includeClosed = false, receipts = [], fixed = [],
}) {
  const headerPoNumbers = poNumbersFrom(poNumbers);
  const receivedFromInvoice = new Map(includeClosed
    ? receipts.map((r) => [receiptKey(r.PurchaseTransactionID, r.ItemID), r])
    : []);

  const candidates = includeClosed ? poLines : poLines.filter((po) => !isClosed(po));

  // What each PO line can still take. An open line has its pending; a closed
  // one has nothing - except what this invoice was actually received with,
  // which is what lets two closed lines for the same box be told apart.
  const remaining = new Map(candidates.map((po) => {
    if (!isClosed(po)) return [po.TransactionDetailID, num(po.PendingQty) ?? 0];
    const receipt = receivedFromInvoice.get(receiptKey(po.TransactionID, po.ItemID));
    return [po.TransactionDetailID, receipt ? (num(receipt.ReceivedQty) ?? 0) : 0];
  }));

  // Lines that name their PO go first, so they get the capacity they named.
  const order = lines.map((line, index) => ({ line, index }))
    .sort((a, b) => Number(poNumberFrom(b.line.poRef) !== null) - Number(poNumberFrom(a.line.poRef) !== null)
      || a.index - b.index);

  const results = new Array(lines.length);

  // Hand-placed lines first: they take their PO line's room before anything
  // automatic is considered.
  const fixedAt = new Map(fixed.filter((f) => f && f.po).map((f) => [f.index, f.po]));
  for (const [index, po] of fixedAt) {
    const qty = num(lines[index]?.qty);
    const id = po.TransactionDetailID;
    if (qty !== null && remaining.has(id)) remaining.set(id, remaining.get(id) - qty);
    results[index] = { po, basis: null, closed: isClosed(po), manual: true };
  }

  for (const { line, index } of order) {
    if (fixedAt.has(index)) continue;
    const assessed = candidates.map((po) => assessCandidate(line, po, { items, headerPoNumbers, receivedFromInvoice }));
    const accepted = assessed.filter((a) => a.accepted);

    if (!accepted.length) {
      // Say what came closest and why it was turned down, or the reviewer is
      // left guessing whether the matcher even looked.
      const nearest = assessed.sort((a, b) => b.score - a.score)[0];
      results[index] = {
        po: null,
        closed: false,
        basis: nearest
          ? `${includeClosed ? 'No PO line fits, open or closed' : 'No open PO line fits'}. Closest: ${nearest.item.ItemName || `item ${nearest.po.ItemID}`} on ${nearest.po.PoVoucherNo} — ${nearest.reasons.join(', ') || 'only a few words in common'}.`
          : `No ${includeClosed ? '' : 'open '}PO lines for this supplier.`,
      };
      continue;
    }

    const qty = num(line.qty);
    const fits = (a) => qty === null
      || (remaining.get(a.po.TransactionDetailID) ?? 0) * (1 + MATCH_RULES.receiptOverPct) >= qty;

    // An actual receipt of this invoice is fact and goes first; then the PO
    // the supplier printed; then an open line over a closed one; then room,
    // fit and age. With closed lines left out, the first and third keys never
    // differ, so open-only matching is exactly what it was.
    accepted.sort((a, b) => Number(b.receivedHere) - Number(a.receivedHere)
      || Number(b.poRefMatch) - Number(a.poRefMatch)
      || Number(a.closed) - Number(b.closed)
      || Number(fits(b)) - Number(fits(a))
      || b.score - a.score
      || new Date(a.po.PoDate) - new Date(b.po.PoDate));

    const chosen = accepted[0];
    // Judged before the capacity is spent, or every line would look too big.
    const chosenFits = fits(chosen);
    if (qty !== null) {
      const id = chosen.po.TransactionDetailID;
      remaining.set(id, (remaining.get(id) ?? 0) - qty);
    }

    const notes = [];
    // Room only means something on a line that can still receive.
    if (!chosenFits && !chosen.closed) notes.push('more than this PO line has pending');
    const named = poNumberFrom(line.poRef);
    if (named !== null && !chosen.poRefMatch) {
      notes.push(`the invoice names PO ${named}, which has no open line for this`);
    }
    results[index] = {
      po: chosen.po,
      closed: chosen.closed,
      basis: `${chosen.reasons.join(', ')}${notes.length ? ` — ${notes.join('; ')}` : ''}.`,
    };
  }

  return results;
}
