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
 * A term CDC has ruled is not a paper type at all.
 *
 * "HI KOTE" heads a KV section, "PDB" trails a Uni Global product. Some of
 * these will turn out to be grades and some will turn out to be brands, mill
 * codes or marketing words — and "it means nothing about the paper" is a real
 * answer that has to be recordable, or the same three questions arrive with
 * every monthly list.
 *
 * Stored as a rule like any other so the answer survives; never applied to a
 * line, because it is not a type.
 */
export const NOT_A_PAPER_TYPE = 'NOT_A_TYPE';

/** Answers that name a type, from either kind of question. */
function typeAnswers(answers) {
  return answers.filter((a) => (a.kind === 'PAPER_TYPE' || a.kind === 'UNKNOWN_TERM')
    && (a.brand || a.token)
    && a.paperType
    && a.paperType !== NOT_A_PAPER_TYPE);
}

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
  /*
    `settled` holds the ORIGINAL answer objects, not the mapped ones. Building
    it from the mapped copies made every identity check miss, so every answer
    counted as unapplied and the no-model shortcut never fired — the whole
    saving, silently gone.
  */
  const settled = new Set(typeAnswers(answers));
  const structured = [...settled].map((a) => ({ ...a, brand: a.brand || a.token }));

  const unapplied = answers.filter((a) => !settled.has(a)
    // A "not a paper type" verdict is settled — it just settles nothing on a
    // line — so it must not send the round back to the model either.
    && !(a.kind === 'UNKNOWN_TERM' && a.paperType === NOT_A_PAPER_TYPE));

  if (!structured.length) {
    // Nothing to write onto a line, but a verdict still counts as progress:
    // it closes a question, and the gate has to be re-run to see that.
    const closed = answers.some((a) => a.kind === 'UNKNOWN_TERM' && a.paperType === NOT_A_PAPER_TYPE);
    return { payload, applied: closed ? 1 : 0, unapplied };
  }

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
    .filter((a) => (a.kind === 'PAPER_TYPE' || a.kind === 'UNKNOWN_TERM')
      && (a.brand || a.token) && a.paperType)
    .map((a) => ({
      brand: String(a.brand || a.token).trim(),
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
 * Keep only the lines belonging to the plant this document owns.
 *
 * A file that prices both plants is split into two documents, one per plant,
 * each holding its own half. The paper reading then re-reads the whole file —
 * it has no choice, the PDF is one file — and comes back with every line. Both
 * halves were being handed all of them, so a 24-product NR list priced for two
 * plants became 48 lines under Kolkata and the same 48 under Ahmedabad, with
 * each plant's rates appearing twice and half of them belonging elsewhere.
 *
 * Filtering only happens when the reading actually found more than one plant.
 * A single-plant document reads back one plant or none, and quietly dropping
 * rows there would be a far worse failure than the one this fixes.
 *
 * Unplaced lines stay in both halves, which is the same rule the split itself
 * uses: a row the document never attributed is likelier to apply to both plants
 * than to belong to one, and losing a priced row silently is the worst outcome
 * available.
 */
export function selectPlantLines(payload, plant) {
  if (!plant) return payload;

  const lines = payload?.lines || [];
  const plants = new Set(lines.map((l) => normalisePlantName(l.plant)).filter(Boolean));
  if (plants.size < 2) return payload;

  const wanted = normalisePlantName(plant);
  return {
    ...payload,
    lines: lines.filter((l) => {
      const linePlant = normalisePlantName(l.plant);
      return !linePlant || linePlant === wanted;
    }),
  };
}

/** KOL, Kolkata, "FOR KOLKATA - REEL" all mean the same plant. */
function normalisePlantName(value) {
  const text = String(value ?? '').toUpperCase();
  if (!text.trim()) return null;
  if (/\bAHMEDABAD\b|\bAHM\b|\bGUJARAT\b/.test(text)) return 'AHMEDABAD';
  if (/\bKOLKATA\b|\bCALCUTTA\b|\bKOL\b|\bTANGRA\b|\bPANCHLA\b|\bHOWRAH\b/.test(text)) return 'KOLKATA';
  return null;
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
  ownedPlant = null,
  settledTokens = [],
  send,
} = {}) {
  if (typeof send !== 'function') throw new Error('interpretPaperQuote needs a send function');

  /*
    Terms already ruled on: those stored from previous months, plus the ones
    answered in this very round. Without the second half, answering "PDB means
    nothing" would be accepted and the same question asked straight back.
  */
  const allSettled = [
    ...settledTokens,
    ...answers.filter((a) => a.kind === 'UNKNOWN_TERM' && a.token).map((a) => a.token),
  ];

  /*
    A prior payload plus structured answers is the common second round, and it
    needs no model at all: the answers are facts about brands, and folding them
    in is a loop. Going back to the model here would cost a full document read
    to be told something we already know, and give it the opportunity to change
    its mind about a line nobody asked about.
  */
  if (priorPayload) {
    const folded = applyAnswers(applyDocumentFacts(selectPlantLines(priorPayload, ownedPlant), documentFacts), answers);
    if (folded.applied > 0 && folded.unapplied.length === 0) {
      const gate = checkHandoff(folded.payload, { settledTokens: allSettled });
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
    const folded = applyAnswers(applyDocumentFacts(selectPlantLines(withKnown.payload, ownedPlant), documentFacts), answers);
    const gate = checkHandoff(folded.payload, { settledTokens: allSettled });

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
