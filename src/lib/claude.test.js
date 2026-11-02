/**
 * lib/claude.js — the request shape, the checks on the reply, and the image
 * handling, against a fake SDK client. No key, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  ask, askJson, askText, parseJson, envModel, mediaBlock, ClaudeError, setClaudeClientForTests,
} from './claude.js';

/** A fake client that records every request and answers with `reply`. */
function fakeClient(reply) {
  const calls = [];
  const stream = (kind) => (params) => {
    calls.push({ kind, params });
    return { finalMessage: async () => ({ model: params.model, usage: { input_tokens: 1, output_tokens: 1 }, ...reply }) };
  };
  return { calls, messages: { stream: stream('ga') }, beta: { messages: { stream: stream('beta') } } };
}

const textReply = (text, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra });

test.afterEach(() => setClaudeClientForTests(null));

test('Haiku goes to the plain endpoint; Sonnet and Opus get the server-side fallback', async () => {
  const fake = fakeClient(textReply('ok'));
  setClaudeClientForTests(fake);

  await ask({ model: 'claude-haiku-5-5', content: 'hi' });
  await ask({ model: 'claude-sonnet-5-5', content: 'hi' });
  await ask({ model: 'claude-opus-5-5', content: 'hi' });

  assert.equal(fake.calls[0].kind, 'ga');
  assert.equal(fake.calls[0].params.fallbacks, undefined);
  for (const call of fake.calls.slice(1)) {
    assert.equal(call.kind, 'beta');
    assert.equal(call.params.fallbacks, 'default');
    assert.deepEqual(call.params.betas, ['server-side-fallback-2026-07-01']);
  }
});

test('effort and schema travel in output_config; no sampling parameters are sent', async () => {
  const fake = fakeClient(textReply('{"a":1}'));
  setClaudeClientForTests(fake);

  const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } }, required: ['a'] };
  const { data } = await askJson({ model: 'claude-haiku-5-5', content: 'x', effort: 'low', schema, system: 'S' });

  const { params } = fake.calls[0];
  assert.deepEqual(data, { a: 1 });
  assert.deepEqual(params.output_config, { effort: 'low', format: { type: 'json_schema', schema } });
  assert.equal(params.system, 'S');
  assert.equal(params.temperature, undefined);
  assert.deepEqual(params.messages, [{ role: 'user', content: 'x' }]);
});

test('without a schema, the system prompt is told to answer in JSON only', async () => {
  const fake = fakeClient(textReply('Here it is:\n{"b":2}'));
  setClaudeClientForTests(fake);

  const { data } = await askJson({ model: 'claude-haiku-5-5', content: 'x', system: 'Extract.' });
  assert.deepEqual(data, { b: 2 });
  assert.match(fake.calls[0].params.system, /^Extract\.\n\nReply with a single JSON object/);
  assert.equal(fake.calls[0].params.output_config, undefined);
});

test('a refusal and a cut-off reply are errors, never partial answers', async () => {
  setClaudeClientForTests(fakeClient(textReply('', { stop_reason: 'refusal', stop_details: { category: 'cyber' } })));
  await assert.rejects(ask({ model: 'claude-haiku-5-5', content: 'x' }), (err) => {
    assert.ok(err instanceof ClaudeError);
    assert.match(err.message, /declined.*cyber/);
    return true;
  });

  setClaudeClientForTests(fakeClient(textReply('{"lines":[', { stop_reason: 'max_tokens' })));
  await assert.rejects(ask({ model: 'claude-haiku-5-5', content: 'x', maxTokens: 100 }), /cut off at 100/);
});

test('askText ignores thinking blocks and rejects an empty answer', async () => {
  setClaudeClientForTests(fakeClient({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' hello ' }],
  }));
  assert.equal((await askText({ model: 'claude-haiku-5-5', content: 'x' })).text, 'hello');

  setClaudeClientForTests(fakeClient({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] }));
  await assert.rejects(askText({ model: 'claude-haiku-5-5', content: 'x' }), /Empty reply/);
});

test('parseJson tolerates fences and a sentence before the object', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure - {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => parseJson('no json here'), ClaudeError);
});

test('envModel honours claude ids and skips the OpenAI-era ones', () => {
  process.env.TEST_MODEL_A = 'gpt-4o';
  process.env.TEST_MODEL_B = 'claude-opus-5-5';
  try {
    assert.equal(envModel('TEST_MODEL_A', 'claude-haiku-5-5'), 'claude-haiku-5-5');
    assert.equal(envModel(['TEST_MODEL_A', 'TEST_MODEL_B'], 'claude-haiku-5-5'), 'claude-opus-5-5');
    assert.equal(envModel('TEST_MODEL_UNSET', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
  } finally {
    delete process.env.TEST_MODEL_A;
    delete process.env.TEST_MODEL_B;
  }
});

test('mediaBlock: PDFs become documents, odd image types are re-encoded to JPEG', async () => {
  const pdf = await mediaBlock(Buffer.from('%PDF-1.7 ...'));
  assert.equal(pdf.type, 'document');
  assert.equal(pdf.source.media_type, 'application/pdf');

  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  const fromDataUrl = await mediaBlock(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(fromDataUrl.type, 'image');
  assert.equal(fromDataUrl.source.media_type, 'image/png');

  const tiff = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).tiff().toBuffer();
  const converted = await mediaBlock(tiff, 'image/tiff');
  assert.equal(converted.source.media_type, 'image/jpeg');
});
