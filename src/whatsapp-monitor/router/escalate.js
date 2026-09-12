import { config } from '../config.js';
import { logger } from '../logger.js';
import { concerns, owners, routing, groups } from '../db.js';
import { sendAlert } from './alert.js';
import { resolveRouting } from './resolve.js';
import { dueForEscalation, nextEscalationTarget } from './escalation-rules.js';

/**
 * Escalates open concerns nobody has acknowledged. Runs on every poll cycle.
 * Never throws — escalation failing must not stop the run.
 *
 * Returns how many were escalated.
 */
export async function runEscalations() {
  const now = new Date();
  let escalated = 0;

  try {
    // Only open concerns can escalate, so the scan stays small even with a long
    // history: acknowledged and resolved ones are excluded by the query.
    const open = await concerns().find({ status: 'open' }).toArray();
    if (open.length === 0) return 0;

    const ownerDocs = await owners().find({}).toArray();
    const ownersByPhone = new Map(ownerDocs.map((o) => [o._id, o]));

    const groupIds = [...new Set(open.map((c) => c.groupId))];
    const groupDocs = await groups().find({ _id: { $in: groupIds } }).toArray();
    const groupNames = new Map(groupDocs.map((g) => [g._id, g.name]));

    const routes = await routing().find({}).toArray();

    for (const concern of open) {
      const route = resolveRouting(concern.groupId, concern.category, routes, {
        ownerPhone: config.defaultOwnerPhone,
        cooldownMin: config.defaultCooldownMin,
        escalateAfterMin: config.defaultEscalateAfterMin,
      });
      const after = route?.escalateAfterMin ?? config.defaultEscalateAfterMin;

      if (!dueForEscalation(concern, now, after)) continue;

      const target = nextEscalationTarget(concern, ownersByPhone);
      if (!target) {
        // The chain ends here. Log once per concern by marking it, so this does
        // not repeat every five minutes for the life of the concern.
        if (!concern.escalationChainExhausted) {
          logger.warn(
            { concernId: String(concern._id), ownerId: concern.ownerId },
            'concern unacknowledged but nobody left to escalate to — set escalationTo on the owner',
          );
          await concerns().updateOne(
            { _id: concern._id },
            { $set: { escalationChainExhausted: true } },
          );
        }
        continue;
      }

      // Recorded before the send, like the first alert, so a crash mid-send
      // cannot cause the same person to be escalated to twice.
      await concerns().updateOne(
        { _id: concern._id },
        { $push: { escalatedTo: target }, $set: { lastEscalatedAt: now } },
      );

      const groupName = groupNames.get(concern.groupId) ?? concern.groupId;
      await sendAlert(concern, groupName, target, 'escalation');
      escalated += 1;

      logger.info(
        {
          concernId: String(concern._id),
          to: target,
          hop: (concern.escalatedTo?.length ?? 0) + 1,
          unackedMin: Math.round((now - concern.createdAt) / 60_000),
        },
        'concern escalated',
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'escalation pass failed');
  }

  return escalated;
}
