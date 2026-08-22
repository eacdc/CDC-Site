/**
 * The OpenAI adapters for the ink interpreter: reading, and looking things up.
 *
 * Deliberately thin. The interpreter takes `send` and `research` as arguments
 * so its control flow — which exit fires, what the model is told when it errs,
 * which answers never reach it — is testable without a key or a network. This
 * is the one part of the ink work that cannot be tested offline.
 *
 * It reuses `createCompletion` rather than calling the SDK directly, so the
 * temperature-fallback memory is shared with every other code path: a reasoning
 * model that refuses `temperature` is discovered once per process.
 */

import { createCompletion } from '../extraction/openai-provider.js';
import { CHEMISTRIES, COLOURS, COATING_FINISHES, CHEMICAL_FUNCTIONS, MATERIAL_CLASSES } from '../../config/ink-vocabulary.js';

const MODEL = process.env.SP_INK_MODEL
  || process.env.SP_EXTRACTION_MODEL
  || 'gpt-4o';

/**
 * The model used to look a product up on the web.
 *
 * Separate because the job is different: reading a quote wants the strongest
 * vision model available, while research is a text question with a search tool
 * attached. `SP_INK_RESEARCH_MODEL` names a model that can search; setting it to
 * an empty string turns research off entirely, and the interpreter then simply
 * asks its questions plainly, which is what it did before this existed.
 */
const RESEARCH_MODEL = process.env.SP_INK_RESEARCH_MODEL ?? 'gpt-4o-search-preview';

/** One interpretation turn against OpenAI. */
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
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  return parseReply(response, 'interpreting an ink quote');
}

/**
 * Look up the products behind a round's open questions.
 *
 * WHY THIS IS WORTH A CALL. An ink question is almost always about a named
 * commercial product with a public datasheet — Boettcher's Cleanfix, Siegwerk's
 * Sicura Plast 770 — and there are dozens per list. Answering them without
 * troubling anybody is the difference between a review that takes two minutes
 * and one that takes twenty.
 *
 * WHY IT ONLY EVER PROPOSES. Chemistry is half the comparison key. A
 * plausible-but-wrong search result merges two products that should never have
 * been compared, and nothing in the result would ever show it. So findings ride
 * back attached to the question, a person confirms, and only then does anything
 * become permanent.
 *
 * Never throws upward with meaning: the interpreter treats a failed search as
 * "no proposals", because the document is still perfectly answerable by
 * somebody who buys ink.
 *
 * @param {Array} gaps  the open questions worth looking up
 * @returns {Promise<Array>} [{ subject, field, value, summary, source, confidence }]
 */
export async function researchWithOpenAI(gaps = []) {
  if (!RESEARCH_MODEL || !gaps.length) return [];

  const response = await createCompletion({
    model: RESEARCH_MODEL,
    messages: [
      { role: 'system', content: RESEARCH_PROMPT },
      { role: 'user', content: buildResearchMessage(gaps) },
    ],
    response_format: { type: 'json_object' },
  });

  const reply = parseReply(response, 'researching an ink product');
  const findings = Array.isArray(reply?.findings) ? reply.findings : [];

  /*
    A finding with no source is dropped. The whole value of research here is
    that a person can see WHY something was proposed before accepting it — an
    unsourced claim is just the model's prior belief wearing a citation's
    clothes, and accepting those is how a wrong rule becomes permanent.
  */
  return findings.filter((f) => f?.subject && f?.field && f?.value && f?.source);
}

const RESEARCH_PROMPT = `You identify printing-industry products for a carton printer's purchasing system.

You are given product names read off a supplier's quotation, and for each one, the single fact that could not be determined from the document. Search for the manufacturer's own datasheet or product page and answer from it.

RULES.

1. Answer only what you can source. A product page, datasheet or distributor listing is a source; your own recollection is not. If you cannot find one, omit that product entirely — a missing answer costs one question, and a wrong one corrupts a price comparison silently and permanently.

2. Use the exact canonical value given for that field. Anything else is discarded.

3. Say what you found in one short sentence a purchase manager would recognise, and give the domain you found it on.

4. Confidence is about the SOURCE, not your fluency. A manufacturer's own datasheet is high; a reseller listing that merely mentions the name is low.

Reply with JSON only: { "findings": [{ "subject": "...", "field": "...", "value": "...", "summary": "...", "source": "domain.com", "confidence": 0.9 }] }`;

/** What to ask about each open question, with the values that would be accepted. */
function buildResearchMessage(gaps) {
  const allowed = {
    materialClass: MATERIAL_CLASSES.map((c) => c.canonical),
    chemistry: CHEMISTRIES.map((c) => c.canonical),
    colour: COLOURS.map((c) => c.canonical),
    finish: COATING_FINISHES.map((f) => f.canonical),
    chemicalFunction: CHEMICAL_FUNCTIONS.map((f) => f.canonical),
  };

  const FIELD_FOR = {
    MATERIAL_CLASS: 'materialClass',
    CHEMISTRY: 'chemistry',
    COLOUR: 'colour',
    FINISH: 'finish',
    CHEMICAL_FUNCTION: 'chemicalFunction',
    UNKNOWN_TERM: 'materialClass',
  };

  const wanted = gaps.map((g) => ({
    subject: g.subject || g.token,
    field: FIELD_FOR[g.kind],
    // The rows it appeared on, which are often the only clue to what it is.
    seenAs: (g.examples || []).slice(0, 3),
  }));

  return [
    'PRODUCTS TO IDENTIFY:',
    JSON.stringify(wanted, null, 2),
    '',
    'ACCEPTED VALUES per field. Use these exact strings:',
    JSON.stringify(allowed, null, 2),
  ].join('\n');
}

function parseReply(response, doing) {
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty response from OpenAI while ${doing}.`);

  try {
    return JSON.parse(text);
  } catch {
    const truncated = !text.trimEnd().endsWith('}');
    throw new Error(
      truncated
        ? `The model's reply was cut off after ${text.length} characters — the document may be too long to read in one pass.`
        : 'The model returned something that is not JSON.',
    );
  }
}

/**
 * Can this page actually be sent?
 *
 * A signed PDF URL passed straight through produced "400 You uploaded an
 * unsupported image" on the paper side — an OpenAI error naming nothing useful,
 * for a mistake made three files away. The guard exists so the failure names
 * the page and the fix instead.
 */
export function isSendableImage(page) {
  const url = String(page?.url ?? '');
  if (url.startsWith('data:image/')) return true;
  return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url);
}

function describeSource(page) {
  const url = String(page?.url ?? '');
  if (url.startsWith('data:')) return url.slice(0, url.indexOf(';') + 1) || 'that data URL';
  return url.split('?')[0].split('/').pop() || 'that URL';
}
