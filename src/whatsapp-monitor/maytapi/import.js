import { groups } from '../db.js';
import { maytapi } from './client.js';
import { normaliseGroups } from './normalise.js';

/**
 * The fields a group starts life with. Off, internal, and nobody to alert - an
 * import can never begin watching something, or begin DMing about it, by
 * itself.
 */
const NEW_GROUP = {
  monitored: false,
  // Internal until somebody says otherwise in Admin: the client prompt raises
  // far more, and applying it to a plant group by accident would bury a manager
  // in alerts.
  kind: 'internal',
  ownerPhone: null,
  // The escalation ladder for this group, in order. Empty means fall back to
  // the older per-person escalationTo chain.
  escalationTo: [],
  department: null,
  joinedAt: null,
  lastTs: null,
  lastMsgId: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
};

/**
 * Works out what an import would change. Pure, so it is testable without
 * Maytapi or a database.
 *
 * `missing` is a group we know about that WhatsApp did not return - the number
 * has left it, or was removed. It is reported and never deleted: a group with
 * months of concerns behind it should not disappear because of one flaky API
 * call, and leaving a group is a decision for a person to confirm.
 */
export function compareGroups(found, existing) {
  const byId = new Map(existing.map((g) => [g._id, g]));
  const seen = new Set();

  const added = [];
  const renamed = [];

  for (const g of found) {
    seen.add(g.id);
    const was = byId.get(g.id);
    if (!was) added.push({ id: g.id, name: g.name });
    else if (was.name !== g.name) renamed.push({ id: g.id, from: was.name, to: g.name });
  }

  const missing = existing
    .filter((g) => !seen.has(g._id))
    .map((g) => ({ id: g._id, name: g.name, monitored: !!g.monitored }));

  return { found: found.length, added, renamed, missing };
}

/**
 * Imports every group the CDC number belongs to.
 *
 * Shared by `npm run whatsapp:seed` and the Refresh button in Admin, so the two
 * cannot drift apart - this project has twice shipped a bug where one caller
 * was fixed and a second copy of the same logic was not.
 *
 * Safe to re-run: only the name is overwritten on a group we already have.
 */
export async function importGroups() {
  const found = normaliseGroups(await maytapi.getGroups());
  const existing = await groups().find({}, { projection: { name: 1, monitored: 1 } }).toArray();
  const summary = compareGroups(found, existing);

  if (found.length > 0) {
    await groups().bulkWrite(
      found.map((g) => ({
        updateOne: {
          filter: { _id: g.id },
          update: { $set: { name: g.name }, $setOnInsert: NEW_GROUP },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  return summary;
}
