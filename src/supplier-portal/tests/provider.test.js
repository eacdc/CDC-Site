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

test('the default provider is registered without anyone importing it', async () => {
  const provider = await getProvider();
  assert.equal(provider.name, 'openai');
});

test('a provider registers whether or not its key is configured', async () => {
  // Registration and credentials are separate concerns. A provider that only
  // appears once a key is present turns a missing key into "provider not
  // registered", which points at the wrong thing entirely.
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.ok((await listProviders()).includes('openai'));
  } finally {
    if (before !== undefined) process.env.OPENAI_API_KEY = before;
  }
});

test('the provider honours the interface the rest of the app calls', async () => {
  const provider = await getProvider('openai');
  for (const method of ['extractQuote', 'extractInvoice', 'adjudicate']) {
    assert.equal(typeof provider[method], 'function', `${method} is missing`);
  }
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
