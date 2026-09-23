/**
 * Removes a group and its stored messages.
 *
 *   npm run whatsapp:delete-group -- "<groupId>"
 *   npm run whatsapp:delete-group -- "<groupId>" --force
 *
 * Its concerns, their alerts and the summaries stay: those are the record of
 * what happened and who was told, while the messages are the bulk of the
 * storage. Refresh from WhatsApp pulls the group back - off, with no owner and
 * no ladder - so this is a tidy-up rather than something final.
 *
 * Refuses while concerns are still open or acknowledged. `--force` overrides
 * it, and lives here rather than in the browser on purpose: the escape hatch
 * should take a deliberate act, not a second tap on a phone.
 */
import { connect, groups, messages, concerns, close } from '../src/whatsapp-monitor/db.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const groupId = args.find((a) => !a.startsWith('--'));

if (!groupId) {
  console.error('usage: npm run whatsapp:delete-group -- "<groupId>" [--force]');
  process.exit(1);
}

await connect();

const group = await groups().findOne({ _id: groupId });
if (!group) {
  console.error(`No group "${groupId}". Run \`npm run whatsapp:groups\` to list them.`);
  await close();
  process.exit(1);
}

const live = await concerns().countDocuments({
  groupId: group._id,
  status: { $in: ['open', 'acknowledged'] },
});

if (live > 0 && !force) {
  console.error(
    `${group.name} still has ${live} open concern(s).\n` +
      'Resolve them first, or re-run with --force to delete the group anyway.\n' +
      'The concerns themselves are kept either way.',
  );
  await close();
  process.exit(1);
}

const { deletedCount } = await messages().deleteMany({ groupId: group._id });
await groups().deleteOne({ _id: group._id });

console.log(`Deleted ${group.name} and ${deletedCount} message(s).`);
if (live > 0) console.log(`${live} concern(s) kept - they now show the raw group id.`);
console.log('Press Refresh from WhatsApp in Admin to pull it back.');

await close();
