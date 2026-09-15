import { sharesThread } from './threads.js';

/**
 * An existing concern absorbs a new candidate when they are part of the same
 * reply thread — and only then.
 *
 * This used to match on category plus a time window, which is why two machines
 * failing within half an hour became one concern, and why a follow-up the next
 * morning started a second concern about a problem already being tracked.
 * Neither is what the reply chain says.
 *
 * `live` must already be scoped to the candidate's group. The newest match
 * wins, so appending follows the most recent thread rather than a stale one.
 */
export function findDuplicate(candidate, live) {
  let best = null;
  for (const existing of live) {
    if (existing.status !== 'open' && existing.status !== 'acknowledged') continue;
    if (!sharesThread(existing.threadRootIds, candidate.threadRootIds)) continue;
    if (!best || existing.createdAt > best.createdAt) best = existing;
  }
  return best;
}

/**
 * Whether an alert for this concern should be held back.
 *
 * Concern identity is strict, so three people reporting one breakdown without
 * quoting each other now make three concerns. All three belong on the
 * dashboard; all three ringing the same phone inside a few minutes does not
 * help anyone. This suppresses the DM only — the concern is still raised, still
 * visible, and still escalates.
 */
export function recentlyAlerted(candidate, live, now, cooldownMin) {
  if (cooldownMin <= 0) return null;
  const floor = now.getTime() - cooldownMin * 60_000;

  for (const existing of live) {
    if (existing.category !== candidate.category) continue;
    if (!existing.alertedAt || existing.alertedAt.getTime() < floor) continue;
    return existing;
  }
  return null;
}
