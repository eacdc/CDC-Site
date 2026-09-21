export const CONCERN_CATEGORIES = [
  'machine_breakdown',
  'quality_reprint',
  'delivery_delay',
  'customer_complaint',
  'material_shortage',
  'safety',
  'hr_attendance',
  'other',
];

export const SEVERITIES = ['low', 'medium', 'high'];

/**
 * What a group is for, which decides how its messages are judged.
 *
 * `internal` is a CDC work group: a concern is something that has gone wrong on
 * the floor. `client` is a group a customer is in: the bar is much lower,
 * because an unanswered customer is itself the problem.
 *
 * Groups default to internal - the safer error, since the client prompt flags
 * far more and would bury a plant in alerts if applied by accident.
 */
export const GROUP_KINDS = ['internal', 'client'];
