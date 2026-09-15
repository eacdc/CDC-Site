import { CONCERN_CATEGORIES, SEVERITIES } from './types.js';

const CATEGORIES = new Set(CONCERN_CATEGORIES);
const SEVERITY_SET = new Set(SEVERITIES);

export class MalformedLlmOutput extends Error {}

/**
 * Models sometimes wrap JSON in a markdown fence despite being told not to.
 * Strip it rather than failing — a fence is not a real disagreement.
 */
function stripFence(raw) {
  const t = raw.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * Parses and validates the classifier's output. Unusable output throws, which
 * escalates to the strong model rather than being guessed at. Unknown
 * categories and severities are coerced instead: the shape is what matters,
 * and "other"/"low" is a safe landing spot that still reaches a human.
 */
export function parseConcerns(raw, knownMsgIds) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw new MalformedLlmOutput(`not JSON: ${String(raw).slice(0, 200)}`);
  }

  const concerns = parsed?.concerns;
  if (!Array.isArray(concerns)) {
    throw new MalformedLlmOutput(`no "concerns" array: ${String(raw).slice(0, 200)}`);
  }

  const out = [];
  for (const c of concerns) {
    if (!c || typeof c !== 'object') continue;

    const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
    if (!summary) continue; // a concern with nothing to say is not a concern

    // Only ids we actually sent. A hallucinated id would break the link back to
    // the messages that triggered the alert.
    const messageIds = Array.isArray(c.messageIds)
      ? c.messageIds.filter((id) => typeof id === 'string' && knownMsgIds.has(id))
      : [];
    if (messageIds.length === 0) continue;

    out.push({
      messageIds,
      category: CATEGORIES.has(c.category) ? c.category : 'other',
      severity: SEVERITY_SET.has(c.severity) ? c.severity : 'low',
      summary,
      ownerHint: typeof c.ownerHint === 'string' && c.ownerHint.trim() ? c.ownerHint.trim() : null,
    });
  }
  return out;
}

/**
 * Parses the resolution verdict.
 *
 * Unparseable output is not an error worth escalating or throwing over: this
 * only decides a label next to a button, so anything unclear means "not
 * resolved", which is the safe direction - it leaves the concern escalating.
 */
export function parseResolution(raw, knownMsgIds) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { resolved: false, msgId: null, reason: null };
  }

  if (parsed?.resolved !== true) return { resolved: false, msgId: null, reason: null };

  // A verdict pointing at a message we never sent cannot be shown as evidence,
  // and a "resolved" with no evidence is not one we act on.
  const msgId = typeof parsed.msgId === 'string' && knownMsgIds.has(parsed.msgId) ? parsed.msgId : null;
  if (!msgId) return { resolved: false, msgId: null, reason: null };

  return {
    resolved: true,
    msgId,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
  };
}
