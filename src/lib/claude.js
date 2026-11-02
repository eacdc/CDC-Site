/**
 * Claude (Anthropic) — the one place the backend talks to a language model.
 *
 * Every feature that reads a document or a conversation goes through here:
 * purchase bills, PO match, job card compare, previous-items analysis, the
 * voice note summary, the WhatsApp monitor and the supplier portal. Keeping the
 * client, the model names and the response checks in one module means a model
 * change is an env change, and a new failure mode is handled once.
 *
 * Speech-to-text is the exception: Claude does not take audio, so voice notes
 * are still transcribed by OpenAI Whisper (see whatsapp-monitor/llm/whisper.js
 * and the voice note route) and only the text comes here.
 */

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

/**
 * Three tiers, named for the job rather than the model, so callers say what
 * they need and the deployment decides what that costs.
 *
 *   fast      high-volume and simple: OCR to text, search hints, chat triage
 *   standard  the gpt-4o work: document extraction, scoring, comparison
 *   strong    the documents where a misread number is expensive to catch
 */
export const MODELS = {
  fast: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-5-5',
  standard: process.env.CLAUDE_MODEL_STANDARD || 'claude-sonnet-5-5',
  strong: process.env.CLAUDE_MODEL_STRONG || 'claude-opus-5-5',
};

/**
 * A per-feature model override from the environment, or `fallback`.
 *
 * Only claude-* ids are honoured. The deployment still carries the OpenAI-era
 * variables (SP_EXTRACTION_MODEL=gpt-..., PO_MATCH_SCORE_MODEL=gpt-4o), and
 * sending one of those to Claude is a 404 on every request; skipping it with
 * a warning keeps the feature working while the variable is cleaned up.
 */
export function envModel(names, fallback) {
  for (const name of [].concat(names)) {
    const value = process.env[name];
    if (!value) continue;
    if (value.startsWith('claude-')) return value;
    console.warn(`[claude] ignoring ${name}=${value}: not a Claude model.`);
  }
  return fallback;
}

export class ClaudeError extends Error {}

let client = null;

/**
 * Lazy, so a missing key fails the request that needs it rather than the boot
 * of a server that mostly does unrelated things.
 */
export function claude() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ClaudeError('ANTHROPIC_API_KEY is not set on the server.');
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/** For tests: swap the SDK client for a fake. Pass null to restore. */
export function setClaudeClientForTests(fake) {
  client = fake;
}

/**
 * Models whose safety classifiers can decline a request, and which therefore
 * take the server-side fallback: on a decline the API re-runs the same request
 * on another model inside the same call instead of returning nothing. Haiku
 * has no server-side fallback.
 */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

/**
 * One request, returning the full Message.
 *
 * Always streamed: a long price list can take minutes to write, and a
 * non-streamed request that long risks an HTTP timeout. `finalMessage()` hands
 * back the same object a plain create would.
 *
 * @param {Object}  opts
 * @param {string}  opts.model      a model id, usually one of MODELS
 * @param {string}  [opts.system]   system prompt
 * @param {string|Array} opts.content  user content: a string, or blocks
 * @param {Array}   [opts.messages]    a whole conversation, instead of `content`
 * @param {number}  [opts.maxTokens]   output cap, thinking included
 * @param {string}  [opts.effort]      low | medium | high | xhigh | max
 * @param {Object}  [opts.format]      output_config.format
 * @param {Array}   [opts.tools]       e.g. web search
 * @param {string}  [opts.feature]     label for the usage log line
 */
export async function ask({
  model, system, content, messages, maxTokens = 8000, effort, format, tools, feature,
}) {
  const params = {
    model,
    max_tokens: maxTokens,
    messages: messages || [{ role: 'user', content }],
    ...(system ? { system } : {}),
    ...(tools?.length ? { tools } : {}),
  };
  if (effort || format) {
    params.output_config = { ...(effort ? { effort } : {}), ...(format ? { format } : {}) };
  }

  const message = FALLBACK_MODELS.test(model)
    ? await claude().beta.messages
      .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      .finalMessage()
    : await claude().messages.stream(params).finalMessage();

  logUsage(feature, message);

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new ClaudeError(`${model} declined this request${category ? ` (${category})` : ''}.`);
  }
  /*
    A reply cut off at the cap can still look complete — a JSON array closes,
    a list just ends early — so it is an error, never a partial answer. A
    shortened price list that reaches a review table looks finished.
  */
  if (message.stop_reason === 'max_tokens') {
    throw new ClaudeError(
      `The reply from ${model} was cut off at ${maxTokens} output tokens, so part of it is missing.`,
    );
  }
  return message;
}

