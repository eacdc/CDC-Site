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
import { normaliseRate, parsePackSize, parseRateCell, uomOverridesFrom, magnitudeCheck } from '../lib/uom.js';
import { normaliseName, hasBrandOrCodeToken } from '../lib/text.js';
import { quoteSpecTuple, buildSpecKey, specKeyString } from '../lib/spec.js';
import { getProvider } from './extraction/provider.js';
import { extractWorkbook } from './extraction/xlsx-extract.js';
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
  checks.push(check('EXT001', !exact, {
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

  return { checks, exactMatch: exact, nearMatch: near, isBlocked: hasBlockingFailure(checks) };
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Run extraction for a document and store the raw lines.
 *
 * Worksheets take the grid path; everything else goes to the vision provider.
 * Both produce the same line shape, so review, matching and approval do not
 * care which was used.
 */
export async function extractDocument(documentId, { pages, buffer, hints = {} } = {}) {
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
      : await extractFromImages(doc, pages, hints);

    await storeLines(doc, result.lines);

    await QuoteDocument.updateOne({ _id: doc._id }, {
      $set: {
        status: hasBlockingFailure(result.checks) ? 'NEEDS_REVIEW' : 'EXTRACTED',
        'extraction.provider': result.provider,
        'extraction.model': result.model,
        'extraction.finishedAt': new Date(),
        'extraction.error': null,
        ...result.documentFields,
      },
      $push: { checks: { $each: result.checks } },
    });

    return { lineCount: result.lines.length, checks: result.checks, ...result.meta };
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

async function extractFromImages(doc, pages, hints) {
  if (!pages?.length) throw new Error('Extraction needs at least one page URL');
  const provider = getProvider(hints.provider);
  const group = await SupplierGroup.findById(doc.supplierGroupId).lean();

  const extracted = await provider.extractQuote({
    pages,
    docType: doc.docType,
    hints: { ...hints, supplierName: group?.name, plantScope: doc.plantScope },
  });

  const checks = [
    check('EXT003', Boolean(extracted.effectiveFrom || extracted.documentDate), {
      message: 'No effective date found — validity will be defaulted',
    }),
  ];

  const documentFields = {};
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
    meta: { plantBlocks: extracted.plantBlocks || null },
  };
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
async function storeLines(doc, rawLines) {
  const overrides = uomOverridesFrom(await UomNormalisation.find({}).lean());
  await QuoteLine.deleteMany({ quoteDocumentId: doc._id });

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
      notes: line.notes ?? null,
    };

    const normalised = normaliseLine(raw, overrides);
    const tuple = quoteSpecTuple({ raw });
    const specKey = buildSpecKey(tuple);

    const lineChecks = [
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
  return docs.length;
}

/**
 * Turn one raw line into normalised numbers.
 *
 * The unit is taken from the rate cell first (`131.00/UNIT` states its own
 * unit), then from the line's own UOM field. A column header is never
 * consulted — the extractor was told not to supply one.
 */
export function normaliseLine(raw, overrides) {
  const flags = [];
  const fromCell = parseRateCell(raw.rate);
  const uomSource = fromCell.uom ? 'RATE_CELL' : 'LINE_UOM';
  const uom = fromCell.uom || raw.uom;

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
  if (uomSource === 'LINE_UOM' && !raw.uom) flags.push('NO_UOM_ON_LINE');
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
export async function approveDocument({ documentId, actor, overrides = [] }) {
  await ensureSupplierPortalReady();
  const doc = await QuoteDocument.findById(documentId);
  if (!doc) throw new Error(`Quote document ${documentId} not found`);
  if (doc.status === 'APPROVED') throw new Error('This document has already been approved.');

  const lines = await QuoteLine.find({
    quoteDocumentId: doc._id,
    supersededByLineId: null,
  }).lean();

  const blocking = collectBlocking(doc, lines);
  if (blocking.length) {
    const error = new Error(
      `Cannot approve: ${blocking.length} blocking check(s) — ${blocking.map((c) => c.code).join(', ')}`,
    );
    error.checks = blocking;
    throw error;
  }

  applyOverrides(doc, overrides, actor);

  const plants = doc.plantScope?.length ? doc.plantScope : [PLANTS.KOL];
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
  ];
  return all.filter((c) => !c.passed && c.severity === 'BLOCK' && !c.overrideReason);
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

function numberish(value) {
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
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
