/**
 * Lets failed transcriptions be tried again.
 *
 *   npm run whatsapp:retry-transcripts
 *
 * A failure stamps transcriptAttemptedAt so the same unreadable clip is never
 * re-downloaded and re-billed every five minutes for sixty days. That is the
 * right default, and it means fixing the cause - a wrong model, an expired
 * media URL, a network blip - does not on its own bring those messages back.
 * This clears the stamp so the next poll or catch-up picks them up.
 *
 * Only ever touches failures: a message that already has a transcript is left
 * exactly as it is.
 */
import { connect, messages, close } from '../src/whatsapp-monitor/db.js';

await connect();

const failed = { transcriptError: { $exists: true }, transcript: { $exists: false } };
const pending = await messages().find(failed).toArray();

if (pending.length === 0) {
  console.log('No failed transcriptions to retry.');
} else {
  // Worth showing: if they all failed the same way, the cause is one thing.
  const reasons = new Map();
  for (const m of pending) reasons.set(m.transcriptError, (reasons.get(m.transcriptError) ?? 0) + 1);
  console.log(`${pending.length} failed transcription(s):`);
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }

  const res = await messages().updateMany(failed, {
    $unset: { transcriptAttemptedAt: '', transcriptError: '' },
  });
  console.log(`\nCleared ${res.modifiedCount}. The next poll or catch-up will try them again.`);
  console.log('Check LLM_MODEL_TRANSCRIBE is whisper-1 first - the gpt-4o models cannot read Ogg.');
}

await close();
