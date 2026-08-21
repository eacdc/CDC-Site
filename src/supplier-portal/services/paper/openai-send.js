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

export const PAPER_MODEL = MODEL;
