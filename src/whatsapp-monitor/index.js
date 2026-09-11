import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { connect, ensureIndexes, runs } from './db.js';
import { runPoll, checkSession } from './poller/poll.js';

let polling = false;

/**
 * Starts the WhatsApp monitor inside the main backend process.
 *
 * Off unless WHATSAPP_MONITOR_ENABLED=true, so the rest of the backend runs
 * untouched on machines that have no Maytapi credentials — including local dev
 * and anyone else's checkout. A startup failure here is logged and swallowed:
 * this feature must never stop the server from booting.
 */
export async function startWhatsappMonitor() {
  if (!config.enabled) {
    logger.info('whatsapp monitor disabled (set WHATSAPP_MONITOR_ENABLED=true to run it)');
    return false;
  }

  try {
    await connect();
    await ensureIndexes();
  } catch (err) {
    logger.error({ err: String(err) }, 'whatsapp monitor failed to start — continuing without it');
    return false;
  }

  cron.schedule(
    config.pollCron,
    async () => {
      // A slow run must not overlap the next tick and double-fetch.
      if (polling) return logger.warn('previous poll still running — skipping this tick');
      polling = true;
      try {
        await runPoll();
      } catch (err) {
        logger.error({ err: String(err) }, 'poll run threw');
      } finally {
        polling = false;
      }
    },
    { timezone: config.tz },
  );

  logger.info({ cron: config.pollCron, tz: config.tz }, 'whatsapp monitor started');
  return true;
}

/** Feeds the backend's health endpoint. Never throws. */
export async function whatsappMonitorHealth() {
  if (!config.enabled) return { enabled: false };

  const out = { enabled: true };
  try {
    const lastRun = await runs().find({}).sort({ startedAt: -1 }).limit(1).next();
    out.db = 'ok';
    out.lastRunAt = lastRun?.startedAt ?? null;
    out.lastRunAgeSeconds = lastRun ? Math.round((Date.now() - lastRun.startedAt.getTime()) / 1000) : null;
    out.lastRunErrors = lastRun?.errors ?? [];
  } catch (err) {
    out.db = String(err);
  }
  try {
    out.maytapiSession = (await checkSession()).ok ? 'logged_in' : 'logged_out';
  } catch (err) {
    out.maytapiSession = String(err);
  }
  return out;
}
