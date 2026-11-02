/**
 * Anthropic (Claude) implementation of the extraction provider — the default.
 *
 * `EXTRACTION_PROVIDER=openai` switches back to openai-provider.js; nothing
 * downstream changes, which is the point of the interface.
 *
 * The prompts come from `prompts.js`, shared with the OpenAI provider. The
 * client, model checks and image handling come from lib/claude.js, shared with
 * the rest of the backend.
 *
 * Models:
 *   SP_ANTHROPIC_MODEL              quotes and invoices      (default: strong tier)
 *   SP_ANTHROPIC_ADJUDICATION_MODEL line → item adjudication (default: standard tier)
 *   SP_ANTHROPIC_EFFORT             low | medium | high      (default: medium)
 * Only claude-* ids are honoured; an OpenAI id left in the environment is
 * skipped with a warning.
 */

import {
  registerProvider,
  ExtractedQuoteSchema,
  ExtractedInvoiceSchema,
  AdjudicationSchema,
} from './provider.js';
import { QUOTE_PROMPT, INVOICE_PROMPT, ADJUDICATION_PROMPT } from './prompts.js';
import { textLayerInstruction } from './pdf-text.js';
import { describeIssues } from './openai-provider.js';
import { askJson, mediaBlock, envModel, MODELS } from '../../../lib/claude.js';

const MODEL = envModel('SP_ANTHROPIC_MODEL', MODELS.strong);
const ADJUDICATION_MODEL = envModel('SP_ANTHROPIC_ADJUDICATION_MODEL', MODELS.standard);
const ORIENTATION_MODEL = MODELS.fast;
const EFFORT = process.env.SP_ANTHROPIC_EFFORT || 'medium';

/*
  Room for the longest price lists. One extracted line runs to well over a
  hundred tokens, thinking comes out of the same allowance, and a reply cut
  off at the cap is an error (lib/claude.js) rather than a shorter list.
*/
const EXTRACTION_MAX_TOKENS = 32000;

/**
 * Content blocks for the pages, in order.
 *
 * A rendered scan arrives with its bytes already in hand (`base64`); anything
 * else is a data: URL or a signed storage URL, fetched and inlined. A page
 * whose type is PDF goes as a document block, which Claude reads natively.
 */
export async function pageBlocks(pages = []) {
  return Promise.all(pages.map((page) => (
    page.base64
      ? mediaBlock(Buffer.from(page.base64, 'base64'), page.mimeType || 'image/jpeg')
      : mediaBlock(page.url, page.mimeType)
  )));
}

/**
 * One extraction, validated against `schema` and retried once.
 *
 * The retry is told what was wrong. Re-sending the identical prompt reproduces
 * the same reply and the same failure, having doubled the wait.
 *
 * `pages` may be empty: a born-digital PDF is read from its text layer, which
 * arrives inside `extraInstructions`, and sending no image is correct rather
 * than a degraded mode — the model has the exact characters instead of a
 * picture of them.
 */
