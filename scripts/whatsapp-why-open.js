/**
 * Explains why an open concern is not flagged "possibly resolved".
 *
 *   npm run whatsapp:why-open                    # every open concern
 *   npm run whatsapp:why-open -- <concernId>
 *   npm run whatsapp:why-open -- <concernId|all> --recheck
 *
 * Read-only unless --recheck is passed, which clears `resolutionCheckedMsgId`
 * so the next poll cycle asks the model again. That matters because a "not
 * resolved" verdict is sticky: the cursor is stamped on a no as well as a yes,
 * so one wrong answer stands until somebody says something new in the thread.
 *
 * Ids come from `npm run whatsapp:concerns`, or from the dashboard URL.
 */
import { ObjectId } from 'mongodb';
import { connect, concerns, messages, close } from '../src/whatsapp-monitor/db.js';
import { threadQueryFor } from '../src/whatsapp-monitor/detector/threads.js';

const args = process.argv.slice(2);
const recheck = args.includes('--recheck');
const idArg = args.find((a) => !a.startsWith('--')) ?? 'all';

await connect();

const targets = idArg === 'all'
  ? await concerns().find({ status: 'open' }).sort({ createdAt: -1 }).toArray()
  : [await concerns().findOne({ _id: toId(idArg) })].filter(Boolean);

if (targets.length === 0) {
  console.log(idArg === 'all' ? 'No open concerns.' : `No concern "${idArg}".`);
}

for (const c of targets) {
  const roots = c.threadRootIds ?? [];
  const cited = c.messageIds ?? [];

  // Both candidate queries, run side by side, because the whole question is
  // whether they disagree.
  const byRoots = roots.length
    ? await messages().find({ groupId: c.groupId, threadRootId: { $in: roots } }).sort({ ts: 1 }).toArray()
    : [];
  const byCited = await messages().find({ msgId: { $in: cited } }).sort({ ts: 1 }).toArray();

  const thread = await messages().find(threadQueryFor(c)).sort({ ts: 1 }).toArray();
  const withText = thread.filter((m) => (m.text ?? '').trim().length > 0);
  const newest = withText[withText.length - 1] ?? null;

  console.log(`\n${'-'.repeat(70)}`);
  console.log(c.summary);
  console.log(`  id=${c._id}  status=${c.status}  group=${c.groupId}`);
  console.log(`  threadRootIds: ${roots.length ? roots.join(', ') : '(none - falls back to messageIds)'}`);
  console.log(`  messageIds:    ${cited.length ? cited.join(', ') : '(none)'}`);
  console.log(`  messages found by roots:  ${byRoots.length}`);
  console.log(`  messages found by cited:  ${byCited.length}`);
  console.log(`  thread used now:          ${thread.length} (${withText.length} with text)`);

  const unstamped = thread.filter((m) => !m.threadRootId).length;
  if (unstamped) console.log(`  ${unstamped} of them have no threadRootId - run whatsapp:backfill-threads`);

  for (const m of withText.slice(-6)) {
    console.log(`    [${m.ts.toISOString().slice(5, 16).replace('T', ' ')}] ${m.senderName}: ${oneLine(m.text)}`);
  }

  console.log(`  resolutionHint:        ${c.resolutionHint ? `"${oneLine(c.resolutionHint.text ?? '')}" (${c.resolutionHint.reason})` : 'none'}`);
  console.log(`  resolutionCheckedMsgId: ${c.resolutionCheckedMsgId ?? 'never checked'}`);
  console.log(`  newest text message:    ${newest ? newest.msgId : '(none)'}`);

  console.log(`  => ${verdict(c, withText, newest)}`);

  if (recheck && c.resolutionCheckedMsgId) {
    await concerns().updateOne({ _id: c._id }, { $unset: { resolutionCheckedMsgId: '' } });
    console.log('  --recheck: cursor cleared, the next poll cycle will ask again.');
  }
}

await close();

function verdict(c, withText, newest) {
  if (withText.length === 0) return 'the checker skips this one: no readable messages in its thread.';
  if (c.resolutionHint) return 'already flagged possibly resolved.';
  if (c.resolutionCheckedMsgId === newest.msgId) {
    return 'checked already, and the model said not resolved. Nothing new has been said since, '
      + 'so it will not ask again - pass --recheck to make it.';
  }
  return 'due for a check on the next poll cycle.';
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
}

function toId(value) {
  try {
    return new ObjectId(value);
  } catch {
    console.error(`"${value}" is not a concern id - copy the id= from \`npm run whatsapp:concerns\`.`);
    process.exit(1);
  }
}
