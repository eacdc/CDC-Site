import { config } from '../config.js';
import { logger } from '../logger.js';
import { concerns, owners, routing, groups } from '../db.js';
import { sendAlert } from './alert.js';
import { resolveRouting } from './resolve.js';
import { dueForEscalation, nextEscalationTarget, MAX_ESCALATIONS } from './escalation-rules.js';

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
    const groupOwners = new Map(groupDocs.map((g) => [g._id, g.ownerPhone ?? null]));
    // The group's own escalation ladder, where it has one. Comes from the same
    // documents as the names, so this costs no extra query.
    const groupChains = new Map(groupDocs.map((g) => [g._id, g.escalationTo ?? []]));

    const routes = await routing().find({}).toArray();

    for (const concern of open) {
      const route = resolveRouting(concern.groupId, concern.category, routes, {
        groupOwnerPhone: groupOwners.get(concern.groupId) ?? null,
        ownerPhone: config.defaultOwnerPhone,
        cooldownMin: config.defaultCooldownMin,
        escalateAfterMin: config.defaultEscalateAfterMin,
      });
      const after = route?.escalateAfterMin ?? config.defaultEscalateAfterMin;

      // A group with a ladder climbs exactly as far as that ladder goes. Without
      // one, the older per-person chain applies and still stops after two hops.
      const chain = groupChains.get(concern.groupId) ?? [];
      const maxHops = chain.length > 0 ? chain.length : MAX_ESCALATIONS;

      if (!dueForEscalation(concern, now, after, maxHops)) continue;

      const target = nextEscalationTarget(concern, ownersByPhone, chain);
      if (!target) {
        // The ladder ends here. Log once per concern by marking it, so this does
        // not repeat every five minutes for the life of the concern.
        //
        // Reaching the end of a group's ladder is a normal end state - somebody
        // chose that list. Having nobody at all is a misconfiguration, and the
        // message has to say which one this is or it sends people looking in
        // the wrong place.
        if (!concern.escalationChainExhausted) {
          logger.warn(
            { concernId: String(concern._id), ownerId: concern.ownerId, ladder: chain.length },
            chain.length > 0
              ? "concern unacknowledged and the group's escalation ladder is exhausted"
              : 'concern unacknowledged but nobody left to escalate to - give the group a ladder, or set escalationTo on the owner',
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
