import { config } from '../config.js';
import { logger } from '../logger.js';
import { messages, concerns, routing } from '../db.js';
import { llm } from '../llm/index.js';
import { resolveRouting } from '../router/resolve.js';
import { sendAlert } from '../router/alert.js';
import { findDuplicate } from './concerns.js';

const toLlm = (m) => ({ msgId: m.msgId, senderName: m.senderName, ts: m.ts, text: m.text });

/**
 * Classify this group's unclassified messages, open concerns for anything real,
 * and alert the owner. Never throws — one group's failure must not stop the rest.
 *
 * Messages are marked classified whatever happens downstream: a routing gap or a
 * failed DM must not cause the same batch to be re-sent to the LLM every five
 * minutes forever, at real cost.
 */
export async function detectForGroup(group) {
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
          ownerPhone: config.defaultOwnerPhone,
          cooldownMin: config.defaultCooldownMin,
          escalateAfterMin: config.defaultEscalateAfterMin,
        });

        const duplicate = findDuplicate(
          candidate,
          live,
          now,
          route?.cooldownMin ?? config.defaultCooldownMin,
        );
        if (duplicate) {
          // Same problem, still inside the cooldown: attach the evidence, stay quiet.
          await concerns().updateOne(
            { _id: duplicate._id },
            { $addToSet: { messageIds: { $each: candidate.messageIds } } },
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
        };
        const { insertedId } = await concerns().insertOne(doc);
        doc._id = insertedId;
        live.push(doc);
        raised += 1;

        if (!route) {
          logger.error(
            { concernId: String(insertedId), category: candidate.category },
            'no routing rule and no DEFAULT_OWNER_PHONE - concern raised but NOBODY was alerted',
          );
          continue;
        }
        await sendAlert(doc, group.name, route.ownerPhone);
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
