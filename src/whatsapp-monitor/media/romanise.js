import { config } from '../config.js';
import { logger } from '../logger.js';
import { llm } from '../llm/index.js';

// Any LETTER that is not Latin - Bengali and Devanagari here, Gujarati in
// Ahmedabad, and whatever else turns up without this needing to know about it.
//
// Letters specifically, not "outside the Latin code range": an emoji or a
// rupee sign is not another script, and sending a perfectly good romanised
// sentence off to be rewritten because it ends in an emoji risks losing it.
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/**
 * Is this transcript worth a call?
 *
 * Pure, so the decision is testable without an API key. Text already in the
 * Latin alphabet is left alone: there is nothing to transliterate, and a round
 * trip through a model can only misspell it.
 */
export function needsRomanising(text, enabled = true) {
  if (!enabled) return false;
  if (!text?.trim()) return false;
  return NON_LATIN_LETTER.test(text);
}

/**
 * Rewrites a transcript into the Latin alphabet, keeping the speaker's words.
 *
 * Whisper transcribes in the script of the language, so a Bengali voice note
 * comes back as a line of Bengali script. Two reasons that is the wrong thing
 * to store: it is unreadable to anyone on the floor who types romanised, and
 * `detector/prompt.md` is written entirely around romanised Hindi and Bengali
 * ("machine band hai", "bondho"), so a native-script transcript is the one
 * input the classifier was never tuned on.
 *
 * Never throws. A tidying step that fails must not lose the message: the
 * original is returned, which is worse to read but still says what happened.
 */
export async function romanise(text) {
  if (!needsRomanising(text, config.romaniseTranscripts)) return text;

  try {
    const out = await llm().romanise(text);
    if (!out?.trim()) throw new Error('romanisation came back empty');
    return out;
  } catch (err) {
    logger.warn(
      { err: String(err), chars: text.length },
      'could not romanise transcript - keeping it in its original script',
    );
    return text;
  }
}
