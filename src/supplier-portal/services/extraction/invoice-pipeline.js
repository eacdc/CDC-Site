/**
 * Reading a supplier invoice: prepare the photos, read, check, retry once.
 *
 * PREPARE. Each page is turned upright and sent as the whole page, then as
 * close-ups: strips from top to bottom, overlapping a little so no row is cut
 * in two. In the October 2026 run a photo of a Siegwerk invoice lying on its
 * side came back as an invented invoice - plausible ink lines and a total that
 * is nowhere on the page - and the same photo turned upright read correctly.
 * The model shrinks every image to about 768 pixels on its short side, so on
 * a whole page the small print is the first thing lost; the close-ups give it
 * back. They once covered only the top of the page - GSTIN, invoice number,
 * gate stamp - and Sonafine's KOLGST26/5003360 showed what that left out: its
 * item row, read off the whole page alone, came back as 120 GSM for 160, size
 * "TCF/2020ms" for 72x102cms, a 20% discount as 2%, and 368.49 KG for
 * 3,136 NOS.
 *
 * Upright is decided two ways: the camera's own EXIF orientation, and then -
 * for a page photographed or scanned sideways, which EXIF knows nothing about
 * - by showing the model four small copies, one per quarter turn, and asking
 * which one reads normally. That costs a few hundred tokens a page.
 *
 * CHECK AND RETRY. invoice-review.js finds what the answer shows to be wrong
 * on its own face. If anything is, the model is asked once more with the
 * problems spelled out, and the better of the two answers is kept.
 */

import sharp from 'sharp';
import { invoiceProblems, retryInstruction } from './invoice-review.js';

/** Close-ups per page, and the share of the page height each covers. */
const STRIPS = 4;
const STRIP_SHARE = 0.32;
/** The short side the model keeps of an image at high detail. */
const MODEL_SHORT_SIDE = 768;
/** Longest side sent; the model scales anything larger down to this anyway. */
const MAX_SIDE = 2048;

