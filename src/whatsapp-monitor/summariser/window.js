/**
 * Pure date arithmetic for summary windows — no I/O and no dependence on the
 * process timezone, so the behaviour is the same on a Kolkata laptop and a
 * Render box running UTC.
 */

/** India is UTC+5:30 and has no daylight saving, so a fixed offset is correct. */
export const IST_OFFSET_MINUTES = 330;

/**
 * The calendar day a moment falls in, in IST, as "YYYY-MM-DD".
 *
 * This is the daily summary's identity: re-running at 20:05 after a 20:00 run
 * must replace that day's summary rather than add a second one.
 */
export function istDayKey(date, offsetMinutes = IST_OFFSET_MINUTES) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Start of that IST day (00:00 IST) as a UTC instant, and the end of the window.
 *
 * `end` is the moment the summary runs, not midnight: the daily summary fires at
 * 20:00 IST and covers the working day up to then. Messages after it land in
 * tomorrow's window, which is the honest thing to do — a summary cannot cover
 * messages that do not exist yet.
 */
export function istDayBounds(date, offsetMinutes = IST_OFFSET_MINUTES) {
  const key = istDayKey(date, offsetMinutes);
  const start = new Date(Date.parse(`${key}T00:00:00.000Z`) - offsetMinutes * 60_000);
  return { dayKey: key, start, end: date };
}

/**
 * Turn "20:00" into the cron expression for that time, daily.
 * Throws on anything unparseable rather than silently scheduling at midnight.
 */
export function timeToCron(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) throw new Error(`DAILY_SUMMARY_TIME must look like "20:00", got "${hhmm}"`);

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`DAILY_SUMMARY_TIME out of range: "${hhmm}"`);

  return `${minute} ${hour} * * *`;
}

/** Earliest and latest ts across messages — the window a summary actually covers. */
export function tsRange(messages) {
  if (messages.length === 0) return null;
  let min = messages[0].ts;
  let max = messages[0].ts;
  for (const m of messages) {
    if (m.ts < min) min = m.ts;
    if (m.ts > max) max = m.ts;
  }
  return { start: min, end: max };
}
