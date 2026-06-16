/**
 * Image preprocessing pipeline.
 *
 * Applied before:
 *   (a) sending images to OpenAI Vision — improves OCR accuracy
 *       (full pipeline: rotate, resize, auto-crop, normalise, sharpen, JPEG)
 *   (b) building the "Scan & Download" PDF — auto-crop only, no enhancement,
 *       so the downloaded pages look like the original photo (just trimmed).
 *
 * Steps (in order) when `enhance: true` (the default, used for AI/OCR):
 *   1. Fetch raw bytes from the Cloudinary URL
 *   2. Auto-rotate based on EXIF orientation (phone photos are often sideways)
 *   3. Resize so the long edge is ≤ MAX_LONG_EDGE px (keeps image in one
 *      GPT-4o tile; avoids paying for tiled processing of 12 MP phone shots)
 *   4. Auto-crop: trim uniform border regions (scanner borders, desk surface,
 *      plain backgrounds). Falls back to no-crop if trimming removes > 40%
 *      of area (prevents over-aggressive crop on dark/complex backgrounds).
 *   5. Normalise contrast histogram (recovers faded / underexposed scans)
 *   6. Unsharp-mask sharpen (crisps text edges from slightly blurry photos)
 *   7. Optional greyscale (for internal documents like Tally Vouchers / GRN
 *      sheets that have no meaningful colour information)
 *   8. Encode as JPEG quality 88 → small payload, lossless-enough for OCR
 *
 * When `enhance: false` (used for the Scan & Download PDF):
 *   1. Fetch raw bytes
 *   2. Auto-rotate based on EXIF orientation (required for correct orientation)
 *   3. Auto-crop (the one preprocessing step we keep for the scan PDF)
 *   4. Encode as JPEG quality SCAN_JPEG_QUALITY
 *   (no resize, no normalise, no sharpen, no greyscale)
 */

import sharp from 'sharp';
import axios from 'axios';

const MAX_LONG_EDGE = 1536;   // fits in one GPT-4o high-res tile
const SHARPEN_SIGMA = 1.1;    // mild unsharp mask — enough to crisp text
const JPEG_QUALITY = 88;      // for OCR / AI path
const SCAN_JPEG_QUALITY = 92; // for Scan & Download PDF — preserve more detail
                              // since we are NOT sharpening/normalising

// Document detection constants
const ANALYSIS_SIZE = 400;        // analyse a small thumbnail for speed
const BRIGHT_THRESHOLD = 140;     // greyscale value above which a pixel is "document"
                                  // (lowered to include slightly shadowed paper edges)
const ROW_DOC_FRACTION = 0.25;    // fraction of row/col pixels that must be bright
                                  // (lowered so text-heavy rows still count as document)
const MIN_CROP_FRACTION = 0.3;    // skip crop if result is < 30 % of original area
const CROP_PADDING_FRAC = 0.025;  // padding as fraction of image edge (≈ 2.5%)
                                  // keeps a safety margin around detected bounds

// ---------- helpers ----------

async function fetchBuffer(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxContentLength: 25 * 1024 * 1024,
  });
  return Buffer.from(resp.data);
}

/**
 * Detect the bounding box of the bright document region by scanning a small
 * greyscale thumbnail row-by-row and column-by-column.
 *
 * Works for documents photographed on ANY background (red fabric, wooden
 * desks, dark tables) as long as the document itself is lighter than the
 * surroundings — which is true for all white/cream paper invoices.
 *
 * @param {Buffer} buf  - already-resized image buffer
 * @returns {Promise<{left:number,top:number,width:number,height:number}|null>}
 */
