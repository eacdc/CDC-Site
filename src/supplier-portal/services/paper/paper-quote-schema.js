/**
 * The contract between the interpreting agent and the database.
 *
 * The conversational layer is free-form on purpose: it reads a document, says
 * what it understood, and asks about what it could not. The exit from that
 * conversation is not free-form at all. This module is the gate.
 *
 * WHY A GATE AT ALL. An agent that talks until it feels finished can produce
 * something fluent that does not fit — `paperType: "premium coated board"`
 * when the canonical list has no such entry. Fluent and wrong is worse than the
 * failures this project has already had, because it looks finished. So the
 * agent proposes and this validates; nothing reaches storage on the agent's own
 * assessment that it is done.
 *
 * TWO QUESTIONS, KEPT SEPARATE, AND THE SEPARATION IS THE DESIGN.
 *
 *   `validatePaperQuote` asks: is this structurally sound? Are the enums real,
 *   the numbers numbers, the bands the right way round?
 *
 *   `assessReadiness` asks: is this finished? Does every line have a paper type
 *   and a rate?
 *
 * A line with no paper type is VALID and NOT READY. That distinction is what
 * makes the conversation possible. Sudarshan's Virgin list states a type for
 * none of its ~28 products; a schema that rejected it outright would leave the
 * agent nothing to show and nothing to ask about. Instead the payload survives,
 * the gaps are named, and the agent asks — which is the entire point.
 *
 * WHAT IS PRINTED IS NEVER DISCARDED. Every interpreted value keeps the text it
 * came from: `rate` beside `rateText`, `gsmFrom`/`gsmTo` beside `gsmText`. A
 * reviewer checking "115 & ABOVE" against 115/null can see both, and a
 * misreading is visible rather than inferred.
 */

import { z } from 'zod';
import { PAPER_TYPES, unconfirmedTokens } from '../../config/paper-vocabulary.js';

const PAPER_TYPE_VALUES = PAPER_TYPES.map((t) => t.canonical);

/** How a paper type came to be on a line. Provenance, not decoration. */
export const TYPE_BASIS = ['STATED', 'BRAND', 'TAUGHT', 'ASKED'];

/**
 * A number the agent read off the page.
 *
 * Accepts a numeric string because an agent asked for JSON returns "78.50" as
 * often as 78.50, and failing a whole document over the quotes around a number
 * is the mistake this codebase already made once with `lineNo`.
 */
const num = () => z.preprocess((v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.-]/g, '');
    if (cleaned === '' || Number.isNaN(Number(cleaned))) return v;
    return Number(cleaned);
  }
  return v;
}, z.number().nullable());

/**
 * Text as printed. A number here is stringified rather than rejected.
 *
 * Absent and null mean the same thing, and both become null. Declaring these
 * nullable but not optional made every omitted key a validation failure — a
 * quote that simply had no GSTIN on it failed on `supplierGstin`, which is not
 * a fault in the document. The same rule holds as for the extraction schema: a
 * field must never reject a payload that does not carry it.
 */
const text = () => z.preprocess((v) => {
  if (v === undefined) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}, z.string().nullable());

/**
 * How a derived rate was arrived at.
 *
 * The kraft quote states four prices and implies about thirty: a base rate per
 * mill and BF, then adjustments by GSM band and by variety. Those thirty rows
 * are expanded at interpretation so that search stays a plain lookup — but an
 * expanded row that cannot show its working is a number nobody can check.
 *
 *   31.05 = 30.80 base + 0.25 for 120 gsm
 */
export const DerivationSchema = z.object({
  base: num(),
  baseNote: text(),
  adjustments: z.array(z.object({
    amount: num(),
    reason: text(),
  })).default([]),
});

