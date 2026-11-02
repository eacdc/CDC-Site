import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseConcerns, parseResolution, MalformedLlmOutput } from './parse.js';
import { parseSummary, MalformedSummary } from '../summariser/parse.js';
import {
  promptForKind,
  SUMMARY_PROMPT,
  ROMANISE_PROMPT,
  RESOLUTION_PROMPT,
  buildSummaryPrompt,
  buildUserPrompt,
  buildResolutionPrompt,
} from './prompts.js';
import { transcribe } from './whisper.js';

export { promptForKind };

/**
 * The OpenAI implementation, kept so LLM_PROVIDER=openai is an instant
 * rollback. Claude (anthropic.js) is the default.
 */
export class OpenAiLlm {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    this.client = new OpenAI({ apiKey });
  }

  async chat(model, system, user) {
    const res = await this.client.chat.completions.create({
      model,
      // JSON mode. Deliberately no temperature and no token cap — the GPT-5
      // family rejects some of those, and the defaults are what we want anyway.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? '';
  }

  async call(model, input) {
    return this.chat(model, promptForKind(input.groupKind), buildUserPrompt(input));
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
      logger.warn({ model: fast, err: err.message }, 'fast model returned malformed JSON - escalating');
      escalationReason = 'malformed_json';
    }

    logger.info({ from: fast, to: strong, reason: escalationReason }, 'escalating to strong model');
    const concerns = parseConcerns(await this.call(strong, input), known);
    return { concerns, model: strong, escalated: true, escalationReason };
  }

  /**
   * Summarises a window of messages into four buckets.
   *
   * Uses the fast model, falling back to the strong one only if the output is
   * structurally broken. Unlike a missed concern, a slightly thin summary costs
   * nobody anything — it is read at leisure on a dashboard, not acted on in the
   * next five minutes — so it does not deserve a second opinion on content.
   */
  async summarise(input) {
    const fast = config.llm.fastModel;
    const user = buildSummaryPrompt(input);

    try {
      return { bullets: parseSummary(await this.chat(fast, SUMMARY_PROMPT, user)), model: fast };
    } catch (err) {
      if (!(err instanceof MalformedSummary)) throw err;
      logger.warn({ model: fast, err: err.message }, 'fast model returned a malformed summary - escalating');
    }

    const strong = config.llm.strongModel;
    return { bullets: parseSummary(await this.chat(strong, SUMMARY_PROMPT, user)), model: strong };
  }

  transcribe(audio, filename) {
    return transcribe(audio, filename);
  }

  /**
   * Rewrites a transcript into the Latin alphabet, keeping the words.
   *
   * Fast model, no fallback: this is a tidying step, and the caller keeps the
   * raw transcript if it fails rather than paying twice to improve legibility.
   */
  async romanise(text) {
    const raw = await this.chat(config.llm.fastModel, ROMANISE_PROMPT, text);
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    } catch {
      // JSON mode makes this unlikely, and an unparseable answer is not worth a
      // second call - the caller falls back to the original.
      return '';
    }
  }

  /**
   * Does this thread say the problem is fixed?
   *
   * Fast model only, and never escalated. The answer is a hint shown next to a
   * button a human still has to press - getting it wrong costs a slightly wrong
   * label, not a missed breakdown - so it does not warrant the strong model's
   * price on every follow-up message in every thread.
   */
  async checkResolved(input) {
    const known = new Set(input.messages.map((m) => m.msgId));
    const model = config.llm.fastModel;
    const verdict = parseResolution(
      await this.chat(model, RESOLUTION_PROMPT, buildResolutionPrompt(input)),
      known,
    );
    return { ...verdict, model };
  }
}
