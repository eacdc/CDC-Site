import { config } from '../config.js';
import { logger } from '../logger.js';
import { concerns, groups } from '../db.js';
import { sendAlert } from './alert.js';
import { recentlyAlerted } from '../detector/concerns.js';
import { dueForFirstAlert, alertDelayFor } from './alert-rules.js';
import { LIVE_STATUSES } from '../concerns-live.js';

/**
 * Sends the first DM for concerns whose waiting window has expired.
 *
 * Raising a concern and alerting about it used to happen in the same breath,
 * inside the detector. They are now separate: the detector records what it
 * found, and this decides - later, on a subsequent cycle - whether anyone still
 * needs to be told. A problem the group fixed inside the window never reaches a
 * phone at all.
 *
 * Runs on every poll cycle. Never throws: a failure here must not stop the run.
 *
 * Returns how many were alerted.
 */
export async function runFirstAlerts() {
  const now = new Date();
  let sent = 0;

  try {
    const waiting = await concerns().find({ status: 'open', alertedAt: null }).toArray();
    if (waiting.length === 0) return 0;

    const groupIds = [...new Set(waiting.map((c) => c.groupId))];
    const groupDocs = await groups().find({ _id: { $in: groupIds } }).toArray();
    const groupById = new Map(groupDocs.map((g) => [g._id, g]));

    // The cooldown compares against concerns that HAVE been alerted, so the
    // whole live set is needed, not just the waiting ones.
    const live = await concerns()
      .find({ groupId: { $in: groupIds }, status: { $in: LIVE_STATUSES } })
      .toArray();

    for (const concern of waiting) {
      const group = groupById.get(concern.groupId);
      const after = alertDelayFor(group, config.alertAfterMin);

      if (!dueForFirstAlert(concern, now, after)) {
        // Worth saying out loud once, because a concern with no owner waits
        // forever in silence and looks identical to one that is simply early.
        if (!concern.ownerId && !concern.backfilledAt && !concern.alertNobodyLogged) {
          logger.error(
            { concernId: String(concern._id), category: concern.category },
            'no routing rule and no DEFAULT_OWNER_PHONE - concern raised but NOBODY will be alerted',
          );
          await concerns().updateOne({ _id: concern._id }, { $set: { alertNobodyLogged: true } });
        }
        continue;
      }

      // Identity is per-thread, so one breakdown reported by three people who
      // did not quote each other is three concerns. All three belong on the
      // dashboard; three DMs in as many minutes is just noise.
      const throttled = recentlyAlerted(concern, live, now, config.alertCooldownMin);
      if (throttled) {
        logger.info(
          { concernId: String(concern._id), category: concern.category, like: String(throttled._id) },
          'alert suppressed - same category alerted inside the cooldown',
        );
        continue;
      }

      // Stamped before the send, so a crash mid-send cannot DM the same person
      // about the same concern twice - and stamped CONDITIONALLY, so neither
      // can a second process. Two instances can both read "not yet alerted";
      // only one of them can be the one that changes it, and the other stands
      // down here rather than sending a duplicate.
      const claimed = await concerns().updateOne(
        { _id: concern._id, alertedAt: null },
        { $set: { alertedAt: now } },
      );
      if (claimed.modifiedCount !== 1) {
        logger.info(
          { concernId: String(concern._id) },
          'another instance alerted this concern first - not sending',
        );
        continue;
      }
      concern.alertedAt = now;
      live.push(concern);

      const groupName = group?.name ?? concern.groupId;
      await sendAlert(concern, groupName, concern.ownerId);
      sent += 1;

      logger.info(
        {
          concernId: String(concern._id),
          to: concern.ownerId,
          kind: group?.kind ?? 'internal',
          waitedMin: Math.round((now - (concern.firstMsgTs ?? concern.createdAt)) / 60_000),
        },
        'first alert sent',
      );
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'first-alert pass failed');
  }

  return sent;
}
