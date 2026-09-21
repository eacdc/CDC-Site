/**
 * Pure first-alert decisions — no I/O, so the timing rules are directly
 * testable.
 *
 * A concern is not DMed the moment it is raised. It waits: 30 minutes in an
 * internal group, 15 in a client group, measured from the message that caused
 * it. If it is still open and still unresolved when the window expires, the
 * owner hears about it. If the group dealt with it first, nobody is disturbed
 * at all.
 */

/**
 * Is this concern due for its first DM?
 *
 * The clock runs from `firstMsgTs` - the triggering message - not `createdAt`,
 * which is whenever the poll happened to notice, up to a cycle later. "15
 * minutes after the message" has to mean the message.
 */
export function dueForFirstAlert(concern, now, afterMin) {
  // Someone already has it. Acknowledged or resolved inside the window is
  // exactly the outcome the wait exists to produce.
  if (concern.status !== 'open') return false;

  if (concern.alertedAt) return false;

  // Raised by a backfill from messages that were already history. Nobody was
  // going to be DMed about these, waiting or not.
  if (concern.backfilledAt) return false;

  // The thread says it is running again. Sending the DM now would be telling
  // someone about a problem the floor considers over - the precise noise this
  // delay exists to remove.
  if (concern.resolutionHint) return false;

  // No routing rule and no default owner: there is nobody to send to. The
  // caller logs this; here it is simply not due.
  if (!concern.ownerId) return false;

  const since = concern.firstMsgTs ?? concern.createdAt;
  if (!since) return false;

  return now.getTime() - since.getTime() >= afterMin * 60_000;
}

/** How long this group's concerns wait, falling back to the internal window. */
export function alertDelayFor(group, alertAfterMin) {
  return alertAfterMin[group?.kind] ?? alertAfterMin.internal;
}