export const PaperLineSchema = z.object({
  lineNo: num(),

  /**
   * The product exactly as the document names it. Required, and it is the
   * anchor for everything else: it is what a reviewer recognises, what a
   * learned rule is keyed on, and what next month's identical list matches
   * against.
   */
  productName: z.string().min(1),

  paperType: z.enum(PAPER_TYPE_VALUES).nullable().default(null),
  paperTypeBasis: z.enum(TYPE_BASIS).nullable().default(null),

  gsmText: text(),
  gsmFrom: num(),
  // Null is meaningful: "115 & ABOVE" has no top, and so does "296 & ABOVE".
  gsmTo: num(),

  /**
   * The plant this one row prices, when the document prices both side by side.
   *
   * Absent from the first cut of this schema, so Zod stripped it — the split
   * filter did its work on the raw payload and validation then threw away the
   * evidence it had worked from. Null on a single-plant document, where the
   * document-level plant applies.
   */
  plant: text(),

  form: z.enum(['SHEET', 'REEL']).nullable().default(null),
  shade: z.enum(['NATURAL']).nullable().default(null),
  bulk: z.enum(['HIGH']).nullable().default(null),
  surfaceSized: z.enum(['SS', 'NON_SS']).nullable().default(null),

  /** Burst factor. Kraft only; every other paper leaves it null. */
  bf: num(),

  mill: text(),
  brand: text(),

  rateText: text(),
  rate: num(),
  rateUom: z.enum(['KGS', 'MT']).default('KGS'),
  supplyMode: z.enum(['MILL_ORDER', 'EX_STOCK']).nullable().default(null),

  derivation: DerivationSchema.nullable().default(null),
  confidence: num(),
}).superRefine((line, ctx) => {
  if (line.gsmFrom != null && line.gsmTo != null && line.gsmFrom > line.gsmTo) {
    ctx.addIssue({
      code: 'custom',
      path: ['gsmFrom'],
      message: `GSM band runs backwards: ${line.gsmFrom} to ${line.gsmTo}`,
    });
  }
  if (line.rate != null && line.rate <= 0) {
    ctx.addIssue({ code: 'custom', path: ['rate'], message: 'A rate must be greater than zero' });
  }
  /*
    BF is meaningful only for kraft. CDC's ERP stores 0 on every other paper as
    a placeholder, so 0 is accepted and treated as absent; a real BF on a
    non-kraft line means the agent has put something in the wrong field.
  */
  if (line.bf != null && line.bf > 0 && line.paperType && line.paperType !== 'KRAFT') {
    ctx.addIssue({
      code: 'custom',
      path: ['bf'],
      message: `BF ${line.bf} on ${line.paperType}; burst factor applies to kraft only`,
    });
  }
});

export const PaperQuoteSchema = z.object({
  materialCategory: z.literal('PAPER_BOARD').default('PAPER_BOARD'),

  supplierName: text(),
  supplierGstin: text(),

  /**
   * What kind of list this is, in the document's own words — "DO BASED
   * EX-STOCK PRICE LIST - RECYCLED BOARD", "FBB & SBS".
   *
   * Kept because it narrows a whole document at once. Sudarshan's four lists
   * are Virgin, Recycled, Maplitho and Coated, and knowing which one is in
   * hand turns twenty-eight questions into one. It never *decides* a type —
   * KV files a CBB under a heading reading "FBB & SBS".
   */
  listContext: text(),

  plant: z.enum(['KOLKATA', 'AHMEDABAD']).nullable().default(null),
  effectiveFrom: text(),
  effectiveTo: text(),
  isSoftQuote: z.boolean().nullable().default(null),

  commercialTerms: z.object({
    creditDays: num(),
    freightTerms: text(),
    insurance: text(),
    gstNote: text(),
    paymentTerms: text(),
  }).nullable().default(null),

  /** Rules stated in prose: "sheet price 1.00 extra", "reel cut Rs 1/kg extra". */
  statedRules: z.array(z.object({
    kind: text(),
    text: text(),
    value: text(),
  })).default([]),

  lines: z.array(PaperLineSchema).default([]),
});

/**
 * Is this payload structurally sound?
 *
 * Never throws. The agent needs the errors back in a form it can act on, and
 * an exception at this boundary would end the conversation instead of
 * continuing it.
 */
