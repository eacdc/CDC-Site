import { config } from '../config.js';
import { logger } from '../logger.js';
import { messages, concerns, routing } from '../db.js';
import { llm } from '../llm/index.js';
import { resolveRouting } from '../router/resolve.js';
import { findDuplicate } from './concerns.js';
import { splitByThread } from './threads.js';

const toLlm = (m) => ({
  msgId: m.msgId,
  senderName: m.senderName,
  ts: m.ts,
  text: m.text,
  // What this message quotes, so the model can tell a follow-up from a second,
  // unrelated problem reported in the same few minutes.
  replyTo: m.quotedMsgId ?? null,
});

/**
 * Classify this group's unclassified messages, open concerns for anything real,
 * and alert the owner. Never throws — one group's failure must not stop the rest.
 *
 * Messages are marked classified whatever happens downstream: a routing gap or a
 * failed DM must not cause the same batch to be re-sent to the LLM every five
 * minutes forever, at real cost.
 *
 * `silent` is for backfilling history: concerns are raised and appear on the
 * dashboard, but nobody is DMed and nothing escalates. A problem from two days
 * ago should not ring a phone tonight, and it may well be fixed already.
 */
export async function detectForGroup(group, { silent = false } = {}) {
  const unclassified = await messages()
    .find({ groupId: group._id, classified: false })
    .sort({ ts: 1 })
    .toArray();

  // Empty messages (media with no caption) carry no signal and cost tokens.
  const judgeable = unclassified.filter((m) => (m.text ?? '').trim().length > 0);
  if (judgeable.length === 0) {
    if (unclassified.length > 0) await markClassified(unclassified);
    return 0;
  }

  const context = (
    await messages()
      .find({ groupId: group._id, classified: true })
      .sort({ ts: -1 })
      .limit(config.llm.contextMessages)
      .toArray()
  ).reverse();

  let raised = 0;
  try {
    const result = await llm().classify({
      groupName: group.name,
      groupKind: group.kind,
      newMessages: judgeable.map(toLlm),
      contextMessages: context.map(toLlm),
    });

    logger.info(
      {
        groupId: group._id,
        judged: judgeable.length,
        found: result.concerns.length,
        model: result.model,
        escalated: result.escalated,
      },
      'classified',
    );

    // One thread is one concern, enforced here rather than trusted to the
    // prompt. rootOf falls back to the message's own id for anything not in
    // this batch, which matches how ingest roots an unknown parent.
    const rootById = new Map(
      [...judgeable, ...context].map((m) => [m.msgId, m.threadRootId ?? m.msgId]),
    );
    result.concerns = splitByThread(result.concerns, (id) => rootById.get(id));

    if (result.concerns.length > 0) {
      const now = new Date();
      const live = await concerns()
        .find({ groupId: group._id, status: { $in: ['open', 'acknowledged'] } })
        .toArray();

      const routes = await routing()
        .find({ $or: [{ groupId: group._id }, { groupId: '*' }] })
        .toArray();

      const tsOf = new Map(judgeable.map((m) => [m.msgId, m.ts]));

      for (const candidate of result.concerns) {
        const route = resolveRouting(group._id, candidate.category, routes, {
          groupOwnerPhone: group.ownerPhone,
          ownerPhone: config.defaultOwnerPhone,
          cooldownMin: config.defaultCooldownMin,
          escalateAfterMin: config.defaultEscalateAfterMin,
        });

        const duplicate = findDuplicate(candidate, live);
        if (duplicate) {
          // Same reply thread: this is the problem we are already tracking, so
          // attach the evidence and stay quiet.
          await concerns().updateOne(
            { _id: duplicate._id },
            {
              $addToSet: {
                messageIds: { $each: candidate.messageIds },
                threadRootIds: { $each: candidate.threadRootIds },
              },
              // New trouble in a thread someone called fixed means it was not.
              // And a backfilled concern that is still being talked about is a
              // live problem after all, so it stops being silent.
              $unset: silent ? { resolutionHint: '' } : { resolutionHint: '', backfilledAt: '' },
            },
          );
          logger.info(
            { concernId: String(duplicate._id), category: candidate.category },
            'duplicate concern - appended, no alert',
          );
          continue;
        }

        const firstMsgTs =
          candidate.messageIds
            .map((id) => tsOf.get(id))
            .filter(Boolean)
            .sort((a, b) => a - b)[0] ?? now;

        const doc = {
          groupId: group._id,
          category: candidate.category,
          severity: candidate.severity,
          summary: candidate.summary,
          ownerId: route?.ownerPhone ?? null,
          messageIds: candidate.messageIds,
          firstMsgTs,
          status: 'open',
          createdAt: now,
          acknowledgedAt: null,
          resolvedAt: null,
          escalatedTo: [],
          threadRootIds: candidate.threadRootIds,
          alertedAt: null,
          // Reconstructed from history rather than seen as it happened, so it
          // is a dashboard item, not an alert. Cleared if the thread comes back
          // to life in a normal poll.
          ...(silent ? { backfilledAt: now } : {}),
        };
        const { insertedId } = await concerns().insertOne(doc);
        doc._id = insertedId;
        live.push(doc);
        raised += 1;

        // Nobody is DMed here. The concern waits - 30 minutes in an internal
        // group, 15 in a client one - and router/first-alert.js decides on a
        // later cycle whether anyone still needs telling. A problem the group
        // fixed in the meantime never reaches a phone.
        logger.info(
          { concernId: String(insertedId), category: candidate.category, severity: candidate.severity },
          'concern raised - waiting before the first alert',
        );
      }
    }
  } catch (err) {
    logger.error({ groupId: group._id, err: String(err) }, 'detector failed');
  }

  await markClassified(unclassified);
  return raised;
}

async function markClassified(msgs) {
  await messages().updateMany(
    { msgId: { $in: msgs.map((m) => m.msgId) } },
    { $set: { classified: true } },
  );
}
