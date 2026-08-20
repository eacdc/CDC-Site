/**
 * Identification tests.
 *
 * The fixture is the real Print Sales quotation of 10-07-2026, transcribed
 * field for field. Its value is that it is unremarkable: no plant is named
 * anywhere, the effective date is in the subject line rather than beside the
 * document date, the sender appears once at the bottom of page three, and the
 * only company printed prominently is CDC's own. Every one of those is a way
 * to get the answer confidently wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyPlant, readValidity, readStrength, readTerms,
  plantFromText, parseIndianDate, siteForPlant, AUTO_ACCEPT,
} from '../services/quote-identify.js';
import { identificationChecks } from '../services/quotes.js';
import { hasBlockingFailure, warningsNeedingReason } from '../config/validations.js';
import { PLANTS } from '../config/constants.js';

/** The Print Sales quote, as extraction reads it. */
const PRINT_SALES = {
  supplierName: 'PRINT SALES PRIVATE LIMITED',
  supplierGstin: null,
  supplier: {
    name: 'PRINT SALES PRIVATE LIMITED',
    gstin: null,
    phone: '+91-7596986452',
    email: null,
    address: null,
    signatory: 'Rina Das',
    foundIn: 'signature block, page 3',
  },
  addressedTo: {
    company: 'CDC PRINTERS (P). LTD.',
    address: '45, Radhanath Chowdhuri Road, Kolkata - 700015',
    gstin: null,
    attention: null,
  },
  subjectLine: 'QUOTATION w.e.f. 15-07-2026.',
  documentDate: '10-07-2026',
  effectiveFrom: '15-07-2026',
  effectiveTo: null,
  isSoftQuote: true,
  softQuoteEvidence: 'The rate is subject to market fluctuation & availability of materials.',
  plantMentions: null,
  entityScope: null,
  commercialTerms: {
    creditDays: null,
    freightTerms: 'Free to your work.',
    insurance: null,
    gstNote: 'GST will be charged extra as applicable',
    paymentTerms: 'As per agreed terms.',
  },
  statedRules: null,
  plantBlocks: null,
  lines: [],
};

// ── Plant ───────────────────────────────────────────────────────────────────

test('the Tangra street address identifies Kolkata without the word Kolkata', () => {
  const plant = identifyPlant({
    addressedTo: { company: 'CDC PRINTERS (P). LTD.', address: '45, Radhanath Chowdhuri Road' },
  });
  assert.deepEqual(plant.value, [PLANTS.KOL]);
  assert.equal(plant.unit, 'Tangra');
  assert.ok(plant.confidence >= AUTO_ACCEPT);
});

test('Print Sales is identified as Kolkata from the address alone', () => {
  const plant = identifyPlant(PRINT_SALES);
  assert.deepEqual(plant.value, [PLANTS.KOL]);
  assert.equal(plant.unit, 'Tangra');
  assert.ok(plant.confidence >= AUTO_ACCEPT, 'should not need a human to confirm');
});

test('a bare "Kolkata" settles the database but not the unit', () => {
  const plant = identifyPlant({ addressedTo: { address: 'Some Road, Kolkata - 700001' } });
  assert.deepEqual(plant.value, [PLANTS.KOL]);
  assert.equal(plant.unit, null);
});

test('a CDC GSTIN outranks the address text', () => {
  // Gujarat GSTIN on CDC's PAN, but a Kolkata address line. The number wins:
  // an address can be a letterhead default, a GSTIN is what was billed.
  const plant = identifyPlant({
    addressedTo: { gstin: '24AABCC2946B1ZZ', address: '45, Radhanath Chowdhuri Road, Kolkata' },
  });
  assert.deepEqual(plant.value, [PLANTS.AHM]);
  assert.match(plant.evidence, /Gujarat/);
});

test("a supplier's own GSTIN never identifies a CDC plant", () => {
  // 19 is West Bengal, but this is not CDC's PAN — it is the sender's number
  // sitting in the addressee block because extraction mis-filed it. Falling
  // through to the address is correct; reading it as "Kolkata" is luck.
  const plant = identifyPlant({
    addressedTo: { gstin: '19AAACX1234C1Z5', address: 'Ahmedabad, Gujarat' },
  });
  assert.deepEqual(plant.value, [PLANTS.AHM]);
});

test('a document naming both plants returns both, and asks', () => {
  const plant = identifyPlant({
    addressedTo: null,
    plantMentions: ['Kolkata', 'Ahmedabad Unit'],
  });
  assert.deepEqual(plant.value.sort(), [PLANTS.AHM, PLANTS.KOL].sort());
  assert.ok(plant.confidence < AUTO_ACCEPT, 'two plants is a decision, not a reading');
});

test('a document naming no plant proposes nothing rather than defaulting', () => {
  const plant = identifyPlant({ addressedTo: null, plantMentions: null });
  assert.deepEqual(plant.value, []);
  assert.equal(plant.confidence, 0);
});

test('plantFromText knows the towns that mean each plant', () => {
  assert.equal(plantFromText('Panchla, Howrah'), PLANTS.KOL);
  assert.equal(plantFromText('AHMEDABAD UNIT'), PLANTS.AHM);
  assert.equal(plantFromText('Bhiwandi'), null);
  assert.equal(plantFromText(null), null);
});

