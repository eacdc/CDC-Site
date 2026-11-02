import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';

let client = null;

/**
 * Transcribes a voice note with OpenAI Whisper.
 *
 * Kept on OpenAI whichever provider reads the text, because Claude does not
 * take audio. Both providers call this, so switching LLM_PROVIDER never turns
 * transcription off.
 *
 * `audio` is the raw bytes and `filename` carries the extension, which is how
 * the API knows the format - WhatsApp sends .oga (audio/ogg, opus), which it
 * accepts directly, so nothing is transcoded.
 *
 * No fallback model: a failed transcription leaves the message reading
 * "[voice message]", which is the same as before this existed.
 */
export async function transcribe(audio, filename) {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required to transcribe voice notes (TRANSCRIBE_VOICE=true)');
    client = new OpenAI({ apiKey });
  }
  const model = config.llm.transcribeModel;
  const res = await client.audio.transcriptions.create({
    model,
    file: await toFile(audio, filename),
  });
  return { text: typeof res?.text === 'string' ? res.text.trim() : '', model };
}
