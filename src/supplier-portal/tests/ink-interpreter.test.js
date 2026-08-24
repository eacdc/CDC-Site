/**
 * The ink reading loop: what it asks, what it never asks twice, and what it
 * refuses to hand over.
 *
 * The rows here are verbatim from Print Sales' July 2026 quotation and
 * Siegwerk's price list. `send` and `research` are injected, so every one of
 * these runs without a key or a network — and several of them exist precisely
 * to assert that NO model call happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretInkQuote, applyInkAnswers, applySectionFacts, resolveKnownFields,
  inkRulesFromAnswers, attachResearch, researchableGaps, summariseInkQuote,
  NOT_MEANINGFUL,
} from '../services/ink/interpreter.js';
import {
  validateInkQuote, assessInkReadiness, checkInkHandoff, uncomparableLines,
} from '../services/ink/ink-quote-schema.js';

const line = (over = {}) => ({ lineNo: 1, productName: 'X', rate: 100, rateUom: 'KG', ...over });

const quote = (lines, over = {}) => ({
  supplierName: 'PRINT SALES PRIVATE LIMITED',
  lines,
  ...over,
});

// ── The gate ────────────────────────────────────────────────────────────────

test('a zero rate is rejected, not stored', () => {
  // Siegwerk's "UV DOLLAR SPL SILVER GREY" carries 0 in its Current Price
  // column. Accepted silently, zero sorts to the top of every cheapest-first
  // list and is the answer to a question nobody asked.
  const result = validateInkQuote(quote([line({ productName: 'UV DOLLAR SPL SILVER GREY', rate: 0 })]));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /greater than zero/);
});

test('water-based ink is refused as its own chemistry', () => {
  // The model is told about WATER_BASED for coatings and will reach for it on
  // an ink. Left alone the row keys on its own and is never compared.
  const result = validateInkQuote(quote([
    line({ productName: 'WB CDC SPL BLACK 2024', materialClass: 'INK', chemistry: 'WATER_BASED' }),
  ]));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /compared as CONVENTIONAL/);
});

test('a field on the wrong kind of row is a misfiling, and is caught', () => {
  const withColour = validateInkQuote(quote([
    line({ materialClass: 'PRESS_CHEMICAL', colour: 'CYAN' }),
  ]));
  assert.equal(withColour.ok, false);
  assert.match(withColour.errors[0].message, /Colour on a PRESS_CHEMICAL/);

  const withFinish = validateInkQuote(quote([line({ materialClass: 'INK', finish: 'GLOSS' })]));
  assert.equal(withFinish.ok, false);
});

test('a line missing its chemistry is VALID and NOT READY', () => {
  /*
    The distinction the whole conversation rests on. Siegwerk's sheet states a
    chemistry for none of its 82 rows; a schema that rejected it outright would
    leave the agent nothing to show and nothing to ask about.
  */
  const payload = quote([line({ productName: 'MYSTERY 500', materialClass: 'INK', colour: 'CYAN' })]);
  assert.equal(validateInkQuote(payload).ok, true);

  const gate = checkInkHandoff(payload);
  assert.equal(gate.stage, 'INCOMPLETE');
  assert.equal(gate.canHandOff, false);
  assert.ok(gate.gaps.some((g) => g.kind === 'CHEMISTRY'));
});

test('questions are grouped by what would answer them', () => {
  /*
    Eighty-two rows, eight families. Eighty-two questions is a form nobody
    completes; eight is a conversation, and each answer settles every colour and
    pack under that family, this month and next.
  */
  const lines = ['PROCESS CYAN', 'PROCESS MAGENTA', 'PROCESS YELLOW', 'PROCESS BLACK']
    .map((c, i) => line({
      lineNo: i + 1,
      productName: `NEWRANGE ${c}`,
      family: 'NEWRANGE',
      materialClass: 'INK',
      colour: c.split(' ')[1],
    }));

  const { gaps } = assessInkReadiness({ supplierName: 'X', lines });
  const chemistry = gaps.filter((g) => g.kind === 'CHEMISTRY');
  assert.equal(chemistry.length, 1);
  assert.equal(chemistry[0].subject, 'NEWRANGE');
  assert.equal(chemistry[0].lineCount, 4);
});

test('a question with no consequence is never asked', () => {
  // An additive has no colour. Asking anyway trains people to dismiss the
  // questions that matter.
  const { gaps } = assessInkReadiness({
    supplierName: 'X',
    lines: [line({ productName: 'UV LIQUID TACK REDUCER', materialClass: 'INK', chemistry: 'ADDITIVE' })],
  });
  assert.equal(gaps.filter((g) => g.kind === 'COLOUR').length, 0);
  assert.equal(gaps.length, 0);
});

