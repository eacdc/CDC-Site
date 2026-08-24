/**
 * Every material class the code writes must be one the schema accepts.
 *
 * THIS EXISTS BECAUSE THE MISMATCH FAILED AT THE WORST POSSIBLE MOMENT. The ink
 * reader writes `materialClass: 'INK_COATING'` on success, and the enum did not
 * list it. So the reading ran, the model was paid for, the questions were
 * answered — and the very last write threw:
 *
 *   SpQuoteDocument validation failed: materialClass: `INK_COATING` is not a
 *   valid enum value for path `materialClass`.
 *
 * The document was then marked FAILED, which is the one thing it was not. No
 * unit test caught it because writing a document needs Mongo, and no reading of
 * either file catches it either: the value is a string in one file and a list in
 * another, and nothing in the language connects them.
 *
 * So the connection is made here, in the only place it can be — a test that
 * knows both sides.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteDocumentSchema } from '../models/schemas.js';

const ALLOWED = quoteDocumentSchema.path('materialClass').options.enum;

/**
 * Every value any code path assigns to `materialClass`, with what writes it.
 *
 * Add to this list when a new reader is added. It is short on purpose: if it
 * ever needs to be long, the field is doing too many jobs.
 */
const WRITTEN = [
  { value: 'PAPER_BOARD', by: 'the classifier, and the paper reader on success' },
  { value: 'INK_COATING', by: 'the ink reader on success — no classifier produces it' },
  { value: 'INK', by: 'the classifier' },
  { value: 'PLATE', by: 'the classifier' },
  { value: 'CHEMICAL', by: 'the classifier' },
  { value: 'CONSUMABLE', by: 'the classifier — tape, film, cartons, not pressroom consumables' },
  { value: 'FILM', by: 'the classifier' },
  { value: 'ADHESIVE', by: 'the classifier' },
  { value: 'OTHER', by: 'the classifier' },
];

test('every material class the code writes is accepted by the schema', () => {
  for (const { value, by } of WRITTEN) {
    assert.ok(
      ALLOWED.includes(value),
      `${value} is written by ${by}, and the schema would reject it`,
    );
  }
});

test('the classes the ink reader answers to are all real', () => {
  // The frontend routes on these and the approval guard blocks on them. A typo
  // in either would fail silently — the panel simply never appearing, or the
  // guard never firing.
  for (const value of ['INK', 'PLATE', 'CHEMICAL', 'CONSUMABLE', 'INK_COATING']) {
    assert.ok(ALLOWED.includes(value), `${value} is not a material class`);
  }
});

test('the schema accepts nothing the code does not write', () => {
  /*
    The other direction, and it is worth checking too. A value in the enum that
    nothing produces is dead vocabulary — it turns up in a dropdown or a filter,
    matches no document ever, and reads as "there are none of those" rather than
    "that is not a thing here".
  */
  const written = new Set(WRITTEN.map((w) => w.value));
  const orphans = ALLOWED.filter((v) => !written.has(v));
  assert.deepEqual(orphans, [], `nothing writes: ${orphans.join(', ')}`);
});
