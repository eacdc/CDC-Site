import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMessages, VOICE_TYPES } from './maytapi/normalise.js';
import { needsRomanising } from './media/romanise.js';

/**
 * Taken verbatim from `npm run whatsapp:media-probe` against CDC Maintenance,
 * with the real ids and captions kept. The media fields were a guess until this
 * payload existed; pinning it is what stops them drifting back to one.
 */
const PROBE = {
  data: {
    users: { '919000000001@c.us': { name: 'Rana Da Punch Cdc' } },
    messages: [
      {
        timestamp: 1789480000,
        uid: '919000000001@c.us',
        fromMe: false,
        message: {
          type: 'image',
          url: 'https://cdnydm.com/wh_new/YB2EyQXsxWhyVwYO8_Fn8ATyn4Tf0ijfP3GNGELYyqw.jpeg',
          mime: 'image/jpeg',
          filename: 'false_919830312721-1551352436@g.us_ACF4D6.jpeg',
          caption: 'Lift stop please solve it',
          id: 'IMG_WITH_CAPTION',
          _serialized: 'IMG_WITH_CAPTION',
        },
      },
      {
        timestamp: 1789480100,
        uid: '919000000001@c.us',
        fromMe: false,
        message: {
          type: 'ptt',
          url: 'https://cdnydm.com/wh_new/nqYmSDvX7HgS62eqlYA-tqC0iJqTJUTAEiytFQ-yUb0.oga',
          mime: 'audio/ogg; codecs=opus',
          filename: 'false_919830312721-1551352436@g.us_AC7C90.oga',
          caption: '',
          id: 'VOICE',
          _serialized: 'VOICE',
        },
      },
      {
        timestamp: 1789480200,
        uid: '919000000001@c.us',
        fromMe: false,
        message: {
          type: 'video',
          url: 'https://cdnydm.com/wh_new/jHGTf9Clch8atPoolRZ-d8-5iIFMZ0g7yCh8kA8pIuc.mp4',
          mime: 'video/mp4',
          filename: 'false_919830312721-1551352436@g.us_ACF3EE.mp4',
          caption: 'CD 2 registration error . @218137714786450',
          id: 'VIDEO_WITH_CAPTION',
          _serialized: 'VIDEO_WITH_CAPTION',
        },
      },
      {
        timestamp: 1789480300,
        uid: '919000000001@c.us',
        fromMe: false,
        message: { type: 'image', url: 'https://cdnydm.com/x.jpeg', mime: 'image/jpeg', id: 'IMG_BARE', _serialized: 'IMG_BARE' },
      },
    ],
  },
};

const byId = () => new Map(normaliseMessages(PROBE).map((m) => [m.msgId, m]));

test('a caption is the message text, media or not', () => {
  assert.equal(byId().get('IMG_WITH_CAPTION').text, 'Lift stop please solve it');
  assert.equal(byId().get('VIDEO_WITH_CAPTION').text, 'CD 2 registration error . @218137714786450');
});

test('media with no caption gets a placeholder rather than vanishing', () => {
  // An empty string caption - which is what a voice note really sends - must
  // count as absent, or the placeholder never applies.
  assert.equal(byId().get('VOICE').text, '[voice message]');
  assert.equal(byId().get('IMG_BARE').text, '[image]');
});

test('the media url and mime are read from the fields Maytapi actually sends', () => {
  const voice = byId().get('VOICE');
  assert.equal(voice.mediaUrl, 'https://cdnydm.com/wh_new/nqYmSDvX7HgS62eqlYA-tqC0iJqTJUTAEiytFQ-yUb0.oga');
  assert.equal(voice.mime, 'audio/ogg; codecs=opus');
  assert.equal(voice.isMedia, true);
});

test('a text message is not marked as media and keeps an empty text', () => {
  const out = normaliseMessages({
    data: { users: {}, messages: [{ timestamp: 1789480000, uid: 'u', message: { type: 'text', text: '', id: 'T', _serialized: 'T' } }] },
  });
  assert.equal(out[0].text, '');
  assert.equal(out[0].isMedia, false);
});

