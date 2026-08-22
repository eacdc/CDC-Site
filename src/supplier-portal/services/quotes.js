/**
 * Quote lifecycle: upload → extract → review → approve.
 *
 * Nothing enters `rateHistory` until a human approves. That is the whole
 * design: extraction is fast and mostly right, and "mostly right" applied
 * silently to a rate table is worse than slow, because a wrong rate is
 * invisible until someone buys against it.
 */

import crypto from 'crypto';
import {
  ensureSupplierPortalReady, QuoteDocument, QuoteLine, SupplierGroup,
  SupplierItem, RateHistory, UomNormalisation, AuditLog,
} from '../db/mongo.js';
import { check, hasBlockingFailure } from '../config/validations.js';
import { TOLERANCES, PLANTS, SITE_BY_PLANT, SEEDED_ALIASES } from '../config/constants.js';
import {
  normaliseRate, normaliseUom, parsePackSize, parseRateCell, uomOverridesFrom, magnitudeCheck,
} from '../lib/uom.js';
import { normaliseName, hasBrandOrCodeToken } from '../lib/text.js';
import { quoteSpecTuple, buildSpecKey, specKeyString } from '../lib/spec.js';
import { getProvider } from './extraction/provider.js';
import { extractWorkbook } from './extraction/xlsx-extract.js';
import { pdfPageTexts, looksLikePdf } from './extraction/pdf-text.js';
import { pdfPageImages } from './extraction/pdf-render.js';
import { identifyQuote, AUTO_ACCEPT } from './quote-identify.js';
import { planPlantSplit, groupLinesByPlant } from './quote-split.js';
import { resolveSupplyMode } from '../config/paper-vocabulary.js';
import { lastPaidRates } from './erp-items.js';
import { hammingDistance } from '../../lib/phash.js';

// ── Upload and dedup ────────────────────────────────────────────────────────

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Duplicate check, run before extraction so a re-upload costs nothing.
 *
 * An exact hash match is a block: the same file has already been processed and
 * approving it again would double-write rate history. A perceptual match
 * within 5/64 is a warning — a rescan of the same page, or the same price list
 * re-sent with a new date, and only a human can tell those apart.
 */
export async function checkDuplicate({ sha256, perceptualHashes = [] }) {
  await ensureSupplierPortalReady();
  const checks = [];

  const exact = sha256 ? await QuoteDocument.findOne({ sha256 }).lean() : null;

  /**
   * The block exists to stop rate history being written twice from one file.
   * A document that never got that far cannot have done so, and treating it as
   * a duplicate strands the file: the upload is refused, and the thing it
   * collides with is a failed record with nothing in it.
   *
   * So a prior upload only blocks if it is still a live claim on the file.
   * A rejected one, or one whose extraction failed and left no lines, is not.
   */
  const blocks = Boolean(exact) && isLiveDocument(exact);
  checks.push(check('EXT001', !blocks, {
    message: exact
      ? `Already uploaded on ${formatDate(exact.uploadedAt)} as "${exact.originalFilename}"`
      : undefined,
    actualValue: exact ? String(exact._id) : null,
  }));

  let near = null;
  if (!exact && perceptualHashes.length) {
    const recent = await QuoteDocument
      .find({ perceptualHashes: { $exists: true, $ne: [] } })
      .sort({ uploadedAt: -1 })
      .limit(500)
      .select('_id originalFilename uploadedAt perceptualHashes')
      .lean();

    outer:
    for (const doc of recent) {
      for (const a of perceptualHashes) {
        for (const b of doc.perceptualHashes || []) {
          const distance = hammingDistance(a, b);
          if (distance !== null && distance <= TOLERANCES.phashNearDuplicate) {
            near = { doc, distance };
            break outer;
          }
        }
      }
    }
  }

  checks.push(check('EXT002', !near, {
    message: near
      ? `Looks like "${near.doc.originalFilename}" uploaded on ${formatDate(near.doc.uploadedAt)} (distance ${near.distance})`
      : undefined,
    actualValue: near ? near.distance : null,
    expectedValue: `> ${TOLERANCES.phashNearDuplicate}`,
  }));

  return {
    checks,
    exactMatch: exact,
    nearMatch: near,
    isBlocked: hasBlockingFailure(checks),
    /** Set when a prior upload exists but is not a live claim on the file. */
    supersedesFailed: Boolean(exact) && !isLiveDocument(exact) ? exact._id : null,
  };
}

/**
 * Whether an existing document still stands for its file.
 *
 * REJECTED is a decision to discard it. An extraction that errored, or that
 * finished with nothing to show, produced no lines and no rates — there is
 * nothing for a re-upload to duplicate.
 */
export function isLiveDocument(doc) {
  if (!doc) return false;
  if (doc.status === 'REJECTED') return false;
  if (doc.extraction?.error) return false;
  return true;
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Run extraction for a document and store the raw lines.
 *
 * Worksheets take the grid path; everything else goes to the vision provider.
 * Both produce the same line shape, so review, matching and approval do not
 * care which was used.
 */
export async function extractDocument(documentId, { site, pages, buffer, hints = {} } = {}) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);

  await QuoteDocument.updateOne({ _id: doc._id }, {
    $set: { status: 'EXTRACTING', 'extraction.startedAt': new Date() },
  });

  try {
    const isWorksheet = doc.docType === 'WORKSHEET' || /spreadsheet|excel|\.xlsx?$/i.test(
      `${doc.mimeType || ''} ${doc.originalFilename || ''}`,
    );

    const result = isWorksheet
      ? await extractFromWorksheet(doc, buffer, hints)
      : await extractFromImages(doc, pages, hints, buffer);

    /*
      A file that prices both plants becomes two documents, one per plant.

      Everything downstream — plantScope, approval, the PO check, rate history —
      assumes a document prices one plant, and the rule that rates never cross
      plants is enforced in those consumers. Splitting keeps that rule
      structural instead of teaching every consumer that a document can
      straddle plants.

      `doc.splitPlant` is what makes re-extraction safe. The first run decides
      the split; every later run SELECTS the half this document already owns.
      Without it a rescan re-read the whole file, re-split it from scratch and
      handed over whichever half sorted first — so rescanning the Ahmedabad
      document filled it with Kolkata's rates, and would have spawned a second
      Ahmedabad sibling on top.
    */
    const grouped = groupLinesByPlant(result.lines, result.extracted?.plantBlocks);
    const owned = doc.splitPlant && grouped.groups.has(doc.splitPlant) ? doc.splitPlant : null;

    let myPlant = owned;
    let myLines = owned ? grouped.groups.get(owned) : result.lines;
    let toSpawn = [];

    if (!owned) {
      const split = planPlantSplit(result.lines, result.extracted?.plantBlocks);
      if (split) {
        myPlant = split.keep.plant;
        myLines = split.keep.lines;
        toSpawn = split.spawn;
      }
    }

    // Read once for the whole file. Supplier, validity, terms and strength are
    // properties of the document, not of a plant, so both halves share them.
    const identified = await identifyQuote({ site, extracted: result.extracted || {} });

    const finished = await finaliseDocument({
      doc, lines: myLines, result, identified, plant: myPlant,
    });

    const siblings = [];
    for (const { plant, lines } of toSpawn) {
      siblings.push(await spawnPlantSibling({ doc, plant, lines, result, identified }));
    }

    return {
      lineCount: myLines.length,
      checks: finished.checks,
      identification: finished.identification,
      ...(siblings.length ? { splitInto: siblings } : {}),
      ...result.meta,
    };
  } catch (err) {
    await QuoteDocument.updateOne({ _id: doc._id }, {
      $set: {
        status: 'NEEDS_REVIEW',
        'extraction.finishedAt': new Date(),
        'extraction.error': err.message,
      },
    });
    throw err;
  }
}

