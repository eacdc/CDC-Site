// Shared Mongo ArtworkUnordered pending/completed classification.
// A job is pending when any approval/tooling/plate step is still open.
// Completed is the inverse (excluding deleted docs).

export const PLATE_CLOSED_MONGO_VALUES = [
  'DONE',
  'Done',
  'done',
  'NOT REQUIRED',
  'Not Required',
  'not required',
];

export const TOOLING_OPEN_MONGO_REGEX = /^required$/i;

/** Conditions where the job still has open artwork work. */
export function buildMongoOpenWorkOrConditions() {
  return [
    { 'finalApproval.approved': { $ne: true } },
    { 'tooling.die': { $regex: TOOLING_OPEN_MONGO_REGEX } },
    { 'tooling.block': { $regex: TOOLING_OPEN_MONGO_REGEX } },
    { 'tooling.blanket': { $regex: TOOLING_OPEN_MONGO_REGEX } },
    {
      'plate.output': {
        $exists: true,
        $nin: [null, ...PLATE_CLOSED_MONGO_VALUES],
      },
    },
  ];
}

export function buildMongoPendingQuery() {
  return {
    'status.isDeleted': { $ne: true },
    $or: buildMongoOpenWorkOrConditions(),
  };
}

export function buildMongoCompletedQuery() {
  return {
    'status.isDeleted': { $ne: true },
    $nor: buildMongoOpenWorkOrConditions(),
  };
}
