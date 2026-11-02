/**
 * The Claude adapter for the paper interpreter — the default.
 *
 * Deliberately thin, like its OpenAI twin: the interpreter takes `send` as an
 * argument so its control flow is testable without a key or a network, and
 * everything that knows about the model lives here.
 *
 * Model: SP_PAPER_MODEL, else SP_ANTHROPIC_MODEL, else the strong tier. Only
 * claude-* ids are honoured.
 */

import { askJson, envModel, MODELS } from '../../../lib/claude.js';
import { pageBlocks } from '../extraction/anthropic-provider.js';
import { isSendableImage } from './openai-send.js';

const MODEL = envModel(['SP_PAPER_MODEL', 'SP_ANTHROPIC_MODEL'], MODELS.strong);
const EFFORT = process.env.SP_ANTHROPIC_EFFORT || 'medium';

/**
 * One interpretation turn against Claude.
 *
 * Pages and text layer both go, and they do different jobs: the text layer has
 * the exact characters, the image has the layout. Krishna Vanijya's list is the
 * case that needs both — its section headings land far from their rows in the
 * text layer, and only the image says which heading a row sits under.
 *
 * A reply cut off at the output cap is an error, not a shorter list (see
 * lib/claude.js): a partial reading that reaches the review table looks
 * finished.
 *
 * @param {Object} input
 * @param {string} input.system   the role prompt
 * @param {string} input.message  the assembled context and rules
 * @param {Array}  input.pages    [{ url }] rendered page images, possibly empty
 * @returns {Promise<Object>} the model's parsed JSON reply
 */
export async function sendToClaude({ system, message, pages = [] }) {
  const unsendable = pages.filter((p) => p?.url && !isSendableImage(p));
  if (unsendable.length) {
    throw new Error(
      `Cannot send page ${unsendable[0].pageNo ?? 1} to the model: `
      + `${describeSource(unsendable[0])} is not an image. `
      + 'PDFs must be rendered to JPEG or PNG before they are read.',
    );
  }

  const blocks = await pageBlocks(pages.filter((p) => p?.url || p?.base64));
  const { data } = await askJson({
    feature: 'supplier-paper-interpret',
    model: MODEL,
    effort: EFFORT,
    // One line of this payload runs to well over a hundred tokens, and
    // thinking comes out of the same allowance.
    maxTokens: 32000,
    system,
    content: [...blocks, { type: 'text', text: message }],
  });
  return data;
}

function describeSource(page) {
  const url = String(page?.url || '');
  if (url.startsWith('data:')) return url.slice(0, url.indexOf(';')) || 'that data URL';
  return page?.mimeType ? `its type ${page.mimeType}` : 'it declares no image type';
}

export const PAPER_MODEL = MODEL;