test('each plant maps to its own database', () => {
  assert.equal(siteForPlant(PLANTS.KOL), 'KOL');
  assert.equal(siteForPlant(PLANTS.AHM), 'AHM');
  assert.equal(siteForPlant('MUMBAI'), null);
});

// ── Validity ────────────────────────────────────────────────────────────────

test('the subject line beats the document date for the effective date', () => {
  const validity = readValidity(PRINT_SALES);
  assert.equal(validity.effectiveFrom.getDate(), 15);
  assert.equal(validity.effectiveFrom.getMonth(), 6, 'July, not October');
  assert.equal(validity.documentDate.getDate(), 10);
  assert.equal(validity.basis, 'DEFAULTED', 'no expiry is printed on this quote');
  assert.match(validity.evidence, /QUOTATION w\.e\.f/);
});

test('a stated expiry is recorded as stated', () => {
  const validity = readValidity({
    documentDate: '01-04-2026', effectiveFrom: '01-04-2026', effectiveTo: '31-03-2027',
  });
  assert.equal(validity.basis, 'STATED');
  assert.equal(validity.effectiveTo.getFullYear(), 2027);
});

test('a quote with no dates at all says so instead of inventing one', () => {
  const validity = readValidity({});
  assert.equal(validity.basis, 'NONE_GIVEN');
  assert.equal(validity.effectiveFrom, null);
  assert.equal(validity.confidence, 0);
});

test('DD-MM-YYYY is read the Indian way, not the American way', () => {
  // The failure this guards is silent: Date.parse('10-07-2026') yields a
  // perfectly valid October date, and nothing downstream can tell it is wrong.
  assert.equal(parseIndianDate('10-07-2026').getMonth(), 6);
  assert.equal(parseIndianDate('01/12/26').getMonth(), 11);
  assert.equal(parseIndianDate('15.07.2026').getDate(), 15);
  assert.equal(parseIndianDate('15 July 2026').getMonth(), 6);
  assert.equal(parseIndianDate(null), null);
  assert.equal(parseIndianDate('not a date'), null);
});

// ── Strength and terms ──────────────────────────────────────────────────────

test('the market-fluctuation sentence makes the quote indicative', () => {
  const strength = readStrength(PRINT_SALES);
  assert.equal(strength.value, 'SOFT');
  assert.match(strength.evidence, /subject to market fluctuation/);
});

test('a quote with no such wording is firm', () => {
  assert.equal(readStrength({ isSoftQuote: false }).value, 'FIRM');
});

test('commercial terms are carried through, credit days as a number', () => {
  const terms = readTerms(PRINT_SALES);
  assert.equal(terms.value.paymentTerms, 'As per agreed terms.');
  assert.equal(terms.value.freightTerms, 'Free to your work.');
  assert.equal(terms.value.creditDays, null, 'this quote states none');

  const credit = readTerms({ commercialTerms: { creditDays: '45 days' } });
  assert.equal(credit.value.creditDays, 45);
});

test('a quote stating no terms scores zero rather than an empty pass', () => {
  assert.equal(readTerms({}).confidence, 0);
});

// ── The gate on approval ────────────────────────────────────────────────────

test('an unsettled supplier or plant blocks approval, and settling clears it', () => {
  const unsettled = identificationChecks({
    needsAttention: ['supplier', 'plant'],
    supplier: { evidence: 'matches no supplier on file', readName: 'PRINT SALES PRIVATE LIMITED' },
    plant: { evidence: 'does not say which plant', readAddress: null },
  });
  assert.equal(unsettled.length, 2);
  assert.ok(hasBlockingFailure(unsettled), 'rates must not be written against an unknown supplier');
  // The reading is carried on the check, so the reviewer sees what was found
  // rather than only that something was missing.
  assert.equal(unsettled[0].actualValue, 'PRINT SALES PRIVATE LIMITED');

  const settled = identificationChecks({ needsAttention: [], supplier: {}, plant: {} });
  assert.equal(settled.length, 2, 'a passing check is still recorded, not deleted');
  assert.ok(settled.every((c) => c.passed));
  assert.equal(hasBlockingFailure(settled), false);
});

test('one settled field does not unblock the other', () => {
  const checks = identificationChecks({ needsAttention: ['plant'], supplier: {}, plant: {} });
  assert.equal(checks.find((c) => c.code === 'EXT009').passed, true);
  assert.equal(checks.find((c) => c.code === 'EXT010').passed, false);
  assert.ok(hasBlockingFailure(checks));
});

test('the identification blocks cannot be overridden with a reason', () => {
  // WARN checks take a typed reason and proceed; these two do not, by design.
  // "I think it is probably Siegwerk" is not a supplier.
  const checks = identificationChecks({ needsAttention: ['supplier', 'plant'], supplier: {}, plant: {} });
  assert.equal(warningsNeedingReason(checks).length, 0);
  assert.ok(checks.every((c) => c.severity === 'BLOCK'));
});
