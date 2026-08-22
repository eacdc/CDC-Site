/**
 * The contract between the interpreting agent and the database, for ink.
 *
 * Same shape as the paper gate and for the same reason: the conversation is
 * free-form, the exit from it is not. An agent that talks until it feels
 * finished can produce something fluent that does not fit — `colour: "a nice
 * warm red"` where the canonical list has WARM_RED — and fluent-and-wrong is
 * worse than the failures this project has already had, because it looks done.
 *
 * TWO QUESTIONS, KEPT SEPARATE.
 *
 *   `validateInkQuote`  is this structurally sound? Are the enums real, the
 *                       numbers numbers, the fields on the right kind of row?
 *
 *   `assessInkReadiness` is this finished? Does every line have the fields its
 *                       own comparison key needs?
 *
 * A line with no chemistry is VALID and NOT READY, and that distinction is what
 * makes the conversation possible. The Siegwerk sheet states a chemistry for
 * none of its 82 rows; a schema that rejected it outright would leave the agent
 * nothing to show and nothing to ask about.
 *
 * WHAT THE KEY NEEDS IS WHAT IS ASKED FOR. The readiness rules here are not a
 * wish list — each one names a field without which `comparisonKey` returns null,
 * meaning the row would be stored and then never appear in any comparison. That
 * is the failure this whole category exists to prevent, and it is silent.
 *
 * WHAT IS PRINTED IS NEVER DISCARDED. `rate` keeps `rateText` beside it, so a
 * reviewer checking "830 .00" against 830 can see both.
 */

import { z } from 'zod';
import {
  MATERIAL_CLASSES, CHEMISTRIES, INK_ROLES, COLOURS, COATING_FINISHES,
  COATING_PROPERTIES, CHEMICAL_FUNCTIONS, RATE_UOMS,
  unconfirmedInkTokens, comparisonKey,
} from '../../config/ink-vocabulary.js';

const CLASS_VALUES = MATERIAL_CLASSES.map((c) => c.canonical);
const CHEMISTRY_VALUES = CHEMISTRIES.map((c) => c.canonical);
const ROLE_VALUES = INK_ROLES.map((r) => r.canonical);
const COLOUR_VALUES = COLOURS.map((c) => c.canonical);
const FINISH_VALUES = COATING_FINISHES.map((f) => f.canonical);
const PROPERTY_VALUES = COATING_PROPERTIES.map((p) => p.value);
const FUNCTION_VALUES = CHEMICAL_FUNCTIONS.map((f) => f.canonical);

/** How a value came to be on a line. Provenance, not decoration. */
export const INK_BASIS = ['STATED', 'SECTION', 'FAMILY', 'TAUGHT', 'RESEARCHED', 'ASKED'];

/** A number the agent read off the page. Numeric strings are accepted. */
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
 * Text as printed. Absent and null mean the same thing, and both become null —
 * a field must never reject a payload that does not carry it.
 */
const text = () => z.preprocess((v) => {
  if (v === undefined) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}, z.string().nullable());

/**
 * What you must buy, which is not what you are charged for.
 *
 * "ECNO WASH KR (20 LTR)" at 220 under "RATE PER LTR." is 220 a litre and 4,400
 * a can. The two live in different fields so that they cannot be confused, and
 * the pack is recorded even though it never enters the arithmetic: somebody
 * ordering a litre of something sold only in fifties needs to see that first.
 */
export const PackSchema = z.object({
  size: num(),
  uom: z.enum(['KG', 'LTR', 'PC']).nullable().default(null),
  inBaseUom: num(),
});

/**
 * A plate, which is priced per piece by its dimensions.
 *
 * The only place in this category where a rate is derived rather than printed:
 * Print Sales heads the section "(470.00/m²)" and every rate below it is that
 * number times the area. 790 x 1030 is 0.8137 m², and 0.8137 x 470 is 382.44 —
 * the figure printed. Keeping the rate per m² beside the piece rate is what
 * lets a reviewer check that in their head.
 */
export const PlateSpecSchema = z.object({
  lengthMm: num(),
  widthMm: num(),
  thicknessMm: num(),
  ratePerSqm: num(),
});

