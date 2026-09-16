/**
 * Reply-thread identity — pure, so the walking rules are directly testable.
 *
 * WhatsApp gives every message that quotes another the quoted message's id
 * (`quotedMsgId`). Following that upwards to the message nobody quoted gives a
 * stable id for the whole conversation: its root. One thread is one problem,
 * however long it runs, and a message that quotes nothing starts its own.
 */

/**
 * A safety valve, not an expected path: a real reply chain is a handful of
 * messages, and WhatsApp can only quote something older, so a chain this long
 * means corruption. Stopping keeps ingest moving instead of letting one bad
 * chain stall the poller.
 */
export const MAX_DEPTH = 200;

/**
 * The root of `msg`'s reply chain. `lookup(id)` returns the message with that
 * id, or null/undefined when it is not known.
 *
 * Unknown quoted messages are common and not an error: the quoted message may
 * predate joinedAt, or have aged out under the 60-day TTL. The chain simply
 * stops there, and the oldest message we actually have becomes the root.
 */
export function threadRootOf(msg, lookup) {
  if (!msg) return null;

  const seen = new Set([msg.msgId]);
  let current = msg;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parentId = current.quotedMsgId;
    if (!parentId) break;

    // A cycle - a message quoting itself, or a chain that loops back. Stopping
    // at whatever message we happened to reach would make the root depend on
    // where the walk started, and the same cycle would then split into two
    // threads. The smallest id in the loop is the same from every entry point.
    if (seen.has(parentId)) {
      return [...seen].sort()[0];
    }

    const parent = lookup(parentId);
    // The parent is not stored. Its id is still the most stable root available:
    // every other reply to it resolves to the same value, so the thread stays
    // together even though the message itself is gone.
    if (!parent) return parentId;

    seen.add(parentId);
    current = parent;
  }

  return current.msgId;
}

/** `threadRootOf` over a batch, resolving parents within the batch as well. */
export function assignThreadRoots(msgs, lookup = () => null) {
  const inBatch = new Map(msgs.map((m) => [m.msgId, m]));
  const find = (id) => inBatch.get(id) ?? lookup(id);
  return msgs.map((m) => ({ ...m, threadRootId: threadRootOf(m, find) }));
}

/** The distinct thread roots covered by a set of messages. */
export function rootsOf(msgs) {
  return [...new Set(msgs.map((m) => m.threadRootId ?? m.msgId))];
}

/** True when two concerns/candidates share any thread — the strict join rule. */
export function sharesThread(a = [], b = []) {
  const set = new Set(a);
  return b.some((root) => set.has(root));
}

/**
 * Splits any candidate whose messages span more than one reply thread into one
 * candidate per thread.
 *
 * The prompt asks the model to keep threads separate; this makes it true. A
 * model handed "Eterna foil machine stop" and "Same problem, machine stop" will
 * sometimes merge them into one concern even though neither quotes the other —
 * two machines, one alert, and the second fault invisible. Guidance is not a
 * guarantee, so the rule is enforced here instead.
 *
 * `rootOf(msgId)` returns that message's thread root. Candidates already inside
 * one thread pass through untouched, including their object identity.
 */
export function splitByThread(candidates, rootOf) {
  const out = [];

  for (const candidate of candidates) {
    const byRoot = new Map();
    for (const msgId of candidate.messageIds) {
      const root = rootOf(msgId) ?? msgId;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(msgId);
    }

    if (byRoot.size <= 1) {
      out.push({ ...candidate, threadRootIds: [...byRoot.keys()] });
      continue;
    }

    for (const [root, messageIds] of byRoot) {
      out.push({ ...candidate, messageIds, threadRootIds: [root] });
    }
  }

  return out;
}

/**
 * The Mongo filter for "every message in this concern's reply thread".
 *
 * A concern normally anchors to thread roots. It may have none: the messages it
 * cites can age out under the TTL before the backfill stamps them, and
 * `whatsapp-backfill-threads` deliberately leaves `threadRootIds` empty in that
 * case. Then the cited messages themselves are the best thread we have.
 *
 * This lives in one place because it did not used to: the detail route had the
 * fallback and the resolution checker did not, so a concern with no roots
 * rendered its whole conversation on screen while the checker saw nothing and
 * silently never asked whether it was fixed.
 */
export function threadQueryFor(concern) {
  const roots = concern.threadRootIds ?? [];
  return roots.length
    ? { groupId: concern.groupId, threadRootId: { $in: roots } }
    : { msgId: { $in: concern.messageIds ?? [] } };
}
