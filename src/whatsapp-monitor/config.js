import dotenv from 'dotenv';

dotenv.config();

function opt(name, fallback) {
  return process.env[name] || fallback;
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
    contextMessages: num('LLM_CONTEXT_MESSAGES', 15),
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

  dashboardBaseUrl: opt('DASHBOARD_BASE_URL', 'http://localhost:3000'),
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
