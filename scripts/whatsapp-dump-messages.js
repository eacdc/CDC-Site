/**
 * Prints the RAW getMessages response for one conversation, so the field names
 * in maytapi/normalise.js can be checked against reality.
 *
 *   npm run whatsapp:dump-messages -- "<conversationId>" > dump.json
 */
import { maytapi } from '../src/whatsapp-monitor/maytapi/client.js';

const id = process.argv[2];
if (!id) {
  console.error('usage: npm run whatsapp:dump-messages -- "<conversationId>"');
  process.exit(1);
}
console.log(JSON.stringify(await maytapi.getMessages(id), null, 2));
