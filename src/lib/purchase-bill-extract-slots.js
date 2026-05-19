/**
 * Run OpenAI vision extraction for every page in a bill slots payload.
 * Used on POST /api/purchase-bills so the client only uploads images first.
 */
import { extractFromImage } from './openai-vision.js';

const SLOT_TYPES = ['tally_voucher', 'supplier_invoice', 'eway_bill', 'grn_sheet'];

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

    const pages = [];
    for (const page of slot.pages) {
      if (!pageNeedsExtraction(page)) {
        pages.push(page);
        continue;
      }

      const result = await extractFromImage(page.cloudinary_url, slotType);
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
