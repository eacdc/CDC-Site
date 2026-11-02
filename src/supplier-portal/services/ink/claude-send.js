/**
 * The Claude adapters for the ink interpreter — the default: reading, and
 * looking things up with Claude's web search tool.
 *
 * Deliberately thin, like the OpenAI twins: the interpreter takes `send` and
 * `research` as arguments so its control flow is testable without a key or a
 * network.
 *
 * Models: SP_INK_MODEL, else SP_ANTHROPIC_MODEL, else the strong tier for
 * reading; SP_INK_RESEARCH_MODEL, else the standard tier, for research.
 * SP_INK_RESEARCH_MODEL set to an empty string turns research off.
 */

import { ask, askJson, parseJson, envModel, MODELS } from '../../../lib/claude.js';
import { pageBlocks } from '../extraction/anthropic-provider.js';
import { isSendableImage, RESEARCH_PROMPT, buildResearchMessage } from './openai-send.js';

const MODEL = envModel(['SP_INK_MODEL', 'SP_ANTHROPIC_MODEL'], MODELS.strong);
const EFFORT = process.env.SP_ANTHROPIC_EFFORT || 'medium';
const RESEARCH_OFF = process.env.SP_INK_RESEARCH_MODEL === '';
const RESEARCH_MODEL = envModel('SP_INK_RESEARCH_MODEL', MODELS.standard);

/*
  Each search is billed, and a list can raise dozens of questions. The prompt
  already says to leave out what cannot be sourced, so a cap costs a few
  unanswered questions, never a wrong answer.
*/
const MAX_SEARCHES = 8;

/** One interpretation turn against Claude. */
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
    feature: 'supplier-ink-interpret',
    model: MODEL,
    effort: EFFORT,
    // Forty rows of name, code, section, class, chemistry, colour and pack do
    // not fit in a small allowance, and thinking comes out of the same one.
    maxTokens: 32000,
    system,
    content: [...blocks, { type: 'text', text: message }],
  });
  return data;
}

/**
 * Look up the products behind a round's open questions on the web.
 *
 * Only ever proposes: findings ride back attached to the question and a person
 * confirms them (see the OpenAI twin for why). A finding with no source is
 * dropped — an unsourced claim is the model's prior belief wearing a
 * citation's clothes.
 *
 * Never throws upward with meaning: the interpreter treats a failed search as
 * "no proposals".
 */
export async function researchWithClaude(gaps = []) {
  if (RESEARCH_OFF || !gaps.length) return [];

  const messages = [{ role: 'user', content: buildResearchMessage(gaps) }];
  let reply;
  // A long search can pause mid-turn; sending the conversation back resumes it.
  for (let turn = 0; turn < 3; turn += 1) {
    reply = await ask({
      feature: 'supplier-ink-research',
      model: RESEARCH_MODEL,
      effort: 'low',
      maxTokens: 16000,
      system: RESEARCH_PROMPT,
      messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES }],
    });
    if (reply.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: reply.content });
  }

  const findings = parseJson(finalText(reply))?.findings;
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f?.subject && f?.field && f?.value && f?.source);
}

/**
 * The answer, without the narration around the searches.
 *
 * With web search on, the reply interleaves "let me look that up" text with
 * search results; the JSON is in the text after the last result.
 */
function finalText(message) {
  const blocks = message?.content || [];
  let last = -1;
  blocks.forEach((b, i) => { if (b.type === 'web_search_tool_result') last = i; });
  return blocks.slice(last + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function describeSource(page) {
  const url = String(page?.url ?? '');
  if (url.startsWith('data:')) return url.slice(0, url.indexOf(';') + 1) || 'that data URL';
  return url.split('?')[0].split('/').pop() || 'that URL';
}
