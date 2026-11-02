/**
 * Provider registry tests.
 *
 * These exist because of a specific failure: registration was a side effect of
 * importing a provider module, and nothing imported one. The registry was
 * therefore empty in every deployment, and the first real extraction — after
 * the upload had been paid for — failed with `Available: none`. Every unit
 * test passed throughout, because every one of them tested the pieces around
 * the registry rather than the registry's one job.
 *
 * So the assertion that matters here is the dullest one imaginable: ask for
 * the default provider, and get it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, listProviders } from '../services/extraction/provider.js';

/** Runs `fn` with the given env vars set (or deleted, for undefined), then restores them. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the default provider is registered without anyone importing it', async () => {
  await withEnv({ EXTRACTION_PROVIDER: undefined, ANTHROPIC_API_KEY: 'test-key' }, async () => {
    const provider = await getProvider();
    assert.equal(provider.name, 'anthropic');
  });
});

test('a provider registers whether or not its key is configured', async () => {
  // Registration and credentials are separate concerns. A provider that only
  // appears once a key is present turns a missing key into "provider not
  // registered", which points at the wrong thing entirely.
  await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const names = await listProviders();
    assert.ok(names.includes('openai'));
    assert.ok(names.includes('anthropic'));
  });
});

test('every provider honours the interface the rest of the app calls', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
    for (const name of ['anthropic', 'openai']) {
      const provider = await getProvider(name);
      for (const method of ['extractQuote', 'extractInvoice', 'adjudicate', 'detectOrientation']) {
        assert.equal(typeof provider[method], 'function', `${name}.${method} is missing`);
      }
    }
  });
});

test('an unknown provider names what is actually available', async () => {
  // The original message said "Available: none" and read as a configuration
  // problem. Listing the real names is what turns it back into a fixable one.
  await assert.rejects(
    () => getProvider('nonesuch'),
    (err) => {
      assert.match(err.message, /"nonesuch" is not registered/);
      assert.match(err.message, /Available: openai/);
      return true;
    },
  );
});

test('asking for anthropic without a key says so, rather than just refusing', async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => getProvider('anthropic'),
      (err) => {
        assert.match(err.message, /ANTHROPIC_API_KEY is not set/);
        return true;
      },
    );
  } finally {
    if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
  }
});
