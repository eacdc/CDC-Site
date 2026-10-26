/**
 * Reading a supplier invoice: prepare the photos, read, check, retry once.
 *
 * PREPARE. Each page is turned upright and sent twice: the whole page, and a
 * close-up of its top part, where the GSTIN, invoice number, e-way bill and
 * CDC's gate stamp sit. In the October 2026 run a photo of a Siegwerk invoice
 * lying on its side came back as an invented invoice - plausible ink lines and
 * a total that is nowhere on the page - and the same photo turned upright read
 * correctly. The model shrinks every image to about 768 pixels on its short
 * side, so on a whole page the small print is the first thing lost; the
 * close-up gives it back.
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

/** The share of the page height the close-up covers. */
const CLOSE_UP_SHARE = 0.45;
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
 * Pages as the model should see them: upright, each followed by a close-up of
 * its top. Anything that is not an image (a PDF page passed through as a URL)
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
    const { width, height } = await sharp(pageImage).metadata();
    const closeUp = await sharp(pageImage)
      .extract({ left: 0, top: 0, width, height: Math.max(1, Math.round(height * CLOSE_UP_SHARE)) })
      .jpeg({ quality: 92 }).toBuffer();

    out.push({ url: asDataUrl(pageImage), pageNo, detail: 'high' });
    out.push({ url: asDataUrl(closeUp), pageNo, detail: 'high', closeUp: true });
  }
  return { pages: out, notes };
}

/** Told to the model alongside the images, so a close-up is not read as another page. */
function imageGuide(pages) {
  if (!pages.some((p) => p.closeUp)) return null;
  const count = new Set(pages.map((p) => p.pageNo)).size;
  return `The images come in pairs: for each of the ${count} page(s), first the whole page, then a close-up of the top `
    + 'part of that SAME page. The close-up is not another page and adds no lines; it is there so you can read small '
    + 'print exactly - GSTINs, the invoice number, the e-way bill and the gate stamp. Where a value appears in both, take '
    + 'its characters from the close-up.';
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
    if (after.length < before.length) {
      return { ...second, _review: { ...review, problemsAfter: after, kept: 'second' } };
    }
    return { ...first, _review: { ...review, problemsAfter: before, secondProblems: after } };
  } catch (err) {
    return { ...first, _review: { ...review, retryError: err.message } };
  }
}
