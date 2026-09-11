/**
 * Pure cursor arithmetic — no I/O, so the rules are directly testable.
 *
 * Rules, in order:
 *  - never ingest anything older than the group's joinedAt
 *  - re-fetch a deliberate overlap window before lastTs; the unique index on
 *    msgId drops the duplicates that creates
 */
export function filterNewMessages(fetched, state, overlapSeconds) {
  const joinedAt = state.joinedAt ? state.joinedAt.getTime() : -Infinity;
  const floor = state.lastTs ? state.lastTs.getTime() - overlapSeconds * 1000 : -Infinity;

  const keep = fetched.filter((m) => {
    const t = m.ts.getTime();
    return t >= joinedAt && t > floor;
  });

  // Every fetched message newer than the cursor means the window may have
  // overflowed and swallowed messages in between.
  const possibleGap =
    state.lastTs !== null &&
    fetched.length > 0 &&
    fetched.every((m) => m.ts.getTime() > state.lastTs.getTime());

  return { keep, possibleGap };
}

/** Newest message by timestamp; ties broken by fetch order (last wins). */
export function newestOf(msgs) {
  let best = null;
  for (const m of msgs) {
    if (!best || m.ts.getTime() >= best.ts.getTime()) best = m;
  }
  return best;
}
