/**
 * Interpreting an ink quote as a conversation, with a research step in it.
 *
 * The paper loop reads, says what it understood, asks about what it could not,
 * and repeats. This is that loop with one addition CDC asked for: before asking
 * a person, look the product up.
 *
 * WHY RESEARCH EARNS ITS PLACE HERE AND DID NOT FOR PAPER. A paper question is
 * usually about CDC's own trade shorthand — "what does PDB mean on Uni Global's
 * list?" — and the internet does not know. An ink question is almost always
 * about a named commercial product with a public datasheet:
 *
 *     CLEANFIX          Boettcher, a roller and blanket cleaner
 *     THERMOTECH        a thermal plate developer
 *     SICURA PLAST 770  Siegwerk, a UV sheetfed ink series
 *
 * Those are answerable without troubling anybody, and there are dozens of them
 * on every list.
 *
 * RESEARCH PROPOSES, IT NEVER DECIDES. A looked-up answer is attached to the
 * question as a suggestion with its source, and a person confirms it. This is
 * not caution for its own sake: chemistry is half the comparison key, and a
 * plausible-but-wrong answer from a search result merges two products that
 * should never have been compared — the exact silent failure the whole
 * vocabulary is built to avoid. A wrong answer a person clicked past is
 * recoverable, because somebody saw it.
 *
 * THE LOOP HAS THE SAME THREE EXITS, AND ONLY ONE IS THE MODEL'S TO TAKE.
 *
 *   INVALID     the payload does not fit the schema. The model's problem; it is
 *               told what failed and asked to repair, at most twice.
 *   INCOMPLETE  the payload fits but something is unknown. A person's question,
 *               now arriving with a proposed answer where research found one.
 *   READY       both pass, and only then does anything reach storage.
 *
 * AND ANSWERS ARE PERMANENT. Every settled question becomes a rule keyed on the
 * term, so next month's identical list asks nothing. That is the difference
 * between a tool somebody uses twice and one they keep using.
 */

import {
  resolveMaterialClass, resolveChemistry, resolveColour, resolveFinish,
  resolveChemicalFunction, resolveManufacturer, resolveFamily, resolveRole,
  resolveBaseNumber, resolveRateUom, parsePack,
} from '../../config/ink-vocabulary.js';
import { checkInkHandoff } from './ink-quote-schema.js';
import { buildInkMessage, INK_SYSTEM_PROMPT } from './ink-prompt.js';

/** How many times the model may be asked to repair its own output. */
const MAX_REPAIRS = 2;

/**
 * A term CDC has ruled means nothing about the product.
 *
 * "RL" trails a dozen Siegwerk rows and "MV --AB" sits inside two varnish
 * names. Some will turn out to be pack codes, some plant codes, some marketing.
 * "It tells you nothing" is a real answer that has to be recordable, or the same
 * seven questions arrive with every monthly list.
 */
export const NOT_MEANINGFUL = 'NOT_MEANINGFUL';

/** Which line field an answer of each kind settles. */
const FIELD_FOR = {
  MATERIAL_CLASS: 'materialClass',
  CHEMISTRY: 'chemistry',
  COLOUR: 'colour',
  FINISH: 'finish',
  CHEMICAL_FUNCTION: 'chemicalFunction',
  RATE_UOM: 'rateUom',
};

/**
 * Fill in what the vocabulary already knows, before the model is asked anything.
 *
 * Runs on the model's own output because it is cheap, deterministic, and catches
 * the case where a reading is right but the naming is not — the model reporting
 * "texture matt" as free text where TEXTURE_MATT was wanted. It never overwrites
 * a value the model set, and it fills the pack and the base number, which are
 * mechanical readings of the product name that no model call should be spent on.
 */
