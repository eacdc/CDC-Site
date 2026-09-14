/**
 * Acknowledge or resolve a concern from the command line, without the
 * dashboard.
 *
 *   npm run whatsapp:close -- <id> resolve
 *   npm run whatsapp:close -- <id> acknowledge
 *   npm run whatsapp:close -- all resolve        # every open/acknowledged one
 *
 * Ids come from `npm run whatsapp:concerns` (the id= on the third line).
 *
 * The same transition the dashboard performs, with the same guard: the update
 * is conditional on the current status, so two people closing the same concern
 * cannot double-apply, and closing something already closed says so instead of
 * silently rewriting the timestamp.
 */
import { ObjectId } from 'mongodb';
import { connect, concerns, close } from '../src/whatsapp-monitor/db.js';

const [idArg, action = 'resolve'] = process.argv.slice(2);

const FROM = { acknowledge: ['open'], resolve: ['open', 'acknowledged'] };
const STAMP = { acknowledge: 'acknowledgedAt', resolve: 'resolvedAt' };
const STATUS = { acknowledge: 'acknowledged', resolve: 'resolved' };

if (!idArg || !FROM[action]) {
  console.error('usage: npm run whatsapp:close -- <concernId|all> [resolve|acknowledge]');
  process.exit(1);
}

await connect();

const targets = idArg === 'all'
  ? await concerns().find({ status: { $in: FROM[action] } }).toArray()
  : [await concerns().findOne({ _id: toId(idArg) })].filter(Boolean);

if (targets.length === 0) {
  console.log(idArg === 'all' ? `Nothing to ${action}.` : `No concern "${idArg}".`);
} else {
  for (const c of targets) {
    const res = await concerns().updateOne(
      { _id: c._id, status: { $in: FROM[action] } },
      { $set: { status: STATUS[action], [STAMP[action]]: new Date(), [`${STAMP[action]}By`]: 'cli' } },
    );
    console.log(
      res.modifiedCount
        ? `${STATUS[action]}: ${c.summary}`
        : `already ${c.status}, left alone: ${c.summary}`,
    );
  }
}

await close();

function toId(value) {
  try {
    return new ObjectId(value);
  } catch {
    console.error(`"${value}" is not a concern id - copy the id= from \`npm run whatsapp:concerns\`.`);
    process.exit(1);
  }
}