test('a rate with no unit is a question, because two bases must never be sorted together', () => {
  const { gaps } = assessInkReadiness({
    supplierName: 'X',
    lines: [line({ productName: 'TEXTURE MATT', materialClass: 'COATING', chemistry: 'UV', finish: 'TEXTURE_MATT', rateUom: null })],
  });
  assert.ok(gaps.some((g) => g.kind === 'RATE_UOM'));
});

test('nothing passes the gate that would then be invisible in search', () => {
  /*
    Readiness is a list of rules written by hand; comparisonKey is what actually
    decides whether a row is ever compared. If those disagree, the row is stored
    looking complete and appears in no search — and nothing on any screen says
    so. This asserts they agree.
  */
  const lines = [
    line({ productName: 'RADICURE INTENSE 9000 PRO CYAN', materialClass: 'INK', chemistry: 'UV', role: 'PRESS_READY', colour: 'CYAN' }),
    line({ lineNo: 2, productName: 'ECNO WASH KR (20 LTR)', materialClass: 'PRESS_CHEMICAL', chemicalFunction: 'WASH', rateUom: 'LTR' }),
    line({ lineNo: 3, productName: 'UV GLOSS', materialClass: 'COATING', chemistry: 'UV', finish: 'GLOSS' }),
  ];
  const gate = checkInkHandoff(quote(lines));
  assert.equal(gate.stage, 'READY');
  assert.deepEqual(uncomparableLines(gate.data), []);
});

// ── Section headings ────────────────────────────────────────────────────────

test('a heading fills in every row beneath it', () => {
  /*
    On Print Sales' quotation the maker and the rate unit are stated once, in a
    heading, and never on a row. Without this every row on that document is
    missing its unit — one of the two ways a rate can be silently wrong.
  */
  const { payload } = applySectionFacts({
    lines: [
      { productName: 'RADICURE INTENSE 9000 PRO CYAN', section: 'DIC UV INK RATE PER KGS', rate: 830 },
      { productName: 'ECNO WASH KR (20 LTR)', section: 'PRESS CHEMICALS RATE PER LTR.', rate: 220 },
      { productName: 'CLEANFIX', section: 'BOETTCHER CHEMICALS RATE PER PC', rate: 1328 },
    ],
  });

  assert.equal(payload.lines[0].rateUom, 'KG');
  assert.equal(payload.lines[0].manufacturer, 'DIC');
  assert.equal(payload.lines[1].rateUom, 'LTR');
  assert.equal(payload.lines[2].rateUom, 'PC');
  assert.equal(payload.lines[2].manufacturer, 'BOETTCHER');
  assert.equal(payload.lines[0].basis, 'SECTION');
});

test('a row beats its heading', () => {
  // "ANTI SET OFF VERN POWDER 375.00/KG" sits under the per-litre heading and
  // says otherwise. The row is right.
  const { payload } = applySectionFacts({
    lines: [{
      productName: 'ANTI SET OFF VERN POWDER',
      section: 'PRESS CHEMICALS RATE PER LTR.',
      rate: 375,
      rateUom: 'KG',
    }],
  });
  assert.equal(payload.lines[0].rateUom, 'KG');
});

test('the vocabulary fills what it can before any question is asked', () => {
  const { payload } = resolveKnownFields({
    lines: [
      { productName: 'SICURA PLAST 770HS PROCESS CYAN', rate: 810, rateUom: 'KG' },
      { productName: 'ECNO WASH KR (20 LTR)', rate: 220, rateUom: 'LTR' },
      { productName: 'VEGA PRIME WARM RED PASTE 246', rate: 464, rateUom: 'KG' },
    ],
  });

  assert.equal(payload.lines[0].materialClass, 'INK');
  assert.equal(payload.lines[0].chemistry, 'UV');
  assert.equal(payload.lines[0].colour, 'CYAN');
  assert.equal(payload.lines[0].family, 'SICURA PLAST 770HS');

  assert.equal(payload.lines[1].chemicalFunction, 'WASH');
  assert.deepEqual(payload.lines[1].pack, { size: 20, uom: 'LTR', inBaseUom: 20 });

  assert.equal(payload.lines[2].role, 'MIXING_BASE');
  assert.equal(payload.lines[2].baseNumber, '246');
});

// ── Answers, and never asking twice ─────────────────────────────────────────