async function extractFromWorksheet(doc, buffer, hints) {
  if (!buffer) throw new Error('Worksheet extraction needs the file buffer');
  const result = extractWorkbook(buffer, {
    priceColumn: hints.priceColumn || doc.nominatedPriceColumn,
    sheetName: hints.sheetName,
  });

  const checks = [
    // Blocking rather than guessing: with five price columns, picking one is
    // a commercial decision, not a parsing decision.
    check('EXT007', !result.needsColumnChoice, {
      message: result.needsColumnChoice
        ? `This worksheet has ${result.priceColumns.length} price columns. Nominate the live one: ${result.priceColumns.join(', ')}`
        : undefined,
      actualValue: result.priceColumns,
    }),
    check('EXT006', result.duplicateCodes.length === 0, {
      message: result.duplicateCodes.length
        ? `${result.duplicateCodes.length} product code(s) appear more than once — these are usually historical price points for one code, not separate products`
        : undefined,
      actualValue: result.duplicateCodes.map((d) => d.productCode),
    }),
  ];

  return {
    lines: result.lines,
    checks,
    provider: 'xlsx',
    model: null,
    documentFields: result.nominatedColumn ? { nominatedPriceColumn: result.nominatedColumn } : {},
    meta: {
      sheets: result.sheets,
      priceColumns: result.priceColumns,
      duplicateCodes: result.duplicateCodes,
    },
  };
}

