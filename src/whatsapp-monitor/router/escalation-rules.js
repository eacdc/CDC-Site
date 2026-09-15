/**
 * Pure escalation decisions — no I/O, so the timing rules are directly testable.
 *
 * A concern escalates at most twice: owner -> owner's escalationTo -> that
 * person's escalationTo. Two hops is the cap. Beyond that, repeatedly DMing
 * more senior people about a concern nobody has acknowledged stops being an
 * alert and becomes noise, and the dashboard is the right place to see it.
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
export function dueForEscalation(concern, now, escalateAfterMin) {
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
  if (level >= MAX_ESCALATIONS) return false;

  const since = level === 0 ? concern.createdAt : concern.lastEscalatedAt;
  if (!since) return false;

  return now.getTime() - since.getTime() >= escalateAfterMin * 60_000;
}

/**
 * Who is next up the chain. `ownersByPhone` maps phone -> owner doc.
 *
 * Returns null when the chain ends (nobody configured an escalationTo) or when
 * the next person has already been alerted about this concern — escalating to
 * someone who is already on the thread would just be a duplicate DM.
 */
export function nextEscalationTarget(concern, ownersByPhone) {
  const escalated = concern.escalatedTo ?? [];
  const from = escalated.length === 0 ? concern.ownerId : escalated[escalated.length - 1];
  if (!from) return null;

  const next = ownersByPhone.get(from)?.escalationTo;
  if (!next) return null;
  if (next === concern.ownerId || escalated.includes(next)) return null;

  return next;
}