test('one answer settles every row of that family', () => {
  const payload = {
    lines: [
      { productName: 'NEWRANGE PROCESS CYAN', family: 'NEWRANGE', materialClass: 'INK', colour: 'CYAN' },
      { productName: 'NEWRANGE PROCESS BLACK', family: 'NEWRANGE', materialClass: 'INK', colour: 'BLACK' },
      { productName: 'OTHERRANGE BLACK', family: 'OTHERRANGE', materialClass: 'INK', colour: 'BLACK' },
    ],
  };

  const result = applyInkAnswers(payload, [{ kind: 'CHEMISTRY', subject: 'NEWRANGE', value: 'UV' }]);
  assert.equal(result.applied, 2);
  assert.equal(result.payload.lines[0].chemistry, 'UV');
  assert.equal(result.payload.lines[1].chemistry, 'UV');
  // And nothing settles a family it does not name.
  assert.equal(result.payload.lines[2].chemistry, undefined);
});

test('an answer never overwrites what was read from the document', () => {
  const payload = { lines: [{ productName: 'X', family: 'F', materialClass: 'INK', chemistry: 'CONVENTIONAL' }] };
  const result = applyInkAnswers(payload, [{ kind: 'CHEMISTRY', subject: 'F', value: 'UV' }]);
  assert.equal(result.payload.lines[0].chemistry, 'CONVENTIONAL');
});

test('a structured answer costs no model call at all', async () => {
  /*
    The commonest second round. The answer is a fact about a family and folding
    it in is a loop — going back to the model would cost a full document read to
    be told something already known, and give it the chance to revise a row
    nobody asked about.
  */
  let called = 0;
  const result = await interpretInkQuote({
    priorPayload: quote([
      line({ productName: 'NEWRANGE CYAN', family: 'NEWRANGE', materialClass: 'INK', colour: 'CYAN', role: 'PRESS_READY' }),
    ]),
    answers: [{ kind: 'CHEMISTRY', subject: 'NEWRANGE', value: 'UV' }],
    send: async () => { called += 1; return {}; },
  });

  assert.equal(called, 0);
  assert.equal(result.rounds, 0);
  assert.equal(result.stage, 'READY');
  assert.equal(result.payload.lines[0].chemistry, 'UV');
});

test('"it means nothing" is a real answer, and it survives', () => {
  /*
    "RL" trails a dozen Siegwerk rows. Some of these terms are pack codes, some
    marketing. Without a way to record a dismissal the same seven questions
    arrive with every monthly list.
  */
  const rules = inkRulesFromAnswers([{ kind: 'UNKNOWN_TERM', token: 'RL', value: NOT_MEANINGFUL }], { supplierGroupId: 'g1' });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].value, NOT_MEANINGFUL);
  assert.equal(rules[0].scope, 'SUPPLIER');
  assert.equal(rules[0].supplierGroupId, 'g1');
});

test('a dismissal counts as progress and does not go back to the model', async () => {
  let called = 0;
  const result = await interpretInkQuote({
    priorPayload: quote([
      line({ productName: 'RICH PALE GOLD INK RL', materialClass: 'INK', chemistry: 'CONVENTIONAL', colour: 'PALE_GOLD', role: 'PRESS_READY' }),
    ]),
    answers: [{ kind: 'UNKNOWN_TERM', token: 'RL', value: NOT_MEANINGFUL }],
    send: async () => { called += 1; return {}; },
  });

  assert.equal(called, 0);
  assert.equal(result.stage, 'READY');
});

test('a term settled this round is not asked about again in the same round', () => {
  // Without counting this round's own answers, answering "RL means nothing" is
  // accepted and the identical question comes straight back.
  const payload = quote([
    line({ productName: 'RICH PALE GOLD INK RL', materialClass: 'INK', chemistry: 'CONVENTIONAL', colour: 'PALE_GOLD' }),
  ]);
  const before = checkInkHandoff(payload);
  assert.ok(before.gaps.some((g) => g.token === 'RL'));

  const after = checkInkHandoff(payload, { settledTerms: ['RL'] });
  assert.equal(after.stage, 'READY');
});

test('rules carry who said so, because research is not a person', () => {
  const rules = inkRulesFromAnswers([
    { kind: 'CHEMISTRY', subject: 'SICURA', value: 'UV', source: 'RESEARCH' },
    { kind: 'CHEMISTRY', subject: 'VEGA', value: 'CONVENTIONAL' },
  ]);
  assert.equal(rules[0].source, 'RESEARCH');
  assert.equal(rules[1].source, 'PERSON');
});

