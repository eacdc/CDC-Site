/**
 * Working out what a quote is, from the quote.
 *
 * The upload screen used to ask a buyer to name the supplier and tick the
 * plant before the file was even read. Both answers are already printed on the
 * document, and asking for them has two costs: it is slow, and a human picking
 * from a dropdown of eighty suppliers picks the wrong one occasionally — which
 * files a supplier's rates under another supplier's name and quietly corrupts
 * every comparison that follows.
 *
 * So this module proposes. It never decides silently:
 *
 *   - Every proposal carries a `confidence` and an `evidence` string naming
 *     what on the page produced it. A reviewer confirms in a glance instead of
 *     re-reading the document.
 *   - Below `AUTO_ACCEPT`, the proposal is offered but not pre-selected, and
 *     approval stays blocked until a person settles it.
 *   - A wrong-but-plausible answer is the failure mode that matters here, so
 *     an ambiguous match returns candidates rather than the best guess.
 */

import { ensureSupplierPortalReady, SupplierGroup } from '../db/mongo.js';
import { CDC_IDENTITY, PLANTS, SITE_BY_PLANT } from '../config/constants.js';
import { normaliseName, tokenSetRatio } from '../lib/text.js';
import {
  stripCorporateSuffixes, normaliseGstin, groupForLedger, suggestGroups,
} from './supplier-groups.js';
import { supplierLedgers } from './erp-ledgers.js';

/** At or above this, a proposal is safe to pre-select for the reviewer. */
export const AUTO_ACCEPT = 0.82;
/**
 * Below this, a candidate is not worth showing at all.
 *
 * Deliberately generous. The reviewer is choosing from a shortlist, not
 * trusting it, so a near-miss in the list costs a glance while a missing right
 * answer costs a search through 1,279 names.
 */
const WORTH_SHOWING = 0.3;

/** How many suppliers to shortlist. Enough to scan, few enough to read. */
const SHORTLIST = 6;

/**
 * CDC's own plants, keyed by the words that appear in an address.
 *
 * Tangra and Panchla are both the Kolkata database — the spec is explicit that
 * `IndusEnterprise` covers "Kolkata (Tangra + Panchla)". Ahmedabad is the
 * separate `IndusEnterprise2`. The unit is recorded separately from the plant
 * because knowing a quote was addressed to Panchla is useful even though it
 * does not change which database the rates belong to.
 */
const PLANT_ADDRESS_MARKERS = [
  { match: /\bTANGRA\b/i, plant: PLANTS.KOL, unit: 'Tangra', evidence: 'Tangra' },
  { match: /RADHANATH\s+CHOWDHU/i, plant: PLANTS.KOL, unit: 'Tangra', evidence: 'the Tangra street address' },
  { match: /\bPANCHLA\b/i, plant: PLANTS.KOL, unit: 'Panchla', evidence: 'Panchla' },
  { match: /\bSATGHARIA\b/i, plant: PLANTS.KOL, unit: 'Panchla', evidence: 'the Panchla address' },
  { match: /\bHOWRAH\b/i, plant: PLANTS.KOL, unit: 'Panchla', evidence: 'Howrah' },
  { match: /\bAHMEDABAD\b/i, plant: PLANTS.AHM, unit: 'Ahmedabad', evidence: 'Ahmedabad' },
  { match: /\bGUJARAT\b/i, plant: PLANTS.AHM, unit: 'Ahmedabad', evidence: 'Gujarat' },
  // Deliberately last and weakest: "Kolkata" alone settles the database but
  // not the unit, and it appears in plenty of addresses that are not CDC's.
  { match: /\bKOLKATA\b|\bCALCUTTA\b/i, plant: PLANTS.KOL, unit: null, evidence: 'Kolkata' },
];

/** GSTIN state codes CDC operates in. 19 West Bengal, 24 Gujarat. */
const GSTIN_STATE_PLANT = { 19: PLANTS.KOL, 24: PLANTS.AHM };