export function resolveKnownFields(payload) {
  let resolved = 0;

  const lines = (payload.lines || []).map((line) => {
    const name = line.productName;
    const next = { ...line };

    if (!next.materialClass) next.materialClass = resolveMaterialClass(name);
    if (!next.chemistry) next.chemistry = resolveChemistry(name, next.materialClass);
    if (!next.manufacturer) next.manufacturer = resolveManufacturer(name);
    if (!next.family) next.family = resolveFamily(name);

    if (next.materialClass === 'INK') {
      if (!next.colour) next.colour = resolveColour(name);
      if (!next.role) next.role = resolveRole(name);
      if (!next.baseNumber) next.baseNumber = resolveBaseNumber(name);
    }
    if (next.materialClass === 'COATING' && !next.finish) next.finish = resolveFinish(name);
    if (next.materialClass === 'PRESS_CHEMICAL' && !next.chemicalFunction) {
      next.chemicalFunction = resolveChemicalFunction(name);
    }

    if (!next.rateUom) next.rateUom = resolveRateUom(name);
    if (!next.pack) next.pack = parsePack(name);

    if (JSON.stringify(next) !== JSON.stringify(line)) {
      resolved += 1;
      if (!next.basis) next.basis = 'STATED';
    }
    return next;
  });

  return { payload: { ...payload, lines }, resolved };
}

/**
 * Apply the section headings to the rows beneath them.
 *
 * On Print Sales' quotation the manufacturer and the rate unit are stated ONCE,
 * in a heading, and never on a row:
 *
 *     DIC UV INK              RATE PER KGS
 *     PRESS CHEMICALS         RATE PER LTR.
 *     BOETTCHER CHEMICALS     RATE PER PC
 *
 * The model is asked to report which heading each row sat under, and this turns
 * that into fields. Without it every row on that document is missing its unit,
 * which is one of the two ways a rate can be silently wrong.
 *
 * A row's own value always wins: "ANTI SET OFF VERN POWDER 375.00/KG" sits under
 * the per-litre heading and says otherwise, and the row is right.
 */
export function applySectionFacts(payload) {
  let applied = 0;

  const lines = (payload.lines || []).map((line) => {
    const section = line.section || line.sectionHeading;
    if (!section) return line;

    const next = { ...line };
    if (!next.rateUom) next.rateUom = resolveRateUom(section);
    if (!next.manufacturer) next.manufacturer = resolveManufacturer(section);
    if (!next.materialClass) next.materialClass = resolveMaterialClass(section);
    if (!next.chemistry) next.chemistry = resolveChemistry(section, next.materialClass);

    if (JSON.stringify(next) !== JSON.stringify(line)) {
      applied += 1;
      if (!next.basis || next.basis === 'STATED') next.basis = 'SECTION';
    }
    return next;
  });

  return { payload: { ...payload, lines }, applied };
}

/**
 * Apply settled answers to a payload, without asking the model again.
 *
 * The commonest question here is "is this family UV or conventional?", and its
 * answer is a fact, not a judgement. Folding it in is a loop over lines — no
 * round trip, no cost, and no chance of the model revising a row nobody asked
 * about while it is in there.
 *
 * One answer settles every colour, pack and code under that family, this month
 * and next. That is why questions are grouped by family rather than by row.
 */
export function applyInkAnswers(payload, answers = []) {
  /*
    `settled` holds the ORIGINAL answer objects. Built from mapped copies, every
    identity check misses, every answer counts as unapplied, and the no-model
    shortcut silently stops firing — a bug this codebase has already had once,
    on the paper side, caught only because two tests asserted the model was
    never called.
  */
  const settled = new Set(answers.filter(isSettling));
  const unapplied = answers.filter((a) => !settled.has(a) && !isDismissal(a));

  const rules = [...settled].map((a) => ({
    subject: String(a.subject || a.token || '').trim(),
    field: FIELD_FOR[a.kind],
    value: a.value,
  })).filter((r) => r.subject && r.field && r.value);

  if (!rules.length) {
    // Nothing to write onto a line, but a dismissal still counts as progress:
    // it closes a question, and the gate must be re-run to see that.
    return { payload, applied: answers.some(isDismissal) ? 1 : 0, unapplied };
  }

  let applied = 0;
  const lines = (payload.lines || []).map((line) => {
    const next = { ...line };
    for (const rule of rules) {
      if (next[rule.field]) continue;
      if (!namesTheSame(rule.subject, line.family) && !mentions(line.productName, rule.subject)) continue;
      next[rule.field] = rule.value;
      next.basis = 'TAUGHT';
      applied += 1;
    }
    return next;
  });

  return { payload: { ...payload, lines }, applied, unapplied };
}

