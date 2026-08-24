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
import {
  withTemperatureFallback, isTemperatureRefusal, withMaxTokensFallback, isMaxTokensRefusal,
} from '../services/extraction/openai-provider.js';

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

// ── The same problem, a second time ─────────────────────────────────────────

/**
 * `max_tokens` versus `max_completion_tokens`.
 *
 * An output cap was added to stop long price lists being truncated silently,
 * and the reasoning model in use answered
 *
 *   400 Unsupported parameter: 'max_tokens' is not supported with this model.
 *   Use 'max_completion_tokens' instead
 *
 * — so the fix for a silent failure became a loud one on every read. Renaming
 * the parameter outright would only move the 400: the older models this project
 * also runs against accept the old name and not the new one.
 */

const refusal = () => Object.assign(
  new Error("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
  { status: 400 },
);

test('the old name is tried first, because most models take it', async () => {
  const sent = [];
  await withMaxTokensFallback(
    { model: 'gpt-4o', max_tokens: 16384 },
    async (body) => { sent.push(body); return 'ok'; },
    new Set(),
  );
  assert.equal(sent[0].max_tokens, 16384);
  assert.equal(sent[0].max_completion_tokens, undefined);
});

test('a refusal is answered by renaming, not by dropping the cap', async () => {
  // Dropping it would restore the silent truncation this cap exists to prevent.
  const sent = [];
  const seen = new Set();

  await withMaxTokensFallback(
    { model: 'o-series', max_tokens: 16384, messages: [] },
    async (body) => {
      sent.push(body);
      if (body.max_tokens != null) throw refusal();
      return 'ok';
    },
    seen,
  );

  assert.equal(sent.length, 2);
  assert.equal(sent[1].max_completion_tokens, 16384);
  assert.equal(sent[1].max_tokens, undefined);
  // And everything else on the request survives the rename.
  assert.deepEqual(sent[1].messages, []);
});

test('the rename is remembered, so it costs one call per model per process', async () => {
  const seen = new Set();
  let calls = 0;

  const send = async (body) => {
    calls += 1;
    if (body.max_tokens != null) throw refusal();
    return 'ok';
  };

  await withMaxTokensFallback({ model: 'o-series', max_tokens: 100 }, send, seen);
  await withMaxTokensFallback({ model: 'o-series', max_tokens: 100 }, send, seen);

  // Two attempts for the first read, one for the second.
  assert.equal(calls, 3);
});

test('a request with no cap is never retried', async () => {
  // There is nothing to rename, and spending a retry to discover that is waste.
  let calls = 0;
  await withMaxTokensFallback({ model: 'gpt-4o' }, async () => { calls += 1; return 'ok'; }, new Set());
  assert.equal(calls, 1);
});

test('an unrelated 400 is not mistaken for the rename', async () => {
  // A bad model id and a malformed message are both 400s. Retrying those under
  // a different parameter name turns one clear error into two confusing ones.
  assert.equal(isMaxTokensRefusal(Object.assign(new Error('The model `nope` does not exist'), { status: 400 })), false);
  assert.equal(isMaxTokensRefusal(Object.assign(new Error("Unsupported value: 'temperature'"), { status: 400 })), false);
  assert.equal(isMaxTokensRefusal(refusal()), true);

  await assert.rejects(
    withMaxTokensFallback(
      { model: 'x', max_tokens: 10 },
      async () => { throw Object.assign(new Error('nope'), { status: 400 }); },
      new Set(),
    ),
    /nope/,
  );
});

test('a model that refuses both parameters still converges', async () => {
  /*
    The real case, and the one neither fallback handles alone: a reasoning model
    rejects `temperature` AND wants `max_completion_tokens`. This composes them
    exactly as `createCompletion` does — the temperature fallback on the
    outside, the cap rename on the inside — and asserts it settles rather than
    ping-ponging.

    It converges because both fallbacks REMEMBER. Without the memory the retry
    that fixes one parameter reintroduces the other, and the pair never agree.
  */
  const noTemperature = new Set();
  const wantsNewName = new Set();
  const sent = [];

  const api = async (body) => {
    sent.push({ ...body });
    if (body.max_tokens != null) {
      throw Object.assign(
        new Error("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
        { status: 400 },
      );
    }
    if (body.temperature != null) {
      throw Object.assign(
        new Error("Unsupported value: 'temperature' does not support 0 with this model."),
        { status: 400 },
      );
    }
    return 'ok';
  };

  const result = await withTemperatureFallback(
    'reasoning-model',
    { max_tokens: 16384, messages: [] },
    (body) => withMaxTokensFallback(body, api, wantsNewName),
    noTemperature,
  );

  assert.equal(result, 'ok');

  // The last request carries the cap under its new name and no temperature —
  // the point being that the cap SURVIVES. Dropping it to get past the 400
  // would restore the silent truncation it was added to prevent.
  const last = sent[sent.length - 1];
  assert.equal(last.max_completion_tokens, 16384);
  assert.equal(last.max_tokens, undefined);
  assert.equal(last.temperature, undefined);

  // And both refusals are now remembered, so the next read starts correct.
  assert.ok(noTemperature.has('reasoning-model'));
  assert.ok(wantsNewName.has('reasoning-model'));
});
