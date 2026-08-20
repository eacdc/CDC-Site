/**
 * Anthropic (Claude) implementation of the extraction provider.
 *
 * Selecting it is a matter of setting `EXTRACTION_PROVIDER=anthropic` and
 * installing `@anthropic-ai/sdk` — nothing downstream changes, which is the
 * point of the interface.
 *
 * Both the SDK import and the registration are deferred:
 *
 *  - The SDK is loaded on first use, so this module is safe to import in a
 *    deployment that has not installed it. The package is an optional
 *    dependency precisely because CDC runs on OpenAI today.
 *  - Registration only happens when a key is present. A registered-but-broken
 *    provider is worse than an absent one: `EXTRACTION_PROVIDER=anthropic`
 *    would then fail once per request instead of once at boot.
 *
 * The prompts come from `prompts.js`, shared with the OpenAI provider.
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

const MODEL = process.env.SP_ANTHROPIC_MODEL || 'claude-sonnet-4-5';

let clientPromise = null;

function anthropic() {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set on the server.');
      }
      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch {
        throw new Error(
          'EXTRACTION_PROVIDER is set to anthropic but @anthropic-ai/sdk is not installed. ' +
          'Run `npm install @anthropic-ai/sdk`, or set EXTRACTION_PROVIDER=openai.',
        );
      }
      return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

/**
 * Claude's vision input takes base64 blocks. Pages arrive as signed URLs,
 * which are fetched and inlined here — a URL that expires mid-request would
 * otherwise fail deep inside the model call with an error that reads like a
 * model problem rather than an expiry.
 */
async function pageToBlock(page) {
  const response = await fetch(page.url);
  if (!response.ok) {
    throw new Error(`Could not fetch page ${page.pageNo ?? ''} for extraction: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mediaType = page.mimeType || response.headers.get('content-type') || 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
  };
}

/**
 * One extraction call.
 *
 * `pages` may be empty: a born-digital PDF is read from its text layer, which
 * arrives inside `extraInstructions`, and sending no image is correct rather
 * than a degraded mode — the model has the exact characters instead of a
 * picture of them.
 */
async function callClaude({ pages, prompt, schema, extraInstructions }) {
  const client = await anthropic();
  const blocks = await Promise.all((pages || []).map(pageToBlock));
  const text = extraInstructions ? `${prompt}\n\n${extraInstructions}` : prompt;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        temperature: 0,
        system: 'Reply with a single JSON object and nothing else. No markdown fences, no commentary.',
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text }] }],
      });

      const body = response.content?.find((c) => c.type === 'text')?.text;
      if (!body) throw new Error('Empty response from Anthropic');
      const parsed = schema.safeParse(JSON.parse(stripFences(body)));
      if (parsed.success) return { data: parsed.data, model: MODEL };
      lastError = new Error(
        `Extraction did not match the schema: ${describeIssues(parsed.error.issues)}`,
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Extraction failed');
}

function stripFences(text) {
  return String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

const anthropicProvider = {
  name: 'anthropic',

  async extractQuote({ pages, textLayer, docType, hints } = {}) {
    if (!pages?.length && !textLayer) {
      throw new Error('extractQuote needs at least one page image or a text layer');
    }
    const extra = [
      docType ? `The uploader classified this document as: ${docType}.` : null,
      hints?.supplierName ? `The uploader says the supplier is "${hints.supplierName}". Verify against the document.` : null,
      hints?.plantScope?.length ? `The uploader says this document covers: ${hints.plantScope.join(', ')}. Still report only plants the document itself names.` : null,
      hints?.priceColumn ? `The live price column is "${hints.priceColumn}".` : null,
      // Last, so it sits closest to the images it corrects.
      textLayer ? textLayerInstruction(textLayer) : null,
    ].filter(Boolean).join('\n') || null;

    const { data, model } = await callClaude({
      pages, prompt: QUOTE_PROMPT, schema: ExtractedQuoteSchema, extraInstructions: extra,
    });
    return { ...data, _provider: 'anthropic', _model: model };
  },

  async extractInvoice({ pages, hints } = {}) {
    if (!pages?.length) throw new Error('extractInvoice needs at least one page');
    const extra = hints?.expectedSupplier
      ? `The supplier is expected to be "${hints.expectedSupplier}". Verify rather than assume.`
      : null;
    const { data, model } = await callClaude({
      pages, prompt: INVOICE_PROMPT, schema: ExtractedInvoiceSchema, extraInstructions: extra,
    });
    return { ...data, _provider: 'anthropic', _model: model };
  },

  async adjudicate({ line, candidates, mapped } = {}) {
    const client = await anthropic();
    const payload = {
      quotedLine: line,
      candidates: (candidates || []).slice(0, 8),
      alreadyMappedForThisSupplier: (mapped || []).slice(0, 20),
    };

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: `${ADJUDICATION_PROMPT}\n\nReply with a single JSON object and nothing else.`,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    });

    const body = response.content?.find((c) => c.type === 'text')?.text;
    if (!body) throw new Error('Empty adjudication response');
    const parsed = AdjudicationSchema.safeParse(JSON.parse(stripFences(body)));
    if (!parsed.success) {
      throw new Error(`Adjudication did not match the schema: ${parsed.error.message}`);
    }
    return { ...parsed.data, _model: MODEL };
  },
};

/** Registers the provider when a key is configured. Returns null otherwise. */
export function registerAnthropicProvider() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return registerProvider(anthropicProvider);
}

export default anthropicProvider;