/**
 * Rules worth remembering from this round's answers.
 *
 * Returned rather than written, so the caller decides what to persist and the
 * folding stays a pure function.
 *
 * Scoped to the supplier by default. "TS" means one thing on Print Sales' list
 * and could mean another on Siegwerk's, and a rule promoted to global should be
 * a deliberate second act rather than a side effect of answering a question.
 *
 * A dismissal is remembered too, and that is the half people forget: "RL means
 * nothing" has to survive, or it is asked again next month.
 */
export function inkRulesFromAnswers(answers = [], { supplierGroupId = null } = {}) {
  return answers
    .filter((a) => (a.subject || a.token) && (a.value || isDismissal(a)))
    .map((a) => ({
      subject: String(a.subject || a.token).trim(),
      field: FIELD_FOR[a.kind] || null,
      value: isDismissal(a) ? NOT_MEANINGFUL : a.value,
      kind: a.kind,
      scope: 'SUPPLIER',
      supplierGroupId,
      source: a.source || 'PERSON',
    }));
}

/**
 * Attach what research found to the questions that are still open.
 *
 * The proposal rides along with the question rather than being applied, so the
 * person sees "Boettcher Cleanfix — a roller and blanket wash (boettcher.com)"
 * with ROLLER_CARE pre-selected, and one click both answers it and makes it
 * permanent.
 *
 * Questions research cannot help with are left exactly as they were. A gap with
 * no proposal is not a failure — "which plant?" was never a question the
 * internet could answer.
 */
export function attachResearch(gaps = [], findings = []) {
  if (!findings.length) return gaps;

  const bySubject = new Map(
    findings
      .filter((f) => f?.subject && f.value)
      .map((f) => [normalise(f.subject), f]),
  );

  return gaps.map((gap) => {
    const found = bySubject.get(normalise(gap.subject || gap.token));
    if (!found || found.field !== FIELD_FOR[gap.kind]) return gap;
    return {
      ...gap,
      proposal: {
        value: found.value,
        summary: found.summary || null,
        source: found.source || null,
        confidence: found.confidence ?? null,
      },
    };
  });
}

/** Which open questions are worth looking up, and what to ask about each. */
export function researchableGaps(gaps = []) {
  /*
    Only the ones about a named product. "Who sent this quote?" and "3 lines
    carry no rate" are about this document, not about anything the world knows,
    and searching for them would spend a call to produce nothing.
  */
  const worthLookingUp = new Set(['MATERIAL_CLASS', 'CHEMISTRY', 'COLOUR', 'FINISH', 'CHEMICAL_FUNCTION', 'UNKNOWN_TERM']);
  return gaps.filter((g) => worthLookingUp.has(g.kind) && (g.subject || g.token));
}

/**
 * One interpretation turn.
 *
 * `send` and `research` are both injected so the loop — which exit fires, what
 * the model is told when it errs, which answers never reach it — is testable
 * without a key or a network.
 *
 * @returns {{ stage, understanding, notes, questions, payload, errors, rounds, rules }}
 */