// ── Research ────────────────────────────────────────────────────────────────

test('only questions the world could answer are looked up', () => {
  // "Who sent this quote?" and "3 lines carry no rate" are about this document.
  // Searching for them spends a call to produce nothing.
  const gaps = [
    { kind: 'CHEMISTRY', subject: 'SICURA PLAST 770HS' },
    { kind: 'CHEMICAL_FUNCTION', subject: 'CLEANFIX' },
    { kind: 'SUPPLIER', question: 'Who sent this quote?' },
    { kind: 'NO_RATE', lineCount: 3 },
    { kind: 'RATE_UOM', lineCount: 2 },
  ];
  assert.deepEqual(researchableGaps(gaps).map((g) => g.subject), ['SICURA PLAST 770HS', 'CLEANFIX']);
});

test('research proposes; it does not decide', () => {
  /*
    The proposal rides with the question so a person sees the evidence and one
    click both answers it and makes it permanent. Applied silently, a
    plausible-but-wrong search result merges two products that should never
    have been compared — and nobody would ever know it happened.
  */
  const gaps = [{ kind: 'CHEMICAL_FUNCTION', subject: 'CLEANFIX', question: 'What is "CLEANFIX" used for?' }];
  const [gap] = attachResearch(gaps, [{
    subject: 'CLEANFIX',
    field: 'chemicalFunction',
    value: 'ROLLER_CARE',
    summary: 'Böttcher roller and blanket cleaner',
    source: 'boettcher.com',
    confidence: 0.9,
  }]);

  assert.equal(gap.proposal.value, 'ROLLER_CARE');
  assert.equal(gap.proposal.source, 'boettcher.com');
  // The question is still a question — nothing was written to a line.
  assert.equal(gap.kind, 'CHEMICAL_FUNCTION');
});

test('a finding for the wrong field is ignored', () => {
  const gaps = [{ kind: 'CHEMISTRY', subject: 'CLEANFIX' }];
  const [gap] = attachResearch(gaps, [{ subject: 'CLEANFIX', field: 'chemicalFunction', value: 'ROLLER_CARE' }]);
  assert.equal(gap.proposal, undefined);
});

test('a failed search leaves the question intact', async () => {
  /*
    Research improves a question; it is not the question. A search that times
    out must not fail the whole reading — the document is still perfectly
    answerable by somebody who buys ink.
  */
  const result = await interpretInkQuote({
    pages: [],
    send: async () => ({
      understanding: 'A Siegwerk price list.',
      payload: quote([{ lineNo: 1, productName: 'MYSTERY 500', family: 'MYSTERY', rate: 100, rateUom: 'KG', materialClass: 'INK', colour: 'CYAN' }]),
    }),
    research: async () => { throw new Error('search timed out'); },
  });

  assert.equal(result.stage, 'INCOMPLETE');
  assert.ok(result.questions.some((g) => g.kind === 'CHEMISTRY'));
  assert.equal(result.questions[0].proposal, undefined);
});

// ── The loop ────────────────────────────────────────────────────────────────

test('a structural failure is repaired by the model, at most twice', async () => {
  let calls = 0;
  const result = await interpretInkQuote({
    send: async () => {
      calls += 1;
      return { payload: quote([line({ rate: 0 })]) }; // never valid
    },
  });

  assert.equal(calls, 3); // one attempt plus two repairs
  assert.equal(result.stage, 'INVALID');
});

