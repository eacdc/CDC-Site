import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { AnthropicLlm } from './llm/anthropic.js';
import { CONCERNS_SCHEMA } from './llm/prompts.js';
import { setClaudeClientForTests } from '../lib/claude.js';

/**
 * A fake SDK client answering each request in turn from `replies` (JSON
 * objects, sent back as the reply text).
 */
function fakeClient(replies) {
  const calls = [];
  const stream = (params) => {
    calls.push(params);
    const body = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      finalMessage: async () => ({
        model: params.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify(body) }],
      }),
    };
  };
  return { calls, messages: { stream }, beta: { messages: { stream } } };
}

const input = {
  groupName: 'Tangra floor',
  groupKind: 'internal',
  contextMessages: [],
  newMessages: [{ msgId: 'm1', senderName: 'Ravi', text: 'Kolbus band hai' }],
};

const concern = (severity) => ({
  messageIds: ['m1'], category: 'machine_breakdown', severity, summary: 'Kolbus down', ownerHint: null,
});

/** Runs `fn` with Claude models configured and a fake client, then restores both. */
async function withClaude(replies, fn) {
  const before = { ...config.llm };
  const key = process.env.ANTHROPIC_API_KEY;
  Object.assign(config.llm, { provider: 'anthropic', fastModel: 'claude-haiku-5-5', strongModel: 'claude-sonnet-5-5' });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const fake = fakeClient(replies);
  setClaudeClientForTests(fake);
  try {
    return await fn(fake);
  } finally {
    Object.assign(config.llm, before);
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
    setClaudeClientForTests(null);
  }
}

test('a quiet window stays on the fast model, constrained to the concerns schema', async () => {
  await withClaude([{ concerns: [concern('medium')] }], async (fake) => {
    const result = await new AnthropicLlm().classify(input);
    assert.equal(result.model, 'claude-haiku-5-5');
    assert.equal(result.escalated, false);
    assert.equal(result.concerns.length, 1);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].output_config.format, { type: 'json_schema', schema: CONCERNS_SCHEMA });
  });
});

test('a high-severity concern gets a second opinion from the strong model', async () => {
  await withClaude([{ concerns: [concern('high')] }, { concerns: [concern('high')] }], async (fake) => {
    const result = await new AnthropicLlm().classify(input);
    assert.equal(result.model, 'claude-sonnet-5-5');
    assert.equal(result.escalationReason, 'high_severity');
    assert.equal(fake.calls[1].model, 'claude-sonnet-5-5');
  });
});

test('an OpenAI model id left in LLM_MODEL_FAST is refused at start-up, by name', async () => {
  await withClaude([], async () => {
    config.llm.fastModel = 'gpt-5-mini';
    assert.throws(() => new AnthropicLlm(), /LLM_MODEL_FAST is "gpt-5-mini"/);
  });
});

test('romanise falls back to an empty string rather than throwing', async () => {
  await withClaude([{ text: 'ami vat khabo' }], async () => {
    assert.equal(await new AnthropicLlm().romanise('আমি ভাত খাবো'), 'ami vat khabo');
  });
});
