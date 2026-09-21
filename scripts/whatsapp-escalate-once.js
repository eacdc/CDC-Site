/**
 * Runs one acknowledgement + first-alert + escalation pass now, instead of
 * waiting for the next poll. Sends real DMs — this is the live path, not a dry
 * run.
 *
 * To test without waiting half an hour, set ALERT_AFTER_MIN_INTERNAL=1 and
 * DEFAULT_ESCALATE_AFTER_MIN=1 in .env first.
 */
import { connect, close } from '../src/whatsapp-monitor/db.js';
import { runAckPoll } from '../src/whatsapp-monitor/router/acknowledge.js';
import { runEscalations } from '../src/whatsapp-monitor/router/escalate.js';
import { runFirstAlerts } from '../src/whatsapp-monitor/router/first-alert.js';

await connect();
// Same order as the poll cycle: a concern acknowledged now must not then be
// escalated for being unacknowledged.
console.log(`acknowledged: ${await runAckPoll()}`);
console.log(`first alerts: ${await runFirstAlerts()}`);
console.log(`escalated:    ${await runEscalations()}`);
await close();
