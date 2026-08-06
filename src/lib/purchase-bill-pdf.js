/**
 * Build a single PDF from all bill slot images (tally → invoice → e-way → GRN).
 *
 * Images are only auto-cropped before embedding (plus EXIF orientation fix
 * + JPEG encode). No resize, contrast normalisation, sharpening, or
 * greyscaling is applied, so the downloaded scan looks like the original
 * captured photo, just trimmed.
 */
import { PDFDocument } from 'pdf-lib';
import { preprocessForPDF } from './preprocess-image.js';
import { resolveViewUrlList } from './media-url.js';

const SLOT_ORDER = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 28;

/**
 * Page refs for a bill in display order (tally → invoice → e-way → GRN).
 * Returns the raw records; call collectBillImageUrls to resolve them.
 *
 * @param {import('../models/PurchaseBill.js').purchaseBillSchema | Record<string, unknown>} bill
 */
export function collectBillImagePages(bill) {
  const pages = [];
  for (const slot of SLOT_ORDER) {
    const slotPages = bill.slots?.[slot]?.pages;
    if (!Array.isArray(slotPages)) continue;
    const sorted = [...slotPages].sort((a, b) => (a.page_no || 0) - (b.page_no || 0));
    for (const p of sorted) {
      if (p?.r2_key || p?.cloudinary_url) pages.push(p);
    }
  }
  return pages;
}

/**
 * Resolve every page of a bill to a fetchable URL.
 *
 * Async because R2 view URLs are signed per request (MIGRATION.md section 5).
 * The signed URLs are consumed immediately by buildBillScanPdf and never
 * stored.
 *
 * @param {import('../models/PurchaseBill.js').purchaseBillSchema | Record<string, unknown>} bill
 * @returns {Promise<string[]>}
 */
export async function collectBillImageUrls(bill) {
  const resolved = await resolveViewUrlList(collectBillImagePages(bill));
  return resolved.filter(Boolean).map(String);
}

/** Safe for Windows/macOS filenames; keeps PUR/1881/26-27 readable as PUR-1881-26-27 */
function sanitizeTallyForFilename(value) {
  return String(value).trim().replace(/[/\\:*?"<>|]/g, '-').slice(0, 80);
}

/** @param {import('../models/PurchaseBill.js').purchaseBillSchema | Record<string, unknown>} bill */
export function billScanPdfFilename(bill) {
  const tally = bill.tally_voucher_number ? sanitizeTallyForFilename(bill.tally_voucher_number) : '';
  const base = tally || String(bill._id || 'bill');
  return `CDC-Bills-${base}.pdf`;
}

/**
 * @param {string[]} imageUrls  Resolved page URLs (in display order): presigned
 *   R2 URLs when USE_R2 is on, else legacy Cloudinary URLs. Consume promptly —
 *   signed URLs expire.
 * @returns {Promise<Uint8Array>}
 */
export async function buildBillScanPdf(imageUrls) {
  if (!imageUrls.length) {
    throw new Error('No images to include in PDF');
  }

  const pdfDoc = await PDFDocument.create();

  for (const url of imageUrls) {
    // Preprocess: EXIF auto-rotate + auto-crop only → JPEG buffer
    // (no resize / normalise / sharpen — see preprocess-image.js)
    let jpegBuf;
    try {
      jpegBuf = await preprocessForPDF(url);
    } catch (err) {
      console.warn('[bill-pdf] preprocess failed, embedding raw image:', err?.message);
      // Fallback: fetch raw bytes
      const { default: axios } = await import('axios');
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 90_000 });
      jpegBuf = Buffer.from(resp.data);
    }

    // preprocessForPDF always returns JPEG; fallback might be any format
    let image;
    try {
      image = await pdfDoc.embedJpg(new Uint8Array(jpegBuf));
    } catch {
      image = await pdfDoc.embedPng(new Uint8Array(jpegBuf));
    }

    const page = pdfDoc.addPage([A4_W, A4_H]);
    const maxW = A4_W - MARGIN * 2;
    const maxH = A4_H - MARGIN * 2;
    const scale = Math.min(maxW / image.width, maxH / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    const x = (A4_W - w) / 2;
    const y = (A4_H - h) / 2;
    page.drawImage(image, { x, y, width: w, height: h });
  }

  return pdfDoc.save();
}
