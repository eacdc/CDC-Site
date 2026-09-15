import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMessages, VOICE_TYPES } from './maytapi/normalise.js';

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
