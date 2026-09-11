/**
 * ============================================================================
 * THE ONLY FILE THAT KNOWS MAYTAPI'S RESPONSE SHAPE.
 * ============================================================================
 * Pinned against a real getMessages response (whatsapp-monitor/normalise.test.js):
 *
 *   { success, data: {
 *       users: { "<jid>": { id, name, phone, image? } },
 *       messages: [ { timestamp, uid, fromMe, message: {...}, quotedMsg? } ],
 *       me, participants } }
 *
 * Two things here are easy to get wrong:
 *  - the SENDER is `uid` on the envelope, and the sender's NAME exists only in
 *    the `data.users` map — it is not on the message itself.
 *  - `message.type === "info"` rows are system events (group/add, group/leave,
 *    group/name) carrying no text at all. They are not messages; we drop them.
 */

/** System events, not conversation. */
const SYSTEM_TYPES = new Set(['info', 'notification', 'e2e_notification', 'gp2']);

/**
 * Maytapi sends epoch SECONDS. Accept millis too, and always return a BSON
 * Date — the TTL index does nothing on a number.
 */
export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toDate(Number(value));
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** The users map is keyed by jid; a sender may legitimately be absent from it. */
function nameOf(users, uid) {
  if (!uid || !users || typeof users !== 'object') return null;
  const name = users[uid]?.name;
  return typeof name === 'string' && name ? name : null;
}

export function normaliseMessages(payload) {
  const data = payload?.data ?? payload;
  const rows = Array.isArray(data?.messages) ? data.messages : [];
  const users = data?.users;

  const out = [];
  for (const row of rows) {
    const msg = row?.message;
    const msgId = msg?.id ?? msg?._serialized;
    const ts = toDate(row?.timestamp);
    if (!msgId || !ts) continue;

    const type = typeof msg?.type === 'string' ? msg.type : 'text';
    if (SYSTEM_TYPES.has(type)) continue;

    const uid = typeof row?.uid === 'string' ? row.uid : null;

    out.push({
      msgId: String(msgId),
      senderId: uid,
      senderName: nameOf(users, uid),
      ts,
      // Media messages carry a caption instead of text.
      text: str(msg?.text) ?? str(msg?.caption) ?? '',
      type,
      mediaUrl: str(msg?.url) ?? str(msg?.media) ?? null,
      quotedMsgId: str(row?.quotedMsg?.id) ?? str(row?.quotedMsg?._serialized) ?? null,
      fromMe: row?.fromMe === true,
    });
  }
  return out;
}

export function normaliseGroups(payload) {
  const data = payload?.data ?? payload;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];

  const out = [];
  for (const row of rows) {
    const id = row?.id ?? row?.conversation_id ?? row?._serialized;
    if (!id) continue;
    const name = str(row?.name) ?? str(row?.subject) ?? str(row?.title);
    out.push({ id: String(id), name: name ?? String(id) });
  }
  return out;
}

/** True when the WhatsApp-Web session is paired and usable. */
export function isLoggedIn(statusPayload) {
  const s = statusPayload?.status ?? statusPayload?.data?.status ?? statusPayload?.data ?? statusPayload;
  if (typeof s?.loggedIn === 'boolean') return s.loggedIn;
  const state = String(s?.state ?? s?.status ?? s ?? '').toLowerCase();
  return ['online', 'active', 'connected', 'ready', 'loading'].includes(state);
}

function str(v) {
  if (typeof v === 'string') return v || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
