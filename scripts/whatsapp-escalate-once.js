/**
 * Runs one acknowledgement + escalation pass now, instead of waiting for the
 * next poll. Sends real DMs — this is the live path, not a dry run.
 *
 * To test escalation without waiting half an hour, set
 * DEFAULT_ESCALATE_AFTER_MIN=1 in .env first.
 */
import { connect, close } from '../src/whatsapp-monitor/db.js';
import { runAckPoll } from '../src/whatsapp-monitor/router/acknowledge.js';
import { runEscalations } from '../src/whatsapp-monitor/router/escalate.js';

await connect();
// Same order as the poll cycle: a concern acknowledged now must not then be
// escalated for being unacknowledged.
console.log(`acknowledged: ${await runAckPoll()}`);
console.log(`escalated:    ${await runEscalations()}`);
await close();
