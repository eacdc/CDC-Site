import { locks } from '../db.js';
import { logger } from '../logger.js';
import { hostname } from 'node:os';

/** Who we are, in a form that means something when read off the Runs tab. */
export const WHO = `${hostname()}:${process.pid}`;

/**
 * Should this process be allowed to start a poll?
 *
 * Pure, so the decision is testable without a database. The lease is free when
 * nobody holds it, when the holder's lease has lapsed, or when the holder is
 * us - a cycle that overran its own lease should carry on rather than lock
 * itself out.
 */
export function leaseIsFree(lock, who, now) {
  if (!lock) return true;
  if (lock.holder === who) return true;
  return !lock.expiresAt || lock.expiresAt.getTime() <= now.getTime();
}

/**
 * Takes the poll lease, or returns false if somebody else holds it.
 *
 * One database is polled by one process. Two - a laptop still running
 * `npm start` alongside the deployed service, say - classify the same messages
 * twice, pay OpenAI twice, race each other's cursors and can DM the same
 * person about the same concern.
 *
 * A lease with an expiry rather than a plain flag: a process that dies
 * mid-cycle must not lock the system out for good. `ttlMs` is set well beyond
 * a normal cycle, so a slow run is not overtaken by the next machine along.
 *
 * Never throws. A locking failure must not be the thing that stops polling -
 * if the lock cannot be read, the poll goes ahead, because not polling at all
 * is the worse outcome of the two.
 */
export async function takePollLease(ttlMs, now = new Date()) {
  const mine = { holder: WHO, expiresAt: new Date(now.getTime() + ttlMs), takenAt: now };

  try {
    // First time here: the insert is the claim. A duplicate key means somebody
    // already has a lease, live or lapsed, and the update below decides.
    try {
      await locks().insertOne({ _id: 'poll', ...mine });
      return true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    // One conditional write, so two processes arriving together cannot both
    // conclude the lease was free: only one of them modifies the document.
    const res = await locks().updateOne(
      { _id: 'poll', $or: [{ holder: WHO }, { expiresAt: { $lte: now } }] },
      { $set: mine },
    );
    if (res.modifiedCount === 1) return true;

    const lock = await locks().findOne({ _id: 'poll' });
    logger.info(
      { holder: lock?.holder, expiresAt: lock?.expiresAt },
      'another instance is polling this database - standing down for this cycle',
    );
    return false;
  } catch (err) {
    logger.warn({ err: String(err) }, 'could not take the poll lease - polling anyway');
    return true;
  }
}

/** Releases the lease, so the next cycle on any instance can start at once. */
export async function releasePollLease() {
  try {
    await locks().updateOne({ _id: 'poll', holder: WHO }, { $set: { expiresAt: new Date(0) } });
  } catch (err) {
    logger.warn({ err: String(err) }, 'could not release the poll lease - it will lapse on its own');
  }
}
