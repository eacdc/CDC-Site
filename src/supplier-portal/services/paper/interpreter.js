/**
 * Interpreting a paper quote as a conversation rather than a single shot.
 *
 * The old flow read a document once, produced whatever it produced, and handed
 * a reviewer a form of blanks to fill. It could not ask a question, so every
 * variation between suppliers had to be anticipated in the prompt — and the
 * prompt grew with every new document while still missing things.
 *
 * This reads, says what it understood, asks about what it could not determine,
 * and repeats until nothing is open. That is how the vocabulary in this project
 * was actually established: eight quotes, each settled in one or two rounds,
 * because the question asked was the one that mattered for that document.
 *
 * THE LOOP HAS TWO EXITS AND ONLY ONE OF THEM IS THE MODEL'S TO TAKE.
 *
 *   INVALID     the payload does not fit the schema. The model's problem; it is
 *               told exactly what failed and asked to repair, at most twice.
 *   INCOMPLETE  the payload fits but something is unknown. A person's question.
 *   READY       both pass, and only then does anything reach storage.
 *
 * WHY MOST ANSWERS NEVER REACH THE MODEL. The commonest question by far is "what
 * paper type is this brand?", and its answer is a fact, not a judgement. Folding
 * it in is a loop over lines — no round trip, no cost, no chance of the model
 * changing something else while it is in there. Only free-form answers go back
 * for another reading.
 */

import { canonicalPaperTypes, resolvePaperType } from '../../config/paper-vocabulary.js';
import { checkHandoff } from './paper-quote-schema.js';
import { buildInterpretationMessage, PAPER_SYSTEM_PROMPT } from './paper-prompt.js';

/** How many times the model may be asked to repair its own output. */
const MAX_REPAIRS = 2;

/**
 * Apply settled answers to a payload, without asking the model again.
 *
 * A brand-to-type answer settles every line of that brand at once — every GSM
 * band, both forms, this month and next. That is why the questions are grouped
 * by brand: one answer, many lines.
 *
 * Matching is on the brand first and the product name second, because a line
 * may carry either. Comparison is loose about case and punctuation and strict
 * about everything else: "PRIMA FOLD" settles "CENTURY PRIMA FOLD RBD", and
 * nothing settles a line it does not actually name.
 *
 * @param {Object} payload
 * @param {Array} answers  [{ kind, brand, paperType }] and free-form entries
 * @returns {{ payload: Object, applied: number, unapplied: Array }}
 */
export function applyAnswers(payload, answers = []) {
  const structured = answers.filter((a) => a.kind === 'PAPER_TYPE' && a.brand && a.paperType);
  const unapplied = answers.filter((a) => !(a.kind === 'PAPER_TYPE' && a.brand && a.paperType));

  if (!structured.length) return { payload, applied: 0, unapplied };

  let applied = 0;
  const lines = (payload.lines || []).map((line) => {
    if (line.paperType) return line;

    const hit = structured.find((a) => namesTheSame(a.brand, line.brand)
      || mentions(line.productName, a.brand));
    if (!hit) return line;

    applied += 1;
    return { ...line, paperType: hit.paperType, paperTypeBasis: 'TAUGHT' };
  });

  return { payload: { ...payload, lines }, applied, unapplied };
}

/**
 * Rules worth remembering from this round's answers.
 *
 * Returned rather than written, so the caller decides what to persist and the
 * folding stays a pure function. Scoped to the supplier by default: "DO" means
 * one thing on AKT's note and could mean another elsewhere, and a rule promoted
 * to global should be a deliberate second act.
 */
export function rulesFromAnswers(answers = [], { supplierGroupId = null } = {}) {
  return answers
    .filter((a) => a.kind === 'PAPER_TYPE' && a.brand && a.paperType)
    .map((a) => ({
      brand: String(a.brand).trim(),
      paperType: a.paperType,
      scope: 'SUPPLIER',
      supplierGroupId,
    }));
}

/**
 * Fill in what the document already knows.
 *
 * The supplier and the plant are settled by identification, against the GSTIN
 * on the letterhead and the addressee block, and confirmed by a person. The
 * interpreter reads them again from the same page, and when its reading comes
 * back empty the gate asks a question the document had already answered — CDC
 * saw "PLANT 98% sure Kolkata" in one panel and "Which plant do these rates
 * apply to?" in the one above it.
 *
 * The document wins where it has an answer, because a confirmed value beats a
 * fresh reading of the same evidence. It never overwrites what the interpreter
 * did read: a document whose plant was assumed should not silently override a
 * plant printed in the rate columns.
 */
export function applyDocumentFacts(payload, facts = {}) {
  if (!facts || (!facts.plant && !facts.supplierName)) return payload;

  return {
    ...payload,
    plant: payload.plant || facts.plant || null,
    supplierName: payload.supplierName || facts.supplierName || null,
  };
}

