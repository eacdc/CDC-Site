import { config } from '../config.js';
import { logger } from '../logger.js';
import { alerts, owners } from '../db.js';
import { maytapi } from '../maytapi/client.js';

export function formatAlert(concern, groupName) {
  return [
    `⚠️ ${concern.severity} · ${concern.category}`,
    `Group: ${groupName}`,
    concern.summary,
    'Reply ACK to acknowledge.',
    `${config.dashboardBaseUrl}/concerns/${concern._id}`,
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
