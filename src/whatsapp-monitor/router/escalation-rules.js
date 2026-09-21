/**
 * Pure escalation decisions — no I/O, so the timing rules are directly testable.
 *
 * A group with its own ladder escalates as deep as that ladder goes: you decide
 * how far it climbs by how many people you put on the list.
 *
 * A group without one falls back to the older arrangement — owner -> owner's
 * escalationTo -> that person's escalationTo — and stops after two hops. That
 * chain has no natural end, and repeatedly DMing more senior people about a
 * concern nobody has acknowledged stops being an alert and becomes noise.
 */
export const MAX_ESCALATIONS = 2;

/**
 * Only `open` concerns escalate. An `acknowledged` one has reached a human who
 * said so — that is the whole point of acknowledging — and a `resolved` one is
 * finished.
 *
 * The clock restarts at each hop: the first runs from createdAt, later ones
 * from the previous escalation, so each person gets the full window to respond.
 */
export function dueForEscalation(concern, now, escalateAfterMin, maxHops = MAX_ESCALATIONS) {
  if (concern.status !== 'open') return false;

  // Raised by a backfill from messages that were already history when the tool
  // read them. Nobody was DMed about it, so escalating it would be the first
  // anyone heard - about a problem that may have ended yesterday. It becomes a
  // normal concern the moment its thread sees new activity.
  if (concern.backfilledAt) return false;

  // Someone in the thread has said it is running again. Waking the next person
  // up the chain over a problem the floor considers over is exactly the noise
  // that makes people stop reading these. The hint is cleared the moment the
  // thread says otherwise, and the clock resumes from there.
  if (concern.resolutionHint) return false;

  const level = concern.escalatedTo?.length ?? 0;
  if (level >= maxHops) return false;

  // The first hop is measured from the ALERT, not from when the concern was
  // raised. The two used to be the same moment; now a concern waits 15 or 30
  // minutes for its first DM, and measuring from createdAt would escalate the
  // owner past in the same cycle their phone buzzed.
  //
  // A concern that was never alerted has no `alertedAt`, and the guard below
  // stops it escalating at all - which is right: escalation means nobody
  // answered the alert, and there was no alert.
  const since = level === 0 ? concern.alertedAt : concern.lastEscalatedAt;
  if (!since) return false;

  return now.getTime() - since.getTime() >= escalateAfterMin * 60_000;
}

/**
 * Who is next up the chain.
 *
 * Two arrangements, and the group's own ladder wins where it exists:
 *
 * 1. **`groupChain`** — an ordered list set against the group in Admin. Walked
 *    in order, one person per hop. This is the whole ladder for that group;
 *    `escalationTo` is not consulted at all, so there is one place to look when
 *    asking who hears about this group.
 * 2. **`owner.escalationTo`** — the older arrangement, a chain that belongs to
 *    the person rather than the group. Still used by every group with no list
 *    of its own.
 *
 * `ownersByPhone` maps phone -> owner doc. Returns null when the ladder is
 * exhausted, which the caller treats as "nobody left to escalate to".
 */
export function nextEscalationTarget(concern, ownersByPhone, groupChain = []) {
  const escalated = concern.escalatedTo ?? [];

  if (groupChain.length > 0) {
    // Skipping rather than stopping: the owner appearing in their own group's
    // ladder is a configuration mistake, and it should not silently disable
    // everyone below them on the list.
    return (
      groupChain.find((phone) => phone !== concern.ownerId && !escalated.includes(phone)) ?? null
    );
  }

  const from = escalated.length === 0 ? concern.ownerId : escalated[escalated.length - 1];
  if (!from) return null;

  const next = ownersByPhone.get(from)?.escalationTo;
  if (!next) return null;
  if (next === concern.ownerId || escalated.includes(next)) return null;

  return next;
}
