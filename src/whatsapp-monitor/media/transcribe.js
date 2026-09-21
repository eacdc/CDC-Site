import { config } from '../config.js';
import { logger } from '../logger.js';
import { messages, groups } from '../db.js';
import { llm } from '../llm/index.js';
import { romanise } from './romanise.js';
import { VOICE_TYPES } from '../maytapi/normalise.js';

/**
 * Turns voice notes into text so the rest of the pipeline can read them.
 *
 * A voice note has no text, and every consumer drops empty text, so an entire
 * report arriving by voice is invisible - and in CDC Maintenance the replies
 * ("Solved...", "engineer coming tomorrow") are replies TO those voice notes,
 * which makes the voice note the root of the thread. Deaf at the root means
 * deaf to the whole conversation.
 *
 * The transcript becomes the message `text`, so classification, threading,
 * summaries and the resolution check all work unchanged.
 *
 * Off by default: this sends staff voice recordings to OpenAI.
 */
export async function runTranscriptions(group) {
  if (!config.transcription.enabled) return 0;
  // Per-group opt-out, so one group can be excluded without an env change.
  if (group.transcribeVoice === false) return 0;

  let done = 0;

  try {
    const pending = await messages()
      .find({
        groupId: group._id,
        type: { $in: [...VOICE_TYPES] },
        mediaUrl: { $ne: null },
        transcriptAttemptedAt: { $exists: false },
      })
      .sort({ ts: 1 })
      .limit(config.transcription.maxPerRun)
      .toArray();

    for (const message of pending) {
      if (await transcribeOne(message)) done += 1;
    }
  } catch (err) {
    logger.error({ groupId: group._id, err: String(err) }, 'transcription pass failed');
  }

  return done;
}

/** Never throws: a voice note we cannot read must not stop the poll. */
async function transcribeOne(message) {
  const attemptedAt = new Date();

  try {
    const audio = await download(message.mediaUrl);

    const { text: heard, model } = await llm().transcribe(audio, filenameFor(message));
    if (!heard) throw new Error('transcription came back empty');

    // Whisper writes in the script of the language. The floor types romanised
    // and the classifier was tuned on romanised, so the transcript is rewritten
    // into the Latin alphabet before it is stored. If that fails it returns
    // what it was given - a message in the wrong script beats no message.
    const text = await romanise(heard);

    await messages().updateOne(
      { msgId: message.msgId },
      {
        $set: {
          text,
          transcript: text,
          transcriptModel: model,
          transcriptAt: new Date(),
          transcriptAttemptedAt: attemptedAt,
          // A transcript is new content, so it has to be judged even if the
          // placeholder row was already classified in an earlier cycle.
          classified: false,
        },
      },
    );

    logger.info(
      {
        msgId: message.msgId,
        groupId: message.groupId,
        model,
        chars: text.length,
        romanised: text !== heard,
      },
      'voice note transcribed',
    );
    return true;
  } catch (err) {
    const detail = String(err?.message ?? err);

    // Stamped on failure too. Retrying forever would re-download and re-bill the
    // same unreadable clip every five minutes for sixty days.
    await messages().updateOne(
      { msgId: message.msgId },
      { $set: { transcriptAttemptedAt: attemptedAt, transcriptError: detail } },
    );

    // A bare "400 Unsupported file format oga" does not tell an operator what
    // to do, and this one has a single cause and a one-line fix.
    if (/unsupported file format|does not support the format/i.test(detail)) {
      logger.error(
        { msgId: message.msgId, model: config.llm.transcribeModel, err: detail },
        'transcription model cannot read WhatsApp audio (Ogg/Opus) - set LLM_MODEL_TRANSCRIBE=whisper-1, ' +
          'then run `npm run whatsapp:retry-transcripts`',
      );
    } else {
      logger.warn(
        { msgId: message.msgId, groupId: message.groupId, err: detail },
        'could not transcribe voice note - it keeps its [voice message] placeholder',
      );
    }
    return false;
  }
}

/**
 * Fetches the media.
 *
 * Deliberately no `x-maytapi-key`: the probe showed the URLs are public, and
 * sending the header made the response content-type `application/octet-stream`
 * instead of `audio/ogg`.
 */
async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.transcription.downloadTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`media download returned HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > config.transcription.maxBytes) {
      throw new Error(`clip is ${buffer.byteLength} bytes, over the limit`);
    }
    if (buffer.byteLength === 0) throw new Error('media download was empty');

    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The API reads the format from the extension. WhatsApp's own filename carries
 * the group id, so a plain one is used instead - it only has to end in the
 * right thing.
 */
function filenameFor(message) {
  const fromMaytapi = (message.filename ?? '').match(/\.([a-z0-9]{1,5})$/i);
  const ext = fromMaytapi ? fromMaytapi[1].toLowerCase() : 'oga';
  return `voice.${ext}`;
}
