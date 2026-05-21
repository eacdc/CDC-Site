/**
 * Run OpenAI vision extraction for every page in a bill slots payload.
 * Used on POST /api/purchase-bills so the client only uploads images first.
 */
import { extractFromImage } from './openai-vision.js';
import { preprocessForAI } from './preprocess-image.js';

const SLOT_TYPES = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];

// Internal documents contain no meaningful colour → greyscale saves tokens
// and removes colour noise from scanner/camera.
const GREYSCALE_SLOTS = new Set(['tally_voucher', 'grn_sheet']);

function pageNeedsExtraction(page) {
  if (!page?.cloudinary_url) return false;
  const ef = page.extracted_fields;
  if (!ef || typeof ef !== 'object') return true;
  return Object.keys(ef).length === 0;
}

/**
 * @param {Record<string, { pages?: object[] }>} slots
 * @returns {Promise<Record<string, { pages: object[] }>>}
 */
export async function extractAllSlotPages(slots) {
  const out = { ...(slots || {}) };

  for (const slotType of SLOT_TYPES) {
    const slot = out[slotType];
    if (!slot?.pages?.length) continue;

    const greyscale = GREYSCALE_SLOTS.has(slotType);
    const pages = [];

    for (const page of slot.pages) {
      if (!pageNeedsExtraction(page)) {
        pages.push(page);
        continue;
      }

      // Preprocess image (auto-rotate, crop, resize, normalise, sharpen) before
      // sending to OpenAI. Returns a base64 data URI so no re-upload is needed.
      let imageSource = page.cloudinary_url;
      try {
        imageSource = await preprocessForAI(page.cloudinary_url, { greyscale });
      } catch (prepErr) {
        console.warn(
          `[extract-slots] preprocess failed for ${page.cloudinary_url}, falling back to raw URL:`,
          prepErr?.message,
        );
      }

      const result = await extractFromImage(imageSource, slotType);
      pages.push({
        ...page,
        extracted_fields: result.fields,
        extraction_model: result.model,
        classification_passed: result.classification_passed,
        classification_confidence: result.classification_confidence,
        uploaded_at: page.uploaded_at || new Date(),
      });
    }
    out[slotType] = { ...slot, pages };
  }

  return out;
}