async function extractFromImages(doc, pages, hints, buffer) {
  if (!pages?.length) throw new Error('Extraction needs at least one page URL');
  const provider = await getProvider(hints.provider);
  // Usually null on a fresh upload: the supplier is what extraction is about to
  // find out. When it is known — a re-extract, or an upload from the supplier
  // portal itself — the name is passed as a hint but never as an answer.
  const group = doc.supplierGroupId
    ? await SupplierGroup.findById(doc.supplierGroupId).lean()
    : null;

  // A born-digital PDF already contains the exact characters the sender typed.
  // Handing them over removes the transcription risk on every number in the
  // document, and costs one fetch.
  const textLayer = await readTextLayer(doc, pages, buffer);

  /**
   * A vision model is sent images, and a PDF is not one — neither provider can
   * see inside it. CDC's quotes mostly arrive as PDFs printed from Word and
   * Tally, which carry their text, so those are read from the text layer and no
   * image is sent at all: the exact characters beat a picture of them.
   *
   * A scan has no text layer. It used to be refused here with "upload its pages
   * as images", which is a chore handed back to the buyer for something the
   * server can do itself — so it renders the pages and reads them as a scan.
   */
  let visionPages = pages.filter((page) => /^image\//i.test(page.mimeType || ''));
  let renderNote = null;

  /*
    Every PDF gets rendered, text layer or not.

    This used to render only scans, on the reasoning that sending an image of
    characters we already have exactly is transcription risk bought for
    nothing. That reasoning was wrong, and a board quote showed why: a PDF's
    text layer is in *drawing* order, not reading order, so a priced table
    arrives with its columns fused and its rows detached from their headings —

        QUALITY GSM SHADE BULK
        230-249 76112              <- GSM and rate run together
        NR POWER FOLD - FBB ...    <- the product, fifteen lines away

    The extraction that came back was confident and wrong: nine lines all named
    "QUALITY GSM SHADE BULK", every brand, shade and bulk lost, no unit. The
    characters were exact and the table was gone. `getTable()` recovers nothing
    here either — the grid is drawn as vector lines, with no structure to read.

    So both go: the image carries the layout, the text layer carries the exact
    digits, and the prompt tells the model to trust the text for characters and
    the image for which column a character is in. Rendering costs a few seconds
    per document; a silently mis-read price table costs a purchase decision.
  */
  if (!visionPages.length) {
    const rendered = await renderPdfPages(doc, pages, buffer);

    if (!rendered && !textLayer) {
      throw new Error(
        'This PDF has no text layer, so it is a scan, and its pages could not be '
        + 'rendered for reading. Upload the pages as images (JPEG or PNG) instead.',
      );
    }

    if (rendered) {
      visionPages = rendered.pages;
      // What the note has to convey is which sources were used, because that
      // is what tells a reviewer how much to trust a column boundary. "Read
      // from a scan" and "read from a laid-out page whose text we also have"
      // warrant different amounts of checking.
      const what = textLayer
        ? (textLayer.isThin ? 'Mostly-image PDF' : 'PDF')
        : 'Scanned PDF';
      const how = textLayer
        ? `${rendered.rendered} page${rendered.rendered === 1 ? '' : 's'} read as images alongside the text layer`
        : `${rendered.rendered} page${rendered.rendered === 1 ? '' : 's'} read as images`;
      // A truncated scan must say so. A silent cap reads as a complete
      // extraction that happens to be missing half the price list.
      renderNote = rendered.truncated
        ? `${what}: only the first ${rendered.rendered} of ${rendered.total} pages were read.`
        : `${what}: ${how}.`;
    }
    // A thin layer whose render failed still has its text — worse than both,
    // better than refusing a document we can partly read.
  }

  const extracted = await provider.extractQuote({
    pages: visionPages,
    textLayer,
    docType: doc.docType,
    hints: { ...hints, supplierName: group?.name, plantScope: doc.plantScope },
  });

  const checks = [
    check('EXT003', Boolean(extracted.effectiveFrom || extracted.documentDate), {
      message: 'No effective date found — validity will be defaulted',
    }),
  ];

  /*
    A scan was transcribed from a picture rather than copied from characters,
    so every number on it carries a reading risk that a born-digital PDF does
    not. The reviewer is told, on the document, which of the two they are
    looking at — without it the two extractions are indistinguishable on screen
    and get the same amount of checking.
  */
  if (renderNote) {
    /*
      Only a document whose numbers were *transcribed from a picture* carries
      extra reading risk. Now that every PDF is rendered, a born-digital one
      also has a render note — but its digits came from the text layer, exactly.
      Flagging both the same way would put this notice on every document in the
      system, and a notice that appears on everything is read as noise and then
      not read at all.
    */
    const transcribed = !textLayer || textLayer.isThin;
    checks.push(check('EXT011', false, {
      message: transcribed
        ? `${renderNote} Rates were transcribed from images — check them against the document.`
        : renderNote,
    }));
  }

  const documentFields = {};
  if (extracted.rateBasisNote) documentFields.rateBasisNote = extracted.rateBasisNote;
  if (extracted.isSoftQuote) documentFields.quoteStrength = 'SOFT';
  if (extracted.commercialTerms) {
    documentFields.commercialTerms = {
      creditDays: numberish(extracted.commercialTerms.creditDays),
      freightTerms: extracted.commercialTerms.freightTerms,
      insurance: extracted.commercialTerms.insurance,
      gstNote: extracted.commercialTerms.gstNote,
      paymentTerms: extracted.commercialTerms.paymentTerms,
    };
  }
  if (extracted.statedRules?.length) {
    documentFields.derivationRules = extracted.statedRules.map(toDerivationRule).filter(Boolean);
  }
  // Plants the document itself names. If it names none, plantScope stays as
  // the uploader set it and plantScopeBasis records that it was assumed.
  const namedPlants = (extracted.plantMentions || [])
    .map(plantFromText)
    .filter(Boolean);
  if (namedPlants.length) {
    documentFields.plantScope = [...new Set(namedPlants)];
    documentFields.plantScopeBasis = 'STATED';
  }

  const dates = resolveValidity(extracted, doc, group);
  Object.assign(documentFields, dates);

  return {
    lines: extracted.lines || [],
    checks,
    provider: extracted._provider,
    model: extracted._model,
    documentFields,
    // Handed back so identification can run on the same reading rather than
    // re-calling the provider. Identification is a judgement about the
    // extraction, not a second extraction.
    extracted,
    meta: { plantBlocks: extracted.plantBlocks || null, renderedFromScan: renderNote },
  };
}

/**
 * Rasterise a scanned PDF's pages so a vision model can read them.
 *
 * Returns null rather than throwing: a failure here should surface as "this
 * scan could not be rendered", which the caller words, rather than as a sharp
 * pdfjs error naming an internal API the reader has no use for.
 */
async function renderPdfPages(doc, pages, buffer) {
  if (!looksLikePdf(doc)) return null;

  try {
    // As with the text layer, the upload path already holds the bytes; only a
    // re-extract has to fetch them back out of storage.
    const bytes = buffer || await fetchPage(pages?.[0]?.url);
    if (!bytes) return null;
    return await pdfPageImages(bytes);
  } catch (err) {
    console.warn('[SP][quotes] could not render the scanned PDF:', err.message);
    return null;
  }
}

/**
 * The PDF's text layer, or null.
 *
 * Fetched from the same signed URL the vision provider reads, so it works for
 * both upload paths without threading a buffer through them. Any failure here
 * is a warning and nothing more: extraction proceeds on the images alone,
 * exactly as it did before this existed.
 */
async function readTextLayer(doc, pages, buffer) {
  if (!looksLikePdf(doc)) return null;

  try {
    // On the upload path the bytes are already in hand. Only a re-extract of a
    // document uploaded earlier has to fetch them back out of storage.
    const bytes = buffer || await fetchPage(pages?.[0]?.url);
    if (!bytes) return null;
    const layer = await pdfPageTexts(bytes);
    return layer.hasTextLayer ? layer : null;
  } catch (err) {
    console.warn('[SP][quotes] could not read the PDF text layer:', err.message);
    return null;
  }
}

async function fetchPage(url) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`storage returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// ── Identification ──────────────────────────────────────────────────────────

/**
 * Propose who sent a quote and which plant it prices, from the document.
 *
 * A proposal above `AUTO_ACCEPT` is written straight through to the settled
 * field — the reviewer sees it filled in with its evidence and moves on. Below
 * that, the field stays empty and a blocking check holds approval until a
 * person answers. Nothing in between: a half-confident supplier written
 * quietly into `supplierGroupId` is exactly the failure this replaces.
 */
export async function proposeIdentification({ doc, site, extracted, fixedPlant = null }) {
  const identified = await identifyQuote({ site, extracted });
  return { ...buildIdentification({ identified, doc, fixedPlant }), identified };
}

/**
 * Turn one reading of a document into the fields and checks for one document.
 *
 * Split out from `proposeIdentification` so the two halves of a split file can
 * share a single reading. The supplier, the validity, the terms and the strength
 * are properties of the *file* — one letterhead, one date, one set of terms —
 * so re-reading them per half would be wasted work and could disagree with
 * itself. Only the plant differs, and `fixedPlant` supplies it.
 *
 * Getting this wrong is what shipped: the Ahmedabad half was created before
 * identification ran and never received any of it, so it opened with no
 * supplier, no validity and no terms, and could not be saved.
 *
 * @param {Object} input
 * @param {Object} input.identified   the result of `identifyQuote`
 * @param {Object} [input.doc]        the document, for a supplier already stated
 * @param {string} [input.fixedPlant] the plant this document owns, when the file
 *   priced several. It comes from the rate column the rows were actually in,
 *   which is stronger evidence than the addressee block, so it settles the
 *   plant outright rather than being weighed against what was read.
 */
export function buildIdentification({ identified, doc = null, fixedPlant = null }) {
  const { supplier, plant, validity, strength, terms } = identified;

  // A supplier the caller already stated outranks anything read off the page.
  // The supplier portal knows whose quote it is from the session, and a
  // letterhead naming a parent company must not reassign it.
  const statedSupplier = doc?.supplierGroupId || null;
  const supplierSettled = Boolean(statedSupplier)
    || (Boolean(supplier.supplierGroupId) && supplier.confidence >= AUTO_ACCEPT);
  const plantSettled = Boolean(fixedPlant)
    || (plant.value.length > 0 && plant.confidence >= AUTO_ACCEPT);

  const identification = {
    status: 'PROPOSED',
    supplier: {
      proposedGroupId: supplier.supplierGroupId || null,
      proposedName: supplier.value || null,
      readName: supplier.readName || null,
      readGstin: supplier.readGstin || null,
      foundIn: supplier.foundIn || null,
      confidence: supplier.confidence,
      evidence: supplier.evidence,
      candidates: supplier.candidates || [],
      ledgerCandidates: supplier.ledgerCandidates || [],
      basis: 'READ',
    },
    plant: fixedPlant ? {
      proposed: [fixedPlant],
      unit: plant.unit || null,
      readAddress: plant.readAddress || null,
      confidence: 1,
      evidence: `This document holds the ${titleCasePlant(fixedPlant)} rates from a quote that priced both plants — taken from the column the rows were printed in.`,
      basis: 'READ',
    } : {
      proposed: plant.value,
      unit: plant.unit || null,
      readAddress: plant.readAddress || null,
      confidence: plant.confidence,
      evidence: plant.evidence,
      basis: 'READ',
    },
    validity: { confidence: validity.confidence, evidence: validity.evidence },
    strength: { confidence: strength.confidence, evidence: strength.evidence },
    terms: { confidence: terms.confidence, evidence: terms.evidence },
    needsAttention: [
      ...(supplierSettled ? [] : ['supplier']),
      ...(plantSettled ? [] : ['plant']),
    ],
  };

  const documentFields = { identification };
  if (supplierSettled) {
    documentFields.supplierGroupId = statedSupplier || supplier.supplierGroupId;
  }
  if (plantSettled) {
    documentFields.plantScope = fixedPlant ? [fixedPlant] : plant.value;
    documentFields.plantScopeBasis = 'STATED';
  }
  // The strength read from the page beats the FIRM default, but never
  // downgrades a FIRM that a person set deliberately at upload.
  if (strength.value === 'SOFT') documentFields.quoteStrength = 'SOFT';

  return { documentFields, checks: identificationChecks(identification), identification };
}

/** "KOLKATA" -> "Kolkata", for a sentence a person reads. */
function titleCasePlant(plant) {
  const t = String(plant || '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The two checks that hold approval until identification is settled.
 *
 * Rebuilt from scratch on every change rather than mutated, so the stored pair
 * always reflects the document's current state. They pass by disappearing from
 * failure, not by being deleted: a check that vanishes when it passes is
 * indistinguishable from one that never ran.
 */
export function identificationChecks(identification) {
  const needs = identification?.needsAttention || [];
  return [
    check('EXT009', !needs.includes('supplier'), {
      message: identification?.supplier?.evidence,
      actualValue: identification?.supplier?.readName || null,
    }),
    check('EXT010', !needs.includes('plant'), {
      message: identification?.plant?.evidence,
      actualValue: identification?.plant?.readAddress || null,
    }),
  ];
}

/**
 * Settle a document's identification.
 *
 * Every field is optional: a reviewer confirming a correct proposal sends
 * nothing but the confirmation, and the proposal becomes the answer. Sending a
 * value overrides it and is recorded as CORRECTED rather than CONFIRMED,
 * because the two mean different things — a supplier corrected every month is
 * a missing alias, and collapsing that into "confirmed" hides it.
 */
export async function confirmIdentification({
  documentId, actor, supplierGroupId, plantScope, quoteStrength, cdcEntityScope,
  effectiveFrom, effectiveTo, commercialTerms, docType, ledgerRef,
}) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);
  if (doc.status === 'APPROVED') {
    throw new Error('This document has already been approved; its identification cannot be changed.');
  }

  const proposal = doc.identification || {};

  // Supplier: an explicit value overrides, otherwise the proposal stands.
  const chosenSupplier = supplierGroupId ?? doc.supplierGroupId ?? proposal.supplier?.proposedGroupId ?? null;
  if (chosenSupplier) {
    const group = await SupplierGroup.findById(chosenSupplier).lean();
    if (!group) throw new Error('Supplier group not found.');
    doc.supplierGroupId = group._id;
    doc.set(
      'identification.supplier.basis',
      String(chosenSupplier) === String(proposal.supplier?.proposedGroupId) ? 'CONFIRMED' : 'CORRECTED',
    );

    // A name the extractor read that did not match becomes an alias on the
    // group the reviewer picked. This is the whole compounding mechanism: the
    // correction made once is why the same supplier's next quote needs none.
    const readName = proposal.supplier?.readName;
    if (readName && normaliseName(readName) !== normaliseName(group.name)) {
      await SupplierGroup.updateOne({ _id: group._id }, {
        $addToSet: { aliases: readName.trim() },
      });
    }
    const readGstin = proposal.supplier?.readGstin;
    if (readGstin) {
      await SupplierGroup.updateOne({ _id: group._id }, { $addToSet: { gstins: readGstin } });
    }
  }

  // Plant: same rule, and an empty array is not a valid answer — it is the
  // absence of one, which is what the blocking check is for.
  const chosenPlants = normalisePlants(plantScope)
    ?? (doc.plantScope?.length ? doc.plantScope : null)
    ?? (proposal.plant?.proposed?.length ? proposal.plant.proposed : null);
  if (chosenPlants?.length) {
    const sameAsProposed = sameSet(chosenPlants, proposal.plant?.proposed || []);
    doc.plantScope = chosenPlants;
    doc.plantScopeBasis = sameAsProposed && proposal.plant?.basis === 'READ' ? 'STATED' : 'ASKED';
    doc.set('identification.plant.basis', sameAsProposed ? 'CONFIRMED' : 'CORRECTED');
  }

  if (docType) doc.docType = docType;
  if (ledgerRef) doc.ledgerRef = ledgerRef;
  if (quoteStrength) doc.quoteStrength = quoteStrength;
  if (cdcEntityScope) doc.cdcEntityScope = cdcEntityScope;
  if (commercialTerms) doc.commercialTerms = { ...doc.commercialTerms, ...commercialTerms };

  const from = parseDate(effectiveFrom);
  const to = parseDate(effectiveTo);
  if (from) doc.effectiveFrom = from;
  if (to) {
    doc.effectiveTo = to;
    doc.validityBasis = 'STATED';
  } else if (doc.validityBasis !== 'STATED' && doc.effectiveFrom) {
    // The supplier's own default validity is only knowable once the supplier
    // is. Extraction ran before that and used the global default, so a
    // supplier with agreed longer terms gets them applied here.
    const group = doc.supplierGroupId ? await SupplierGroup.findById(doc.supplierGroupId).lean() : null;
    const days = group?.defaultValidityDays || TOLERANCES.defaultValidityDays;
    const expiry = new Date(doc.effectiveFrom);
    expiry.setDate(expiry.getDate() + days);
    doc.effectiveTo = expiry;
  }

  const needsAttention = [
    ...(doc.supplierGroupId ? [] : ['supplier']),
    ...(doc.plantScope?.length ? [] : ['plant']),
  ];
  doc.set('identification.needsAttention', needsAttention);
  doc.set('identification.status', needsAttention.length ? 'PROPOSED' : 'CONFIRMED');
  if (!needsAttention.length) {
    doc.set('identification.confirmedBy', actor);
    doc.set('identification.confirmedAt', new Date());
  }

  // The two identification checks are replaced rather than appended, so the
  // stored pair is always the current state and never a history of attempts.
  doc.checks = [
    ...(doc.checks || []).filter((c) => !['EXT009', 'EXT010'].includes(c.code)),
    ...identificationChecks(doc.identification),
  ];

  if (doc.status === 'NEEDS_REVIEW' && !hasBlockingFailure(doc.checks)) {
    doc.status = 'EXTRACTED';
  }

  await doc.save();

  await AuditLog.create({
    action: 'QUOTE_IDENTIFICATION_CONFIRMED',
    entity: 'quoteDocument',
    entityId: String(doc._id),
    actor,
    before: {
      supplierGroupId: proposal.supplier?.proposedGroupId || null,
      plantScope: proposal.plant?.proposed || [],
    },
    after: { supplierGroupId: doc.supplierGroupId, plantScope: doc.plantScope },
    meta: {
      supplierBasis: doc.identification?.supplier?.basis,
      plantBasis: doc.identification?.plant?.basis,
    },
  });

  return doc.toObject();
}

/**
 * Re-run identification against the supplier groups as they stand now.
 *
 * The document is not re-extracted. What was read off the page — the name, the
 * GSTIN, the address it was addressed to — is stored on the proposal, and that
 * is the entire input identification needs. Paying for a second vision call to
 * discover that a group created two minutes ago now matches would be absurd.
 *
 * Fields a person has already settled are left alone: re-identifying must not
 * undo a decision by proposing over it.
 */
/**
 * Set the unit for a document whose rows print none, and re-normalise.
 *
 * Re-normalising rather than storing the answer and moving on is the whole
 * point: a rate is only comparable once it is in canonical units, and a board
 * quote at ₹76,112 per tonne is ₹76.11 per kg. Leaving the raw figure and a
 * note beside it would put a number a thousand times too large into every
 * comparison that reads this document.
 *
 * Rows that DID state their own unit are untouched — `normaliseLine` keeps the
 * printed unit ahead of this one, so a mixed document cannot be flattened by
 * one answer.
 */
export async function setDocumentUom({ documentId, uom, actor }) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);
  if (doc.status === 'APPROVED') {
    throw new Error('This document has already been approved; its rates cannot be re-based.');
  }

  const parsed = normaliseUom(uom);
  if (!parsed?.canonical) {
    throw new Error(
      `"${uom}" is not a unit this system can convert. Use one it knows — KG, MT, PC, LTR, SQM.`,
    );
  }

  doc.defaultUom = String(uom).trim().toUpperCase();
  await doc.save();

  // Re-run from the stored raw lines. The extraction is not repeated: nothing
  // about the document changed, only what we know the numbers mean.
  const lines = await QuoteLine.find({ quoteDocumentId: doc._id }).sort({ lineNo: 1 }).lean();
  const relined = lines.map((l) => ({ ...l.raw, lineNo: l.lineNo, confidence: l.extractionConfidence }));
  const stored = await storeLines(doc, relined);

  const checks = (doc.checks || []).filter((c) => c.code !== 'EXT012');
  await QuoteDocument.updateOne({ _id: doc._id }, {
    $set: { checks, status: hasBlockingFailure(checks) ? 'NEEDS_REVIEW' : 'EXTRACTED' },
  });

  await AuditLog.create({
    action: 'QUOTE_DEFAULT_UOM_SET',
    entity: 'quoteDocument',
    entityId: String(doc._id),
    actor: actor || null,
    after: { defaultUom: doc.defaultUom, lines: stored.count },
  });

  return { defaultUom: doc.defaultUom, lines: stored.count };
}

export async function reidentifyDocument({ documentId, site }) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);
  if (doc.status === 'APPROVED') {
    throw new Error('This document has already been approved; its identification cannot be changed.');
  }

  const prior = doc.identification || {};
  const supplierSettled = prior.supplier?.basis && prior.supplier.basis !== 'READ';
  const plantSettled = prior.plant?.basis && prior.plant.basis !== 'READ';

  const { documentFields, checks } = await proposeIdentification({
    doc,
    site,
    // Reconstructed from what was stored, not re-read. `readName` is the name
    // exactly as printed, which is what matched — or failed to — last time.
    extracted: {
      supplier: {
        name: prior.supplier?.readName || null,
        gstin: prior.supplier?.readGstin || null,
        foundIn: prior.supplier?.foundIn || null,
      },
      addressedTo: { address: prior.plant?.readAddress || null },
      plantMentions: prior.plant?.proposed || null,
    },
  });

  const identification = documentFields.identification;

  if (supplierSettled) {
    identification.supplier = prior.supplier;
    identification.needsAttention = identification.needsAttention.filter((f) => f !== 'supplier');
  } else if (documentFields.supplierGroupId) {
    doc.supplierGroupId = documentFields.supplierGroupId;
  }

  if (plantSettled) {
    identification.plant = prior.plant;
    identification.needsAttention = identification.needsAttention.filter((f) => f !== 'plant');
  } else if (documentFields.plantScope) {
    doc.plantScope = documentFields.plantScope;
    doc.plantScopeBasis = documentFields.plantScopeBasis;
  }

  // Validity, strength and terms were judged from the full extraction, which
  // is not being re-read. Keeping the earlier readings is more truthful than
  // recomputing them from a stub that has no dates in it.
  identification.validity = prior.validity || identification.validity;
  identification.strength = prior.strength || identification.strength;
  identification.terms = prior.terms || identification.terms;

  doc.set('identification', identification);
  doc.checks = [
    ...(doc.checks || []).filter((c) => !['EXT009', 'EXT010'].includes(c.code)),
    ...identificationChecks(identification),
  ];
  if (doc.status === 'NEEDS_REVIEW' && !hasBlockingFailure(doc.checks)) doc.status = 'EXTRACTED';
  await doc.save();

  return { document: doc.toObject(), identification, checks };
}

/** Canonical plant names, or null when nothing usable was sent. */
function normalisePlants(value) {
  if (!Array.isArray(value)) return null;
  const plants = [...new Set(value.map(plantFromText).filter(Boolean))];
  return plants.length ? plants : null;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((x) => set.has(x));
}

/**
 * Resolve effectiveFrom/To.
 *
 * Sanjeevani gives no date at all; the default validity (75 days, overridable
 * per supplier) applies and the basis records that it was defaulted rather
 * than stated. Distinguishing the two matters: a defaulted expiry is a prompt
 * to ask, not a fact about the supplier's terms.
 */
export function resolveValidity(extracted, doc, group) {
  const from = parseDate(extracted.effectiveFrom) || parseDate(extracted.documentDate) || doc.uploadedAt || new Date();
  const statedTo = parseDate(extracted.effectiveTo);

  if (statedTo) {
    return { effectiveFrom: from, effectiveTo: statedTo, validityBasis: 'STATED' };
  }

  const days = group?.defaultValidityDays || TOLERANCES.defaultValidityDays;
  const to = new Date(from);
  to.setDate(to.getDate() + days);

  return {
    effectiveFrom: from,
    effectiveTo: to,
    validityBasis: parseDate(extracted.effectiveFrom) ? 'DEFAULTED' : 'NONE_GIVEN',
  };
}

/**
 * Normalise and store the extracted lines.
 *
 * Normalisation happens here rather than in the extractor so the raw text
 * stays alongside the computed number. Every figure on the review screen can
 * then be traced to what the document actually said.
 */
/**
 * Store one document's lines and write everything that follows from them.
 *
 * The single finishing path, used by the document the reviewer uploaded and by
 * every half split off it. That it is shared is the point: the first version
 * created siblings on a separate, shorter path that skipped identification and
 * skipped the checks, so the Ahmedabad half opened with no supplier, no
 * validity, no terms, no unit question — and a status of EXTRACTED that its
 * own blocking checks would have contradicted, had any been run.
 *
 * @param {Object} input
 * @param {Object} input.doc        the document to finish
 * @param {Array}  input.lines      the lines that belong to it
 * @param {Object} input.result     the extraction result for the whole file
 * @param {Object} input.identified the single reading of the file
 * @param {string} [input.plant]    the plant it owns, when the file split
 */
async function finaliseDocument({ doc, lines, result, identified, plant = null }) {
  const stored = await storeLines(doc, lines);

  // A worksheet carries no letterhead, so it produces an empty proposal — and
  // an empty proposal is the correct outcome: it asks, instead of defaulting.
  const { documentFields, checks: idChecks, identification } = buildIdentification({
    identified, doc, fixedPlant: plant,
  });

  const checks = [...result.checks, ...idChecks];

  // One question about the document, rather than the same question against
  // every row of it.
  if (stored.documentStatesNoUom) {
    checks.push(check('EXT012', false, {
      message: result.documentFields?.rateBasisNote
        ? `The rate column reads "${result.documentFields.rateBasisNote}" and names no unit — set the unit these rates are quoted in.`
        : 'No unit is printed anywhere on this document — set the unit these rates are quoted in.',
      actualValue: result.documentFields?.rateBasisNote || null,
    }));
  }

  await QuoteDocument.updateOne({ _id: doc._id }, {
    $set: {
      status: hasBlockingFailure(checks) ? 'NEEDS_REVIEW' : 'EXTRACTED',
      'extraction.provider': result.provider,
      'extraction.model': result.model,
      'extraction.finishedAt': new Date(),
      'extraction.error': null,
      ...result.documentFields,
      ...documentFields,
      ...(result.extracted?.materialClass
        ? { materialClass: result.extracted.materialClass } : {}),
      // Recorded on both halves, so a later rescan selects this plant's rows
      // instead of splitting the file again from scratch.
      ...(plant ? { splitPlant: plant } : {}),
      /*
        Replaced, not appended.

        Checks are rebuilt from the document's current state on every run, so
        pushing them accumulated: a rescan left the previous run's failures
        standing beside the very fixes that resolved them, and the count on
        screen only ever grew. A check passes by disappearing from failure, and
        that only works if the stored set is the current one.
      */
      checks,
    },
  });

  return { checks, identification, lineCount: lines.length };
}

/**
 * Create the document for one extra plant and finish it exactly like the first.
 *
 * The halves share the uploaded file rather than copying it: same
 * `storageKey`, same hashes, so the review screen shows the same PDF and R2
 * holds one object. `splitFrom` records where this one came from, so the two
 * can be shown as siblings rather than as an unexplained duplicate.
 *
 * A failure here must not lose the extraction that produced it. If the sibling
 * cannot be written, the original still gets its own plant's rows and the
 * caller is told which plant went missing; throwing would discard both halves.
 */
async function spawnPlantSibling({ doc, plant, lines, result, identified }) {
  try {
    const source = doc.toObject ? doc.toObject() : { ...doc };
    const {
      _id, createdAt, updatedAt, checks, status, extraction, ...carried
    } = source;

    const sibling = await QuoteDocument.create({
      ...carried,
      splitFrom: doc._id,
      splitPlant: plant,
      plantScope: [plant],
      plantScopeBasis: 'STATED',
      status: 'EXTRACTING',
      checks: [],
    });

    const finished = await finaliseDocument({
      doc: sibling, lines, result, identified, plant,
    });

    return { documentId: String(sibling._id), plant, lineCount: finished.lineCount };
  } catch (err) {
    console.error(`[SP][split] could not create the ${plant} half:`, err.message);
    return { plant, error: err.message };
  }
}

async function storeLines(doc, rawLines) {
  const overrides = uomOverridesFrom(await UomNormalisation.find({}).lean());
  await QuoteLine.deleteMany({ quoteDocumentId: doc._id });

  /*
    "No row states a unit" and "one row is missing its unit" are different
    problems with different fixes. The first is a property of the document —
    board price lists routinely omit it — and is answered once by a person; the
    second is a misread row and belongs against that row. Distinguish them here
    so the review screen can ask the right question.
  */
  const documentStatesNoUom = !doc.defaultUom
    && rawLines.length > 0
    && rawLines.every((l) => !l.uom && !parseRateCell(l.rate).uom);

  const docs = rawLines.map((line, index) => {
    const raw = {
      text: line.text ?? null,
      productName: line.productName ?? null,
      productCode: line.productCode ?? null,
      packSize: line.packSize ?? null,
      uom: line.uom ?? null,
      rate: line.rate ?? null,
      gstNote: line.gstNote ?? null,
      gsmFrom: line.gsmFrom ?? null,
      gsmTo: line.gsmTo ?? null,
      productForm: line.productForm ?? null,
      width: line.width ?? null,
      micron: line.micron ?? null,
      // Paper and board. Kept as separate fields rather than folded into the
      // product name, because matching a board quote means matching a grade
      // and a GSM band, not a string.
      mill: line.mill ?? null,
      brand: line.brand ?? null,
      grade: line.grade ?? null,
      shade: line.shade ?? null,
      bulk: line.bulk ?? null,
      brightness: line.brightness ?? null,
      /*
        Read from the field when the extractor set one, otherwise recovered
        from the words around the row. On a handwritten note "mill order" and
        "from stock" are section headings rather than a column, so the
        extractor often folds them into the product name — and a rate filed
        without its supply mode is one of two prices with no way to tell which.
      */
      supplyMode: resolveSupplyMode(line.supplyMode)
        || resolveSupplyMode(line.productName)
        || resolveSupplyMode(line.notes)
        || null,
      notes: line.notes ?? null,
    };

    const normalised = normaliseLine(raw, overrides, { documentUom: doc.defaultUom });
    const tuple = quoteSpecTuple({ raw });
    const specKey = buildSpecKey(tuple);

    /*
      When the document names no unit anywhere, the per-line failure is not
      this line's fault and repeating it per row buries the one thing that
      needs doing. EXT011 asks once, at document scope, instead.
    */
    const lineChecks = documentStatesNoUom ? [] : [
      check('EXT004', Boolean(normalised.uom), {
        message: normalised.conversionNote || 'Unit could not be resolved from this line',
        actualValue: raw.uom,
        lineNo: line.lineNo ?? index + 1,
      }),
    ];

    return {
      quoteDocumentId: doc._id,
      lineNo: line.lineNo ?? index + 1,
      raw,
      normalised,
      specKey,
      extractionConfidence: line.confidence ?? null,
      flags: normalised.flags,
      checks: lineChecks,
    };
  });

  if (docs.length) await QuoteLine.insertMany(docs);
  return { count: docs.length, documentStatesNoUom };
}

/**
 * Turn one raw line into normalised numbers.
 *
 * The unit is taken from the rate cell first (`131.00/UNIT` states its own
 * unit), then from the line's own UOM field. A column header is never
 * consulted — the extractor was told not to supply one.
 */
export function normaliseLine(raw, overrides, { documentUom = null } = {}) {
  const flags = [];
  const fromCell = parseRateCell(raw.rate);

  /*
    Order of authority: the rate cell, then the line, then the document.

    The document-level unit is last because it is the weakest evidence — a
    person's answer about the sheet as a whole, not something printed on the
    row. It exists because some price lists state their unit nowhere at all: a
    board quote whose column reads "RATE FOR 90 DAYS" gives nine rows and no
    unit, and asking the same question nine times is not a review, it is an
    obstacle. A row that does state its own unit always wins, so setting a
    document default can never overwrite something the supplier printed.
  */
  const uomSource = fromCell.uom ? 'RATE_CELL' : (raw.uom ? 'LINE_UOM' : 'DOCUMENT');
  const uom = fromCell.uom || raw.uom || documentUom;

  const pack = parsePackSize([raw.productName, raw.packSize].filter(Boolean).join(' '));
  if (pack) flags.push('PACK_SIZE_IN_NAME');
  if (pack?.assumedUom) flags.push('PACK_UOM_ASSUMED');

  /**
   * Whether the quoted figure prices a whole pack or one base unit cannot be
   * read off the document with certainty. The rule used here: if the quoted
   * unit is the same as the pack unit, the supplier is pricing per unit
   * (₹149/kg for a 15 kg spool); if the quoted unit is a count — NOS, PCS,
   * SET, BOX — while the pack is measured in mass or volume, the figure
   * prices the pack.
   */
  const perPack = Boolean(pack) && isCountUnit(uom) && !isCountUnit(pack.packUom);
  if (perPack) flags.push('RATE_TREATED_AS_PER_PACK');

  const result = normaliseRate({
    rate: fromCell.rate ?? raw.rate,
    uom,
    packQty: pack?.packQty,
    packUom: pack?.packUom,
    perPack,
    overrides,
  });

  if (result.isAmbiguous) flags.push('UOM_UNRESOLVED');
  if (!raw.uom && !fromCell.uom) {
    flags.push('NO_UOM_ON_LINE');
    // Traceable on the review screen: a rate normalised from an answer rather
    // than from the page must never look like it was printed there.
    if (documentUom) flags.push('UOM_FROM_DOCUMENT');
  }
  if (hasBrandOrCodeToken(`${raw.productName || ''} ${raw.productCode || ''}`)) {
    flags.push('WEB_LOOKUP_ELIGIBLE');
  }

  return {
    rate: result.rate,
    uom: result.uom,
    packQty: result.packQty,
    packUom: result.packUom,
    ratePerBaseUom: result.ratePerBaseUom,
    conversionNote: result.conversionNote,
    flags,
  };
}

function isCountUnit(uom) {
  return ['NOS', 'PCS', 'SET', 'BOX', 'ROLL', 'SHEET'].includes(String(uom ?? '').toUpperCase());
}

// ── Magnitude guard against last-paid ───────────────────────────────────────

/**
 * Run EXT005 across a document's lines once they have candidate items.
 *
 * A line is blocked when its normalised rate is more than 10x from what CDC
 * last paid. That is not a pricing judgement — a 10x move is a basis error, and
 * the reviewer is told which basis error it most likely is.
 */
export async function runMagnitudeChecks(site, documentId) {
  await ensureSupplierPortalReady();
  const { ItemMapping } = await import('../db/mongo.js');

  const lines = await QuoteLine.find({ quoteDocumentId: documentId }).lean();
  const supplierItemIds = lines.map((l) => l.supplierItemId).filter(Boolean);
  if (!supplierItemIds.length) return [];

  const mappings = await ItemMapping.find({
    supplierItemId: { $in: supplierItemIds },
    isActive: true,
    'itemRef.site': site,
  }).lean();

  // One supplier item can map to several equivalent CDC items. Any of them is
  // a valid basis for the magnitude check, so the first is used — the check
  // asks "is this the right order of magnitude", not "which item exactly".
  const itemBySupplierItem = new Map();
  for (const m of mappings) {
    if (!itemBySupplierItem.has(String(m.supplierItemId))) {
      itemBySupplierItem.set(String(m.supplierItemId), m.itemRef.itemId);
    }
  }

  const lastPaid = await lastPaidRates(site, [...itemBySupplierItem.values()]);
  const results = [];

  for (const line of lines) {
    const itemId = line.supplierItemId
      ? itemBySupplierItem.get(String(line.supplierItemId))
      : null;
    const paid = itemId ? lastPaid.get(itemId) : null;
    const verdict = magnitudeCheck(line.normalised?.ratePerBaseUom ?? line.normalised?.rate, paid?.rate);

    // No last-paid rate is not evidence of a problem — a new item has none.
    if (!verdict) continue;

    const result = check('EXT005', verdict.passed, {
      lineNo: line.lineNo,
      message: verdict.passed
        ? undefined
        : `Normalised ₹${verdict.normalisedRate} vs last paid ₹${verdict.lastPaidRate} (${verdict.ratio}x) — ${verdict.likelyCause}`,
      actualValue: verdict.normalisedRate,
      expectedValue: verdict.lastPaidRate,
    });

    await QuoteLine.updateOne({ _id: line._id }, { $push: { checks: result } });
    results.push(result);
  }

  return results;
}

// ── Approval ────────────────────────────────────────────────────────────────

/**
 * Approve a document and write its rate history.
 *
 * Plant is the dimension that makes this more than an insert. A document
 * covering both plants writes two rows per line at different rates; a document
 * covering one writes one row and says nothing about the other. Nothing here
 * ever copies a rate across plants.
 *
 * @param {Object} opts
 * @param {string} opts.documentId
 * @param {string} opts.actor
 * @param {Array<{code: string, reason: string}>} [opts.overrides] reasons for WARN checks
 */
/**
 * Delete a quote document and its lines.
 *
 * An APPROVED document is refused. Its rates are in `rateHistory`, other rows
 * were closed to make room for them, and PO checks have been answered against
 * them — deleting it would leave a rate whose provenance no longer exists,
 * which is worse than a wrong rate because nothing can even be traced. Reject
 * or supersede those instead.
 *
 * Everything else is fair game. A failed extraction, a wrong file, a scan of
 * the wrong page: these are mistakes, and a mistake you cannot undo becomes a
 * permanent row in a list somebody has to read past forever.
 */
/**
 * Read an already-stored file again, as a new document that supersedes the old.
 *
 * The gap this fills: an approved quote cannot be deleted, because its rates
 * are in `rateHistory` and deleting it would orphan them. The refusal pointed
 * at uploading a replacement "as a re-quote" — a workflow that existed in the
 * service layer and had no way to reach it. Re-uploading the same file did not
 * work either: an identical file is caught as a duplicate of the live approved
 * one. So an approved quote was a dead end, and the only way to re-read it with
 * improved extraction was to have never approved it.
 *
 * The distinction that makes this safe: **the old document is not touched.**
 * Its lines and its rate rows stand exactly as approved. This creates a second
 * document over the same stored file, extracts it fresh, and points
 * `supersedesDocId` at the original — so approving the new one closes the old
 * one through the same path a genuine re-quote from the supplier would.
 *
 * Two reasons to run it, and they behave identically:
 *   - the supplier sent the same prices again and you want them re-read by a
 *     better extractor
 *   - you want to correct an approved document you can no longer edit
 *
 * The file is not re-uploaded; `storageKey` is shared. The hashes are
 * deliberately NOT copied — see below.
 */
export async function requoteFromDocument({ documentId, actor, reason }) {
  await ensureSupplierPortalReady();
  const original = await QuoteDocument.findById(documentId).lean();
  if (!original) throw new Error('Quote document not found.');

  if (!original.storageKey && !original.cloudinaryUrl) {
    const error = new Error(
      'This quote has no stored file to read again — it was registered without one. Upload the file instead.',
    );
    error.status = 409;
    throw error;
  }

  const existing = await QuoteDocument.findOne({
    supersedesDocId: original._id,
    status: { $nin: ['REJECTED', 'SUPERSEDED'] },
  }).lean();
  if (existing) {
    const error = new Error('A re-read of this quote is already open. Finish or reject that one first.');
    error.status = 409;
    error.documentId = String(existing._id);
    throw error;
  }

  const replacement = await QuoteDocument.create({
    storageKey: original.storageKey,
    cloudinaryUrl: original.cloudinaryUrl,
    pageKeys: original.pageKeys,
    originalFilename: original.originalFilename,
    mimeType: original.mimeType,
    docType: original.docType,

    /*
      sha256 and perceptualHashes are left unset on purpose.

      They are the duplicate detector's index, and copying them would make this
      document collide with the original — the very block that made an approved
      quote impossible to re-read. The stored file is still reachable through
      storageKey, which is what the extractor needs; the hashes exist to stop
      somebody uploading the same file twice by accident, and this is not that.
    */

    supersedesDocId: original._id,
    // The supplier and plant were settled on the original by a person. Making
    // them answer again would be asking a question they have already answered,
    // and re-reading the letterhead could disagree with their decision.
    supplierGroupId: original.supplierGroupId,
    ledgerRef: original.ledgerRef,
    plantScope: original.plantScope,
    plantScopeBasis: original.plantScopeBasis,
    splitPlant: original.splitPlant,
    splitFrom: original.splitFrom,
    defaultUom: original.defaultUom,

    status: 'UPLOADED',
    uploadedBy: actor,
  });

  await AuditLog.create({
    action: 'QUOTE_REQUOTED',
    entity: 'quoteDocument',
    entityId: String(replacement._id),
    actor,
    before: { documentId: String(original._id), status: original.status },
    after: { documentId: String(replacement._id), reason: reason || null },
  });

  return {
    documentId: String(replacement._id),
    supersedes: String(original._id),
    storageKey: replacement.storageKey,
  };
}

export async function deleteDocument({ documentId, actor, reason, force = false }) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId).lean();
  if (!doc) throw new Error('Quote document not found.');

  const rates = await RateHistory.countDocuments({ quoteDocumentId: doc._id });

  /*
    Without `force`, an approved quote and anything that has written rates are
    refused. Those rates are what the comparison and the PO check answer from,
    and deleting the document behind them leaves numbers whose provenance no
    longer exists.

    With `force`, the rates go too. That is the honest version of the operation
    a person actually wants when they say "delete this": not an orphaned
    remainder, and not a refusal that leaves them stuck. It is deliberately not
    the default, and it says in the audit row how many rate rows it took with
    it — recoverable only by re-uploading the file and approving it again.
  */
  if (!force) {
    if (doc.status === 'APPROVED') {
      const error = new Error(
        'An approved quote cannot be deleted — its rates are already in the rate history. '
        + 'Delete it with force to remove those rates too, or use "Read this file again" '
        + 'to supersede it and keep the trail.',
      );
      error.status = 409;
      error.canForce = true;
      throw error;
    }

    if (rates > 0) {
      const error = new Error(
        `This quote has written ${rates} rate row(s). Delete it with force to remove them too, or reject it instead.`,
      );
      error.status = 409;
      error.canForce = true;
      throw error;
    }
  }

  const ratesDeleted = force && rates > 0
    ? (await RateHistory.deleteMany({ quoteDocumentId: doc._id })).deletedCount
    : 0;

  const lines = await QuoteLine.deleteMany({ quoteDocumentId: doc._id });
  await QuoteDocument.deleteOne({ _id: doc._id });

  // The stored file is deliberately left in place. It is cheap, it is the only
  // copy of what the supplier actually sent, and an audit row pointing at a
  // key that no longer resolves is not much of an audit row.
  await AuditLog.create({
    action: 'QUOTE_DELETED',
    entity: 'quoteDocument',
    entityId: String(doc._id),
    actor,
    before: doc,
    reason: reason || null,
    meta: {
      linesDeleted: lines.deletedCount,
      ratesDeleted,
      forced: Boolean(force),
      priorStatus: doc.status,
      storageKey: doc.storageKey,
    },
  });

  return {
    deleted: true,
    linesDeleted: lines.deletedCount,
    ratesDeleted,
    storageKey: doc.storageKey,
  };
}

/**
 * Delete every quote, with its lines and the rates it wrote.
 *
 * A starting-over button, and it exists because starting over was otherwise a
 * hundred separate confirmations — which is not a decision anybody makes
 * carefully, it is one they click through. One deliberate action is safer than
 * a hundred careless ones.
 *
 * Deliberately narrow: quote documents, their lines, their rate rows. It does
 * NOT touch suppliers, the UOM normalisation table, or the supplier-item
 * mappings unless asked — those are learned settings that survive a bad batch
 * of extractions and are tedious to rebuild. Pass `includeMappings` when the
 * mappings themselves are the thing that went wrong.
 *
 * The stored files are left in R2. They are the only copy of what suppliers
 * actually sent, they cost almost nothing, and keeping them means the same
 * documents can be re-uploaded rather than chased down again.
 */
export async function purgeAllQuotes({ actor, reason, includeMappings = false } = {}) {
  await ensureSupplierPortalReady();

  const documents = await QuoteDocument.countDocuments({});
  const lines = await QuoteLine.deleteMany({});
  const rates = await RateHistory.deleteMany({});
  const mappings = includeMappings
    ? (await SupplierItem.deleteMany({})).deletedCount
    : 0;
  await QuoteDocument.deleteMany({});

  await AuditLog.create({
    action: 'QUOTES_PURGED',
    entity: 'quoteDocument',
    entityId: 'ALL',
    actor,
    reason: reason || null,
    meta: {
      documents,
      linesDeleted: lines.deletedCount,
      ratesDeleted: rates.deletedCount,
      mappingsDeleted: mappings,
    },
  });

  return {
    documents,
    linesDeleted: lines.deletedCount,
    ratesDeleted: rates.deletedCount,
    mappingsDeleted: mappings,
  };
}

export async function approveDocument({ documentId, actor, overrides = [] }) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);
  if (doc.status === 'APPROVED') throw new Error('This document has already been approved.');

  const lines = await QuoteLine.find({
    quoteDocumentId: doc._id,
    supersededByLineId: null,
  }).lean();

  /**
   * A document with nothing priced on it cannot be approved.
   *
   * Approving writes rate history; with no usable line there is nothing to
   * write, and the only effect is to mark the document APPROVED — which then
   * makes it undeletable, because deletion refuses approved documents on the
   * grounds that their rates are live. Rates it does not have. A failed
   * extraction would become a permanent, unremovable row.
   */
  const priced = lines.filter((l) => Number.isFinite(l.normalised?.rate));
  if (!priced.length) {
    const error = new Error(
      lines.length
        ? `Cannot approve: none of the ${lines.length} extracted line(s) has a usable rate.`
        : 'Cannot approve: no lines were extracted from this document. Re-run extraction, '
          + 'or delete it and upload the file again.',
    );
    error.status = 409;
    throw error;
  }

  const blocking = collectBlocking(doc, lines);
  if (blocking.length) {
    const error = new Error(
      `Cannot approve: ${blocking.length} blocking check(s) — ${blocking.map((c) => c.code).join(', ')}`,
    );
    error.checks = blocking;
    throw error;
  }

  applyOverrides(doc, overrides, actor);

  // No silent default. EXT009/EXT010 make an unsettled document unapprovable,
  // and if that gate is ever bypassed the right outcome is a refusal, not
  // Kolkata rates invented for a quote that never named a plant.
  if (!doc.supplierGroupId) {
    throw new Error('Cannot approve: the supplier has not been identified.');
  }
  const plants = doc.plantScope?.length ? doc.plantScope : null;
  if (!plants) {
    throw new Error('Cannot approve: the plant has not been identified.');
  }
  const written = [];

  for (const line of lines) {
    if (!Number.isFinite(line.normalised?.rate)) continue;

    for (const plant of plants) {
      // A document with per-plant blocks prices each plant separately; the
      // line's own plant wins over the document's scope when it has one.
      if (line.plant && line.plant !== plant) continue;

      const row = await writeRateRow({ doc, line, plant });
      written.push(row);

      // Rules stated on the document generate the derived rate rather than
      // leaving a buyer to apply "+₹1 for reel cut" by hand each time.
      for (const derived of derivedRowsFor({ doc, line, plant })) {
        written.push(await writeRateRow({ doc, line, plant, ...derived }));
      }
    }
  }

  // A partial re-quote restates only some lines. The rest of the prior
  // document stays current — Alpap's August email restates one of two
  // wash-cloth prices given in April, and invalidating the other would lose a
  // rate the supplier never withdrew.
  if (doc.supersedesDocId && !doc.isPartialUpdate) {
    await QuoteDocument.updateOne({ _id: doc.supersedesDocId }, { $set: { status: 'SUPERSEDED' } });
  }

  doc.status = 'APPROVED';
  doc.approvedBy = actor;
  doc.approvedAt = new Date();
  await doc.save();

  await AuditLog.create({
    action: 'QUOTE_APPROVED',
    entity: 'quoteDocument',
    entityId: String(doc._id),
    actor,
    after: { rateRowsWritten: written.length, plants },
    reason: overrides.map((o) => `${o.code}: ${o.reason}`).join('; ') || null,
  });

  return { rateRowsWritten: written.length, plants, lineCount: lines.length };
}

/**
 * Write one rate row, closing whatever it supersedes.
 *
 * `isCurrent` is scoped to (supplierItem | specKey, plant). Closing the old
 * row before inserting the new one is what keeps exactly one current rate per
 * key — and it is done per plant, so a Kolkata re-quote never closes an
 * Ahmedabad rate.
 */
async function writeRateRow({ doc, line, plant, rate, isDerived = false, derivationNote = null }) {
  const effectiveRate = rate ?? line.normalised.rate;
  const scope = supersedeScope({ line, plant, supplierGroupId: doc.supplierGroupId });

  // An unmapped, non-spec line still stores its rate — an unmatched quote is
  // a real benchmark — but it supersedes nothing, because it has no key to
  // supersede on.
  if (scope) await RateHistory.updateMany(scope, { $set: { isCurrent: false } });

  return RateHistory.create({
    quoteLineId: line._id,
    quoteDocumentId: doc._id,
    supplierGroupId: doc.supplierGroupId,
    supplierItemId: line.supplierItemId || null,
    itemRef: line.itemRef || null,
    specKey: line.specKey,
    rate: effectiveRate,
    uom: line.normalised.uom,
    ratePerBaseUom: line.normalised.ratePerBaseUom,
    plant,
    cdcEntityScope: doc.cdcEntityScope,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo,
    quoteStrength: doc.quoteStrength,
    isDerived,
    derivationNote,
    isCurrent: true,
  });
}

/**
 * The filter that closes whatever this row replaces.
 *
 * `isCurrent` is scoped to (supplier item | spec key, plant). Two things make
 * this scope the shape it is:
 *
 *  - **Plant is always in the filter.** A Kolkata re-quote must never close an
 *    Ahmedabad rate; absence of a rate for a plant is meaningful information
 *    and closing one by accident destroys it silently.
 *  - **A spec key supersedes by its fields**, since Mongo cannot filter on a
 *    computed key. A film rate is keyed on {filmType, micron} and is scoped to
 *    the supplier group as well, because two suppliers quoting 10-micron gloss
 *    BOPP are two live rates, not one.
 *
 * Returns null when the line has no key at all.
 */
function supersedeScope({ line, plant, supplierGroupId }) {
  const specKey = line.specKey?.kind && line.specKey.kind !== 'ITEM' ? line.specKey : null;

  if (specKey) {
    const scope = { plant, isCurrent: true, supplierGroupId, 'specKey.kind': specKey.kind };
    for (const [field, value] of Object.entries(specKey)) {
      if (field === 'kind' || value === null || value === undefined) continue;
      scope[`specKey.${field}`] = value;
    }
    return scope;
  }

  if (line.supplierItemId) {
    return { plant, isCurrent: true, supplierItemId: line.supplierItemId };
  }

  return null;
}

/**
 * Rows generated from a rule stated on the document rather than quoted.
 *
 * Sudarshan's RBD and RLS run a consistent ₹3.00 apart; NR Agarwal states
 * "sheet price 1.00 extra from reel price"; Krishna Vanijya states "reel cut
 * ₹1/kg extra". Storing the rule and deriving the second rate keeps the two in
 * step; storing both as quoted rows lets them drift.
 */
function derivedRowsFor({ doc, line }) {
  const rules = (doc.derivationRules || []).filter((r) => r.kind === 'FORM_PREMIUM');
  if (!rules.length) return [];
  const lineForm = line.specKey?.form || null;

  return rules
    .filter((rule) => !lineForm || rule.fromForm === lineForm)
    .filter((rule) => Number.isFinite(rule.delta))
    .map((rule) => ({
      rate: round(line.normalised.rate + rule.delta, 4),
      isDerived: true,
      derivationNote: rule.note
        || `Derived from the ${rule.fromForm} rate: ${rule.toForm} is ₹${rule.delta} ${rule.delta >= 0 ? 'more' : 'less'}`,
    }));
}

function collectBlocking(doc, lines) {
  const all = [
    ...(doc.checks || []),
    ...lines.flatMap((l) => l.checks || []),
    ...(paperInterpretationCheck(doc) ? [paperInterpretationCheck(doc)] : []),
  ];
  return all.filter((c) => !c.passed && c.severity === 'BLOCK' && !c.overrideReason);
}

/**
 * A paper quote that has not been read as one, or null.
 *
 * COMPUTED, NEVER STORED, and that is the whole point of it. Every other check
 * is written down at extraction and stays true until extraction runs again.
 * This one stops being true the moment interpretation succeeds — an event that
 * touches neither extraction nor the stored checks. Stored, it would go stale
 * in the one direction that matters: still blocking a document that has since
 * been read properly.
 *
 * The general extractor flattens a board line into a product name and cannot
 * ask a question, which is why paper has its own path at all. What it produces
 * is a plausible table naming no grade — approvable, and useless to compare
 * against anything. Without this, a reviewer could accept it without ever
 * noticing the paper reading existed.
 */
export function paperInterpretationCheck(doc) {
  if (doc?.materialClass !== 'PAPER_BOARD') return null;
  if (doc?.interpretation?.stage === 'INTERPRETED') return null;

  const stage = doc?.interpretation?.stage;
  return check('EXT013', false, {
    message: {
      NEEDS_INPUT: 'This paper quote has been read but still has open questions — answer them before approving.',
      INTERPRETING: 'This paper quote is still being read.',
      FAILED: 'This paper quote could not be read — fix the error above before approving.',
    }[stage] || undefined,
    actualValue: stage || 'not read',
  });
}

/**
 * Record a reason against each accepted warning. A WARN with no reason stays
 * a WARN — the point of the override is the sentence, not the click.
 */
function applyOverrides(doc, overrides, actor) {
  if (!overrides?.length) return;
  const byCode = new Map(overrides.map((o) => [o.code, o.reason]));
  for (const c of doc.checks || []) {
    if (c.passed || c.severity !== 'WARN') continue;
    const reason = byCode.get(c.code);
    if (!reason) continue;
    c.overrideReason = reason;
    c.overriddenBy = actor;
    c.overriddenAt = new Date();
  }
  doc.markModified('checks');
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Map a plant word found on a document to the canonical plant name. */
export function plantFromText(text) {
  const t = String(text ?? '').toUpperCase();
  if (/KOLKATA|CALCUTTA|TANGRA|PANCHLA|HOWRAH|WEST BENGAL/.test(t)) return PLANTS.KOL;
  if (/AHMEDABAD|GUJARAT/.test(t)) return PLANTS.AHM;
  return null;
}

/** The site behind a plant name. */
export function siteForPlant(plant) {
  return SITE_BY_PLANT[String(plant ?? '').toUpperCase()] || null;
}

function toDerivationRule(rule) {
  const text = String(rule?.text ?? '');
  const value = Number(String(rule?.value ?? '').replace(/[^\d.-]/g, ''));
  if (!text) return null;

  if (/sheet/i.test(text) && /reel|reel cut/i.test(text)) {
    return {
      kind: 'FORM_PREMIUM',
      fromForm: 'REEL',
      toForm: 'SHEET',
      delta: Number.isFinite(value) ? value : null,
      note: text,
    };
  }
  return { kind: 'RATE_BASIS', basisPerUom: rule?.value ?? null, note: text };
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();

  // Indian documents write DD/MM/YYYY and DD-MM-YYYY; Date.parse reads the
  // first as MM/DD, which silently produces a valid wrong date.
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = new Date(year, Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A number out of "45 days", or null.
 *
 * The digits are required. Stripping non-digits from an empty or wordy value
 * leaves "", and `Number('')` is 0 — so a quote stating no credit period would
 * be filed as "payment due immediately", a term the supplier never offered.
 */
function numberish(value) {
  const digits = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!digits) return null;
  const n = Number(digits[0]);
  return Number.isFinite(n) ? n : null;
}

function formatDate(date) {
  if (!date) return 'an unknown date';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export { parseDate };
