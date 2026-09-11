/** One full cycle — fetch, classify, alert — then exit. */
import { connect, ensureIndexes, close } from '../src/whatsapp-monitor/db.js';
import { runPoll } from '../src/whatsapp-monitor/poller/poll.js';

await connect();
await ensureIndexes();
console.log(JSON.stringify(await runPoll(), null, 2));
await close();
