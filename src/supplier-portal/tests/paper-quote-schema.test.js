/**
 * The gate between the interpreting agent and the database.
 *
 * The distinction these exist to protect: a line with no paper type is VALID
 * and NOT READY. Sudarshan's Virgin list states a type for none of its ~28
 * products, and a schema that rejected it would leave the agent nothing to show
 * and nothing to ask about. The payload has to survive so the gaps can be named.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePaperQuote, assessReadiness, checkHandoff,
  applyDerivation, explainDerivation,
} from '../services/paper/paper-quote-schema.js';

/** A finished line, as the agent would hand one over. */
const LINE = {
  lineNo: 1,
  productName: 'MEHALI ECO GREEN GB',
  paperType: 'GREY_BACK',
  paperTypeBasis: 'STATED',
  gsmText: '250 284',
  gsmFrom: 250,
  gsmTo: 284,
  rateText: '54.00',
  rate: 54,
  rateUom: 'KGS',
  mill: 'MEHALI',
};

function quote(lines, extra = {}) {
  return {
    supplierName: 'SUDARSHAN PAPER AND BOARD PRIVATE LIMITED',
    plant: 'KOLKATA',
    lines,
    ...extra,
  };
}

// ── Structural validity ─────────────────────────────────────────────────────

test('a finished quote validates and is ready', () => {
  const result = checkHandoff(quote([LINE]));
  assert.equal(result.canHandOff, true);
  assert.equal(result.stage, 'READY');
  assert.deepEqual(result.gaps, []);
});

test('a numeric string rate is accepted rather than failing the document', () => {
  // An agent asked for JSON returns "78.50" as often as 78.50. Failing a whole
  // document over the quotes around a number is the mistake this codebase
  // already made once, with lineNo, and it cost 47 lines of a good extraction.
  const { ok, data } = validatePaperQuote(quote([{ ...LINE, rate: '54.00', gsmFrom: '250' }]));
  assert.ok(ok);
  assert.equal(data.lines[0].rate, 54);
  assert.equal(data.lines[0].gsmFrom, 250);
});

test('a paper type outside the canonical list is rejected', () => {
  // The whole reason the gate exists. "premium coated board" is fluent and
  // unusable, and fluent-and-wrong looks finished.
  const { ok, errors } = validatePaperQuote(quote([{ ...LINE, paperType: 'premium coated board' }]));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.path.includes('paperType')));
});

test('a backwards GSM band is rejected', () => {
  const { ok, errors } = validatePaperQuote(quote([{ ...LINE, gsmFrom: 400, gsmTo: 200 }]));
  assert.equal(ok, false);
  assert.match(errors[0].message, /backwards/);
});

test('an open-topped band is fine', () => {
  // "115 & ABOVE" and "296 & ABOVE" are on real lists. A null top is meaningful.
  const { ok, data } = validatePaperQuote(quote([{
    ...LINE, gsmText: '115 & ABOVE', gsmFrom: 115, gsmTo: null,
  }]));
  assert.ok(ok);
  assert.equal(data.lines[0].gsmTo, null);
});

test('a zero or negative rate is rejected', () => {
  assert.equal(validatePaperQuote(quote([{ ...LINE, rate: 0 }])).ok, false);
  assert.equal(validatePaperQuote(quote([{ ...LINE, rate: -5 }])).ok, false);
});

test('a line with no product name is rejected', () => {
  // The product name is the anchor: what a reviewer recognises, what a learned
  // rule is keyed on, what next month's list matches against.
  assert.equal(validatePaperQuote(quote([{ ...LINE, productName: '' }])).ok, false);
});

test('BF on a non-kraft line is rejected, but zero is not', () => {
  // CDC's ERP stores BF 0 on every non-kraft paper as a placeholder. A real BF
  // on FBB means the agent put something in the wrong field.
  assert.equal(validatePaperQuote(quote([{ ...LINE, paperType: 'FBB', bf: 18 }])).ok, false);
  assert.equal(validatePaperQuote(quote([{ ...LINE, paperType: 'FBB', bf: 0 }])).ok, true);
  assert.equal(validatePaperQuote(quote([{ ...LINE, paperType: 'KRAFT', bf: 18 }])).ok, true);
});

// ── Valid but not ready — the distinction the design turns on ───────────────

test('a line with no paper type is valid and not ready', () => {
  const payload = quote([{ ...LINE, productName: 'CENTURY PRIMA FOLD', paperType: null, brand: 'PRIMA FOLD' }]);

  assert.equal(validatePaperQuote(payload).ok, true, 'structurally fine');

  const result = checkHandoff(payload);
  assert.equal(result.canHandOff, false);
  assert.equal(result.stage, 'INCOMPLETE');
  assert.equal(result.gaps[0].kind, 'PAPER_TYPE');
  assert.match(result.gaps[0].question, /PRIMA FOLD/);
});

