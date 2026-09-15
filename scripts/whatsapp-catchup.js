/**
 * Pulls recent history into the issue list, once, then gets out of the way.
 *
 *   npm run whatsapp:catchup                 # last 20 from every monitored group
 *   npm run whatsapp:catchup -- --count 50
 *   npm run whatsapp:catchup -- --group "<id>"
 *
 * Normally nothing older than a group's joinedAt is ever ingested, so the
 * conversation that was already happening when monitoring started is invisible.
 * This lowers that floor just far enough to cover the messages it fetched, and
 * leaves it there - they are real messages and belong in the data.
 *
 * Concerns raised here are SILENT: no DMs, no escalation. Something reported
 * two days ago should not ring a phone tonight, and it may already be fixed.
 * They appear on the dashboard for review, and the resolution check will mark
 * the ones whose threads say so as possibly resolved. If new messages land in
 * one of those threads later, it stops being silent and behaves normally.
 *
 * Polling afterwards continues exactly as before - the cursor advances on its
 * own, and this changes nothing about how the next cycle runs.
 */
import { config, assertConfigured } from '../src/whatsapp-monitor/config.js';
import { connect, ensureIndexes, groups, concerns, close } from '../src/whatsapp-monitor/db.js';
import { fetchBackToCursor, pollGroup } from '../src/whatsapp-monitor/poller/poll.js';
import { detectForGroup } from '../src/whatsapp-monitor/detector/detect.js';
import { runTranscriptions } from '../src/whatsapp-monitor/media/transcribe.js';
import { runResolutionChecks } from '../src/whatsapp-monitor/detector/resolution.js';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const count = Number(value('--count', '20'));
const onlyGroup = value('--group', null);

if (!Number.isFinite(count) || count < 1) {
  console.error('--count must be a positive number');
  process.exit(1);
}

assertConfigured();
await connect();
await ensureIndexes();

// fetchBackToCursor takes its page size from config, and one page is exactly
// what is wanted here - the last `count` messages, not a walk back through
// history we are not asking for.
config.maytapi.messageCount = count;
config.maytapi.maxPages = 1;

const query = onlyGroup ? { _id: onlyGroup } : { monitored: true };
const selected = await groups().find(query).toArray();

if (selected.length === 0) {
  console.error(onlyGroup ? `No group "${onlyGroup}".` : 'No groups are being monitored.');
  await close();
  process.exit(1);
}

console.log(`Catching up on the last ${count} message(s) in ${selected.length} group(s).\n`);

let ingestedTotal = 0;
let raisedTotal = 0;

for (const group of selected) {
  process.stdout.write(`${group.name}\n`);

  try {
    const { fetched } = await fetchBackToCursor(group._id, { joinedAt: null, lastTs: null });
    if (fetched.length === 0) {
      console.log('  nothing returned\n');
      continue;
    }

    // Lower the ingest floor to cover exactly what came back, and no further.
    const oldest = fetched.reduce((a, b) => (b.ts < a.ts ? b : a)).ts;
    const floor = new Date(oldest.getTime() - 1000);
    if (!group.joinedAt || group.joinedAt > floor) {
      await groups().updateOne({ _id: group._id }, { $set: { joinedAt: floor } });
      console.log(`  joinedAt lowered to ${floor.toISOString()}`);
    }

    const fresh = await groups().findOne({ _id: group._id });
    const { ingested, error } = await pollGroup(fresh);
    if (error) {
      console.log(`  poll failed: ${error}\n`);
      continue;
    }
    ingestedTotal += ingested;

    const transcribed = await runTranscriptions(fresh);
    const raised = await detectForGroup(fresh, { silent: true });
    raisedTotal += raised;

    console.log(
      `  fetched ${fetched.length}, ingested ${ingested}` +
        (transcribed ? `, transcribed ${transcribed}` : '') +
        `, raised ${raised} concern(s)\n`,
    );
  } catch (err) {
    console.log(`  failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// Threads that already say "solved" get marked now, so the list you review is
// not full of problems that ended before the tool could see them.
const flagged = await runResolutionChecks();

console.log(`Ingested ${ingestedTotal} message(s), raised ${raisedTotal} concern(s).`);
if (flagged) console.log(`${flagged} of them look already resolved.`);

const open = await concerns().countDocuments({ status: 'open' });
console.log(`\n${open} open concern(s) on the dashboard. Nobody was DMed and none of these will escalate.`);
console.log('Run `npm run whatsapp:concerns` to read them, or open the Concerns page.');
console.log('Normal polling is unaffected - start the backend as usual and it carries on from here.');

await close();