test('an unanswerable question is not repaired — it is asked', async () => {
  let calls = 0;
  const result = await interpretInkQuote({
    send: async () => {
      calls += 1;
      return { payload: quote([line({ productName: 'MYSTERY 500', materialClass: 'INK', colour: 'CYAN' })]) };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.stage, 'INCOMPLETE');
});

test('a clean read hands over on the first pass', async () => {
  const result = await interpretInkQuote({
    send: async () => ({
      understanding: 'Print Sales, a dealer, quoting DIC and Boettcher.',
      payload: quote([{
        lineNo: 1,
        productName: 'RADICURE INTENSE 9000 PRO CYAN',
        section: 'DIC UV INK RATE PER KGS',
        rate: 830,
      }]),
    }),
  });

  assert.equal(result.stage, 'READY');
  assert.equal(result.payload.lines[0].chemistry, 'UV');
  assert.equal(result.payload.lines[0].colour, 'CYAN');
  assert.equal(result.payload.lines[0].rateUom, 'KG');
  assert.equal(result.payload.lines[0].manufacturer, 'DIC');
});

test('next month starts from how last month was read', () => {
  const summary = summariseInkQuote(quote([
    line({ productName: 'SICURA PLAST 770HS PROCESS CYAN', family: 'SICURA PLAST 770HS', materialClass: 'INK', chemistry: 'UV' }),
    line({ lineNo: 2, productName: 'VEGA SPRINT PROCESS CYAN', family: 'VEGA SPRINT', materialClass: 'INK', chemistry: 'CONVENTIONAL' }),
  ]));

  assert.match(summary, /SICURA PLAST 770HS -> INK \/ UV/);
  assert.match(summary, /VEGA SPRINT -> INK \/ CONVENTIONAL/);
});

// ── Rows that a real document produced and the schema wrongly refused ────────

/**
 * Three validation errors on one reading of Print Sales' quotation, all of them
 * the schema being stricter than the world:
 *
 *   lines.20.chemicalFunction: Chemical function on a CONSUMABLE row
 *   lines.34.pack.uom: Invalid option: expected one of "KG"|"LTR"|"PC"
 *   lines.35.pack.uom: Invalid option: expected one of "KG"|"LTR"|"PC"
 *
 * A whole forty-three row document was rejected over a powder and two bottle
 * sizes — details that change no rate and no comparison. The trade is badly
 * wrong in that direction: a schema exists to stop a bad rate being stored, not
 * to stop a good document being read.
 */

test('a consumable may have a function', () => {
  // "ANTI SET OFF VERN POWDER" is a consumable by any reading — a powder, not a
  // liquid chemical — and ANTI_SET_OFF is exactly what it does. The rule was
  // written to catch misfiling and instead rejected a row it had understood.
  const ok = validateInkQuote(quote([line({
    productName: 'ANTI SET OFF VERN POWDER',
    materialClass: 'CONSUMABLE',
    chemicalFunction: 'ANTI_SET_OFF',
    rate: 375,
  })]));
  assert.equal(ok.ok, true);

  // An ink or a coating still may not carry one: there it really would mean
  // something has been put in the wrong place.
  assert.equal(validateInkQuote(quote([line({
    materialClass: 'INK', chemicalFunction: 'WASH',
  })])).ok, false);
});

test('a pack size in millilitres is read, not refused', () => {
  const ok = validateInkQuote(quote([
    line({ productName: 'DEEP KLEEN SHAMPOO (500 ML)', pack: { size: 500, uom: 'ML' } }),
    line({ lineNo: 2, productName: 'BLANKET SAVER (250 ML)', pack: { size: 250, uom: 'ml' } }),
  ]));

  assert.equal(ok.ok, true);
  assert.equal(ok.data.lines[0].pack.uom, 'ML');
  // Case and plural spellings are normalised rather than rejected.
  assert.equal(ok.data.lines[1].pack.uom, 'ML');
});

test('every spelling a quote uses for a pack is accepted', () => {
  for (const [printed, expected] of [
    ['KGS', 'KG'], ['kg', 'KG'], ['GM', 'GM'], ['grams', 'GM'],
    ['LTRS', 'LTR'], ['Litre', 'LTR'], ['L', 'LTR'], ['ML', 'ML'],
    ['PCS', 'PC'], ['NOS', 'PC'], ['unit', 'PC'],
  ]) {
    const parsed = validateInkQuote(quote([line({ pack: { size: 1, uom: printed } })]));
    assert.equal(parsed.ok, true, printed);
    assert.equal(parsed.data.lines[0].pack.uom, expected, printed);
  }
});

test('an unrecognised pack unit becomes null rather than failing the document', () => {
  /*
    The pack is context for a person, never arithmetic. Not knowing it costs
    nothing; losing a forty-three row reading over it costs the whole document.
  */
  const ok = validateInkQuote(quote([line({ pack: { size: 1, uom: 'DRUM' } })]));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.lines[0].pack.uom, null);
  // The size is still there, because the document did say one.
  assert.equal(ok.data.lines[0].pack.size, 1);
});

test('a rate that is wrong is still refused', () => {
  // The looseness above is about details that change no comparison. Anything
  // that decides a price stays exactly as strict as it was.
  assert.equal(validateInkQuote(quote([line({ rate: 0 })])).ok, false);
  assert.equal(validateInkQuote(quote([line({ materialClass: 'INK', chemistry: 'WATER_BASED' })])).ok, false);
  assert.equal(validateInkQuote(quote([line({ materialClass: 'COATING', colour: 'CYAN' })])).ok, false);
});