/**
 * Identify a quote from what extraction read off it.
 *
 * @param {Object} input
 * @param {'KOL'|'AHM'} input.site        the session's site, used only to
 *                                        prefer one ERP ledger list; never to
 *                                        decide the answer
 * @param {Object} input.extracted        the provider's ExtractedQuote
 * @returns {Promise<Identification>}
 */
export async function identifyQuote({ site, extracted }) {
  await ensureSupplierPortalReady();

  const supplier = await identifySupplier({ site, extracted });
  const plant = identifyPlant(extracted);
  const validity = readValidity(extracted);
  const strength = readStrength(extracted);
  const terms = readTerms(extracted);

  return {
    supplier,
    plant,
    validity,
    strength,
    terms,
    /**
     * What still needs a human. The upload screen shows this directly, so a
     * buyer knows at a glance whether they are confirming or deciding.
     */
    needsAttention: [
      ...(supplier.confidence >= AUTO_ACCEPT ? [] : ['supplier']),
      ...(plant.confidence >= AUTO_ACCEPT ? [] : ['plant']),
    ],
  };
}

// ── Supplier ────────────────────────────────────────────────────────────────

/**
 * Match the sender against known supplier groups, then against ERP ledgers.
 *
 * GSTIN first when there is one: it is an identifier rather than a name, so it
 * cannot be confused by a branch or a rewording. Name matching is the fallback
 * and is deliberately suffix-blind — "Pvt Ltd" matching "Pvt Ltd" is not
 * evidence of anything, and letting it count would score every Indian company
 * against every other.
 */
async function identifySupplier({ site, extracted }) {
  const name = extracted.supplier?.name || extracted.supplierName || null;
  const gstin = normaliseGstin(extracted.supplier?.gstin || extracted.supplierGstin);
  const foundIn = extracted.supplier?.foundIn || null;

  if (!name && !gstin) {
    return {
      value: null,
      supplierGroupId: null,
      confidence: 0,
      evidence: 'No supplier name or GSTIN could be read from the document',
      candidates: [],
      readName: null,
      readGstin: null,
      foundIn,
    };
  }

  const groups = await SupplierGroup.find({}).lean();

  // A GSTIN we already hold is conclusive — it is an identifier, not a name.
  if (gstin) {
    const byGstin = groups.find((g) => (g.gstins || []).some((x) => normaliseGstin(x) === gstin));
    if (byGstin) {
      return {
        value: byGstin.name,
        supplierGroupId: byGstin._id,
        confidence: 1,
        evidence: `GSTIN ${gstin} on the document is on file for ${byGstin.name}`,
        candidates: [],
        readName: name,
        readGstin: gstin,
        foundIn,
      };
    }

    // Not harvested onto a group yet, but the ERP knows it. Reconciliation
    // copies ledger GSTINs onto groups, and a supplier who has not been
    // reconciled since registering is exactly the case that would otherwise
    // fall back to fuzzy name matching for no reason.
    const byLedger = await groupFromLedgerGstin({ site, gstin });
    if (byLedger) return { ...byLedger, readName: name, readGstin: gstin, foundIn };
  }

  // Fuzzy, suffix-blind, and only ever a shortlist. Most quotes print no
  // GSTIN and almost none print a name that matches a ledger character for
  // character — "PRINT SALES PRIVATE LIMITED" against "Print Sales Pvt Ltd" —
  // so this is the normal path, not the fallback. Its job is to cut 1,279
  // suppliers down to the handful worth looking at.
  const scored = suggestGroups(name, groups, { limit: SHORTLIST, floor: WORTH_SHOWING });

  const top = scored[0];
  const runnerUp = scored[1];

  // Clear of the field, not merely above the bar. Two suppliers scoring 0.85
  // is a coin toss, and a coin toss belongs to a person.
  const isClear = top && (!runnerUp || top.score - runnerUp.score >= 0.08);

  if (top && top.score >= AUTO_ACCEPT && isClear) {
    return {
      value: top.group.name,
      supplierGroupId: top.group._id,
      confidence: round(top.score, 3),
      evidence: describeSupplierMatch(name, top, foundIn),
      candidates: scored.slice(1).map(toCandidate),
      readName: name,
      readGstin: gstin,
      foundIn,
    };
  }

  // Nothing clear enough to pre-select. Offer the ERP's own supplier ledgers
  // alongside the shortlist — a ledger added since the last sync has no
  // supplier record yet, and naming it beats an empty result.
  const ledgerSuggestions = await suggestFromLedgers({ site, name });

  return {
    value: null,
    supplierGroupId: null,
    confidence: top ? round(top.score, 3) : 0,
    evidence: top
      ? `Read "${name}" from the document. Closest is ${top.group.name} (${Math.round(top.score * 100)}%) — too close to call, so pick the right supplier below`
      : `Read "${name}" from the document but nothing on file resembles it — search for the supplier below`,
    candidates: scored.map(toCandidate),
    ledgerCandidates: ledgerSuggestions,
    readName: name,
    readGstin: gstin,
    foundIn,
  };
}