export async function interpretInkQuote({
  pages = [],
  textLayer = null,
  knownTerms = [],
  previousSummary = null,
  answers = [],
  priorPayload = null,
  supplierGroupId = null,
  documentFacts = null,
  settledTerms = [],
  send,
  research = null,
} = {}) {
  if (typeof send !== 'function') throw new Error('interpretInkQuote needs a send function');

  /*
    Terms already ruled on: those stored from previous months, plus the ones
    answered in this very round. Without the second half, answering "RL means
    nothing" would be accepted and the same question asked straight back.
  */
  const allSettled = [
    ...settledTerms,
    ...answers.filter((a) => a.kind === 'UNKNOWN_TERM' && a.token).map((a) => a.token),
  ];

  /*
    A prior payload plus structured answers is the common second round, and it
    needs no model at all: the answers are facts about families, and folding
    them in is a loop. Going back to the model here would cost a full document
    read to be told something already known.
  */
  if (priorPayload) {
    const folded = applyInkAnswers(applyDocumentFacts(priorPayload, documentFacts), answers);
    if (folded.applied > 0 && folded.unapplied.length === 0) {
      const gate = checkInkHandoff(folded.payload, { settledTerms: allSettled });
      return {
        stage: gate.stage,
        understanding: null,
        notes: [],
        questions: await withResearch(gate.gaps, research),
        payload: gate.data,
        errors: gate.errors,
        rounds: 0,
        rules: inkRulesFromAnswers(answers, { supplierGroupId }),
      };
    }
  }

  let repairErrors = [];
  let last = null;

  for (let round = 0; round <= MAX_REPAIRS; round += 1) {
    const message = buildInkMessage({ knownTerms, previousSummary, answers, textLayer, repairErrors });

    // eslint-disable-next-line no-await-in-loop
    const reply = await send({ system: INK_SYSTEM_PROMPT, message, pages });

    const withSections = applySectionFacts(reply?.payload || {});
    const withKnown = resolveKnownFields(withSections.payload);
    const folded = applyInkAnswers(applyDocumentFacts(withKnown.payload, documentFacts), answers);
    const gate = checkInkHandoff(folded.payload, { settledTerms: allSettled });

    last = {
      stage: gate.stage,
      understanding: reply?.understanding || null,
      notes: reply?.notes || [],
      // eslint-disable-next-line no-await-in-loop
      questions: await withResearch(gate.gaps, research),
      payload: gate.data,
      errors: gate.errors,
      rounds: round + 1,
      rules: inkRulesFromAnswers(answers, { supplierGroupId }),
    };

    // INCOMPLETE is a question for a person, not a fault to repair. Only a
    // structural failure is worth spending another model call on.
    if (gate.stage !== 'INVALID') return last;

    repairErrors = gate.errors;
  }

  return last;
}

/**
 * Fill in what the document already knows.
 *
 * The supplier is settled by identification, against the GSTIN on the
 * letterhead, and confirmed by a person. The interpreter reads the same page
 * again, and when its reading comes back empty the gate asks a question the
 * document had already answered. The confirmed value wins where it has one, and
 * never overwrites what the interpreter did read.
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
 * A short description of how a supplier's last quote was read, for the next one.
 *
 * Their format rarely changes month to month — Siegwerk's sheet is the same 82
 * rows with new prices — and saying so is what stops the second month asking
 * the first month's questions again.
 */
export function summariseInkQuote(payload) {
  if (!payload?.lines?.length) return null;

  const families = new Map();
  for (const line of payload.lines) {
    const key = line.family || line.productName;
    if (key && line.chemistry && !families.has(key)) {
      families.set(key, `${line.materialClass || '?'} / ${line.chemistry}`);
    }
  }

  return [
    payload.listContext ? `List: ${payload.listContext}` : null,
    `${payload.lines.length} lines`,
    families.size ? 'Families and what they are:' : null,
    ...[...families.entries()].map(([f, what]) => `  ${f} -> ${what}`),
  ].filter(Boolean).join('\n');
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Run research over the open questions, and never let it break the round. */
async function withResearch(gaps, research) {
  const wanted = researchableGaps(gaps);
  if (!research || !wanted.length) return gaps;

  try {
    const findings = await research(wanted);
    return attachResearch(gaps, findings || []);
  } catch {
    /*
      Research is an improvement to a question, not the question itself. A
      search that times out must leave a person with the plain question rather
      than failing the whole reading — the document is still perfectly
      answerable by somebody who buys ink.
    */
    return gaps;
  }
}

function isSettling(a) {
  return Boolean(FIELD_FOR[a?.kind]) && Boolean(a?.subject || a?.token) && Boolean(a?.value)
    && a.value !== NOT_MEANINGFUL;
}

function isDismissal(a) {
  return a?.value === NOT_MEANINGFUL;
}

function normalise(t) {
  return String(t ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function namesTheSame(a, b) {
  const left = normalise(a);
  return Boolean(left) && left === normalise(b);
}

/** Whole-word containment, so "770" does not match "7700". */
function mentions(haystack, needle) {
  const hay = ` ${normalise(haystack)} `;
  const pin = normalise(needle);
  return Boolean(pin) && hay.includes(` ${pin} `);
}
