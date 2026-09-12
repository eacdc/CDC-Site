/**
 * Pure acknowledgement decisions — no I/O, so the matching rules are testable.
 */

/**
 * True when an owner's reply means "I've got this".
 *
 * Deliberately narrow: the word ACK as a whole word, case-insensitive, anywhere
 * in the message. "ack", "ACK", "Ack noted", "ok ack" all count. A message that
 * merely contains those letters inside another word — "acknowledge my back
 * pain", "Jack" — does not, which is why this is a word-boundary match rather
 * than a substring test.
 *
 * "ok" and "done" are deliberately NOT acknowledgements. They are the two most
 * common words in any work group, and treating them as acknowledgement would
 * silently swallow concerns nobody actually picked up.
 */
export function isAck(text) {
  return /\back\b/i.test(text ?? '');
}

/**
 * The concern an owner's ACK applies to: their newest still-open one.
 *
 * "Theirs" includes concerns they were escalated into, not just ones they own —
 * someone who was pulled in at the second hop and replies ACK has taken it on,
 * and the alert they answered was about that concern.
 *
 * `concerns` may be in any order; the newest by createdAt wins.
 */
export function findAckTarget(phone, concerns) {
  let best = null;
  for (const c of concerns) {
    if (c.status !== 'open') continue;
    const mine = c.ownerId === phone || (c.escalatedTo ?? []).includes(phone);
    if (!mine) continue;
    if (!best || c.createdAt > best.createdAt) best = c;
  }
  return best;
}