function describeSupplierMatch(readName, top, foundIn) {
  const where = foundIn ? ` (${foundIn})` : '';
  if (normaliseName(readName) === normaliseName(top.matchedOn)) {
    return `"${readName}"${where} matches ${top.group.name} exactly`;
  }
  return `"${readName}"${where} matches ${top.group.name} via "${top.matchedOn}" (${Math.round(top.score * 100)}%)`;
}

function toCandidate(row) {
  return {
    supplierGroupId: row.group._id,
    name: row.group.name,
    score: round(row.score, 3),
    matchedOn: row.matchedOn,
  };
}

/**
 * Resolve a GSTIN through the ERP's own ledgers to the group that owns them.
 *
 * Returns a proposal when the ledger is grouped, and a "ledger found, no group"
 * proposal when it is not — which is still worth surfacing, because it tells a
 * reviewer the supplier exists in the ERP and only needs grouping.
 */
async function groupFromLedgerGstin({ site, gstin }) {
  if (!site) return null;
  let ledgers;
  try {
    ledgers = await supplierLedgers(site);
  } catch (err) {
    console.warn('[SP][identify] could not read supplier ledgers by GSTIN:', err.message);
    return null;
  }

  const ledger = ledgers.find((l) => normaliseGstin(l.GSTNo) === gstin);
  if (!ledger) return null;

  const group = await groupForLedger(site, ledger.LedgerID);
  if (!group) {
    return {
      value: null,
      supplierGroupId: null,
      confidence: 0.6,
      evidence: `GSTIN ${gstin} belongs to ERP ledger "${ledger.LedgerName}", which has no supplier record yet — run Sync from ERP on the Suppliers screen, then re-check`,
      candidates: [],
      ledgerCandidates: [{
        ledgerId: ledger.LedgerID,
        ledgerName: ledger.LedgerName,
        gstin,
        score: 1,
      }],
    };
  }

  return {
    value: group.name,
    supplierGroupId: group._id,
    confidence: 1,
    evidence: `GSTIN ${gstin} belongs to ERP ledger "${ledger.LedgerName}", which is part of ${group.name}`,
    candidates: [],
  };
}

/** ERP supplier ledgers that resemble the name, for a first-time supplier. */
async function suggestFromLedgers({ site, name }) {
  if (!name || !site) return [];
  try {
    const ledgers = await supplierLedgers(site);
    return ledgers
      .filter((l) => !l.isInternal)
      .map((l) => ({
        ledgerId: l.LedgerID,
        ledgerName: l.LedgerName,
        gstin: l.GSTNo || null,
        score: round(tokenSetRatio(stripCorporateSuffixes(name), stripCorporateSuffixes(l.LedgerName)), 3),
      }))
      .filter((l) => l.score >= WORTH_SHOWING)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  } catch (err) {
    // The ERP being unreachable must not stop a quote being filed — the
    // supplier can still be picked from the groups already on record.
    console.warn('[SP][identify] could not read supplier ledgers:', err.message);
    return [];
  }
}

