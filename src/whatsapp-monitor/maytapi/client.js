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

/** Omits anything unset, so an absent option never becomes `?count=undefined`. */
function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

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
  getMessages: (conversationId, { count, page } = {}) =>
    request(
      `${phoneScope()}/getMessages/${encodeURIComponent(conversationId)}${buildQuery({ count, page })}`,
    ),
  getMessage: (msgId) => request(`${phoneScope()}/getMessage/${encodeURIComponent(msgId)}`),
  /**
   * All chats, 1:1 included - this is how the ACK poll finds owners' replies.
   *
   * `days` returns only conversations whose last message falls inside that
   * window, which is a cheap way to skip dormant groups instead of asking every
   * monitored group for messages every five minutes.
   */
  getConversations: ({ days, page } = {}) => {
    const qs = buildQuery({ days, page });
    return request(`${phoneScope()}/getConversations${qs}`);
  },

  /**
   * The same payload as getMessages - same users/messages/me shape, same
   * count/page parameters - reached through the conversations endpoint instead.
   *
   * Kept as a fallback: getMessages has been seen returning 500 "Connection to
   * Api is failed" for every group while the lighter endpoints stayed healthy,
   * and a second door to the same data is worth having when the first one is
   * the one that is stuck.
   */
  getConversationMessages: (conversationId, { count, page } = {}) =>
    request(
      `${phoneScope()}/getConversations/${encodeURIComponent(conversationId)}${buildQuery({ count, page })}`,
    ),
  listPhones: () => request(`${config.maytapi.productId}/listPhones`),
  sendMessage: (to, message) =>
    request(`${phoneScope()}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ to_number: to, type: 'text', message }),
    }),
  request,
};
