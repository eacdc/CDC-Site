/**
 * Creates the WhatsApp-monitor indexes (including the 60-day TTL) and imports
 * every group the CDC number belongs to, all left monitored:false.
 * Safe to re-run — only the group name is overwritten.
 */
import { connect, ensureIndexes, groups, close } from '../src/whatsapp-monitor/db.js';
import { maytapi } from '../src/whatsapp-monitor/maytapi/client.js';
import { normaliseGroups } from '../src/whatsapp-monitor/maytapi/normalise.js';

await connect();
await ensureIndexes();

const found = normaliseGroups(await maytapi.getGroups());
console.log(`maytapi returned ${found.length} groups`);

for (const g of found) {
  await groups().updateOne(
    { _id: g.id },
    {
      $set: { name: g.name },
      $setOnInsert: {
        monitored: false,
        // Internal until somebody says otherwise in Admin: the client prompt
        // raises far more, and applying it to a plant group by accident would
        // bury a manager in alerts.
        kind: 'internal',
        ownerPhone: null,
        // The escalation ladder for this group, in order. Empty means fall back
        // to the older per-person escalationTo chain.
        escalationTo: [],
        department: null,
        joinedAt: null,
        lastTs: null,
        lastMsgId: null,
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
      },
    },
    { upsert: true },
  );
  console.log(`  ${g.id}  ${g.name}`);
}

console.log('\nTurn one on with:  npm run whatsapp:groups -- "<groupId>" on');
await close();
