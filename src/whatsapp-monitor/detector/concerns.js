/**
 * An existing concern absorbs a new candidate when it is for the same category,
 * is still live, and was raised within the cooldown window. One machine going
 * down produces a dozen messages over half an hour — that is one problem, and
 * one alert.
 *
 * `live` must already be scoped to the candidate's group. The newest match wins,
 * so appending follows the most recent thread rather than a stale one.
 */
export function findDuplicate(candidate, live, now, cooldownMin) {
  const floor = now.getTime() - cooldownMin * 60_000;

  let best = null;
  for (const existing of live) {
    if (existing.category !== candidate.category) continue;
    if (existing.status !== 'open' && existing.status !== 'acknowledged') continue;
    if (existing.createdAt.getTime() < floor) continue;
    if (!best || existing.createdAt > best.createdAt) best = existing;
  }
  return best;
}