// ── Plant ───────────────────────────────────────────────────────────────────

/**
 * Which CDC plant the quote is for, from the address it is addressed to.
 *
 * Order of evidence, strongest first:
 *   1. A CDC GSTIN in the addressee block — a state code is unambiguous.
 *   2. A plant-specific word in the address: Tangra, Panchla, Ahmedabad.
 *   3. A plant named anywhere else on the document.
 *
 * A document that names both plants is not a failure — several suppliers quote
 * Kolkata and Ahmedabad in separate blocks — so both are returned and the
 * rates get written per plant.
 */
export function identifyPlant(extracted) {
  const addressee = extracted.addressedTo || {};
  const addressText = [addressee.company, addressee.address].filter(Boolean).join(' ');

  const gstinPlant = plantFromGstin(addressee.gstin);
  if (gstinPlant) {
    return {
      value: [gstinPlant.plant],
      unit: gstinPlant.unit,
      confidence: 0.98,
      evidence: `The quote is addressed to CDC's ${gstinPlant.state} GSTIN (${addressee.gstin})`,
      readAddress: addressText || null,
    };
  }

  if (addressText) {
    const hit = PLANT_ADDRESS_MARKERS.find((m) => m.match.test(addressText));
    if (hit) {
      // "Kolkata" on its own settles the database but not the unit, so it is
      // reported a little less confidently than a street or unit name.
      const confidence = hit.unit ? 0.95 : 0.85;
      return {
        value: [hit.plant],
        unit: hit.unit,
        confidence,
        evidence: `Addressed to ${hit.evidence} — ${titleCase(hit.plant)}`,
        readAddress: addressText,
      };
    }
  }

  // Plants named anywhere on the page, e.g. two priced blocks.
  const mentioned = [...new Set(
    (extracted.plantMentions || [])
      .map(plantFromText)
      .filter(Boolean),
  )];

  if (mentioned.length) {
    return {
      value: mentioned,
      unit: null,
      confidence: mentioned.length === 1 ? 0.8 : 0.7,
      evidence: mentioned.length === 1
        ? `The document names ${titleCase(mentioned[0])}`
        : `The document prices both ${mentioned.map(titleCase).join(' and ')} — rates will be stored separately per plant`,
      readAddress: addressText || null,
    };
  }

  return {
    value: [],
    unit: null,
    confidence: 0,
    evidence: addressText
      ? `Could not tell which plant "${addressText}" refers to — please confirm`
      : 'The document does not say which plant it is for — please confirm',
    readAddress: addressText || null,
  };
}

function plantFromGstin(gstin) {
  const normalised = normaliseGstin(gstin);
  if (!normalised) return null;
  // Only CDC's own GSTINs identify a plant; a supplier's says where THEY are.
  const isCdc = normalised === CDC_IDENTITY.gstin
    || normalised.slice(2, 12) === CDC_IDENTITY.pan;
  if (!isCdc) return null;

  const code = Number(normalised.slice(0, 2));
  const plant = GSTIN_STATE_PLANT[code];
  if (!plant) return null;
  return {
    plant,
    unit: plant === PLANTS.AHM ? 'Ahmedabad' : null,
    state: code === 19 ? 'West Bengal' : 'Gujarat',
  };
}

export function plantFromText(text) {
  const t = String(text ?? '').toUpperCase();
  if (/AHMEDABAD|GUJARAT/.test(t)) return PLANTS.AHM;
  if (/KOLKATA|CALCUTTA|TANGRA|PANCHLA|HOWRAH|WEST\s*BENGAL/.test(t)) return PLANTS.KOL;
  return null;
}

// ── Validity, strength, terms ───────────────────────────────────────────────

