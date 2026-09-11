/**
 * Runs the detector over a group's unclassified messages now, instead of
 * waiting for the next poll. Sends real alerts — this is the live path.
 *
 *   npm run whatsapp:classify-once -- "<groupId>"
 */
import { connect, groups, close } from '../src/whatsapp-monitor/db.js';
import { detectForGroup } from '../src/whatsapp-monitor/detector/detect.js';

const groupId = process.argv[2];
if (!groupId) {
  console.error('usage: npm run whatsapp:classify-once -- "<groupId>"');
  process.exit(1);
}

await connect();
const group = await groups().findOne({ _id: groupId });
if (!group) {
  console.error(`No group "${groupId}". Run \`npm run whatsapp:groups\` to list them.`);
  await close();
  process.exit(1);
}

console.log(`\n${await detectForGroup(group)} new concern(s) raised.`);
await close();
