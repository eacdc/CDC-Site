/**
 * Build a single PDF from all bill slot images (tally → invoice → e-way → GRN).
 * Images are preprocessed (auto-rotate, auto-crop, normalise, sharpen) before
 * embedding so the PDF contains clean, cropped pages.
 */
import { PDFDocument } from 'pdf-lib';
import { preprocessForPDF } from './preprocess-image.js';

const SLOT_ORDER = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 28;

/** @param {import('../models/PurchaseBill.js').purchaseBillSchema | Record<string, unknown>} bill */
export function collectBillImageUrls(bill) {
  const urls = [];
  for (const slot of SLOT_ORDER) {
    const pages = bill.slots?.[slot]?.pages;
    if (!Array.isArray(pages)) continue;
    const sorted = [...pages].sort((a, b) => (a.page_no || 0) - (b.page_no || 0));
    for (const p of sorted) {
      if (p?.cloudinary_url) urls.push(String(p.cloudinary_url));
    }
  }
  return urls;
}

/** @param {import('../models/PurchaseBill.js').purchaseBillSchema | Record<string, unknown>} bill */
export function billScanPdfFilename(bill) {
  const inv = bill.invoice_number
    ? String(bill.invoice_number).replace(/[^\w.-]+/g, '_').slice(0, 40)
    : null;
  const voucher = bill.tally_voucher_number
    ? String(bill.tally_voucher_number).replace(/[^\w.-]+/g, '_').slice(0, 40)
    : null;
  const base = inv || voucher || String(bill._id || 'bill');
  return `CDC-Bill-${base}.pdf`;
}

/**
 * @param {string[]} imageUrls  Cloudinary URLs of bill pages (in display order)
 * @returns {Promise<Uint8Array>}
 */
export async function buildBillScanPdf(imageUrls) {
  if (!imageUrls.length) {
    throw new Error('No images to include in PDF');
  }

  const pdfDoc = await PDFDocument.create();

  for (const url of imageUrls) {
    // Preprocess: auto-rotate, crop, normalise, sharpen → clean JPEG buffer
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