test('both voice types are recognised', () => {
  // A recorded note is ptt; a forwarded audio file is audio.
  assert.ok(VOICE_TYPES.has('ptt'));
  assert.ok(VOICE_TYPES.has('audio'));
  assert.ok(!VOICE_TYPES.has('video'));
});

test('an unknown media type still gets a readable placeholder', () => {
  const out = normaliseMessages({
    data: { users: {}, messages: [{ timestamp: 1789480000, uid: 'u', message: { type: 'contact_card', url: 'https://x/y', id: 'C', _serialized: 'C' } }] },
  });
  assert.equal(out[0].text, '[contact_card]');
});

test('system rows are still dropped, placeholders or not', () => {
  const out = normaliseMessages({
    data: { users: {}, messages: [{ timestamp: 1789480000, uid: 'u', message: { type: 'info', id: 'I', _serialized: 'I' } }] },
  });
  assert.deepEqual(out, []);
});

// --- the transcription model ----------------------------------------------

test('the transcription model can actually read WhatsApp audio', async () => {
  // WhatsApp sends Ogg/Opus (.oga). Only some models accept it:
  //
  //   gpt-4o-transcribe, gpt-4o-mini-transcribe:
  //       mp3, mp4, mpeg, mpga, m4a, wav, webm        <- no ogg, no oga
  //   whisper-1:
  //       flac, oga, ogg + all of the above
  //
  // Defaulting to a gpt-4o model returned "400 Unsupported file format oga" on
  // every voice note - it reads none of our audio at all. This test exists so
  // that switching to the newer, cheaper-looking model fails here rather than
  // silently going deaf in production.
  const { config } = await import('./config.js');
  const READS_OGG = new Set(['whisper-1']);

  assert.ok(
    READS_OGG.has(config.llm.transcribeModel),
    `LLM_MODEL_TRANSCRIBE is "${config.llm.transcribeModel}", which cannot read Ogg/Opus. ` +
      `Use one of: ${[...READS_OGG].join(', ')}.`,
  );
});

// --- romanising transcripts -----------------------------------------------
//
// Whisper writes in the script of the language. The floor types romanised, and
// detector/prompt.md was tuned entirely on romanised Hindi and Bengali, so a
// native-script transcript is the one input the classifier never saw.

test('a Bengali transcript is sent to be romanised', () => {
  assert.equal(needsRomanising('আমি ভাত খাবো'), true);
});

test('Devanagari and Gujarati too', () => {
  // Gujarati matters for Ahmedabad, and the rule covers it without naming it.
  assert.equal(needsRomanising('मशीन बंद है'), true);
  assert.equal(needsRomanising('મશીન બંધ છે'), true);
});

test('a sentence already in Latin is left exactly alone', () => {
  // Nothing to transliterate, and a round trip through a model can only
  // misspell it - "bondho" is not a word it has any reason to preserve.
  assert.equal(needsRomanising('machine bondho hai, Kolbus stopped'), false);
});

test('accents and punctuation are not another script', () => {
  assert.equal(needsRomanising('café — ok'), false);
});

test('an emoji does not send a good sentence off to be rewritten', () => {
  // The rule is "any letter that is not Latin". An emoji is not a letter, and
  // rewriting the line risks losing it for nothing.
  assert.equal(needsRomanising('machine down 🔧'), false);
  assert.equal(needsRomanising('cost Rs 500 ₹'), false);
});

test('one non-Latin word in an English sentence is enough', () => {
  assert.equal(needsRomanising('machine বন্ধ'), true);
});

test('romanising can be switched off without a code change', () => {
  assert.equal(needsRomanising('আমি ভাত খাবো', false), false);
});

test('empty and whitespace transcripts are never sent', () => {
  assert.equal(needsRomanising('   '), false);
  assert.equal(needsRomanising(''), false);
  assert.equal(needsRomanising(null), false);
});
