/**
 * Prints the latest summaries so they can be read without a dashboard.
 *
 *   npm run whatsapp:summaries             # newest per group, both kinds
 */
import { connect, summaries, groups, close } from '../src/whatsapp-monitor/db.js';

await connect();
const rows = await summaries().find({}).sort({ periodEnd: -1 }).limit(20).toArray();

if (rows.length === 0) {
  console.log('No summaries yet. Run `npm run whatsapp:summarise -- both`.');
} else {
  const names = new Map(
    (await groups().find({ _id: { $in: [...new Set(rows.map((r) => r.groupId))] } }).toArray())
      .map((g) => [g._id, g.name]),
  );
  for (const s of rows) {
    console.log(`\n=== ${names.get(s.groupId) ?? s.groupId} · ${s.kind}${s.dayKey ? ` ${s.dayKey}` : ''} ===`);
    console.log(`    ${s.messageCount} messages, ${s.model}, to ${s.periodEnd.toISOString()}`);
    for (const [label, key] of [['Decisions', 'decisions'], ['Open', 'openIssues'], ['Blocked', 'blocked'], ['Notable', 'notable']]) {
      for (const b of s.bullets?.[key] ?? []) console.log(`    ${label.padEnd(9)} ${b}`);
    }
  }
}
await close();
