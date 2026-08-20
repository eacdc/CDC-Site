/**
 * The text layer of a born-digital PDF.
 *
 * Most supplier quotes arrive as PDFs printed straight from Word or Tally, and
 * those carry the exact characters the sender typed. A vision model reading the
 * rendered image of that page is transcribing something it already has
 * perfectly — and transcription is where quiet errors come from: `131.00`
 * becomes `13100`, `w.e.f. 15-07-2026` becomes `w.e.f. 15-07-2020`, a GSTIN's
 * `0` becomes `O`. Neither is implausible enough for anyone to notice.
 *
 * So a PDF whose layer accounts for its pages is read from text alone, and no
 * image is sent at all. When both do go — see `isThin` — the model is told to
 * prefer the text on characters and the image on layout: a price table's
 * meaning lives in its columns, and a text layer flattens those into a stream
 * of words.
 *
 * Two PDFs need their pages rendered instead, and `pdf-render.js` does it. A
 * scan has no layer, and this returns nothing rather than the stray characters
 * an OCR-less extractor finds in one. The harder case is a thin layer — a typed
 * letterhead over a photographed price table — which clears the has-a-layer bar
 * and would otherwise be read text-only, coming back confident and empty.
 */

/** Below this many characters a "text layer" is noise, not content. */
const MEANINGFUL_CHARS = 40;

/**
 * Below this many characters per page, the layer is a caption on a picture.
 *
 * `hasTextLayer` is one threshold for a whole document, and that is not enough
 * on its own: a five-page scanned price list with a typed letterhead line
 * clears 40 characters easily and would be read text-only, so the extraction
 * would come back confident and empty — every rate lives in the image nobody
 * sent. A real page of quote text runs to several hundred characters, so a page
 * averaging fewer than this is carrying its content as pixels.
 */
const THIN_CHARS_PER_PAGE = 180;

/**
 * Read a PDF's text, per page.
 *
 * `isThin` says the layer exists but does not account for the page — the caller
 * renders images as well and sends both.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{pages: string[], text: string, hasTextLayer: boolean,
 *                    isThin: boolean, charsPerPage: number, pageCount: number}>}
 */
export async function pdfPageTexts(buffer) {
  if (!buffer?.length) return empty();

  let PDFParse;
  try {
    ({ PDFParse } = await import('pdf-parse'));
  } catch (err) {
    // The text layer is an optimisation, not a dependency. Without the parser
    // extraction still works — it just pays the transcription risk.
    console.warn('[SP][pdf-text] pdf-parse is not available:', err.message);
    return empty();
  }

  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const pages = (result?.pages || [])
      .map((page) => tidy(page?.text ?? ''));

    // Older shapes return one blob rather than per-page entries. A single-page
    // fallback is right: it keeps the characters, and loses only the ability to
    // say which page each line came from.
    const text = tidy(result?.text ?? pages.join('\n'));
    const resolved = pages.length ? pages : (text ? [text] : []);

    const dense = (text || '').replace(/\s/g, '').length;
    const pageCount = result?.total ?? resolved.length;
    const charsPerPage = pageCount ? Math.round(dense / pageCount) : 0;

    return {
      pages: resolved,
      text: text || resolved.join('\n\n'),
      hasTextLayer: dense >= MEANINGFUL_CHARS,
      isThin: charsPerPage < THIN_CHARS_PER_PAGE,
      charsPerPage,
      pageCount,
    };
  } catch (err) {
    console.warn('[SP][pdf-text] could not read the text layer:', err.message);
    return empty();
  } finally {
    // The parser holds a worker; leaking one per upload would exhaust the
    // process long before anybody connected it to quote uploads.
    try { await parser?.destroy?.(); } catch { /* already gone */ }
  }
}

/**
 * True when a file is worth trying the text layer on.
 *
 * Cheap enough to be worth being wrong about — a mislabelled PDF costs one
 * failed parse and a warning, while skipping a real one costs transcription
 * risk on every number in the document.
 */
export function looksLikePdf({ mimeType, originalFilename } = {}) {
  return /pdf/i.test(`${mimeType || ''} ${originalFilename || ''}`);
}

/**
 * The block appended to the extraction prompt.
 *
 * Worded to settle the one conflict that matters: when the image and the text
 * disagree about a character, the text wins. It is what the sender typed; the
 * image is a picture of it.
 */
export function textLayerInstruction({ pages, text }) {
  const body = pages?.length
    ? pages.map((page, i) => `--- PAGE ${i + 1} ---\n${page}`).join('\n\n')
    : text;
  if (!body) return null;

  return [
    'TEXT LAYER. This PDF was created digitally, so the exact characters the',
    'sender typed are below. Where the text below and the page image disagree',
    'about a character — a digit, a date, a GSTIN, a decimal point — the text',
    'below is right and the image is a picture of it.',
    '',
    'Use the images for layout: which column a number sits in, which rows a',
    'heading covers, where a table ends. The text layer flattens those and',
    'cannot be trusted for structure.',
    '',
    body,
  ].join('\n');
}

function tidy(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // Long runs of spaces are column padding in a flattened table; collapsing
    // them to one keeps the words without pretending the columns survived.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function empty() {
  return { pages: [], text: '', hasTextLayer: false, isThin: true, charsPerPage: 0, pageCount: 0 };
}
