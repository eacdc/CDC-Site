import { config } from '../config.js';
import { logger } from '../logger.js';
import { alerts, owners } from '../db.js';
import { maytapi } from '../maytapi/client.js';

/**
 * The dashboard link for a concern.
 *
 * `concerns.html#id=` and not `/concerns/<id>`, which is what this used to
 * build and which nothing has ever served: the dashboard routes on the
 * fragment (see routeParams() in the frontend's app.js), so every alert went
 * out carrying a dead link.
 *
 * A real file rather than the `/concerns` rewrite, because a rewrite only
 * exists where serve.json does, and a fragment on a real path cannot be caught
 * by a cached redirect.
 */
export const concernUrl = (concernId) =>
  `${config.dashboardBaseUrl}/concerns.html#id=${concernId}`;

export function formatAlert(concern, groupName) {
  return [
    `⚠️ ${concern.severity} · ${concern.category}`,
    `Group: ${groupName}`,
    concern.summary,
    '',
    // A WhatsApp DM is plain text - there is no button that expands in place -
    // so this link is the "read more": it opens the whole reply thread, every
    // message, in order.
    'Read the full conversation:',
    concernUrl(concern._id),
    '',
    'Reply ACK to acknowledge.',
  ].join('\n');
}

/**
 * Sends one alert DM. The alert row is written BEFORE the send and updated
 * after, so a crash mid-send leaves a record saying "we tried" rather than
 * losing the fact entirely. Never throws — a failed alert must not abort the
 * run or block the remaining concerns.
 */
export async function sendAlert(concern, groupName, toPhone, channel = 'owner') {
  const payload = formatAlert(concern, groupName);
  const owner = await owners().findOne({ _id: toPhone });

  const { insertedId } = await alerts().insertOne({
    concernId: concern._id,
    toPhone,
    toName: owner?.name ?? null,
    channel,
    sentAt: new Date(),
    payload,
    maytapiMsgId: null,
    delivered: false,
    error: null,
  });

  try {
    const res = await maytapi.sendMessage(toPhone, payload);
    const maytapiMsgId = res?.data?.[0]?.msg_id ?? res?.data?.msg_id ?? res?.message_id ?? null;
    await alerts().updateOne({ _id: insertedId }, { $set: { delivered: true, maytapiMsgId } });
    logger.info({ concernId: String(concern._id), toPhone, channel }, 'alert sent');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await alerts().updateOne({ _id: insertedId }, { $set: { delivered: false, error: message } });
    logger.error({ concernId: String(concern._id), toPhone, err: message }, 'alert send failed');
    return false;
  }
}
