/**
 * Runs the summarisers now, instead of waiting for their cron.
 *
 *   npm run whatsapp:summarise             # rolling only
 *   npm run whatsapp:summarise -- daily    # daily only
 *   npm run whatsapp:summarise -- both
 */
import { connect, close } from '../src/whatsapp-monitor/db.js';
import { runRollingSummaries, runDailySummaries } from '../src/whatsapp-monitor/summariser/summarise.js';

const which = process.argv[2] ?? 'rolling';
await connect();

if (which === 'rolling' || which === 'both') console.log(`rolling written: ${await runRollingSummaries()}`);
if (which === 'daily' || which === 'both') console.log(`daily written:   ${await runDailySummaries()}`);
if (!['rolling', 'daily', 'both'].includes(which)) console.error(`unknown argument "${which}" — use rolling, daily or both`);

await close();
