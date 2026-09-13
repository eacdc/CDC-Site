import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE = 'https://api.maytapi.com/api';

export class MaytapiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'MaytapiError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single entry point for every Maytapi HTTP call.
 * Retries 3x with exponential backoff on network errors and 5xx / 429.
 * Other 4xx fail fast — retrying a bad request is pointless.
 */
async function request(path, init = {}) {
  const url = `${BASE}/${path}`;
  let lastErr;

  for (let attempt = 1; attempt <= config.maytapi.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.maytapi.timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'x-maytapi-key': config.maytapi.token,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });

      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (res.ok) return body;

      const retryable = res.status >= 500 || res.status === 429;
      const err = new MaytapiError(`Maytapi ${res.status} on ${path}`, res.status, body);
      if (!retryable) {
        logger.error({ path, status: res.status, body }, 'maytapi call failed (non-retryable)');
        throw err;
      }
      lastErr = err;
    } catch (err) {
      if (err instanceof MaytapiError && !(err.status >= 500 || err.status === 429)) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < config.maytapi.retries) {
      const backoff = 500 * 2 ** (attempt - 1);
      logger.warn({ path, attempt, backoff, err: String(lastErr) }, 'maytapi call failed, retrying');
      await sleep(backoff);
    }
  }

  logger.error({ path, err: String(lastErr) }, 'maytapi call failed after all retries');
  throw lastErr instanceof Error ? lastErr : new MaytapiError(String(lastErr));
}

const phoneScope = () => `${config.maytapi.productId}/${config.maytapi.phoneId}`;

export const maytapi = {
  /** Session status. Note: the endpoint is `/status`, NOT `/getStatus`. */
  getStatus: () => request(`${phoneScope()}/status`),
  getGroups: () => request(`${phoneScope()}/getGroups`),
  getGroup: (conversationId) => request(`${phoneScope()}/getGroups/${encodeURIComponent(conversationId)}`),
  /**
   * `count` caps how many of the most recent messages come back, and `page`
   * walks backwards through older ones. Without `count` the response grows on
   * every call as the WhatsApp-Web session lazily loads more history - one
   * group went 51 -> 101 -> 148 across three consecutive polls.
   *
   * Note the parameter is `count`, not `limit`; a `limit` is silently ignored.
   */
  getMessages: (conversationId, { count, page } = {}) => {
    const query = new URLSearchParams();
    if (count != null) query.set('count', String(count));
    if (page != null) query.set('page', String(page));
    const qs = query.toString();
    return request(
      `${phoneScope()}/getMessages/${encodeURIComponent(conversationId)}${qs ? `?${qs}` : ''}`,
    );
  },
  getMessage: (msgId) => request(`${phoneScope()}/getMessage/${encodeURIComponent(msgId)}`),
  /** All chats, 1:1 included — this is how phase 3 will find owners' ACK replies. */
  getConversations: () => request(`${phoneScope()}/getConversations`),
  listPhones: () => request(`${config.maytapi.productId}/listPhones`),
  sendMessage: (to, message) =>
    request(`${phoneScope()}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ to_number: to, type: 'text', message }),
    }),
  request,
};
