/**
 * The OpenAI adapter for the paper interpreter.
 *
 * Deliberately thin. The interpreter takes `send` as an argument so its control
 * flow — which exit fires, what the model is told when it errs, which answers
 * never reach it — is testable without a key or a network. Everything that
 * knows about OpenAI lives here, and it is the one part of the paper work that
 * cannot be tested offline.
 *
 * It reuses `createCompletion` rather than calling the SDK directly, so the
 * temperature-fallback memory is shared with the extraction provider: a
 * reasoning model that refuses `temperature` is discovered once per process,
 * not once per code path.
 */

import { createCompletion } from '../extraction/openai-provider.js';

const MODEL = process.env.SP_PAPER_MODEL
  || process.env.SP_EXTRACTION_MODEL
  || 'gpt-4o';

/**
 * One interpretation turn against OpenAI.
 *
 * Pages and text layer both go, and they do different jobs: the text layer has
 * the exact characters, the image has the layout. Krishna Vanijya's list is the
 * case that needs both — its section headings land far from their rows in the
 * text layer, and only the image says which heading a row sits under.
 *
 * @param {Object} input
 * @param {string} input.system   the role prompt
 * @param {string} input.message  the assembled context and rules
 * @param {Array}  input.pages    [{ url }] rendered page images, possibly empty
 * @returns {Promise<Object>} the model's parsed JSON reply
 */
export async function sendToOpenAI({ system, message, pages = [] }) {
  const unsendable = pages.filter((p) => p?.url && !isSendableImage(p));
  if (unsendable.length) {
    throw new Error(
      `Cannot send page ${unsendable[0].pageNo ?? 1} to the model: `
      + `${describeSource(unsendable[0])} is not an image. `
      + 'PDFs must be rendered to JPEG or PNG before they are read.',
    );
  }

  const content = [{ type: 'text', text: message }];
  for (const page of pages) {
    if (page?.url) content.push({ type: 'image_url', image_url: { url: page.url } });
  }

  const response = await createCompletion({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from OpenAI while interpreting a paper quote.');

  try {
    return JSON.parse(text);
  } catch {
    /*
      JSON mode makes this rare, but a truncated reply is still possible on a
      long price list. Say which it was: "unparseable" sends somebody looking
      at the prompt, when the actual fix is a shorter document or a larger
      output allowance.
    */
    const truncated = !text.trimEnd().endsWith('}');
    throw new Error(
      truncated
        ? `The model's reply was cut off after ${text.length} characters — the document may be too long to read in one pass.`
        : 'The model returned something that is not JSON.',
    );
  }
}

/** The only formats the vision endpoint accepts. */
const SENDABLE = /^(png|jpe?g|gif|webp)$/i;

/**
 * Can this page go to a vision model?
 *
 * Exists because it did not, and the failure was worth turning into our own
 * error. The paper route first passed signed storage URLs straight through, so
 * a PDF — which is what every real quote is — arrived at OpenAI as an image and
 * came back `400 You uploaded an unsupported image`. That message names neither
 * the document nor the fix, and points at the upload rather than at the missing
 * rasterise step.
 *
 * A `data:` URL declares its own type. A storage URL does not, so the page's
 * `mimeType` decides — and a page with neither is refused rather than sent
 * hopefully, because the whole point is to fail here with a sentence somebody
 * can act on instead of there with one they cannot.
 */
export function isSendableImage(page) {
  const url = String(page?.url || '');

  const dataUrl = url.match(/^data:image\/([a-z0-9.+-]+);/i);
  if (dataUrl) return SENDABLE.test(dataUrl[1]);
  if (url.startsWith('data:')) return false;

  const mime = String(page?.mimeType || '').match(/^image\/([a-z0-9.+-]+)/i);
  return Boolean(mime) && SENDABLE.test(mime[1]);
}

function describeSource(page) {
  const url = String(page?.url || '');
  if (url.startsWith('data:')) return url.slice(0, url.indexOf(';')) || 'that data URL';
  return page?.mimeType ? `its type ${page.mimeType}` : 'it declares no image type';
}

export const PAPER_MODEL = MODEL;
