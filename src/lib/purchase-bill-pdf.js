/**
 * Build a single PDF from all bill slot images (tally → invoice → e-way → GRN).
 */
import { PDFDocument } from 'pdf-lib';
import axios from 'axios';

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
 * @param {string[]} imageUrls
 * @returns {Promise<Uint8Array>}
 */
export async function buildBillScanPdf(imageUrls) {
  if (!imageUrls.length) {
    throw new Error('No images to include in PDF');
  }

  const pdfDoc = await PDFDocument.create();

  for (const url of imageUrls) {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90_000,
      maxContentLength: 25 * 1024 * 1024,
    });
    const bytes = new Uint8Array(resp.data);
    const contentType = String(resp.headers['content-type'] || '').toLowerCase();

    let image;
    if (contentType.includes('png')) {
      image = await pdfDoc.embedPng(bytes);
    } else {
      try {
        image = await pdfDoc.embedJpg(bytes);
      } catch {
        image = await pdfDoc.embedPng(bytes);
      }
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
