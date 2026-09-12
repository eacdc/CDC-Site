import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { connect, ensureIndexes, runs } from './db.js';
import { runPoll, checkSession } from './poller/poll.js';
import { runRollingSummaries, runDailySummaries } from './summariser/summarise.js';
import { timeToCron } from './summariser/window.js';

let polling = false;
let summarising = false;

/** Wraps a job so a slow run cannot overlap the next tick, and a throw cannot kill the process. */
function guard(name, isRunning, setRunning, job) {
  return async () => {
    if (isRunning()) return logger.warn({ job: name }, 'previous run still going - skipping this tick');
    setRunning(true);
    try {
      await job();
    } catch (err) {
      logger.error({ job: name, err: String(err) }, 'scheduled job threw');
    } finally {
      setRunning(false);
    }
  };
}

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
    logger.error({ err: String(err) }, 'whatsapp monitor failed to start - continuing without it');
    return false;
  }

  cron.schedule(
    config.pollCron,
    guard('poll', () => polling, (v) => { polling = v; }, runPoll),
    { timezone: config.tz },
  );

  // Both summary jobs share one lock: they read the same messages and there is
  // no value in the 20:00 daily run racing the 20:00 rolling run.
  const summaryLock = [() => summarising, (v) => { summarising = v; }];

  cron.schedule(
    config.rollingSummaryCron,
    guard('rolling-summary', ...summaryLock, runRollingSummaries),
    { timezone: config.tz },
  );

  let dailyCron;
  try {
    dailyCron = timeToCron(config.dailySummaryTime);
  } catch (err) {
    // A bad time must not silently schedule the daily summary at midnight.
    logger.error({ err: String(err) }, 'daily summary not scheduled');
  }
  if (dailyCron) {
    cron.schedule(
      dailyCron,
      guard('daily-summary', ...summaryLock, () => runDailySummaries()),
      { timezone: config.tz },
    );
  }

  logger.info(
    {
      poll: config.pollCron,
      rolling: config.rollingSummaryCron,
      daily: dailyCron ?? 'not scheduled',
      tz: config.tz,
    },
    'whatsapp monitor started',
  );
  return true;
}

/**
 * Feeds the backend's health endpoint. Never throws.
 *
 * Reports the last run even when the poller is disabled: runs happen from the
 * CLI scripts too, and showing "-" when the database holds a run from twenty
 * minutes ago is less honest than showing it alongside `enabled: false`.
 */
export async function whatsappMonitorHealth() {
  const out = { enabled: config.enabled };

  try {
    await connect();
    const lastRun = await runs().find({}).sort({ startedAt: -1 }).limit(1).next();
    out.db = 'ok';
    out.lastRunAt = lastRun?.startedAt ?? null;
    out.lastRunAgeSeconds = lastRun ? Math.round((Date.now() - lastRun.startedAt.getTime()) / 1000) : null;
    out.lastRunErrors = lastRun?.errors ?? [];
  } catch (err) {
    // Not configured at all is the normal case on a machine without Maytapi
    // credentials, and is not worth surfacing as a database failure.
    out.db = config.mongodbUri ? String(err) : 'not configured';
  }

  // Skip the Maytapi call when the monitor is off - it is a network round trip
  // whose answer nobody is acting on.
  if (!config.enabled) {
    out.maytapiSession = 'not running';
    return out;
  }

  try {
    out.maytapiSession = (await checkSession()).ok ? 'logged_in' : 'logged_out';
  } catch (err) {
    out.maytapiSession = String(err);
  }
  return out;
}
