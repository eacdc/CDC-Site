import dotenv from 'dotenv';

dotenv.config();

function opt(name, fallback) {
  return process.env[name] || fallback;
}

/**
 * A base URL, with trailing slashes trimmed.
 *
 * Everything that uses one appends a path with its own leading slash, and a
 * URL pasted out of a browser's address bar usually carries a trailing one -
 * which would otherwise produce `...com//concerns.html`. It still works, and
 * it still looks broken in a message sent to a manager.
 */
function url(name, fallback) {
  return (process.env[name] || fallback).replace(/\/+$/, '');
}

function num(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

/**
 * All WhatsApp-monitor configuration in one place. Nothing here is read
 * anywhere else in the module, and no phone number, group id or model name is
 * hard-coded in code — they live here (env) or in Mongo.
 */
export const config = {
  enabled: opt('WHATSAPP_MONITOR_ENABLED', 'false') === 'true',
  mongodbUri: opt('MONGODB_URI_WA', ''),

  maytapi: {
    productId: opt('MAYTAPI_PRODUCT_ID', ''),
    phoneId: opt('MAYTAPI_PHONE_ID', ''),
    token: opt('MAYTAPI_TOKEN', ''),
    /**
     * A successful getMessages against a real group measured 12-14s. At the
     * old 20s a slightly slow response was aborted mid-flight and retried,
     * turning a call that would have worked into three slow failures - and only
     * under load, which is when nobody is watching.
     */
    timeoutMs: num('MAYTAPI_TIMEOUT_MS', 45000),
    retries: num('MAYTAPI_RETRIES', 3),
    /** Most recent messages to fetch per page. Keeps the response bounded. */
    messageCount: num('MAYTAPI_MESSAGE_COUNT', 100),
    /** Extra pages to walk back when a page holds nothing older than the cursor. */
    maxPages: num('MAYTAPI_MAX_PAGES', 5),
    /**
     * The most wall-clock time one group may consume in a cycle. Without it,
     * retries across maxPages can occupy the whole poll interval, and the
     * "previous poll still running" guard then skips tick after tick while the
     * monitor quietly stops keeping up.
     */
    groupBudgetMs: num('MAYTAPI_GROUP_BUDGET_MS', 120000),
  },

  llm: {
    provider: opt('LLM_PROVIDER', 'openai'),
    fastModel: opt('LLM_MODEL_FAST', 'gpt-5-mini'),
    strongModel: opt('LLM_MODEL_STRONG', 'gpt-5'),
    /**
     * whisper-1, and not one of the newer gpt-4o transcription models, because
     * they cannot read a WhatsApp voice note at all:
     *
     *   gpt-4o-transcribe, gpt-4o-mini-transcribe:
     *       mp3, mp4, mpeg, mpga, m4a, wav, webm
     *   whisper-1:
     *       flac, oga, ogg + all of the above
     *
     * WhatsApp sends Ogg/Opus (.oga), so a gpt-4o model returns
     * "400 Unsupported file format oga" on every single one. The newer model
     * costs about half as much and reads none of our audio; the difference is
     * roughly a dollar a month.
     */
    transcribeModel: opt('LLM_MODEL_TRANSCRIBE', 'whisper-1'),
    contextMessages: num('LLM_CONTEXT_MESSAGES', 15),
  },

  transcription: {
    /**
     * Off unless asked for: it sends staff voice recordings to OpenAI, which is
     * a step beyond sending their typed text, and the groups should be told
     * before it is switched on.
     */
    enabled: opt('TRANSCRIBE_VOICE', 'false') === 'true',
    /** A backlog drains over several cycles rather than blowing one interval. */
    maxPerRun: num('TRANSCRIBE_MAX_PER_RUN', 20),
    /** The API's own upload limit; anything larger would fail after the download. */
    maxBytes: num('TRANSCRIBE_MAX_BYTES', 25 * 1024 * 1024),
    downloadTimeoutMs: num('TRANSCRIBE_DOWNLOAD_TIMEOUT_MS', 30000),
  },

  pollCron: opt('POLL_CRON', '*/5 * * * *'),
  rollingSummaryCron: opt('ROLLING_SUMMARY_CRON', '0 */4 * * *'),
  dailySummaryTime: opt('DAILY_SUMMARY_TIME', '20:00'),
  cursorOverlapSeconds: num('CURSOR_OVERLAP_SECONDS', 60),
  messageTtlSeconds: num('MESSAGE_TTL_SECONDS', 5184000),

  defaultOwnerPhone: opt('DEFAULT_OWNER_PHONE', ''),
  adminPhone: opt('ADMIN_PHONE', ''),
  defaultCooldownMin: num('DEFAULT_COOLDOWN_MIN', 30),
  /**
   * Holds back a DM when a concern of the same category was alerted this
   * recently. Concern identity is per reply thread, so one breakdown reported
   * by three people who did not quote each other is three concerns - all on the
   * dashboard, but not all on the phone. Set to 0 to alert on every one.
   */
  alertCooldownMin: num('ALERT_COOLDOWN_MIN', 30),
  defaultEscalateAfterMin: num('DEFAULT_ESCALATE_AFTER_MIN', 30),
  /**
   * Scales the escalation window by how bad the concern is, so a low-severity
   * note does not climb the ladder at the pace of a stopped press.
   *
   * Multiplies whatever window already applies - a routing row's
   * escalateAfterMin or the default - rather than replacing it, so a 5-minute
   * safety route still means 5 for a high, 15 for a medium, 30 for a low.
   *
   * `high` is 1 and not configurable: it is the base the other two are defined
   * against, and letting it drift would make them mean nothing.
   */
  escalationSeverityMultiplier: {
    high: 1,
    medium: num('ESCALATE_MULTIPLIER_MEDIUM', 3),
    low: num('ESCALATE_MULTIPLIER_LOW', 6),
  },
  /**
   * How long a concern waits before its first DM, by kind of group.
   *
   * Most problems are handled by the people already in the group. A DM that
   * arrives after the fitter has fixed the machine is noise, and noise is what
   * stops managers reading alerts at all - so the alert is held back to give
   * the group a chance to deal with it, and dropped entirely if the thread
   * says it is fixed.
   *
   * Client groups wait half as long: a customer left waiting is the problem
   * itself, not something the group can quietly resolve between themselves.
   */
  /**
   * Rewrites voice-note transcripts into the Latin alphabet, keeping the words
   * rather than translating them: `আমি ভাত খাবো` becomes `ami vat khabo`.
   *
   * Whisper transcribes in the script of the language, which is unreadable to
   * anyone on the floor who types romanised - and the classifier prompt is
   * written entirely around romanised Hindi and Bengali, so a native-script
   * transcript is the one input it was never tuned on.
   *
   * One extra fast-model call per voice note.
   */
  romaniseTranscripts: opt('ROMANISE_TRANSCRIPTS', 'true') === 'true',

  alertAfterMin: {
    internal: num('ALERT_AFTER_MIN_INTERNAL', 30),
    client: num('ALERT_AFTER_MIN_CLIENT', 15),
  },

  /**
   * Where the dashboard lives, used to build the "Read the full conversation"
   * link in every alert.
   *
   * Defaults to the deployed dashboard, not localhost: this runs on Render
   * talking to a dashboard on Render, and a localhost link is the one value
   * that produces an unusable alert - WhatsApp will not even make it tappable,
   * because a bare hostname with no dot does not look like a web address.
   */
  dashboardBaseUrl: url('DASHBOARD_BASE_URL', 'https://whatsappsummarizer.onrender.com'),
  tz: opt('TZ', 'Asia/Kolkata'),
  logLevel: opt('LOG_LEVEL', 'info'),
  nodeEnv: opt('NODE_ENV', 'development'),
};

/** Throws with a clear list rather than failing one variable at a time. */
export function assertConfigured() {
  const missing = [];
  if (!config.mongodbUri) missing.push('MONGODB_URI_WA');
  if (!config.maytapi.productId) missing.push('MAYTAPI_PRODUCT_ID');
  if (!config.maytapi.phoneId) missing.push('MAYTAPI_PHONE_ID');
  if (!config.maytapi.token) missing.push('MAYTAPI_TOKEN');
  if (missing.length) {
    throw new Error(`WhatsApp monitor is missing env vars: ${missing.join(', ')}`);
  }
}
