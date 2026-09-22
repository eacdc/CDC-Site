/**
 * Marks the concerns already on the board as alerted, without sending anything.
 *
 *   npm run whatsapp:silence            # show what would be silenced
 *   npm run whatsapp:silence -- --apply
 *
 * For the moment a configuration is fixed and a backlog of concerns suddenly
 * becomes alertable all at once. They belong on the dashboard - somebody should
 * read and close them - but nobody should get a DM about a customer question
 * from this morning. The first thing a manager sees from this tool should not
 * be a queue of stale ones, because that is how people learn to ignore it.
 *
 * Sets `alertedAt` to now so the first-alert pass skips them, and
 * `silencedAt` so it is clear on inspection that nothing was actually sent -
 * an alertedAt with no row in `alerts` would otherwise look like a failed send.
 *
 * Escalation measures its first hop from alertedAt, so these would begin
 * escalating instead. `backfilledAt` stops that, the same flag the history
 * catch-up uses, and it clears by itself the moment the thread sees new
 * activity - at which point the concern is live again and alerts normally.
 */
import { connect, concerns, close } from '../src/whatsapp-monitor/db.js';

const apply = process.argv.includes('--apply');

await connect();

const pending = await concerns()
  .find({ status: 'open', alertedAt: null })
  .sort({ createdAt: 1 })
  .toArray();

if (pending.length === 0) {
  console.log('Nothing is waiting to be alerted.');
} else {
  console.log(`${pending.length} concern(s) waiting for a first alert.\n`);
  for (const c of pending) {
    console.log(`  ${apply ? 'silenced' : 'would silence'}: ${c.summary}`);
  }

  if (apply) {
    const now = new Date();
    const res = await concerns().updateMany(
      { _id: { $in: pending.map((c) => c._id) }, alertedAt: null },
      { $set: { alertedAt: now, silencedAt: now, backfilledAt: now } },
    );
    console.log(
      `\n${res.modifiedCount} concern(s) silenced. They stay open on the dashboard, ` +
        'send no DM and do not escalate. Anything raised from now on alerts normally.',
    );
  } else {
    console.log('\nNothing written. Re-run with --apply.');
  }
}

await close();