async function extractWithSchema({ pages, prompt, schema, extraInstructions, feature }) {
  const blocks = await pageBlocks(pages);
  let lastError;
  let correction = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = [prompt, extraInstructions, correction].filter(Boolean).join('\n\n');
    try {
      const { data, model } = await askJson({
        feature,
        model: MODEL,
        effort: EFFORT,
        maxTokens: EXTRACTION_MAX_TOKENS,
        content: [...blocks, { type: 'text', text }],
      });
      const parsed = schema.safeParse(data);
      if (parsed.success) return { data: parsed.data, model };

      const detail = describeIssues(parsed.error.issues);
      lastError = new Error(`Extraction did not match the schema: ${detail}`);
      correction = `Your previous reply was rejected: ${detail}\nReturn the same data with those fields corrected.`;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Extraction failed');
}

const anthropicProvider = {
  name: 'anthropic',

  async extractQuote({ pages, textLayer, docType, hints } = {}) {
    if (!pages?.length && !textLayer) {
      throw new Error('extractQuote needs at least one page image or a text layer');
    }
    const extra = [
      docType ? `The uploader classified this document as: ${docType}.` : null,
      hints?.supplierName ? `The uploader says the supplier is "${hints.supplierName}". Verify against the document rather than assuming.` : null,
      hints?.plantScope?.length ? `The uploader says this document covers: ${hints.plantScope.join(', ')}. Still report only plants the document itself names.` : null,
      hints?.priceColumn ? `For multi-column worksheets, the live price column is "${hints.priceColumn}". Extract that column as the rate and put the others in notes.` : null,
      // Last, so it sits closest to the images whose characters it corrects.
      textLayer ? textLayerInstruction(textLayer) : null,
    ].filter(Boolean).join('\n') || null;

    const { data, model } = await extractWithSchema({
      pages, prompt: QUOTE_PROMPT, schema: ExtractedQuoteSchema, extraInstructions: extra,
      feature: 'supplier-quote-extract',
    });
    return { ...data, _provider: 'anthropic', _model: model };
  },

  async extractInvoice({ pages, hints } = {}) {
    if (!pages?.length) throw new Error('extractInvoice needs at least one page');
    const extra = [
      hints?.expectedSupplier ? `The supplier is expected to be "${hints.expectedSupplier}". Verify rather than assume.` : null,
      ...(hints?.notes || []),
    ].filter(Boolean).join('\n\n') || null;
    const { data, model } = await extractWithSchema({
      pages, prompt: INVOICE_PROMPT, schema: ExtractedInvoiceSchema, extraInstructions: extra,
      feature: 'supplier-invoice-extract',
    });
    return { ...data, _provider: 'anthropic', _model: model };
  },

  /**
   * Which of four copies of a page - one per quarter turn - reads the right
   * way up. Small images on the fast model: a cheap question.
   * Returns the index of the upright copy.
   */
  async detectOrientation({ images } = {}) {
    const labels = ['A', 'B', 'C', 'D'];
    const content = [{
      type: 'text',
      text: 'These are four copies of the same document page, each turned a different way: A, B, C and D, in that '
        + 'order. Which one has its text the right way up, so that it reads normally from left to right and top to '
        + 'bottom?',
    }];
    for (const [i, url] of images.entries()) {
      content.push({ type: 'text', text: `Copy ${labels[i]}:` });
      content.push(await mediaBlock(url));
    }
    const { data } = await askJson({
      feature: 'supplier-invoice-orientation',
      model: ORIENTATION_MODEL,
      effort: 'low',
      maxTokens: 2000,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { upright: { type: 'string', enum: labels } },
        required: ['upright'],
      },
      content,
    });
    const index = labels.indexOf(String(data?.upright || '').trim().toUpperCase());
    if (index < 0) throw new Error('No orientation in the reply.');
    return index;
  },

  async adjudicate({ line, candidates, mapped } = {}) {
    const payload = {
      quotedLine: line,
      candidates: (candidates || []).slice(0, 8),
      alreadyMappedForThisSupplier: (mapped || []).slice(0, 20),
    };

    const { data, model } = await askJson({
      feature: 'supplier-adjudicate',
      model: ADJUDICATION_MODEL,
      effort: 'low',
      maxTokens: 4000,
      system: ADJUDICATION_PROMPT,
      content: JSON.stringify(payload, null, 2),
    });
    const parsed = AdjudicationSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Adjudication did not match the schema: ${parsed.error.message}`);
    }
    return { ...parsed.data, _model: model };
  },
};

/**
 * Registered unconditionally, like the OpenAI provider: registration and
 * credentials are separate concerns, and a missing key is reported by
 * getProvider() and by the first call, naming the key.
 */
export function registerAnthropicProvider() {
  return registerProvider(anthropicProvider);
}

export default anthropicProvider;