async function detectDocumentBounds(buf) {
  const origMeta = await sharp(buf).metadata();
  const origW = origMeta.width || 1;
  const origH = origMeta.height || 1;

  // Downscale to a small thumbnail for cheap pixel analysis
  const { data, info } = await sharp(buf)
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tw = info.width;   // thumbnail width
  const th = info.height;  // thumbnail height

  // Count bright pixels per row and per column
  const rowBright = new Int32Array(th);
  const colBright = new Int32Array(tw);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (data[y * tw + x] > BRIGHT_THRESHOLD) {
        rowBright[y]++;
        colBright[x]++;
      }
    }
  }

  // Find first/last row/col where enough pixels are bright
  let topRow = 0, bottomRow = th - 1, leftCol = 0, rightCol = tw - 1;
  for (let y = 0; y < th; y++)       { if (rowBright[y] / tw >= ROW_DOC_FRACTION) { topRow    = y; break; } }
  for (let y = th - 1; y >= 0; y--)  { if (rowBright[y] / tw >= ROW_DOC_FRACTION) { bottomRow = y; break; } }
  for (let x = 0; x < tw; x++)       { if (colBright[x] / th >= ROW_DOC_FRACTION) { leftCol   = x; break; } }
  for (let x = tw - 1; x >= 0; x--)  { if (colBright[x] / th >= ROW_DOC_FRACTION) { rightCol  = x; break; } }

  // Scale detected bounds back to original image dimensions
  const scaleX = origW / tw;
  const scaleY = origH / th;

  // Proportional padding so behaviour is consistent across image sizes
  const padX = Math.round(origW * CROP_PADDING_FRAC);
  const padY = Math.round(origH * CROP_PADDING_FRAC);

  const left   = Math.max(0,      Math.floor(leftCol  * scaleX) - padX);
  const top    = Math.max(0,      Math.floor(topRow   * scaleY) - padY);
  const right  = Math.min(origW,  Math.ceil(rightCol  * scaleX) + padX);
  const bottom = Math.min(origH,  Math.ceil(bottomRow * scaleY) + padY);

  const cropW = right  - left;
  const cropH = bottom - top;

  // Safety: only accept the crop if it keeps at least MIN_CROP_FRACTION of area
  if (cropW <= 0 || cropH <= 0 || (cropW * cropH) < (origW * origH * MIN_CROP_FRACTION)) {
    return null;
  }

  return { left, top, width: cropW, height: cropH };
}

/**
 * Auto-crop using brightness-based document detection.
 * Returns the cropped buffer, or the original if no valid crop was found.
 *
 * @param {Buffer} buf
 * @returns {Promise<Buffer>}
 */
async function autoCrop(buf) {
  try {
    const bounds = await detectDocumentBounds(buf);
    if (!bounds) return buf;
    return sharp(buf)
      .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
      .toBuffer();
  } catch {
    return buf;
  }
}

// ---------- main pipeline ----------

/**
 * Preprocess a Cloudinary image URL and return a JPEG buffer.
 *
 * @param {string} url  - Cloudinary (or any HTTP) image URL
 * @param {{ greyscale?: boolean, enhance?: boolean }} [opts]
 *   - greyscale: convert to greyscale (only honoured when enhance=true)
 *   - enhance:   when true (default), run the full OCR pipeline (resize,
 *                normalise, sharpen, optional greyscale). When false, only
 *                auto-rotate + auto-crop + JPEG encode are applied.
 * @returns {Promise<Buffer>}
 */
export async function preprocessToBuffer(url, { greyscale = false, enhance = true } = {}) {
  const raw = await fetchBuffer(url);

  if (!enhance) {
    // Scan & Download path: only auto-crop. No resize, normalise, or sharpen.
    // EXIF rotate is kept because without it phone photos would be sideways
    // — that is orientation correction, not image enhancement.
    const rotatedBuf = await sharp(raw).rotate().toBuffer();
    const croppedBuf = await autoCrop(rotatedBuf);
    return sharp(croppedBuf).jpeg({ quality: SCAN_JPEG_QUALITY }).toBuffer();
  }

  // Step 1+2: rotate from EXIF + resize
  const resizedBuf = await sharp(raw)
    .rotate()                                                // EXIF auto-rotate
    .resize({
      width: MAX_LONG_EDGE,
      height: MAX_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toBuffer();

  // Step 3: auto-crop borders
  const croppedBuf = await autoCrop(resizedBuf);

  // Steps 4-6: normalise + sharpen + optional greyscale → JPEG
  let pipeline = sharp(croppedBuf)
    .normalise()
    .sharpen({ sigma: SHARPEN_SIGMA });

  if (greyscale) {
    pipeline = pipeline.greyscale();
  }

  return pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

/**
 * Preprocess an image and return a base64 data URI suitable for OpenAI
 * `image_url` message content. Runs the full enhancement pipeline.
 *
 * @param {string} url
 * @param {{ greyscale?: boolean }} [opts]
 * @returns {Promise<string>}  e.g. "data:image/jpeg;base64,/9j/..."
 */
export async function preprocessForAI(url, { greyscale = false } = {}) {
  const buf = await preprocessToBuffer(url, { greyscale, enhance: true });
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * Preprocess an image and return a raw JPEG Buffer for embedding in the
 * "Scan & Download" bill PDF.
 *
 * Only auto-cropping is applied (plus the unavoidable EXIF orientation fix
 * and JPEG encoding). No resize, normalise, sharpen, or greyscale — so the
 * downloaded image looks like the original captured photo, just trimmed.
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function preprocessForPDF(url) {
  return preprocessToBuffer(url, { greyscale: false, enhance: false });
}
