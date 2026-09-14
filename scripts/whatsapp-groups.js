/**
 * Turn monitoring on or off for a group, without touching Mongo by hand.
 *
 *   npm run whatsapp:groups                    # list groups + their state
 *   npm run whatsapp:groups -- "<id>" on       # start watching (sets joinedAt = now)
 *   npm run whatsapp:groups -- "<id>" off      # stop watching
 *   npm run whatsapp:groups -- "<id>" on --since 2026-09-01T00:00:00Z
 *
 * Turning a group ON sets joinedAt to this moment only if it has never been
 * set, so toggling off and on again does not move the ingest floor. --since
 * moves it deliberately, which is the only way to reach messages that were
 * already in the group before it was switched on.
 */
import { connect, groups, close } from '../src/whatsapp-monitor/db.js';

const argv = process.argv.slice(2);
const sinceAt = argv.indexOf('--since');
const since = sinceAt >= 0 ? new Date(argv[sinceAt + 1] ?? '') : null;
if (since && Number.isNaN(since.getTime())) {
  console.error('--since needs a date, e.g. --since 2026-09-01T00:00:00Z');
  process.exit(1);
}
// Remove the flag and its value by position, not by matching their text - a
// groupId that happened to equal the date string would otherwise vanish too.
const positional = argv.filter((_, i) => sinceAt < 0 || (i !== sinceAt && i !== sinceAt + 1));
const [groupId, state] = positional;

await connect();

if (!groupId) {
  const all = await groups().find({}).sort({ name: 1 }).toArray();
  if (all.length === 0) {
    console.log('No groups yet. Run `npm run whatsapp:seed` first.');
  } else {
    console.log(`${all.length} group(s):\n`);
    for (const g of all) {
      const flag = g.monitored ? '[ON ]' : '[off]';
      const since = g.joinedAt ? ` since ${g.joinedAt.toISOString()}` : '';
      const last = g.lastTs ? ` lastTs=${g.lastTs.toISOString()}` : '';
      console.log(`${flag} ${g._id}\n      ${g.name}${since}${last}`);
    }
    console.log('\nUsage: npm run whatsapp:groups -- "<groupId>" on|off');
  }
  await close();
  process.exit(0);
}

if (state !== 'on' && state !== 'off') {
  console.error('Second argument must be "on" or "off".');
  await close();
  process.exit(1);
}

const group = await groups().findOne({ _id: groupId });
if (!group) {
  console.error(`No group "${groupId}". Run with no arguments to list them.`);
  await close();
  process.exit(1);
}

const monitored = state === 'on';
const update = { monitored };
if (since) update.joinedAt = since;
else if (monitored && !group.joinedAt) update.joinedAt = new Date();

await groups().updateOne({ _id: groupId }, { $set: update });
console.log(`${group.name} - monitoring ${monitored ? 'ON' : 'off'}`);
if (update.joinedAt) {
  console.log(`joinedAt set to ${update.joinedAt.toISOString()} - nothing older will ever be ingested.`);
}
await close();