async function loadImage(url) {
  if (url.startsWith('data:')) {
    const [meta, data] = url.split(',', 2);
    return { buffer: Buffer.from(data, meta.includes(';base64') ? 'base64' : 'utf8'), type: meta.slice(5).split(';')[0] };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch the page image (HTTP ${res.status}).`);
  return { buffer: Buffer.from(await res.arrayBuffer()), type: (res.headers.get('content-type') || '').split(';')[0] };
}

const asDataUrl = (buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`;

/**
 * Ask which quarter turn makes the page upright. Returns 0, 90, 180 or 270
 * (degrees clockwise to apply), or 0 when the provider cannot say.
 */
async function uprightTurn(provider, upright) {
  if (typeof provider.detectOrientation !== 'function') return 0;
  const turns = [0, 90, 180, 270];
  const thumbs = await Promise.all(turns.map((deg) => sharp(upright).rotate(deg)
    .resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()));
  try {
    const index = await provider.detectOrientation({ images: thumbs.map(asDataUrl) });
    return turns[index] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A page cut into STRIPS strips from top to bottom, overlapping, each scaled
 * to what the model keeps: up to MODEL_SHORT_SIDE on its short side, enlarged
 * if need be - a phone photo's row of 10-pixel figures is read at 17.
 */
async function strips(pageImage) {
  const { width, height } = await sharp(pageImage).metadata();
  const h = Math.max(1, Math.min(height, Math.round(height * STRIP_SHARE)));
  const out = [];
  for (let i = 0; i < STRIPS; i += 1) {
    const top = Math.round(((height - h) * i) / Math.max(1, STRIPS - 1));
    const scale = Math.min(MAX_SIDE / width, MODEL_SHORT_SIDE / Math.min(width, h));
    out.push(await sharp(pageImage)
      .extract({ left: 0, top, width, height: h })
      .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(h * scale)), { kernel: 'lanczos3' })
      .jpeg({ quality: 92 }).toBuffer());
  }
  return out;
}

/**
 * Pages as the model should see them: upright, each followed by close-ups of
 * it, top to bottom. Anything that is not an image (a PDF page passed through as a URL)
 * is left exactly as it was.
 */
export async function preparePages(provider, pages = []) {
  const out = [];
  const notes = [];
  for (const [i, page] of pages.entries()) {
    const pageNo = page.pageNo ?? i + 1;
    let buffer;
    try {
      const loaded = await loadImage(page.url);
      if (loaded.type && !loaded.type.startsWith('image/')) { out.push(page); continue; }
      buffer = loaded.buffer;
      await sharp(buffer).metadata();
    } catch {
      out.push(page);
      continue;
    }

    // EXIF first: a phone photo often stores its orientation instead of applying it.
    const exifUpright = await sharp(buffer).rotate().toBuffer();
    const turn = await uprightTurn(provider, exifUpright);
    if (turn) notes.push(`page ${pageNo} was turned ${turn} degrees to read upright`);
    const pageImage = await sharp(exifUpright).rotate(turn)
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    out.push({ url: asDataUrl(pageImage), pageNo, detail: 'high' });
    for (const strip of await strips(pageImage)) {
      out.push({ url: asDataUrl(strip), pageNo, detail: 'high', closeUp: true });
    }
  }
  return { pages: out, notes };
}

/**
 * Fields the two reads answered differently. The model does not report doubt
 * reliably, but a value it reads two ways is one it was not sure of.
 */
export function readingsDiffer(first = {}, second = {}) {
  const out = [];
  const clean = (v) => String(v ?? '').replace(/[\s,]/g, '').toUpperCase();
  for (const field of ['invoiceNo', 'invoiceDate', 'supplierGstin', 'shipToGstin', 'eWayBillNo', 'vehicleNo',
    'gateEntryNo', 'gateEntryDate', 'subTotal', 'taxable', 'cgst', 'sgst', 'igst', 'grandTotal']) {
    if (clean(first[field]) !== clean(second[field])) out.push({ field, first: first[field] ?? null, second: second[field] ?? null });
  }
  const byNo = new Map((first.lines || []).map((l) => [Number(l.lineNo), l]));
  for (const l of second.lines || []) {
    const was = byNo.get(Number(l.lineNo));
    if (!was) continue;
    for (const f of ['qty', 'rate', 'amount']) {
      if (clean(was[f]) !== clean(l[f])) out.push({ field: `lines.${l.lineNo}.${f}`, first: was[f] ?? null, second: l[f] ?? null });
    }
  }
  return out;
}

/** Told to the model alongside the images, so a close-up is not read as another page. */
function imageGuide(pages) {
  if (!pages.some((p) => p.closeUp)) return null;
  const count = new Set(pages.map((p) => p.pageNo)).size;
  return `The images come in groups of ${STRIPS + 1}: for each of the ${count} page(s), first the whole page, then `
    + `${STRIPS} close-ups of that SAME page - strips from its top to its bottom, each overlapping the next a little. `
    + 'The close-ups are not more pages and add no lines: a row that shows in two strips is one row. Take the layout - '
    + 'which lines there are, which column is which - from the whole page; take the characters of every value - GSTINs, the '
    + 'invoice number, descriptions, GSM and size, HSN, quantities, rates, discounts and amounts, the gate stamp - from '
    + 'the close-ups, where they are large enough to read exactly.';
}

/**
 * Read an invoice through `provider`, check the answer, and retry once if it
 * is provably wrong. Returns the provider's answer with `_review` added.
 */
export async function readInvoice(provider, { pages, hints = {} } = {}) {
  const prepared = await preparePages(provider, pages);
  const guide = imageGuide(prepared.pages);
  const notes = [...(hints.notes || []), guide].filter(Boolean);

  const first = await provider.extractInvoice({ pages: prepared.pages, hints: { ...hints, notes } });
  const before = invoiceProblems(first);
  const review = { rotation: prepared.notes, problemsBefore: before, retried: false, problemsAfter: before, kept: 'first' };
  if (!before.length) return { ...first, _review: review };

  review.retried = true;
  try {
    const { _provider, _model, ...firstData } = first;
    const second = await provider.extractInvoice({
      pages: prepared.pages,
      hints: { ...hints, notes: [...notes, retryInstruction(firstData, before)] },
    });
    const after = invoiceProblems(second);
    const disagreements = readingsDiffer(firstData, second);
    if (after.length < before.length) {
      return { ...second, _review: { ...review, problemsAfter: after, kept: 'second', disagreements } };
    }
    return { ...first, _review: { ...review, problemsAfter: before, secondProblems: after, disagreements } };
  } catch (err) {
    return { ...first, _review: { ...review, retryError: err.message } };
  }
}