export const InkLineSchema = z.object({
  lineNo: num(),

  /**
   * The product exactly as the document names it. Required, and the anchor for
   * everything else: what a reviewer recognises, what a learned rule is keyed
   * on, and what next month's identical list matches against.
   */
  productName: z.string().min(1),

  /** The maker's or dealer's own code — Siegwerk 71-100023-2.2690, DIC 120000201834. */
  productCode: text(),

  /**
   * The heading this row sat under, verbatim — "DIC UV INK RATE PER KGS".
   *
   * Declared because it is read, and the paper schema has already taught this
   * lesson the expensive way: `plant` was left out there, so Zod stripped it,
   * the split filter did its work on the raw payload and validation then threw
   * away the evidence it had worked from. On a dealer's quote the heading is
   * the only place the maker and the rate unit appear at all, so losing it
   * makes the reading unauditable.
   */
  section: text(),

  materialClass: z.enum(CLASS_VALUES).nullable().default(null),
  chemistry: z.enum(CHEMISTRY_VALUES).nullable().default(null),
  role: z.enum(ROLE_VALUES).nullable().default(null),

  colour: z.enum(COLOUR_VALUES).nullable().default(null),
  /** The Pantone base number, where a mixing base carries one: 517, 706, 228. */
  baseNumber: text(),

  finish: z.enum(FINISH_VALUES).nullable().default(null),
  /** Recorded, never compared on: high slip, foil stampable. */
  coatingProperty: z.enum(PROPERTY_VALUES).nullable().default(null),

  chemicalFunction: z.enum(FUNCTION_VALUES).nullable().default(null),

  /**
   * The maker, which on a dealer's quote is a section heading rather than a
   * field, and which deliberately does NOT enter the comparison key. Recorded
   * because "who is cheapest on DIC Radicure" is otherwise unanswerable.
   */
  manufacturer: text(),
  /** How a buyer recognises the row: "Sicura Plast 770HS", "Vega Sprint". */
  family: text(),

  basis: z.enum(INK_BASIS).nullable().default(null),

  rateText: text(),
  rate: num(),
  rateUom: z.enum(RATE_UOMS).nullable().default(null),

  pack: PackSchema.nullable().default(null),
  plate: PlateSpecSchema.nullable().default(null),

  /**
   * A rate the document announces but does not yet charge.
   *
   * Siegwerk's sheet carries a proposed second increase alongside the current
   * price. CDC takes the post-increase figure as the rate, so the *earlier*
   * price is what is optional here — kept so a reviewer can see the movement
   * rather than a bare new number.
   */
  previousRate: num(),

  confidence: num(),
}).superRefine((line, ctx) => {
  if (line.rate != null && line.rate <= 0) {
    /*
      Siegwerk's "UV DOLLAR SPL SILVER GREY" carries 0 in the Current Price
      column. Zero is not a price, and accepted silently it would sort to the
      top of every cheapest-first list.
    */
    ctx.addIssue({ code: 'custom', path: ['rate'], message: 'A rate must be greater than zero' });
  }

  /*
    Water-based INK is conventional ink — confirmed by CDC. The vocabulary folds
    it, and the schema says so too, because a model told about WATER_BASED for
    coatings will reach for it on an ink and the row would then key on its own
    and never be compared with anything.
  */
  if (line.materialClass === 'INK' && line.chemistry === 'WATER_BASED') {
    ctx.addIssue({
      code: 'custom',
      path: ['chemistry'],
      message: 'Water-based ink is compared as CONVENTIONAL; WATER_BASED is for coatings only',
    });
  }

  if (line.materialClass === 'COATING' && line.chemistry && line.chemistry !== 'UV' && line.chemistry !== 'WATER_BASED') {
    ctx.addIssue({
      code: 'custom',
      path: ['chemistry'],
      message: `A coating is UV or WATER_BASED, not ${line.chemistry}`,
    });
  }

  // Fields on the wrong kind of row mean the agent has misfiled something, and
  // the misfiling is invisible once stored.
  if (line.colour && line.materialClass && line.materialClass !== 'INK') {
    ctx.addIssue({ code: 'custom', path: ['colour'], message: `Colour on a ${line.materialClass} row` });
  }
  if (line.finish && line.materialClass && line.materialClass !== 'COATING') {
    ctx.addIssue({ code: 'custom', path: ['finish'], message: `Coating finish on a ${line.materialClass} row` });
  }
  if (line.chemicalFunction && line.materialClass && line.materialClass !== 'PRESS_CHEMICAL') {
    ctx.addIssue({ code: 'custom', path: ['chemicalFunction'], message: `Chemical function on a ${line.materialClass} row` });
  }
  if (line.plate && line.materialClass && line.materialClass !== 'PLATE') {
    ctx.addIssue({ code: 'custom', path: ['plate'], message: `Plate dimensions on a ${line.materialClass} row` });
  }

  if (line.pack?.size != null && line.pack.size <= 0) {
    ctx.addIssue({ code: 'custom', path: ['pack', 'size'], message: 'A pack size must be greater than zero' });
  }
});

