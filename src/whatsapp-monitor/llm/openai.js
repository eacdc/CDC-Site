import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseConcerns, MalformedLlmOutput } from './parse.js';

const SYSTEM_PROMPT = readFileSync(new URL('../detector/prompt.md', import.meta.url), 'utf8');

function renderMessages(label, msgs) {
  if (msgs.length === 0) return '';
  const lines = msgs.map((m) => `[${m.msgId}] ${m.senderName ?? 'unknown'}: ${m.text.replace(/\n/g, ' ')}`);
  return `${label}\n${lines.join('\n')}\n`;
}

function buildUserPrompt(input) {
  return [
    `Group: ${input.groupName}`,
    '',
    renderMessages('EARLIER MESSAGES (context only — do not raise concerns for these):', input.contextMessages),
    renderMessages('NEW MESSAGES (judge only these):', input.newMessages),
  ]
    .filter(Boolean)
    .join('\n');
}

export class OpenAiLlm {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    this.client = new OpenAI({ apiKey });
  }

  async call(model, input) {
    const res = await this.client.chat.completions.create({
      model,
      // JSON mode. Deliberately no temperature and no token cap — the GPT-5
      // family rejects some of those, and the defaults are what we want anyway.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return res.choices[0]?.message?.content ?? '';
  }

  /**
   * Two tiers: the fast model first, then the strong model if the fast one
   * returned malformed JSON or flagged anything high-severity. High severity is
   * what wakes someone at night, so it gets a second opinion.
   */
  async classify(input) {
    const known = new Set(input.newMessages.map((m) => m.msgId));
    const fast = config.llm.fastModel;
    const strong = config.llm.strongModel;

    let escalationReason = null;

    try {
      const concerns = parseConcerns(await this.call(fast, input), known);
      if (!concerns.some((c) => c.severity === 'high')) {
        return { concerns, model: fast, escalated: false, escalationReason: null };
      }
      escalationReason = 'high_severity';
    } catch (err) {
      if (!(err instanceof MalformedLlmOutput)) throw err;
      logger.warn({ model: fast, err: err.message }, 'fast model returned malformed JSON — escalating');
      escalationReason = 'malformed_json';
    }

    logger.info({ from: fast, to: strong, reason: escalationReason }, 'escalating to strong model');
    const concerns = parseConcerns(await this.call(strong, input), known);
    return { concerns, model: strong, escalated: true, escalationReason };
  }
}