test('untyped lines are grouped by brand, not listed per row', () => {
  // Sudarshan's Virgin list: ~28 rows, about a dozen brands. Twenty-eight
  // questions is a form nobody completes; twelve is a conversation. Teaching
  // one brand settles every GSM band and both forms beneath it.
  const lines = [
    { ...LINE, lineNo: 1, productName: 'CENTURY PRIMA FOLD RBD', paperType: null, brand: 'PRIMA FOLD' },
    { ...LINE, lineNo: 2, productName: 'CENTURY PRIMA FOLD RLS', paperType: null, brand: 'PRIMA FOLD' },
    { ...LINE, lineNo: 3, productName: 'ITC SAFIRE GRAPHIK RBD', paperType: null, brand: 'SAFIRE GRAPHIK' },
  ];
  const { gaps } = assessReadiness(validatePaperQuote(quote(lines)).data);

  const typeGaps = gaps.filter((g) => g.kind === 'PAPER_TYPE');
  assert.equal(typeGaps.length, 2, 'two brands, not three rows');
  assert.equal(typeGaps.find((g) => g.brand === 'PRIMA FOLD').lineCount, 2);
});

test('an unpriced line is reported as a misreading, not a question', () => {
  const { gaps } = assessReadiness(validatePaperQuote(quote([{ ...LINE, rate: null }])).data);
  const gap = gaps.find((g) => g.kind === 'NO_RATE');
  assert.ok(gap);
  assert.equal(gap.lineCount, 1);
});

test('unconfirmed terms are gathered once, not per row', () => {
  const lines = [
    { ...LINE, lineNo: 1, productName: 'UNI GLOBAL PDB 230-259', paperType: null, brand: 'PDB' },
    { ...LINE, lineNo: 2, productName: 'UNI GLOBAL PDB 260 & ABOVE', paperType: null, brand: 'PDB' },
  ];
  const { gaps } = assessReadiness(validatePaperQuote(quote(lines)).data);

  const unknown = gaps.filter((g) => g.kind === 'UNKNOWN_TERM');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].token, 'PDB');
});

test('a missing supplier or plant is a gap, not a validation error', () => {
  const payload = { lines: [LINE] };
  assert.equal(validatePaperQuote(payload).ok, true);

  const { gaps } = assessReadiness(validatePaperQuote(payload).data);
  assert.ok(gaps.some((g) => g.kind === 'SUPPLIER'));
  assert.ok(gaps.some((g) => g.kind === 'PLANT'));
});

test('a document with no lines says so', () => {
  const { gaps } = assessReadiness(validatePaperQuote(quote([])).data);
  assert.equal(gaps[0].kind, 'NO_LINES');
});

// ── Kraft derivations ───────────────────────────────────────────────────────

test('a derived kraft rate computes and shows its working', () => {
  // Natraj: 18 BF base 30.80 for 140-180 gsm, +0.25 at 120 gsm.
  const derivation = {
    base: 30.8,
    baseNote: '18 BF, 140-180 gsm',
    adjustments: [{ amount: 0.25, reason: '120 gsm' }],
  };
  assert.equal(applyDerivation(derivation), 31.05);
  assert.equal(
    explainDerivation(derivation),
    '30.8 (18 BF, 140-180 gsm) + 0.25 for 120 gsm = 31.05',
  );
});

test('several adjustments stack', () => {
  // Natraj 18 BF, 100 gsm, Sony Gold: 30.80 + 1.50 + 1.50.
  const derivation = {
    base: 30.8,
    baseNote: '18 BF',
    adjustments: [
      { amount: 1.5, reason: '100 gsm' },
      { amount: 1.5, reason: 'Sony Gold' },
    ],
  };
  assert.equal(applyDerivation(derivation), 33.8);
});

test('a derived line validates like any other', () => {
  const { ok, data } = validatePaperQuote(quote([{
    ...LINE,
    productName: 'KRAFT 18 BF 120 GSM',
    paperType: 'KRAFT',
    bf: 18,
    gsmFrom: 120,
    gsmTo: 120,
    rate: 31.05,
    derivation: { base: 30.8, baseNote: '18 BF, 140-180 gsm', adjustments: [{ amount: 0.25, reason: '120 gsm' }] },
  }]));
  assert.ok(ok);
  assert.equal(data.lines[0].derivation.adjustments.length, 1);
});

test('a derivation with no base yields nothing rather than zero', () => {
  // A missing base is not a free product.
  assert.equal(applyDerivation({ base: null, adjustments: [{ amount: 5 }] }), null);
  assert.equal(applyDerivation(null), null);
  assert.equal(explainDerivation(null), null);
});

// ── The handoff ─────────────────────────────────────────────────────────────

test('an invalid payload never reaches the readiness question', () => {
  // Structural failure is the agent's problem to fix; readiness is a question
  // for a person. Reporting both at once would confuse the two.
  const result = checkHandoff(quote([{ ...LINE, paperType: 'NONSENSE' }]));
  assert.equal(result.canHandOff, false);
  assert.equal(result.stage, 'INVALID');
  assert.ok(result.errors.length);
  assert.deepEqual(result.gaps, []);
});
