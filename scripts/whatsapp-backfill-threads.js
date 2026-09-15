/**
 * Stamps threadRootId on messages stored before reply threads were tracked, and
 * threadRootIds on the concerns that cite them.
 *
 * Safe to re-run: it only touches documents that are missing the field.
 *
 *   npm run whatsapp:backfill-threads
 */
import { connect, ensureIndexes, messages, concerns, close } from '../src/whatsapp-monitor/db.js';
import { threadRootOf } from '../src/whatsapp-monitor/detector/threads.js';

await connect();
await ensureIndexes();

const pending = await messages().find({ threadRootId: { $exists: false } }).toArray();
console.log(`${pending.length} message(s) without a thread root.`);

if (pending.length > 0) {
  // Resolving a chain needs its parents, which may already be stamped or may be
  // in this same batch, so the whole group is loaded once and walked in memory.
  const groupIds = [...new Set(pending.map((m) => m.groupId))];
  const byId = new Map();
  for (const m of await messages().find({ groupId: { $in: groupIds } }).toArray()) {
    byId.set(m.msgId, m);
  }

  const ops = pending.map((m) => ({
    updateOne: {
      filter: { msgId: m.msgId },
      update: { $set: { threadRootId: threadRootOf(m, (id) => byId.get(id) ?? null) } },
    },
  }));
  const res = await messages().bulkWrite(ops, { ordered: false });
  console.log(`stamped ${res.modifiedCount} message(s).`);
}

const oldConcerns = await concerns().find({ threadRootIds: { $exists: false } }).toArray();
let updated = 0;
for (const c of oldConcerns) {
  const cited = await messages().find({ msgId: { $in: c.messageIds ?? [] } }).toArray();
  const roots = [...new Set(cited.map((m) => m.threadRootId).filter(Boolean))];
  // A concern whose messages have all aged out has nothing to anchor to; its
  // own id would match no message, so leave it empty and let the detail view
  // fall back to messageIds.
  await concerns().updateOne({ _id: c._id }, { $set: { threadRootIds: roots } });
  updated += 1;
}
console.log(`${updated} concern(s) given thread roots.`);

await close();
