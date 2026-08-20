/**
 * Rendering a PDF's pages to images, for the scans that have no text layer.
 *
 * The text layer is always the better reading when it exists: it is the exact
 * characters the sender typed, so nothing can be misread. `pdf-text.js` handles
 * that case and this module never runs for it.
 *
 * What is left is a quote someone photocopied, or printed and scanned back in.
 * It carries no characters at all — only a picture of them — and the portal
 * used to refuse it with "upload its pages as images", which is a chore handed
 * back to the buyer for something the server can do itself in a second.
 *
 * So it does it itself. Pages are rasterised and sent to the vision model, and
 * the reading is a transcription rather than a copy — which is exactly why this
 * is the fallback and not the default.
 */

import sharp from 'sharp';

/**
 * How many pages are worth rendering.
 *
 * A price list runs to a handful of pages; a 60-page scan is somebody uploading
 * the wrong file, and rendering all of it would spend a minute and a large
 * request discovering that. The caller is told what was left out rather than
 * being quietly given a partial reading.
 */
export const MAX_RENDER_PAGES = 12;

/**
 * 2× page scale, then capped at 2200px on the long edge.
 *
 * Below roughly 1600px a scanned rate table stops being reliably legible —
 * ₹382.44 and ₹382.44/PC differ by a few pixels of glyph. Above ~2200 the extra
 * detail buys nothing a vision model uses and costs upload time on every page.
 */
export const RENDER_SCALE = 2;
export const MAX_EDGE = 2200;

/** JPEG rather than the PNG that comes out of the rasteriser. See below. */
export const JPEG_QUALITY = 82;

/**
 * Render up to `maxPages` pages as JPEG data URLs.
 *
 * @param {Buffer|Uint8Array} buffer  the PDF bytes
 * @returns {Promise<{pages: Array<{pageNo:number,url:string,mimeType:string,bytes:number}>,
 *                    total:number, rendered:number, truncated:boolean}>}
 */
export async function pdfPageImages(buffer, {
  maxPages = MAX_RENDER_PAGES,
  scale = RENDER_SCALE,
} = {}) {
  if (!buffer?.length) throw new Error('No PDF bytes to render');

  // Imported here rather than at module load: this path runs only for scans,
  // and pdf-parse pulls in the whole pdfjs worker.
  const { PDFParse } = await import('pdf-parse');

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // `first: N` means pages 1..N, so the rasteriser never touches the pages
    // beyond the cap — the cap saves the work, not just the upload.
    const shot = await parser.getScreenshot({ scale, first: maxPages });
    const rendered = shot?.pages || [];
    const total = shot?.total ?? rendered.length;

    const pages = [];
    for (const page of rendered) {
      const png = toBuffer(page.data);
      if (!png?.length) continue;
      const jpeg = await compress(png);
      pages.push({
        pageNo: page.pageNumber,
        mimeType: 'image/jpeg',
        url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        base64: jpeg.toString('base64'),
        bytes: jpeg.length,
      });
    }

    if (!pages.length) throw new Error('The PDF produced no readable page images');

    return { pages, total, rendered: pages.length, truncated: total > pages.length };
  } finally {
    // The worker holds native handles; leaking one per upload would starve the
    // process long before anybody connected it to quote extraction.
    await parser.destroy().catch(() => {});
  }
}

/**
 * PNG in, JPEG out, long edge capped.
 *
 * The rasteriser emits PNG, which is lossless and, for a photographed page,
 * enormous — several megabytes each, before base64 adds a third again. Three
 * pages of that is a request large enough to time out on its own. A quality-82
 * JPEG of a document scan is visually indistinguishable to the reader that
 * matters here and roughly a tenth the size.
 */
async function compress(png) {
  return sharp(png)
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      // Never scale a small page up: it adds bytes and no detail, and a
      // low-resolution scan should be reported as hard to read rather than
      // dressed up as a large one.
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

/** The rasteriser returns a Uint8Array; older builds returned a plain array. */
function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  return null;
}
