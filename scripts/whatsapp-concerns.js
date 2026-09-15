/**
 * Lists concerns so their state can be seen without opening Mongo.
 *
 *   npm run whatsapp:concerns            # open + acknowledged
 *   npm run whatsapp:concerns -- all     # including resolved
 */
import { connect, concerns, groups, close } from '../src/whatsapp-monitor/db.js';

const showAll = process.argv[2] === 'all';
await connect();

const query = showAll ? {} : { status: { $in: ['open', 'acknowledged'] } };
const rows = await concerns().find(query).sort({ createdAt: -1 }).limit(50).toArray();

if (rows.length === 0) {
  console.log(showAll ? 'No concerns yet.' : 'No open or acknowledged concerns.');
} else {
  const names = new Map(
    (await groups().find({ _id: { $in: [...new Set(rows.map((r) => r.groupId))] } }).toArray())
      .map((g) => [g._id, g.name]),
  );
  for (const c of rows) {
    const age = Math.round((Date.now() - c.createdAt.getTime()) / 60_000);
    const esc = c.escalatedTo?.length ? ` escalated->${c.escalatedTo.join(',')}` : '';

    // The dashboard shows these; without them the list looks like nine equally
    // live problems when two of them already read as fixed.
    const flags = [
      c.status === 'open' && c.resolutionHint ? 'possibly resolved' : null,
      c.backfilledAt ? 'from history, silent' : null,
    ].filter(Boolean);
    const label = [c.status, ...flags].join(' - ');

    console.log(
      `[${label.padEnd(12)}] ${c.severity.padEnd(6)} ${c.category.padEnd(20)} ${age}m ago` +
        `\n    ${names.get(c.groupId) ?? c.groupId}: ${c.summary}` +
        `\n    id=${c._id} owner=${c.ownerId ?? 'NOBODY'}${esc}` +
        (c.resolutionHint?.text ? `\n    looks fixed: "${c.resolutionHint.text}"` : ''),
    );
  }
}
await close();