/** The text of a reply, with thinking and tool blocks left out. */
export function textOf(message) {
  return (message?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/** A plain-text answer. */
export async function askText(opts) {
  const message = await ask(opts);
  const text = textOf(message);
  if (!text) throw new ClaudeError(`Empty reply from ${opts.model}.`);
  return { text, model: message.model };
}

/**
 * A JSON answer.
 *
 * With `schema`, structured outputs constrain the reply to it, so it always
 * parses and always has the required keys. The schema must be the subset the
 * API supports: every object `additionalProperties: false`, no min/max.
 *
 * Without one — the prompts whose shape lives in a Zod schema that cannot be
 * expressed that way — Claude is told to reply with JSON only, and the caller
 * validates. `parseJson` tolerates a stray fence either way.
 */
export async function askJson({ schema, system, ...opts }) {
  const message = await ask({
    ...opts,
    system: schema ? system : [system, JSON_ONLY].filter(Boolean).join('\n\n'),
    format: schema ? { type: 'json_schema', schema } : undefined,
  });
  return { data: parseJson(textOf(message)), model: message.model };
}

const JSON_ONLY = 'Reply with a single JSON object and nothing else: no markdown fence, no commentary before or after it.';

export function parseJson(text) {
  const t = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    // A sentence before the object is the usual slip; the object itself is fine.
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new ClaudeError(`The model did not return JSON: ${t.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Images and PDFs
// ---------------------------------------------------------------------------

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/*
  The API refuses an image over 5 MB (measured on the base64) or over 8000 px
  on a side. Phone photos of bills and rendered scans can exceed both, so
  anything large is re-encoded rather than sent to fail. 3.5 MB of bytes is
  about 4.7 MB of base64.
*/
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 4000;

/**
 * A content block for one image or PDF.
 *
 * Accepts what the routes already hold: a `data:` URL, an http(s) URL (a
 * signed storage link — fetched here and inlined, because a link that expires
 * while the request is queued fails deep inside the model call with an error
 * that reads like a model problem), or a Buffer with its type.
 *
 * A PDF becomes a `document` block, which Claude reads natively; everything
 * else becomes an `image` block.
 */
export async function mediaBlock(source, mimeType) {
  let buffer;
  let type = mimeType ? String(mimeType).toLowerCase() : '';

  if (Buffer.isBuffer(source)) {
    buffer = source;
  } else {
    const url = String(source || '');
    const dataUrl = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (dataUrl) {
      type = type || dataUrl[1].toLowerCase();
      buffer = Buffer.from(dataUrl[3], dataUrl[2] ? 'base64' : 'utf8');
    } else if (/^https?:\/\//i.test(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new ClaudeError(`Could not fetch ${url.split('?')[0]}: HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      type = type || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    } else {
      throw new ClaudeError('An image must be a data: URL, an http(s) URL or a Buffer.');
    }
  }

  if (type === 'application/pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
    };
  }

  if (!IMAGE_TYPES.has(type) || buffer.length > MAX_IMAGE_BYTES) {
    buffer = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    type = 'image/jpeg';
  }

  return {
    type: 'image',
    source: { type: 'base64', media_type: type, data: buffer.toString('base64') },
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * One line per call: which feature, which model, how many tokens. OpenAI's
 * dashboard could only ever say which model was used, never which feature
 * used it; this is what answers "what does the bills screen cost us".
 */
function logUsage(feature, message) {
  const u = message?.usage;
  if (!u) return;
  const cached = u.cache_read_input_tokens ? ` cached=${u.cache_read_input_tokens}` : '';
  const searches = u.server_tool_use?.web_search_requests ? ` searches=${u.server_tool_use.web_search_requests}` : '';
  console.info(
    `[claude] feature=${feature || 'unlabelled'} model=${message.model} `
    + `in=${u.input_tokens} out=${u.output_tokens}${cached}${searches}`,
  );
}
