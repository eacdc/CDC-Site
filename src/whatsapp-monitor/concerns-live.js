/**
 * The statuses that mean a concern is still somebody's problem.
 *
 * Open, or acknowledged by a human who has not finished. A resolved one is
 * history. Named here because two places ask the same question - the
 * de-duplication rule in detector/concerns.js and the guard that refuses to
 * delete a group out from under live work - and they must not drift apart.
 */
export const LIVE_STATUSES = ['open', 'acknowledged'];

/** Is this concern still live? */
export const isLive = (concern) => LIVE_STATUSES.includes(concern?.status);
