/**
 * A line as corrected on the review step.
 *
 * The page sends only the fields it shows. A field it did not send must keep
 * the value the reader found: rebuilding the line from what was sent blanked
 * every other field, and with GSM and size gone the matcher could not tell
 * Krishna Vanijya's 128 and 210 GSM boards apart (KV/26-27/19508, October
 * 2026) - every line came back "no open PO".
 *
 * @param {Object} sent   the line as the page sent it
 * @param {Object} was    the line as stored
 * @param {string[]} fields the fields a person may correct
 */
export function correctedLine(sent = {}, was = {}, fields = []) {
  return Object.fromEntries(fields.map((k) => [
    k, Object.prototype.hasOwnProperty.call(sent, k) ? (sent[k] ?? null) : (was[k] ?? null),
  ]));
}

/**
 * A line's discount after a person changed it, or its quantity or rate.
 *
 * A percentage is applied to the new gross; a typed amount stands as typed.
 * Setting one clears the other. The printed after-discount value no longer
 * describes the line, so it is worked out again - or dropped with the
 * discount. `line` already carries the edits and its new amount.
 */
export function repricedDiscount(line = {}, edits = {}) {
  const out = {};
  if (edits.discountPct !== undefined) {
    out.discountPct = edits.discountPct || null;
    if (edits.discountAmount === undefined) out.discountAmount = null;
  }
  if (edits.discountAmount !== undefined) {
    out.discountAmount = edits.discountAmount || null;
    if (edits.discountPct === undefined) out.discountPct = null;
  }
  const pct = out.discountPct !== undefined ? out.discountPct : line.discountPct;
  const given = out.discountAmount !== undefined ? out.discountAmount : line.discountAmount;
  const gross = Number.isFinite(Number(line.amount)) && line.amount !== null ? Number(line.amount) : null;
  const amount = pct && gross !== null ? Math.round(gross * pct) / 100 : (given || null);
  if (pct) out.discountAmount = amount;
  out.taxableValue = amount && gross !== null ? Math.round((gross - amount) * 100) / 100 : null;
  return out;
}
