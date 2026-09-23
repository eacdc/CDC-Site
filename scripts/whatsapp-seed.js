/**
 * Creates the WhatsApp-monitor indexes (including the 60-day TTL) and imports
 * every group the CDC number belongs to, all left monitored:false.
 * Safe to re-run — only the group name is overwritten.
 *
 * The same import the Refresh button in Admin runs.
 */
import { connect, ensureIndexes, close } from '../src/whatsapp-monitor/db.js';
import { importGroups } from '../src/whatsapp-monitor/maytapi/import.js';

await connect();
await ensureIndexes();

const { found, added, renamed, missing } = await importGroups();
console.log(`maytapi returned ${found} group(s)`);

for (const g of added) console.log(`  new      ${g.id}  ${g.name}`);
for (const g of renamed) console.log(`  renamed  ${g.id}  ${g.from} -> ${g.to}`);
for (const g of missing) {
  console.log(`  missing  ${g.id}  ${g.name}${g.monitored ? '  [MONITORED - it will never see another message]' : ''}`);
}
if (added.length === 0 && renamed.length === 0) console.log('  nothing new');

console.log('\nTurn one on with:  npm run whatsapp:groups -- "<groupId>" on');
await close();
