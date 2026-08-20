/**
 * What each half of a split file knows about itself.
 *
 * A two-plant NR quote split correctly — Kolkata took the right rates and
 * saved. Then the Ahmedabad half opened with no supplier, no validity and no
 * terms, and could not be saved at all; rescanning it filled it with Kolkata's
 * numbers.
 *
 * Two faults, and both were structural rather than incidental:
 *
 *   - The sibling was created on a **separate, shorter path** that ran before
 *     identification and skipped the checks. Everything the reviewer needed
 *     was computed after it had already been written.
 *   - Nothing recorded which plant a document owned, so a rescan re-split the
 *     file from scratch and handed over whichever half sorted first.
 *
 * These cover the first fault. The second is `splitPlant`, exercised through
 * `groupLinesByPlant` in quote-split.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentification } from '../services/quotes.js';

/** One reading of the NR quote: a clear supplier, an unclear plant. */
function reading({ plantValue = [], plantConfidence = 0 } = {}) {
  return {
    supplier: {
      value: 'Sudarshan Paper & Board Pvt Ltd',
      supplierGroupId: 'sup1',
      confidence: 0.97,
      evidence: 'Letterhead names Sudarshan',
      readName: 'SUDARSHAN', readGstin: null, foundIn: 'letterhead',
      candidates: [], ledgerCandidates: [],
    },
    plant: {
      value: plantValue,
      unit: null,
      readAddress: null,
      confidence: plantConfidence,
      evidence: 'The document does not say which plant it is for',
    },
    validity: { confidence: 0.8, evidence: 'w.e.f. 18/08/2026' },
    strength: { value: 'FIRM', confidence: 0.9, evidence: 'No fluctuation clause' },
    terms: { confidence: 0.85, evidence: 'GST extra as applicable' },
  };
}

const failing = (checks, code) => checks.find((c) => c.code === code && !c.passed);

test('a split half knows its plant without being asked', () => {
  // The plant came from the rate column the rows were printed in, which is
  // stronger evidence than the addressee block. Asking again would be asking a
  // question we have already answered better.
  const { documentFields, checks, identification } = buildIdentification({
    identified: reading(), fixedPlant: 'AHMEDABAD',
  });

  assert.deepEqual(documentFields.plantScope, ['AHMEDABAD']);
  assert.equal(documentFields.plantScopeBasis, 'STATED');
  assert.equal(identification.needsAttention.includes('plant'), false);
  assert.equal(failing(checks, 'EXT010'), undefined, 'approval is not blocked on the plant');
});

test('the Ahmedabad half carries the supplier, validity, strength and terms', () => {
  // The whole failure in one assertion: these are properties of the file, and
  // the half that was written on the shorter path had none of them.
  const { documentFields, identification, checks } = buildIdentification({
    identified: reading(), fixedPlant: 'AHMEDABAD',
  });

  assert.equal(documentFields.supplierGroupId, 'sup1');
  assert.equal(identification.supplier.proposedName, 'Sudarshan Paper & Board Pvt Ltd');
  assert.ok(identification.validity.evidence);
  assert.ok(identification.terms.evidence);
  assert.ok(identification.strength.evidence);
  assert.equal(failing(checks, 'EXT009'), undefined, 'the supplier is not asked again');
});

test('both halves read the file identically, differing only in plant', () => {
  const identified = reading();
  const kol = buildIdentification({ identified, fixedPlant: 'KOLKATA' });
  const ahm = buildIdentification({ identified, fixedPlant: 'AHMEDABAD' });

  assert.equal(kol.documentFields.supplierGroupId, ahm.documentFields.supplierGroupId);
  assert.equal(
    kol.identification.validity.evidence,
    ahm.identification.validity.evidence,
  );
  assert.deepEqual(kol.documentFields.plantScope, ['KOLKATA']);
  assert.deepEqual(ahm.documentFields.plantScope, ['AHMEDABAD']);
});

test('the fixed plant says where it came from, in a sentence', () => {
  // A reviewer seeing "Ahmedabad" on a document they did not upload deserves
  // to know why, without opening the PDF.
  const { identification } = buildIdentification({
    identified: reading(), fixedPlant: 'AHMEDABAD',
  });
  assert.match(identification.plant.evidence, /Ahmedabad/);
  assert.match(identification.plant.evidence, /both plants/i);
  assert.equal(identification.plant.confidence, 1);
});

test('the fixed plant overrides a plant that was read from the page', () => {
  // The addressee block on a two-plant quote names one plant, or neither. The
  // rate column is the better evidence and must win.
  const { documentFields } = buildIdentification({
    identified: reading({ plantValue: ['KOLKATA'], plantConfidence: 0.95 }),
    fixedPlant: 'AHMEDABAD',
  });
  assert.deepEqual(documentFields.plantScope, ['AHMEDABAD']);
});

test('an ordinary single-plant document is unaffected', () => {
  const { documentFields, identification } = buildIdentification({
    identified: reading({ plantValue: ['KOLKATA'], plantConfidence: 0.95 }),
  });
  assert.deepEqual(documentFields.plantScope, ['KOLKATA']);
  assert.equal(identification.plant.confidence, 0.95);
  assert.equal(identification.needsAttention.includes('plant'), false);
});

test('a document naming no plant still asks, as it always did', () => {
  const { documentFields, checks, identification } = buildIdentification({
    identified: reading(),
  });
  assert.equal(documentFields.plantScope, undefined);
  assert.ok(identification.needsAttention.includes('plant'));
  assert.ok(failing(checks, 'EXT010'), 'approval stays blocked until someone answers');
});

test('a supplier already stated on the document outranks the letterhead', () => {
  const { documentFields } = buildIdentification({
    identified: reading(),
    doc: { supplierGroupId: 'chosen-by-a-person' },
    fixedPlant: 'AHMEDABAD',
  });
  assert.equal(documentFields.supplierGroupId, 'chosen-by-a-person');
});
