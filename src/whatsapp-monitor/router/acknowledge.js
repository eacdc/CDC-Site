import { logger } from '../logger.js';
import { concerns, owners, alerts } from '../db.js';
import { maytapi } from '../maytapi/client.js';
import { normaliseMessages } from '../maytapi/normalise.js';
import { isAck, findAckTarget } from './ack-rules.js';

/** Maytapi addresses 1:1 chats by JID, not bare phone number. */
const jidFor = (phone) => `${phone}@c.us`;

/**
 * Polls the CDC number's 1:1 chat with each owner for "ACK" replies, and marks
 * their newest open concern acknowledged. Runs on every poll cycle.
 *
 * Only owners who have actually been alerted are polled — there is no point
 * fetching a DM thread with someone who has never been sent anything, and it
 * keeps the number of Maytapi calls proportional to real activity rather than
 * to the size of the owners table.
 *
 * Never throws. Returns how many concerns were acknowledged.
 */
export async function runAckPoll() {
  let acknowledged = 0;

  try {
    // Anyone with an open concern assigned or escalated to them could plausibly
    // reply ACK right now.
    const open = await concerns().find({ status: 'open' }).toArray();
    if (open.length === 0) return 0;

    const phones = new Set();
    for (const c of open) {
      if (c.ownerId) phones.add(c.ownerId);
      for (const p of c.escalatedTo ?? []) phones.add(p);
    }
    if (phones.size === 0) return 0;

    for (const phone of phones) {
      try {
        acknowledged += await checkOwner(phone, open);
      } catch (err) {
        // One unreachable DM thread must not stop the others.
        logger.error({ phone, err: String(err) }, 'ack check failed for owner');
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'ack pass failed');
  }

  return acknowledged;
}

async function checkOwner(phone, openConcerns) {
  const owner = await owners().findOne({ _id: phone });
  const now = new Date();

  // First time we look at this thread, start the clock now. Otherwise an owner
  // who happened to type "ack" in some unrelated chat months ago would
  // acknowledge a concern raised today.
  let since = owner?.lastAckTs ?? null;
  if (!since) {
    await owners().updateOne(
      { _id: phone },
      { $set: { lastAckTs: now }, $setOnInsert: { name: null, role: null, department: null, escalationTo: null } },
      { upsert: true },
    );
    return 0;
  }

  const fetched = normaliseMessages(await maytapi.getMessages(jidFor(phone)));

  // Only what the owner sent, after the cursor. fromMe is the CDC number's own
  // alerts — those contain the word ACK in the instruction line, and treating
  // them as replies would acknowledge every concern the moment it was raised.
  const replies = fetched.filter((m) => !m.fromMe && m.ts > since && isAck(m.text));

  // Advance the cursor to the newest message seen, acknowledgement or not, so
  // the thread is not rescanned from the same point forever.
  const newest = fetched.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
  if (newest && newest.ts > since) {
    await owners().updateOne({ _id: phone }, { $set: { lastAckTs: newest.ts } });
  }

  if (replies.length === 0) return 0;

  const target = findAckTarget(phone, openConcerns);
  if (!target) {
    logger.info({ phone }, 'ACK received but no open concern is theirs — ignoring');
    return 0;
  }

  await concerns().updateOne(
    { _id: target._id, status: 'open' },
    { $set: { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: phone } },
  );
  // Keep the in-memory copy in step so a second ACK in the same pass moves on
  // to the next concern instead of re-acknowledging this one.
  target.status = 'acknowledged';

  await alerts().insertOne({
    concernId: target._id,
    toPhone: phone,
    toName: owner?.name ?? null,
    channel: 'ack_received',
    sentAt: now,
    payload: replies[replies.length - 1].text,
    maytapiMsgId: null,
    delivered: true,
    error: null,
  });

  logger.info({ concernId: String(target._id), phone }, 'concern acknowledged');

  // Without this the owner has no idea whether their reply registered, and the
  // natural response to silence is to send it again.
  try {
    await maytapi.sendMessage(phone, `✅ Acknowledged: ${target.summary}`);
  } catch (err) {
    logger.warn({ phone, err: String(err) }, 'could not confirm the acknowledgement');
  }

  return 1;
}