export const InkQuoteSchema = z.object({
  materialCategory: z.literal('INK_COATING').default('INK_COATING'),

  supplierName: text(),
  supplierGstin: text(),

  /**
   * Whether the supplier makes what it sells.
   *
   * Print Sales is a dealer for DIC, Boettcher and Capri; Siegwerk quotes its
   * own. It changes what a section heading means — on a dealer's list a heading
   * names the maker, on a manufacturer's it names a range — and it changes what
   * "cheapest" means, because two dealers can quote the same maker's product.
   */
  supplierIsDealer: z.boolean().nullable().default(null),

  /** What kind of list this is, in the document's own words. */
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

  /** Rules stated in prose: "GST extra", "no further discount on the above price". */
  statedRules: z.array(z.object({
    kind: text(),
    text: text(),
    value: text(),
  })).default([]),

  lines: z.array(InkLineSchema).default([]),
});

/** Is this payload structurally sound? Never throws — the agent needs the errors. */
export function validateInkQuote(payload) {
  const parsed = InkQuoteSchema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data, errors: [] };

  return {
    ok: false,
    data: null,
    errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/**
 * Is this payload finished?
 *
 * Every gap here names a field without which `comparisonKey` returns null. That
 * is the point: a row missing one of these is stored, looks fine in the review
 * table, and then never appears in a single comparison. Nothing on any screen
 * would say so.
 *
 * Gaps are grouped by WHAT WOULD ANSWER THEM rather than listed per row, which
 * is the whole ergonomics of the design. Siegwerk's 82 rows state a chemistry
 * for none of them, across about eight product families. Eighty-two questions is
 * a form nobody completes; eight is a conversation, and each answer settles
 * every colour and pack under that family, this month and next.
 */
export function assessInkReadiness(data, { settledTerms = [] } = {}) {
  const gaps = [];
  const lines = data?.lines || [];
  const settled = new Set(settledTerms.map((t) => String(t).toUpperCase()));

  if (!lines.length) {
    gaps.push({ kind: 'NO_LINES', question: 'No priced lines were read from this document.' });
  }

  // What kind of thing it is. Nothing else can be asked until this is known.
  group(lines.filter((l) => !l.materialClass), (l) => l.family || l.productName)
    .forEach((entry) => gaps.push({
      kind: 'MATERIAL_CLASS',
      subject: entry.key,
      lineCount: entry.count,
      examples: entry.examples,
      question: `Is "${entry.key}" an ink, a coating, a press chemical, a plate or a consumable?`,
    }));

  /*
    Chemistry, grouped by product family — the single most valuable question in
    this category. It is half the comparison key, it is almost never printed,
    and one answer settles a whole range.
  */
  group(
    lines.filter((l) => (l.materialClass === 'INK' || l.materialClass === 'COATING') && !l.chemistry),
    (l) => l.family || l.productName,
  ).forEach((entry) => gaps.push({
    kind: 'CHEMISTRY',
    subject: entry.key,
    lineCount: entry.count,
    examples: entry.examples,
    question: `Is "${entry.key}" UV, conventional, web or an additive?`,
  }));

  // Colour on an ink that has one to give. Additives genuinely have none, so
  // asking there would be a question with no consequence attached — and a
  // screen that asks those trains people to dismiss the ones that matter.
  group(
    lines.filter((l) => l.materialClass === 'INK' && l.chemistry && l.chemistry !== 'ADDITIVE' && !l.colour),
    (l) => l.productName,
  ).forEach((entry) => gaps.push({
    kind: 'COLOUR',
    subject: entry.key,
    lineCount: entry.count,
    examples: entry.examples,
    question: `What colour is "${entry.key}"?`,
  }));

  group(
    lines.filter((l) => l.materialClass === 'COATING' && !l.finish),
    (l) => l.family || l.productName,
  ).forEach((entry) => gaps.push({
    kind: 'FINISH',
    subject: entry.key,
    lineCount: entry.count,
    examples: entry.examples,
    question: `What finish does "${entry.key}" give — gloss, matt, texture, soft touch, primer or sealer?`,
  }));

  group(
    lines.filter((l) => l.materialClass === 'PRESS_CHEMICAL' && !l.chemicalFunction),
    (l) => l.productName,
  ).forEach((entry) => gaps.push({
    kind: 'CHEMICAL_FUNCTION',
    subject: entry.key,
    lineCount: entry.count,
    examples: entry.examples,
    question: `What is "${entry.key}" used for — wash, fount, plate, blanket, roller, gum, developer, anti set-off or solvent?`,
  }));

  /*
    The rate unit, which on these documents lives in a section header and not on
    the row. Without it two numbers in different bases can be sorted against
    each other: a plate at 382 a piece and a varnish at 400 a kilo.
  */
  const noUom = lines.filter((l) => l.rate != null && !l.rateUom);
  if (noUom.length) {
    gaps.push({
      kind: 'RATE_UOM',
      lineCount: noUom.length,
      examples: noUom.slice(0, 3).map((l) => l.productName),
      question: `${noUom.length} line(s) do not say what the rate is per — kg, litre, piece, m² or unit?`,
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

  // Terms nobody has confirmed, gathered once rather than per row.
  const unknown = new Map();
  for (const line of lines) {
    for (const token of unconfirmedInkTokens(line.productName)) {
      if (settled.has(token.toUpperCase())) continue;
      if (!unknown.has(token)) unknown.set(token, []);
      if (unknown.get(token).length < 3) unknown.get(token).push(line.productName);
    }
  }
  for (const [token, examples] of unknown) {
    gaps.push({ kind: 'UNKNOWN_TERM', token, examples, question: `What does "${token}" mean?` });
  }

  if (!data?.supplierName) gaps.push({ kind: 'SUPPLIER', question: 'Who sent this quote?' });

  return { ready: gaps.length === 0, gaps };
}

/**
 * The gate: structurally sound AND finished.
 *
 * `validateInkQuote` failing is the agent's problem to fix; `assessInkReadiness`
 * failing is a question for a person.
 */
export function checkInkHandoff(payload, { settledTerms = [] } = {}) {
  const validation = validateInkQuote(payload);
  if (!validation.ok) {
    return { canHandOff: false, stage: 'INVALID', errors: validation.errors, gaps: [], data: null };
  }

  const readiness = assessInkReadiness(validation.data, { settledTerms });
  return {
    canHandOff: readiness.ready,
    stage: readiness.ready ? 'READY' : 'INCOMPLETE',
    errors: [],
    gaps: readiness.gaps,
    data: validation.data,
  };
}

/**
 * Lines that passed the gate but would still never be compared to anything.
 *
 * A belt-and-braces check, and the reason it exists is that readiness is a list
 * of rules written by hand while `comparisonKey` is the thing that actually
 * decides. If those two ever disagree, the row is stored looking complete and
 * is invisible in every search — the exact silent failure this category was
 * built to avoid. Computed, never stored: its answer changes when the
 * vocabulary learns a term, which touches no stored field.
 */
export function uncomparableLines(data) {
  return (data?.lines || []).filter((line) => !comparisonKey(line));
}

/** Group rows by whatever would answer their question, keeping a few examples. */
function group(lines, keyOf) {
  const seen = new Map();
  for (const line of lines) {
    const key = keyOf(line);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, { key, count: 0, examples: [] });
    const entry = seen.get(key);
    entry.count += 1;
    if (entry.examples.length < 3) entry.examples.push(line.productName);
  }
  return [...seen.values()];
}