/**
 * Fill in what the vocabulary already knows, before the model is asked anything.
 *
 * Runs on the model's own output because it is cheap, deterministic, and
 * catches the case where a reading is right but the naming is not — the model
 * reporting "grey back" as free text where GREY_BACK was wanted. It never
 * overwrites a type the model set.
 */
export function resolveKnownTypes(payload) {
  let resolved = 0;
  const lines = (payload.lines || []).map((line) => {
    if (line.paperType) return line;
    const known = resolvePaperType(line.productName);
    if (!known) return line;
    resolved += 1;
    return { ...line, paperType: known, paperTypeBasis: 'STATED' };
  });
  return { payload: { ...payload, lines }, resolved };
}

/**
 * One interpretation turn.
 *
 * `send` is injected so the loop can be tested without a key or a network. It
 * takes `{ system, message, pages }` and returns the model's parsed JSON.
 *
 * @returns {{ stage, understanding, notes, questions, payload, errors, rounds }}
 */
export async function interpretPaperQuote({
  pages = [],
  textLayer = null,
  knownBrands = [],
  previousSummary = null,
  answers = [],
  priorPayload = null,
  supplierGroupId = null,
  documentFacts = null,
  send,
} = {}) {
  if (typeof send !== 'function') throw new Error('interpretPaperQuote needs a send function');

  /*
    A prior payload plus structured answers is the common second round, and it
    needs no model at all: the answers are facts about brands, and folding them
    in is a loop. Going back to the model here would cost a full document read
    to be told something we already know, and give it the opportunity to change
    its mind about a line nobody asked about.
  */
  if (priorPayload) {
    const folded = applyAnswers(applyDocumentFacts(priorPayload, documentFacts), answers);
    if (folded.applied > 0 && folded.unapplied.length === 0) {
      const gate = checkHandoff(folded.payload);
      return {
        stage: gate.stage,
        understanding: null,
        notes: [],
        questions: gate.gaps,
        payload: gate.data,
        errors: gate.errors,
        rounds: 0,
        rules: rulesFromAnswers(answers, { supplierGroupId }),
      };
    }
  }

  const canonicalTypes = canonicalPaperTypes();
  let repairErrors = [];
  let last = null;

  for (let round = 0; round <= MAX_REPAIRS; round += 1) {
    const message = buildInterpretationMessage({
      canonicalTypes, knownBrands, previousSummary, answers, textLayer, repairErrors,
    });

    // eslint-disable-next-line no-await-in-loop
    const reply = await send({ system: PAPER_SYSTEM_PROMPT, message, pages });

    const withKnown = resolveKnownTypes(reply?.payload || {});
    const folded = applyAnswers(applyDocumentFacts(withKnown.payload, documentFacts), answers);
    const gate = checkHandoff(folded.payload);

    last = {
      stage: gate.stage,
      understanding: reply?.understanding || null,
      notes: reply?.notes || [],
      questions: gate.gaps,
      payload: gate.data,
      errors: gate.errors,
      rounds: round + 1,
      rules: rulesFromAnswers(answers, { supplierGroupId }),
    };

    // INCOMPLETE is a question for a person, not a fault to repair. Only a
    // structural failure is worth spending another model call on.
    if (gate.stage !== 'INVALID') return last;

    repairErrors = gate.errors;
  }

  return last;
}

/**
 * A short description of how a supplier's last quote was read, for the next one.
 *
 * Their format rarely changes month to month, so this is usually the same
 * document with new prices — and saying so is what stops the second month
 * asking the first month's questions all over again.
 */
export function summarisePreviousQuote(payload) {
  if (!payload?.lines?.length) return null;

  const brands = new Map();
  for (const line of payload.lines) {
    const key = line.brand || line.productName;
    if (key && line.paperType && !brands.has(key)) brands.set(key, line.paperType);
  }

  const lines = [
    payload.listContext ? `List: ${payload.listContext}` : null,
    `${payload.lines.length} lines, rates in ${payload.lines[0]?.rateUom || 'KGS'}`,
    brands.size ? `Products and their types:` : null,
    ...[...brands.entries()].map(([b, t]) => `  ${b} -> ${t}`),
  ].filter(Boolean);

  return lines.join('\n');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalise(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function namesTheSame(a, b) {
  const left = normalise(a);
  return Boolean(left) && left === normalise(b);
}

/** Whole-word containment, so "GC1" does not match "GC10". */
function mentions(haystack, needle) {
  const hay = ` ${normalise(haystack)} `;
  const pin = normalise(needle);
  return Boolean(pin) && hay.includes(` ${pin} `);
}
