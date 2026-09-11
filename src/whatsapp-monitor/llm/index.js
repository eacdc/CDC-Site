import { config } from '../config.js';
import { OpenAiLlm } from './openai.js';

let instance = null;

/**
 * The seam between this module and whatever LLM is behind it. Nothing outside
 * src/whatsapp-monitor/llm/ imports a vendor SDK, so swapping providers is a
 * new file here plus an env var — never a change to the detector.
 *
 * Built lazily so a missing API key only fails when the LLM is actually used.
 */
export function llm() {
  if (instance) return instance;
  switch (config.llm.provider) {
    case 'openai':
      instance = new OpenAiLlm();
      return instance;
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${config.llm.provider}`);
  }
}

export function setLlmForTests(fake) {
  instance = fake;
}