/**
 * The dates, and how firmly they were established.
 *
 * `basis` is the point: a defaulted expiry is a prompt to ask the supplier,
 * while a stated one is a fact about their terms. Collapsing the two loses the
 * distinction that drives the refresh report.
 */
export function readValidity(extracted) {
  const documentDate = parseIndianDate(extracted.documentDate);
  const statedFrom = parseIndianDate(extracted.effectiveFrom);
  const statedTo = parseIndianDate(extracted.effectiveTo);

  const from = statedFrom || documentDate;
  const evidence = [];
  if (extracted.subjectLine && statedFrom) evidence.push(`"${extracted.subjectLine.trim()}"`);
  else if (statedFrom) evidence.push('an effective date on the document');
  else if (documentDate) evidence.push('the document date');

  if (statedTo) {
    return {
      effectiveFrom: from,
      effectiveTo: statedTo,
      basis: 'STATED',
      documentDate,
      confidence: 0.95,
      evidence: `Valid from ${formatDate(from)} to ${formatDate(statedTo)}, both stated`,
    };
  }

  return {
    effectiveFrom: from,
    effectiveTo: null,
    basis: statedFrom || documentDate ? 'DEFAULTED' : 'NONE_GIVEN',
    documentDate,
    confidence: from ? 0.8 : 0,
    evidence: from
      ? `Effective ${formatDate(from)} from ${evidence[0]}; no expiry stated, so the default validity applies`
      : 'No dates found — the default validity will run from the upload date',
  };
}

export function readStrength(extracted) {
  if (extracted.isSoftQuote) {
    return {
      value: 'SOFT',
      confidence: 0.9,
      evidence: extracted.softQuoteEvidence
        ? `Marked indicative: "${extracted.softQuoteEvidence.trim()}"`
        : 'The document says prices are subject to change',
    };
  }
  return {
    value: 'FIRM',
    confidence: 0.7,
    evidence: 'No wording found that makes the prices indicative',
  };
}

export function readTerms(extracted) {
  const terms = extracted.commercialTerms || {};
  const present = Object.entries(terms).filter(([, v]) => v);
  return {
    value: {
      creditDays: numberish(terms.creditDays),
      paymentTerms: terms.paymentTerms || null,
      freightTerms: terms.freightTerms || null,
      insurance: terms.insurance || null,
      gstNote: terms.gstNote || null,
    },
    confidence: present.length ? 0.85 : 0,
    evidence: present.length
      ? `Read ${present.length} term${present.length === 1 ? '' : 's'} from the document`
      : 'No commercial terms stated',
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function siteForPlant(plant) {
  return SITE_BY_PLANT[String(plant ?? '').toUpperCase()] || null;
}

/**
 * Indian documents write DD-MM-YYYY. `Date.parse` reads that as MM-DD and
 * produces a valid wrong date — 10-07-2026 becomes October rather than July —
 * which is worse than failing, because nothing downstream can tell.
 */
export function parseIndianDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();
  const dmy = text.match(/(\d{1,2})[/\-.\s](\d{1,2})[/\-.\s](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const day = Number(d);
    const month = Number(m);
    // A day above 12 in the first position confirms DD-MM; below that the
    // convention decides, and in India the convention is DD-MM.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(year, month - 1, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  // "15 July 2026" and similar are unambiguous, so the built-in parser is safe.
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A number out of "45 days", or null.
 *
 * The digits are required. Stripping non-digits from an empty or wordy value
 * leaves "", and `Number('')` is 0 — so a quote that states no credit period
 * would be filed as "payment due immediately", which is a term the supplier
 * never offered and the harshest possible reading of their silence.
 */
function numberish(value) {
  const digits = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!digits) return null;
  const n = Number(digits[0]);
  return Number.isFinite(n) ? n : null;
}

function titleCase(text) {
  const t = String(text ?? '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function formatDate(date) {
  if (!date) return 'an unknown date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
