/**
 * OpenAI vision implementation of the extraction provider.
 *
 * The prompts carry the hard-won rules from the August 2026 quote batch. They
 * are long on purpose — every paragraph corresponds to a document that broke a
 * shorter prompt, and the alternative to stating a rule is a plausible wrong
 * number that nobody catches.
 */

import OpenAI from 'openai';
import {
  registerProvider,
  ExtractedQuoteSchema,
  ExtractedInvoiceSchema,
  AdjudicationSchema,
} from './provider.js';
import { QUOTE_PROMPT, INVOICE_PROMPT, ADJUDICATION_PROMPT } from './prompts.js';
import { textLayerInstruction } from './pdf-text.js';

let client = null;

/**
 * Lazy init so a missing key does not crash module load — the server boots
 * many unrelated routes and should only fail when extraction is actually
 * called.
 */
function openai() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server.');
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

const VISION_MODEL = process.env.SP_EXTRACTION_MODEL || 'gpt-4o';
const TEXT_MODEL = process.env.SP_ADJUDICATION_MODEL || 'gpt-4o';

/**
 * Models that rejected `temperature`, remembered for the life of the process.
 *
 * `temperature: 0` was hardcoded on every call. Reasoning models accept only
 * the default, and answer anything else with
 * `400 Unsupported value: 'temperature' does not support 0 with this model` —
 * so changing SP_EXTRACTION_MODEL to one of them broke every extraction, every
 * adjudication, and left no way forward except reverting the model.
 *
 * A config flag would have moved the problem rather than solved it: it is one
 * more thing to set correctly, it is set per deployment rather than per model,
 * and getting it wrong fails in exactly the same way. So the provider finds out
 * for itself — send the parameter, and if this model refuses it, drop it and
 * retry. One wasted call per model per process, and no configuration at all.
 */
const rejectsTemperature = new Set();

/**
 * Models that call the output cap `max_completion_tokens`, remembered likewise.
 *
 * The second instance of exactly the same problem, and it arrived the same way:
 * an output cap was added to stop long price lists being silently truncated,
 * and the reasoning model in use answered
 * `400 Unsupported parameter: 'max_tokens' is not supported with this model.
 * Use 'max_completion_tokens' instead` — so the fix for one silent failure
 * became a loud one on every read.
 *
 * Renaming the parameter outright is not the answer: the older models this
 * project also runs against accept `max_tokens` and not the new name, so a
 * blind rename would simply move the 400 to a different deployment. The
 * provider finds out for itself, exactly as it does for temperature.
 */
const wantsMaxCompletionTokens = new Set();

/**
 * True for the specific 400 that means "this model has a fixed temperature".
 *
 * Narrow on purpose. A 400 is also how the API reports a bad model id, a
 * malformed message or an oversized image, and retrying those without
 * temperature would turn one clear error into two confusing ones.
 */
export function isTemperatureRefusal(err) {
  return err?.status === 400 && /temperature/i.test(err?.message || '');
}

/**
 * True for the specific 400 that means "this model spells the cap differently".
 *
 * Narrow for the same reason as its temperature twin: a 400 is also how the API
 * reports a bad model id or a malformed message, and retrying those under a
 * different parameter name would turn one clear error into two confusing ones.
 */
export function isMaxTokensRefusal(err) {
  return err?.status === 400
    && /max_tokens/i.test(err?.message || '')
    && /max_completion_tokens/i.test(err?.message || '');
}

/**
 * Send `body`, renaming `max_tokens` to `max_completion_tokens` for the models
 * that insist on it.
 *
 * The rename is remembered per model, so the wasted call happens once per model
 * per process rather than on every read. `send` is passed in so the fallback
 * can be tested without a network or a key.
 *
 * A body with no cap at all passes straight through — there is nothing to
 * rename, and spending a retry to discover that would be pure waste.
 */
export async function withMaxTokensFallback(body, send, seen = wantsMaxCompletionTokens) {
  const { model, max_tokens: cap, ...rest } = body;
  if (cap == null) return send(body);

  if (seen.has(model)) {
    return send({ model, ...rest, max_completion_tokens: cap });
  }

  try {
    return await send(body);
  } catch (err) {
    if (!isMaxTokensRefusal(err)) throw err;

    console.warn(`[SP][openai] ${model} wants max_completion_tokens; using it.`);
    seen.add(model);
    return send({ model, ...rest, max_completion_tokens: cap });
  }
}

/**
 * Send `params`, asking for temperature 0, and fall back to the model's own
 * default if it refuses.
 *
 * `send` is passed in so the fallback can be tested without a network or a key.
 */
export async function withTemperatureFallback(model, params, send, seen = rejectsTemperature) {
  const wanted = !seen.has(model);

  try {
    return await send({ model, ...params, ...(wanted ? { temperature: 0 } : {}) });
  } catch (err) {
    if (!wanted || !isTemperatureRefusal(err)) throw err;

    console.warn(`[SP][openai] ${model} does not accept temperature; using its default.`);
    seen.add(model);
    return send({ model, ...params });
  }
}

/**
 * One chat completion, with `temperature` only where it is welcome.
 *
 * Determinism matters here — the same quote read twice should produce the same
 * rates — so temperature 0 is still asked for wherever it is supported. Where
 * it is not, the model's own default is the only option available, and a
 * slightly less repeatable extraction beats no extraction.
 */
/**
 * Exported so the paper interpreter shares this module's temperature-fallback
 * memory rather than discovering the same refusal a second time. One wasted
 * call per model per process, not one per code path.
 */