export function validatePaperQuote(payload) {
  const parsed = PaperQuoteSchema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data, errors: [] };

  return {
    ok: false,
    data: null,
    errors: parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

/**
 * Is this payload finished?
 *
 * Gaps are grouped by what would answer them, not listed per row, and that is
 * the whole ergonomics of this design. Sudarshan's Virgin list has ~28 rows
 * with no paper type across about a dozen brands. Twenty-eight questions is a
 * form nobody completes; twelve is a conversation. Teaching one brand settles
 * every GSM band and both forms under it, this month and next.
 */
export function assessReadiness(data, { settledTokens = [] } = {}) {
  const gaps = [];
  const lines = data?.lines || [];
  const settled = new Set(settledTokens.map((t) => String(t).toUpperCase()));

  if (!lines.length) {
    gaps.push({ kind: 'NO_LINES', question: 'No priced lines were read from this document.' });
  }

  // Paper type, grouped by the brand that would answer it.
  const needType = new Map();
  for (const line of lines) {
    if (line.paperType) continue;
    const key = line.brand || line.productName;
    if (!needType.has(key)) needType.set(key, { brand: key, lines: [], examples: [] });
    const entry = needType.get(key);
    entry.lines.push(line.lineNo);
    if (entry.examples.length < 3) entry.examples.push(line.productName);
  }
  for (const entry of needType.values()) {
    gaps.push({
      kind: 'PAPER_TYPE',
      brand: entry.brand,
      lineCount: entry.lines.length,
      examples: entry.examples,
      question: `What paper type is "${entry.brand}"?`,
    });
  }

  // A line with no rate is not a line. This is a misread, not a question.
  const unpriced = lines.filter((l) => l.rate == null);
  if (unpriced.length) {
    gaps.push({
      kind: 'NO_RATE',
      lineCount: unpriced.length,
      examples: unpriced.slice(0, 3).map((l) => l.productName),
      question: `${unpriced.length} line(s) carry no rate.`,
    });
  }

  // Abbreviations nobody has confirmed, gathered once rather than per row.
  const unknown = new Map();
  for (const line of lines) {
    for (const token of unconfirmedTokens(line.productName)) {
      // Asked and answered once. A term CDC has already ruled on — either as a
      // paper type or as "not one" — must stop being asked, or the same three
      // questions arrive with every monthly list.
      if (settled.has(token.toUpperCase())) continue;
      if (!unknown.has(token)) unknown.set(token, []);
      if (unknown.get(token).length < 3) unknown.get(token).push(line.productName);
    }
  }
  for (const [token, examples] of unknown) {
    gaps.push({
      kind: 'UNKNOWN_TERM',
      token,
      examples,
      question: `What does "${token}" mean?`,
    });
  }

  if (!data?.supplierName) {
    gaps.push({ kind: 'SUPPLIER', question: 'Who sent this quote?' });
  }
  if (!data?.plant) {
    gaps.push({ kind: 'PLANT', question: 'Which plant do these rates apply to?' });
  }

  return { ready: gaps.length === 0, gaps };
}

/**
 * The gate: structurally sound AND finished.
 *
 * Nothing reaches the regular pipeline without passing both. `validatePaperQuote`
 * failing is the agent's problem to fix; `assessReadiness` failing is a question
 * for a person.
 */
export function checkHandoff(payload, { settledTokens = [] } = {}) {
  const validation = validatePaperQuote(payload);
  if (!validation.ok) {
    return { canHandOff: false, stage: 'INVALID', errors: validation.errors, gaps: [], data: null };
  }

  const readiness = assessReadiness(validation.data, { settledTokens });
  return {
    canHandOff: readiness.ready,
    stage: readiness.ready ? 'READY' : 'INCOMPLETE',
    errors: [],
    gaps: readiness.gaps,
    data: validation.data,
  };
}

/**
 * Apply a derivation and return the rate it produces.
 *
 * Exported so the expansion can be tested on its own and shown to a reviewer as
 * arithmetic rather than as an assertion.
 */
export function applyDerivation(derivation) {
  if (!derivation || derivation.base == null) return null;
  return (derivation.adjustments || []).reduce(
    (total, a) => total + (a.amount || 0),
    derivation.base,
  );
}

/** "30.80 base + 0.25 for 120 gsm = 31.05" — the working, for a person. */
export function explainDerivation(derivation) {
  if (!derivation || derivation.base == null) return null;
  const parts = [`${derivation.base}${derivation.baseNote ? ` (${derivation.baseNote})` : ''}`];
  for (const a of derivation.adjustments || []) {
    const sign = (a.amount || 0) < 0 ? '−' : '+';
    parts.push(`${sign} ${Math.abs(a.amount || 0)}${a.reason ? ` for ${a.reason}` : ''}`);
  }
  return `${parts.join(' ')} = ${applyDerivation(derivation)}`;
}
