import { config } from '../config.js';
import { logger } from '../logger.js';
import { concerns, messages } from '../db.js';
import { llm } from '../llm/index.js';

const toLlm = (m) => ({ msgId: m.msgId, senderName: m.senderName, ts: m.ts, text: m.text });

/**
 * Looks at open concerns whose reply threads have new messages and marks the
 * ones that look fixed.
 *
 * The concern stays `open`. Only a human resolves a concern - this sets a hint
 * the dashboard shows as "open - possibly resolved" next to the Resolve button.
 * Anything else would let a cheerful "ho gaya" close a live breakdown.
 *
 * Runs on every poll cycle. Never throws: a failure here must not stop the run.
 */
export async function runResolutionChecks() {
  let flagged = 0;

  try {
    const open = await concerns().find({ status: 'open' }).toArray();
    if (open.length === 0) return 0;

    for (const concern of open) {
      try {
        if (await checkOne(concern)) flagged += 1;
      } catch (err) {
        // One concern's thread failing must not stop the others.
        logger.error(
          { concernId: String(concern._id), err: String(err) },
          'resolution check failed for concern',
        );
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'resolution pass failed');
  }

  return flagged;
}

async function checkOne(concern) {
  const roots = concern.threadRootIds ?? [];
  if (roots.length === 0) return false;

  const thread = await messages()
    .find({ groupId: concern.groupId, threadRootId: { $in: roots } })
    .sort({ ts: 1 })
    .toArray();

  const withText = thread.filter((m) => (m.text ?? '').trim().length > 0);
  if (withText.length === 0) return false;

  const newest = withText[withText.length - 1];

  // Nothing has been said since the last verdict, so asking again would buy the
  // same answer at the same price.
  if (concern.resolutionCheckedMsgId === newest.msgId) return false;

  const verdict = await llm().checkResolved({
    summary: concern.summary,
    messages: withText.slice(-config.llm.contextMessages).map(toLlm),
  });

  const update = { resolutionCheckedMsgId: newest.msgId };

  if (verdict.resolved) {
    const evidence = withText.find((m) => m.msgId === verdict.msgId);
    update.resolutionHint = {
      at: new Date(),
      msgId: verdict.msgId,
      text: evidence?.text ?? null,
      senderName: evidence?.senderName ?? null,
      reason: verdict.reason,
      model: verdict.model,
    };
    await concerns().updateOne({ _id: concern._id }, { $set: update });
    logger.info(
      { concernId: String(concern._id), msgId: verdict.msgId, reason: verdict.reason },
      'concern possibly resolved - escalation paused, waiting for a human',
    );
    return true;
  }

  // The thread has moved on and no longer reads as fixed, so the hint goes and
  // the escalation clock starts again.
  const query = { _id: concern._id };
  if (concern.resolutionHint) {
    await concerns().updateOne(query, { $set: update, $unset: { resolutionHint: '' } });
    logger.info({ concernId: String(concern._id) }, 'resolution hint cleared - thread says otherwise');
  } else {
    await concerns().updateOne(query, { $set: update });
  }
  return false;
}