export async function createCompletion({ model, ...params }) {
  return withTemperatureFallback(
    model,
    params,
    (body) => withMaxTokensFallback(body, (b) => openai().chat.completions.create(b)),
  );
}

/**
 * One extraction call.
 *
 * `pages` may be empty: a born-digital PDF is read from its text layer, which
 * arrives inside `extraInstructions`, and sending no image is correct rather
 * than a degraded mode — the model has the exact characters instead of a
 * picture of them.
 */
async function callVision({ pages, prompt, extraInstructions }) {
  const content = [{ type: 'text', text: extraInstructions ? `${prompt}\n\n${extraInstructions}` : prompt }];
  for (const page of pages || []) {
    content.push({ type: 'image_url', image_url: { url: page.url } });
  }

  const response = await createCompletion({
    model: VISION_MODEL,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from OpenAI');
  return JSON.parse(text);
}

/**
 * Parse and validate, retrying once. The retry exists because the failure is
 * usually a shape slip (a number where a string was asked for) rather than a
 * misreading, and a second pass at temperature 0 with the same prompt fixes
 * it more often than not.
 */
async function extractWithSchema({ pages, prompt, schema, extraInstructions }) {
  let lastError;
  let correction = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callVision({
        pages,
        prompt,
        extraInstructions: correction
          ? [extraInstructions, correction].filter(Boolean).join('\n\n')
          : extraInstructions,
      });
      const parsed = schema.safeParse(raw);
      if (parsed.success) return { data: parsed.data, model: VISION_MODEL };

      const detail = describeIssues(parsed.error.issues);
      lastError = new Error(`Extraction did not match the schema: ${detail}`);

      // The retry is only worth its minute if it knows what went wrong.
      // Re-sending the identical prompt at temperature 0 reproduces the same
      // response and the same failure, having doubled the wait.
      correction = `Your previous reply was rejected: ${detail}\nReturn the same data with those fields corrected.`;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Extraction failed');
}

/**
 * Summarise validation failures without repeating one per line.
 *
 * A shape slip in a 47-line price list produces 47 identical complaints, and
 * the resulting message buries the single fact it contains — which field, and
 * what was wrong with it — under its own repetition.
 */
export function describeIssues(issues = []) {
  const byField = new Map();
  for (const issue of issues) {
    // lines.12.lineNo and lines.30.lineNo are one problem, not two.
    const field = issue.path.map((p) => (typeof p === 'number' ? '#' : p)).join('.');
    const entry = byField.get(field) || { message: issue.message, count: 0 };
    entry.count += 1;
    byField.set(field, entry);
  }

  return [...byField.entries()]
    .map(([field, { message, count }]) => (
      count > 1 ? `${field}: ${message} (${count} rows)` : `${field}: ${message}`
    ))
    .join('; ');
}

export const openaiProvider = registerProvider({
  name: 'openai',

  async extractQuote({ pages, textLayer, docType, hints } = {}) {
    if (!pages?.length && !textLayer) {
      throw new Error('extractQuote needs at least one page image or a text layer');
    }
    const extra = buildQuoteHints({ docType, hints, textLayer });
    const { data, model } = await extractWithSchema({
      pages, prompt: QUOTE_PROMPT, schema: ExtractedQuoteSchema, extraInstructions: extra,
    });
    return { ...data, _provider: 'openai', _model: model };
  },

  async extractInvoice({ pages, hints } = {}) {
    if (!pages?.length) throw new Error('extractInvoice needs at least one page');
    const extra = hints?.expectedSupplier
      ? `The supplier is expected to be "${hints.expectedSupplier}". Verify rather than assume.`
      : null;
    const { data, model } = await extractWithSchema({
      pages, prompt: INVOICE_PROMPT, schema: ExtractedInvoiceSchema, extraInstructions: extra,
    });
    return { ...data, _provider: 'openai', _model: model };
  },

  async adjudicate({ line, candidates, mapped } = {}) {
    const payload = {
      quotedLine: line,
      candidates: (candidates || []).slice(0, 8),
      alreadyMappedForThisSupplier: (mapped || []).slice(0, 20),
    };

    const response = await createCompletion({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: ADJUDICATION_PROMPT },
        { role: 'user', content: JSON.stringify(payload, null, 2) },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty adjudication response');
    const parsed = AdjudicationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`Adjudication did not match the schema: ${parsed.error.message}`);
    }
    return { ...parsed.data, _model: TEXT_MODEL };
  },
});

function buildQuoteHints({ docType, hints, textLayer }) {
  const parts = [];
  if (docType) parts.push(`The uploader classified this document as: ${docType}.`);
  if (hints?.supplierName) {
    parts.push(`The uploader says the supplier is "${hints.supplierName}". Verify against the document rather than assuming.`);
  }
  if (hints?.plantScope?.length) {
    parts.push(`The uploader says this document covers: ${hints.plantScope.join(', ')}. Still report only plants the document itself names.`);
  }
  if (hints?.priceColumn) {
    parts.push(`For multi-column worksheets, the live price column is "${hints.priceColumn}". Extract that column as the rate and put the others in notes.`);
  }
  // Last, so it sits closest to the images whose characters it corrects.
  if (textLayer) {
    const block = textLayerInstruction(textLayer);
    if (block) parts.push(block);
  }
  return parts.length ? parts.join('\n') : null;
}

export default openaiProvider;
