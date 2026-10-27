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
