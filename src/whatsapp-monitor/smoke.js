/**
 * Pure helpers for the end-to-end smoke test (scripts/whatsapp-smoke-test.js).
 *
 * The stages themselves are integration — they talk to Maytapi, Mongo and
 * OpenAI, and mocking them would only prove the mocks work. These two pieces
 * are pure, so they are unit-tested instead of being taken on trust.
 */

/** Marks every row the smoke test creates, so cleanup can find them all. */
export const SMOKE_MARKER = 'smokeTest';

/**
 * The synthetic message the classifier is asked to catch.
 *
 * Ten real messages may be nothing but chatter, in which case the alert, ACK
 * and escalation stages would have no concern to work with and would report a
 * false pass. This guarantees one, and doubles as a check on the single most
 * important case in detector/prompt.md: a machine breakdown written in
 * romanised Hindi.
 *
 * It is written to Mongo only. It is never sent to WhatsApp and nobody in the
 * group ever sees it.
 */
export function buildSmokeMessage(groupId, runId, now = new Date()) {
  return {
    msgId: `smoke-${runId}`,
    groupId,
    senderId: 'smoke-test',
    senderName: 'Smoke Test',
    ts: now,
    receivedAt: now,
    text: '[SMOKE TEST] Kolbus binder band jam ho gaya, production stopped hai',
    type: 'text',
    mediaUrl: null,
    quotedMsgId: null,
    fromMe: false,
    classified: false,
    [SMOKE_MARKER]: runId,
  };
}

/**
 * Folds stage results into the closing tally. A skipped stage is neither a pass
 * nor a failure: reporting "11/12 passed" when one could not run would read as
 * a failure, and counting it as a pass would be a lie.
 */
export function tally(results) {
  const count = (state) => results.filter((r) => r.state === state).length;
  return {
    passed: count('PASS'),
    failed: count('FAIL'),
    skipped: count('SKIP'),
    total: results.length,
    ok: count('FAIL') === 0,
  };
}
