import { config } from '../config.js';
import { logger } from '../logger.js';
import { ask, textOf, ClaudeError } from '../../lib/claude.js';
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
  CONCERNS_SCHEMA,
  SUMMARY_SCHEMA,
  RESOLUTION_SCHEMA,
  ROMANISE_SCHEMA,
} from './prompts.js';
import { transcribe } from './whisper.js';

/**
 * The Claude implementation, and the default.
 *
 * Same two tiers and the same escalation rules as the OpenAI one; the
 * difference is that every reply is constrained to a JSON schema, so a
 * malformed answer can no longer be the reason to escalate - only a
 * high-severity concern, or the fast model failing outright.
 *
 * Voice notes are still transcribed by Whisper (whisper.js): Claude does not
 * take audio.
 */
export class AnthropicLlm {
  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    }
    // A model id left over from LLM_PROVIDER=openai would 404 on every poll;
    // say so once, at the start, instead.
    for (const [name, model] of [['LLM_MODEL_FAST', config.llm.fastModel], ['LLM_MODEL_STRONG', config.llm.strongModel]]) {
      if (!String(model).startsWith('claude-')) {
        throw new Error(`${name} is "${model}", which is not a Claude model. Set it to a claude-* id or unset it.`);
      }
    }
  }

  async chat(model, system, user, schema, { feature, effort } = {}) {
    const message = await ask({
      feature,
      model,
      system,
      content: user,
      effort,
      maxTokens: 8000,
      format: { type: 'json_schema', schema },
    });
    return textOf(message);
  }

  async call(model, input, effort) {
    return this.chat(model, promptForKind(input.groupKind), buildUserPrompt(input), CONCERNS_SCHEMA, {
      feature: 'whatsapp-classify',
      effort,
    });
  }

  /**
   * Two tiers: the fast model first, then the strong model if the fast one
   * failed or flagged anything high-severity. High severity is what wakes
   * someone at night, so it gets a second opinion.
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
      if (err instanceof MalformedLlmOutput) {
        escalationReason = 'malformed_json';
      } else if (err instanceof ClaudeError) {
        // A decline or a cut-off reply on the fast model. Haiku has no
        // server-side fallback, so the strong model is the fallback.
        escalationReason = 'fast_model_error';
      } else {
        throw err;
      }
      logger.warn({ model: fast, err: err.message }, 'fast model failed - escalating');
    }

    logger.info({ from: fast, to: strong, reason: escalationReason }, 'escalating to strong model');
    const concerns = parseConcerns(await this.call(strong, input, 'medium'), known);
    return { concerns, model: strong, escalated: true, escalationReason };
  }

  /**
   * Summarises a window of messages into four buckets. Fast model, falling
   * back to the strong one only if the fast one fails: a slightly thin summary
   * is read at leisure on a dashboard, so it does not deserve a second opinion
   * on content.
   */
  async summarise(input) {
    const fast = config.llm.fastModel;
    const user = buildSummaryPrompt(input);
    const opts = { feature: 'whatsapp-summary' };

    try {
      return { bullets: parseSummary(await this.chat(fast, SUMMARY_PROMPT, user, SUMMARY_SCHEMA, opts)), model: fast };
    } catch (err) {
      if (!(err instanceof MalformedSummary) && !(err instanceof ClaudeError)) throw err;
      logger.warn({ model: fast, err: err.message }, 'fast model failed on a summary - escalating');
    }

    const strong = config.llm.strongModel;
    return { bullets: parseSummary(await this.chat(strong, SUMMARY_PROMPT, user, SUMMARY_SCHEMA, opts)), model: strong };
  }

  transcribe(audio, filename) {
    return transcribe(audio, filename);
  }

  /**
   * Rewrites a transcript into the Latin alphabet, keeping the words. Fast
   * model, no fallback: the caller keeps the raw transcript if this fails.
   */
  async romanise(text) {
    try {
      const raw = await this.chat(config.llm.fastModel, ROMANISE_PROMPT, text, ROMANISE_SCHEMA, {
        feature: 'whatsapp-romanise',
        effort: 'low',
      });
      const parsed = JSON.parse(raw);
      return typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    } catch (err) {
      if (err instanceof ClaudeError || err instanceof SyntaxError) return '';
      throw err;
    }
  }

  /**
   * Does this thread say the problem is fixed? Fast model only, never
   * escalated: the answer is a hint next to a button a human still presses.
   */
  async checkResolved(input) {
    const known = new Set(input.messages.map((m) => m.msgId));
    const model = config.llm.fastModel;
    const raw = await this.chat(model, RESOLUTION_PROMPT, buildResolutionPrompt(input), RESOLUTION_SCHEMA, {
      feature: 'whatsapp-resolution',
      effort: 'low',
    });
    return { ...parseResolution(raw, known), model };
  }
}
