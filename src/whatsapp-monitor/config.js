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
    timeoutMs: num('MAYTAPI_TIMEOUT_MS', 20000),
    retries: num('MAYTAPI_RETRIES', 3),
  },

  llm: {
    provider: opt('LLM_PROVIDER', 'openai'),
    fastModel: opt('LLM_MODEL_FAST', 'gpt-5-mini'),
    strongModel: opt('LLM_MODEL_STRONG', 'gpt-5'),
    contextMessages: num('LLM_CONTEXT_MESSAGES', 15),
  },

  pollCron: opt('POLL_CRON', '*/5 * * * *'),
  cursorOverlapSeconds: num('CURSOR_OVERLAP_SECONDS', 60),
  messageTtlSeconds: num('MESSAGE_TTL_SECONDS', 5184000),

  defaultOwnerPhone: opt('DEFAULT_OWNER_PHONE', ''),
  adminPhone: opt('ADMIN_PHONE', ''),
  defaultCooldownMin: num('DEFAULT_COOLDOWN_MIN', 30),
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
