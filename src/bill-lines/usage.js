/**
 * Tokens and cost per bill.
 *
 * lib/claude.js logs one `[claude] feature=... model=... in=... out=...` line
 * per call and returns nothing else about usage. Rather than change a module
 * every feature shares, the line is read back here: while a bill is being
 * processed its calls run inside an AsyncLocalStorage context, so a log line
 * lands on the bill that caused it even with several bills in flight.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** USD per million tokens, input / output (Anthropic list prices, Oct 2026). */
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50],
};

const store = new AsyncLocalStorage();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const original = console.info.bind(console);
  console.info = (...args) => {
    const tally = store.getStore();
    const text = typeof args[0] === 'string' ? args[0] : '';
    const m = tally && text.match(/^\[claude\] feature=\S+ model=(\S+) in=(\d+) out=(\d+)/);
    if (m) {
      tally.calls += 1;
      tally.inputTokens += Number(m[2]);
      tally.outputTokens += Number(m[3]);
      tally.models.add(m[1]);
      const [pin, pout] = PRICES[m[1]] || [null, null];
      if (pin === null) tally.unpriced = true;
      else tally.costUsd += (Number(m[2]) * pin + Number(m[3]) * pout) / 1e6;
      return undefined;
    }
    return original(...args);
  };
}

/** Run `fn` and return its result with the Claude usage it caused. */
export async function withUsage(fn) {
  install();
  const tally = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: new Set(), unpriced: false };
  const result = await store.run(tally, fn);
  return {
    result,
    usage: {
      calls: tally.calls,
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      costUsd: Math.round(tally.costUsd * 10000) / 10000,
      models: [...tally.models],
      unpriced: tally.unpriced,
    },
  };
}
