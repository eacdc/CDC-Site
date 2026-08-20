/**
 * Models that will not accept a temperature.
 *
 * `temperature: 0` was hardcoded on every OpenAI call. Reasoning models accept
 * only their default and answer anything else with
 * `400 Unsupported value: 'temperature' does not support 0 with this model`,
 * so pointing SP_EXTRACTION_MODEL at one of them broke every extraction and
 * every adjudication at once, with no way forward but reverting the model.
 *
 * The provider now finds out for itself rather than being told. What these
 * pin is the shape of that: ask once, remember the refusal, and never mistake
 * an unrelated 400 for this one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withTemperatureFallback, isTemperatureRefusal } from '../services/extraction/openai-provider.js';

/** The refusal exactly as the API sends it. */
function temperatureError() {
  return Object.assign(
    new Error("400 Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported."),
    { status: 400 },
  );
}

/** A model that accepts anything, recording what it was sent. */
function acceptingModel(calls) {
  return async (body) => { calls.push(body); return { ok: true, body }; };
}

/** A model that refuses temperature, as the reasoning models do. */
function refusingModel(calls) {
  return async (body) => {
    calls.push(body);
    if ('temperature' in body) throw temperatureError();
    return { ok: true, body };
  };
}

test('a model that accepts temperature is sent 0, for repeatability', () => {
  // Determinism is the point: the same quote read twice must produce the same
  // rates. Temperature 0 is still asked for wherever it is welcome.
  const calls = [];
  return withTemperatureFallback('gpt-4o', { messages: [] }, acceptingModel(calls), new Set())
    .then(() => {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].temperature, 0);
    });
});

test('a model that refuses it is retried without it, and still answers', async () => {
  const calls = [];
  const result = await withTemperatureFallback(
    'reasoning-model', { messages: [] }, refusingModel(calls), new Set(),
  );

  assert.equal(result.ok, true, 'the call succeeds rather than failing the document');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].temperature, 0);
  assert.equal('temperature' in calls[1], false);
});

test('the refusal is remembered, so only the first call pays for it', async () => {
  const seen = new Set();
  const calls = [];
  const send = refusingModel(calls);

  await withTemperatureFallback('reasoning-model', { messages: [] }, send, seen);
  await withTemperatureFallback('reasoning-model', { messages: [] }, send, seen);
  await withTemperatureFallback('reasoning-model', { messages: [] }, send, seen);

  // 2 for the first call, then 1 each. Not 6.
  assert.equal(calls.length, 4);
  assert.equal('temperature' in calls[2], false);
  assert.equal('temperature' in calls[3], false);
});

test('one model refusing does not disarm another', async () => {
  const seen = new Set();
  const calls = [];

  await withTemperatureFallback('reasoning-model', { messages: [] }, refusingModel(calls), seen);
  calls.length = 0;
  await withTemperatureFallback('gpt-4o', { messages: [] }, acceptingModel(calls), seen);

  assert.equal(calls[0].temperature, 0, 'gpt-4o still gets a deterministic read');
});

test('an unrelated 400 is raised, not retried', async () => {
  // A bad model id, a malformed message and an oversized image are all 400s.
  // Retrying those without temperature turns one clear error into two
  // confusing ones, and hides the real cause.
  const calls = [];
  const send = async (body) => {
    calls.push(body);
    throw Object.assign(new Error('400 The model `gtp-4o` does not exist'), { status: 400 });
  };

  await assert.rejects(
    () => withTemperatureFallback('gtp-4o', { messages: [] }, send, new Set()),
    /does not exist/,
  );
  assert.equal(calls.length, 1, 'no pointless second call');
});

test('a rate limit or server error is raised untouched', async () => {
  const send = async () => { throw Object.assign(new Error('429 Rate limit reached'), { status: 429 }); };
  await assert.rejects(
    () => withTemperatureFallback('gpt-4o', { messages: [] }, send, new Set()),
    /Rate limit/,
  );
});

test('the retry itself is not retried', async () => {
  // If a model refuses temperature and then fails again for its own reasons,
  // that second failure is real and belongs to the caller.
  const calls = [];
  const send = async (body) => {
    calls.push(body);
    if ('temperature' in body) throw temperatureError();
    throw Object.assign(new Error('400 Invalid image'), { status: 400 });
  };

  await assert.rejects(
    () => withTemperatureFallback('m', { messages: [] }, send, new Set()),
    /Invalid image/,
  );
  assert.equal(calls.length, 2);
});

test('the error matcher recognises the real message and nothing else', () => {
  assert.equal(isTemperatureRefusal(temperatureError()), true);
  assert.equal(isTemperatureRefusal(Object.assign(new Error('400 bad request'), { status: 400 })), false);
  assert.equal(
    isTemperatureRefusal(Object.assign(new Error('temperature'), { status: 500 })), false,
    'a 500 mentioning temperature is a server fault, not a parameter problem',
  );
  assert.equal(isTemperatureRefusal(null), false);
});
