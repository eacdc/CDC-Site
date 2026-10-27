/**
 * Receiving (M5) — tablet capture through to a posted voucher.
 *
 * The posting endpoint is the only place in the portal that writes to the ERP,
 * and it refuses to do so unless `SP_ENABLE_ERP_WRITES` is set. Until that has
 * been exercised against a real database, `?dryRun=true` returns the exact
 * rows that would be written, which is what makes the first live test
 * reviewable line by line.
 */

import { Router } from 'express';
import { requireAuth, requireRole, requireSite } from '../middleware/auth.js';
import { ensureSupplierPortalReady, DocumentSet, AuditLog } from '../db/mongo.js';
import { getProvider } from '../services/extraction/provider.js';
import { readInvoice } from '../services/extraction/invoice-pipeline.js';
import { buildFieldFlags, resolveEditedFlags, confirmFlag, openFlags } from '../services/extraction/field-flags.js';
// Amounts as suppliers print them: "1,38,550/-", "(-)0.22", "815 Kg".
import { toNumber as printedNumber } from '../services/extraction/invoice-review.js';
import { runInvoiceChecks } from '../services/invoice-checks.js';
import {
  postDocumentSet, erpWritesEnabled, postPurchaseInvoiceForGrn, priceLines, discountNote,
} from '../services/erp-receiving.js';
import { openPoLines, findPostedInvoice, receiptsForInvoice } from '../services/erp-po.js';
import { getItems, hsnForItems } from '../services/erp-items.js';
import { groupForLedger, ledgerIdsForSite } from '../services/supplier-groups.js';
import { chargeLedgers, warehouses, supplierLedgers, employeeLedgers, purchaseLedgers } from '../services/erp-ledgers.js';
import { identifyInvoiceSupplier } from '../services/supplier-identify.js';
import { grnLinesWithIssues } from '../services/grn-issues.js';
import { listGrns, loadGrn } from '../services/grn-register.js';
import { editGrn, deleteGrn, canEditGrns } from '../services/erp-grn-edit.js';
import { query } from '../db/mssql.js';
import { COMPANY_ID } from '../config/constants.js';
import { warningsNeedingReason } from '../config/validations.js';
import {
  ignoreCheck, undoIgnore, liveIgnores, withIgnores, unresolvedBlocks,
} from '../services/check-overrides.js';
import { createUploadUrl, viewUrl, deleteObjects } from '../../lib/r2-storage.js';
import {
  matchInvoiceLines, assessCandidate, poNumbersFrom, isClosed,
} from '../services/receiving-match.js';
import { receivingDefaults } from '../services/receiving-defaults.js';
import { stockQtyFor, stockQtyFromPurchase, purchaseQtyFromStock } from '../services/receipt-units.js';
import { correctedLine, repricedDiscount } from '../services/line-corrections.js';
import { billsByKgStocksSheets, piQty } from '../lib/invoice-math.js';

const router = Router();

/** The line fields a person may correct: what was read off the invoice. */
const EDITABLE_LINE_FIELDS = [
  'lineNo', 'description', 'hsn', 'gsm', 'size', 'unitWt', 'bundles', 'totalUnits',
  'qty', 'stockQty', 'uom', 'rate', 'amount', 'discountPct', 'discountAmount', 'taxableValue', 'poRef',
];

/** Every field the matcher writes about a PO, cleared. See the match route. */
const UNMATCHED = {
  matchedPoTransactionId: null,
  matchedPoTransactionDetailId: null,
  matchedItemId: null,
  matchedPoRate: null,
  poPendingQty: null,
  poQty: null,
  poVoucherNo: null,
  itemGroupId: null,
  itemCode: null,
  itemName: null,
  poDate: null,
  poFYear: null,
  itemGroupName: null,
  purchaseUnit: null,
  stockUnit: null,
  productHsnId: null,
  expectedHsn: null,
  wtPerPacking: null,
  unitPerPacking: null,
  widthMm: null,
  lengthMm: null,
  matchedPoClosed: null,
  gstPercentage: null,
  cgstPercentage: null,
  sgstPercentage: null,
  igstPercentage: null,
};

/** The state code each plant sits in: CGST + SGST inside it, IGST from outside. */
const PLANT_STATE = { KOL: '19', AHM: '24' };
router.use(requireAuth, requireSite);

router.post('/upload-url', async (req, res, next) => {
  try {
    res.json(await createUploadUrl({
      folder: 'supplier-portal/receiving',
      contentType: req.body?.contentType,
      contentLength: req.body?.contentLength,
    }));
  } catch (err) { next(err); }
});

/** Create a document set from captured pages. */
router.post('/document-sets', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { slots = {}, supplierLedgerId } = req.body || {};

    const set = await DocumentSet.create({
      setType: 'GRN_PURCHASE',
      site: req.sp.site,
      slots: {
        supplierInvoice: slots.supplierInvoice || [],
        eWayBill: slots.eWayBill || [],
        packingList: slots.packingList || [],
      },
      // The session already carries who is receiving, where, and as which
      // employee — the store person should not have to re-state it per parcel.
      context: {
        userId: req.sp.context?.erpUserId ?? null,
        employeeLedgerId: req.sp.context?.employeeLedgerId ?? null,
        warehouseId: req.sp.context?.warehouseId ?? null,
        supplierLedgerId: supplierLedgerId ? Number(supplierLedgerId) : null,
      },
      status: 'CAPTURED',
      createdBy: req.sp.actor,
    });

    return res.status(201).json(set);
  } catch (err) { return next(err); }
});

/**
 * Start a GRN by hand, as on the ERP's own screen: a supplier and the delivery
 * note, then PO lines picked one by one. No invoice is read. The same checks,
 * the same writer and the same write gate apply as for one the AI filled in.
 */
router.post('/document-sets/manual', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const supplierLedgerId = Number(req.body?.supplierLedgerId);
    if (!Number.isFinite(supplierLedgerId) || supplierLedgerId <= 0) {
      return res.status(400).json({ error: 'Choose the supplier.' });
    }
    const known = (await supplierLedgers(req.sp.site)).some((l) => Number(l.LedgerID) === supplierLedgerId);
    if (!known) return res.status(400).json({ error: `Ledger ${supplierLedgerId} is not a ${req.sp.site} supplier ledger.` });

    const set = await DocumentSet.create({
      setType: 'GRN_PURCHASE',
      entryMode: 'MANUAL',
      site: req.sp.site,
      slots: { supplierInvoice: [], eWayBill: [], packingList: [] },
      extractedHeader: {
        invoiceNo: req.body?.invoiceNo ? String(req.body.invoiceNo).trim() : null,
        invoiceDate: parseDate(req.body?.invoiceDate),
      },
      extractedLines: [],
      context: {
        userId: req.sp.context?.erpUserId ?? null,
        employeeLedgerId: req.sp.context?.employeeLedgerId ?? null,
        warehouseId: req.sp.context?.warehouseId ?? null,
        supplierLedgerId,
      },
      status: 'EXTRACTED',
      createdBy: req.sp.actor,
    });
    return res.status(201).json(set);
  } catch (err) { return next(err); }
});

router.post('/document-sets/:id/extract', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });

    const pages = await Promise.all(
      (set.slots.supplierInvoice || []).map(async (p, i) => ({
        url: p.url || await viewUrl(p.storageKey),
        pageNo: p.pageNo ?? i + 1,
      })),
    );
    if (!pages.length) return res.status(400).json({ error: 'No supplier invoice pages have been captured.' });

    const provider = await getProvider();
    // Turned upright, read, checked, and read again once if provably wrong.
    const extracted = await readInvoice(provider, { pages });
    set.extractionReview = extracted._review ?? null;

    set.extractedHeader = {
      invoiceNo: extracted.invoiceNo,
      invoiceDate: parseDate(extracted.invoiceDate),
      supplierName: extracted.supplierName ?? null,
      supplierGstin: extracted.supplierGstin,
      buyerGstin: extracted.buyerGstin,
      shipToGstin: extracted.shipToGstin,
      supplierState: extracted.supplierState,
      shipToState: inferShipToState(extracted),
      eWayBillNo: extracted.eWayBillNo,
      vehicleNo: extracted.vehicleNo,
      taxType: extracted.taxType,
      subTotal: printedNumber(extracted.subTotal),
      // "Less: Discount" on the whole bill, kept positive however it is signed.
      discount: positive(printedNumber(extracted.discount)),
      discountPct: positive(printedNumber(extracted.discountPct)),
      freight: printedNumber(extracted.freight),
      taxable: printedNumber(extracted.taxable),
      cgst: printedNumber(extracted.cgst),
      sgst: printedNumber(extracted.sgst),
      igst: printedNumber(extracted.igst),
      roundOff: printedNumber(extracted.roundOff),
      grandTotal: printedNumber(extracted.grandTotal),
      // The "Buyer's Order No." list. The schema has always asked for it; it
      // was being read and then thrown away here.
      poNumbers: (extracted.poNumbers || []).filter(Boolean).map(String),
      // The gate stamp, as the store keys it into Gate Entry No. and Date.
      // A serial number, digits only: handwritten strokes come back as "25/707".
      gateEntryNo: extracted.gateEntryNo ? (String(extracted.gateEntryNo).replace(/\D/g, '') || null) : null,
      gateEntryDate: parseDate(extracted.gateEntryDate),
    };
    set.extractedLines = (extracted.lines || []).map((l, i) => ({
      lineNo: l.lineNo ?? i + 1,
      description: l.description,
      hsn: l.hsn,
      gsm: num(l.gsm),
      size: l.size,
      unitWt: num(l.unitWt),
      bundles: num(l.bundles),
      totalUnits: num(l.totalUnits),
      qty: printedNumber(l.qty),
      uom: l.uom,
      rate: printedNumber(l.rate),
      amount: printedNumber(l.amount),
      discountPct: positive(printedNumber(l.discountPct)),
      discountAmount: positive(printedNumber(l.discountAmount)),
      taxableValue: printedNumber(l.taxableValue),
      poRef: l.poRef ?? null,
    }));

    /**
     * Who it is from: the GSTIN on the invoice first, then the name. A choice
     * a person already made is never overwritten - but the identification is
     * kept beside it, so a disagreement shows on the page.
     */
    const identified = await identifyInvoiceSupplier(set.site, {
      gstin: extracted.supplierGstin, name: extracted.supplierName,
    }).catch((err) => ({ ledgerId: null, evidence: `Could not check the ledgers: ${err.message}` }));
    set.supplierIdentification = { ...identified, at: new Date() };
    // A GSTIN that failed its check character, matched to a ledger's: keep
    // what was read beside it, so the page can show both.
    if (identified.matchedBy === 'GSTIN_NEAR' && identified.correctedGstin) {
      set.set('extractedHeader.supplierGstinRead', extracted.supplierGstin ?? null);
      set.set('extractedHeader.supplierGstin', identified.correctedGstin);
    }
    // Red flags: what the model was unsure of, and what the checks proved wrong.
    set.fieldFlags = buildFieldFlags({
      uncertain: extracted.uncertain,
      problems: extracted._review?.problemsAfter,
      identification: identified,
      read: extracted,
      disagreements: extracted._review?.disagreements,
    });
    if (!set.context?.supplierLedgerId && identified.ledgerId) {
      set.set('context.supplierLedgerId', identified.ledgerId);
    }
    set.status = 'EXTRACTED';
    await set.save();

    return res.json(set);
  } catch (err) { return next(err); }
});

/**
 * Match the extracted lines to open PO lines and run the full check
 * catalogue.
 *
 * Matching is by supplier and item within the open PO set — a line that
 * cannot be placed on a PO raises INV002 and blocks, because receiving
 * against nothing is how stock and commitments drift apart.
 */
// ── matching: shared by the matcher and by a person's choice ────────────────

/** Every ledger the supplier trades under on this site. */
async function supplierLedgersFor(site, ledgerId) {
  const group = await groupForLedger(site, ledgerId);
  // Every ledger the supplier trades under, so an invoice from the Haryana
  // branch still finds a PO raised on the head office.
  const ids = group ? ledgerIdsForSite(group, site) : [ledgerId];
  return ids.length ? ids : [ledgerId];
}

/**
 * Plain objects first. A Mongoose subdocument keeps its values behind
 * getters on the prototype, so `{ ...sub }` copies its internals ($__,
 * _doc, __parentArray) and NONE of its fields. Before this, every line
 * reached runInvoiceChecks with no lineNo, qty, rate or amount - so the
 * over-receipt block (INV003), the rate check (INV005) and the line
 * arithmetic (INV006) silently never ran, and INV007 blocked every
 * invoice for "lines total Rs 0". The save still looked right, because
 * Mongoose re-hydrates from `_doc`, which is what hid it.
 */
function plainLinesOf(set) {
  return (set.extractedLines || []).map(
    (sub) => (typeof sub.toObject === 'function' ? sub.toObject() : sub),
  );
}

/**
 * The fields a line carries once it sits on a PO line. One place, so a match
 * the matcher made and one a person made are recorded identically.
 */
function fieldsForPo(line, po, { items, hsn, closed, taxSplit }) {
  const item = items.get(po.ItemID);
  const units = {
    purchaseUnit: String(po.PurchaseUnit ?? '').trim() || null,
    stockUnit: po.StockUnit ?? null,
    wtPerPacking: item?.WtPerPacking ?? null,
    unitPerPacking: item?.UnitPerPacking ?? null,
  };
  return {
    ...units,
    // Receipt Qty (S.U.): sheets for paper bought by the kilo, else the qty.
    stockQty: stockQtyFor({ ...line, ...units }),
    ...gstFor(hsn.get(po.ItemID), taxSplit),
    matchedPoTransactionId: po.TransactionID,
    matchedPoTransactionDetailId: po.TransactionDetailID,
    matchedItemId: po.ItemID,
    // The ERP's item, as its GRN screen names it - not the invoice's wording.
    itemCode: po.ItemCode ?? null,
    itemName: po.ItemName ?? null,
    poDate: po.PoDate ?? null,
    poFYear: po.FYear ?? null,
    itemGroupName: po.ItemGroupName ?? null,
    matchedPoRate: po.PurchaseRate,
    poPendingQty: po.PendingQty,
    poQty: po.PurchaseOrderQuantity,
    poVoucherNo: po.PoVoucherNo,
    matchedPoClosed: Boolean(closed),
    // Written onto the GRN line; without them it went out with NULLs.
    itemGroupId: po.ItemGroupID ?? po.MasterItemGroupID ?? null,
    productHsnId: po.ProductHSNID ?? null,
    expectedHsn: hsn.get(po.ItemID)?.HSNCode ?? null,
    widthMm: item?.SizeW ?? null,
    lengthMm: item?.SizeL ?? null,
    gsm: line.gsm ?? item?.GSM ?? null,
  };
}

/**
 * The line's GST rates, from the item's HSN code in ProductHSNMaster - where
 * the ERP's own purchase invoice gets them. For PU/26-27/0710 it wrote GST 5,
 * CGST 2.5, SGST 2.5, IGST 0 on every line: the HSN rates, split for a
 * supplier inside the state. Without this the purchase invoice was written
 * with no tax at all, because nothing ever put a rate on a line.
 */
function gstFor(h, taxSplit) {
  if (!h || !taxSplit) {
    return { gstPercentage: null, cgstPercentage: null, sgstPercentage: null, igstPercentage: null };
  }
  const gst = num(h.GSTTaxPercentage);
  if (taxSplit === 'IGST') {
    return { gstPercentage: gst, cgstPercentage: 0, sgstPercentage: 0, igstPercentage: num(h.IGSTTaxPercentage) ?? gst };
  }
  return {
    gstPercentage: gst,
    cgstPercentage: num(h.CGSTTaxPercentage) ?? (gst === null ? null : gst / 2),
    sgstPercentage: num(h.SGSTTaxPercentage) ?? (gst === null ? null : gst / 2),
    igstPercentage: 0,
  };
}

/**
 * CGST + SGST or IGST. What the supplier actually charged wins when the
 * invoice was read; otherwise it follows from where the supplier is - its
 * GSTIN's state against the plant's. Unknown stays unknown (null): a wrong
 * split is worse than an obviously missing one.
 */
/**
 * One supplier's GSTIN, kept for 10 minutes. It used to read every supplier
 * ledger of the site (0.24 s) on each line added, to find one GSTIN.
 */
const gstinCache = new Map();
async function supplierGstin(site, ledgerId) {
  const key = `${site}:${Number(ledgerId)}`;
  const hit = gstinCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.gstin;
  const [row] = await query(site, `
    SELECT GSTNo FROM LedgerMaster WHERE CompanyID = @companyId AND LedgerID = @ledgerId
  `, { companyId: COMPANY_ID, ledgerId: Number(ledgerId) });
  gstinCache.set(key, { gstin: row?.GSTNo ?? null, at: Date.now() });
  return row?.GSTNo ?? null;
}

async function taxSplitFor(set) {
  if (set.extractedHeader?.taxType) return set.extractedHeader.taxType;
  let gstin = set.extractedHeader?.supplierGstin;
  if (!gstin && set.context?.supplierLedgerId) {
    gstin = await supplierGstin(set.site, set.context.supplierLedgerId);
  }
  const state = String(gstin || '').trim().slice(0, 2);
  if (!/^\d{2}$/.test(state)) return null;
  return state === PLANT_STATE[set.site] ? 'CGST_SGST' : 'IGST';
}

/**
 * Everything matching needs for one document set. PO lines are fetched open
 * AND closed whatever the mode: a line placed by hand may sit on a closed one,
 * and the matcher applies the open-only filter itself.
 */
async function matchingInputs(set, { includeClosed }) {
  const site = set.site;
  const ledgerIds = await supplierLedgersFor(site, set.context.supplierLedgerId);
  const invoiceNo = set.extractedHeader?.invoiceNo;
  const [poLines, receipts, alreadyPosted] = await Promise.all([
    openPoLines(site, { ledgerIds, includeCompleted: true }),
    includeClosed ? receiptsForInvoice(site, { invoiceNo, ledgerIds }) : Promise.resolve([]),
    findPostedInvoice(site, { invoiceNo, ledgerIds }),
  ]);
  const itemIds = [...new Set(poLines.map((l) => l.ItemID))];
  const [items, hsn, taxSplit] = await Promise.all([
    getItems(site, itemIds), hsnForItems(site, itemIds), taxSplitFor(set),
  ]);
  return { ledgerIds, poLines, receipts, alreadyPosted, items, hsn, taxSplit };
}

/**
 * The same, for one PO the person clicked: its lines only, still looked up
 * among THIS supplier's ledgers. Adding or placing one PO line used to fetch
 * every PO line the supplier has (3,005 for Krishna Vanijya, 1.2-1.9 s) to
 * find the one. Without a PO id it falls back to the full fetch.
 */
async function poLineInputs(set, poTransactionId) {
  const id = Number(poTransactionId);
  if (!Number.isFinite(id) || id <= 0) return matchingInputs(set, { includeClosed: false });
  const site = set.site;
  const ledgerIds = await supplierLedgersFor(site, set.context.supplierLedgerId);
  // Side by side: none of these waits on another.
  const [poLines, alreadyPosted, taxSplit] = await Promise.all([
    openPoLines(site, { ledgerIds, transactionIds: [id], includeCompleted: true }),
    findPostedInvoice(site, { invoiceNo: set.extractedHeader?.invoiceNo, ledgerIds }),
    taxSplitFor(set),
  ]);
  const itemIds = [...new Set(poLines.map((l) => l.ItemID))];
  const [items, hsn] = await Promise.all([getItems(site, itemIds), hsnForItems(site, itemIds)]);
  return { ledgerIds, poLines, receipts: [], alreadyPosted, items, hsn, taxSplit };
}

/**
 * What re-running the checks after a quantity, rate or removal needs: only
 * whether the invoice is already in the ERP (INV001). The PO match stands, so
 * the supplier's PO lines are not fetched again.
 */
async function checkInputs(set) {
  const ledgerIds = await supplierLedgersFor(set.site, set.context.supplierLedgerId);
  const alreadyPosted = await findPostedInvoice(set.site, { invoiceNo: set.extractedHeader?.invoiceNo, ledgerIds });
  return { alreadyPosted };
}

/** Run every check over the lines, store both, and build the reply. */
async function checkAndSave(set, lines, { alreadyPosted }) {
  const checks = runInvoiceChecks({
    header: set.extractedHeader, lines, alreadyPosted, context: set.context,
  });
  set.extractedLines = lines;
  set.poCandidates = [...new Set(lines.map((l) => l.matchedPoTransactionId).filter(Boolean))];
  return saveChecks(set, checks);
}

/**
 * Store a run of the checks with the ignores that still apply to it - one
 * whose check now passes is dropped - and build the reply. An ignored block
 * no longer blocks; one nothing excuses does.
 */
async function saveChecks(set, checks) {
  const ignored = liveIgnores(set.toObject().ignoredChecks || [], checks);
  const stamped = withIgnores(checks, ignored);
  const blocked = unresolvedBlocks(checks, ignored).length > 0;
  set.ignoredChecks = ignored;
  set.checks = stamped;
  set.status = blocked ? 'NEEDS_REVIEW' : 'MATCHED';
  await set.save();
  return {
    documentSet: set,
    checks: stamped,
    isBlocked: blocked,
    warningsNeedingReason: warningsNeedingReason(checks),
  };
}

/**
 * The person, as a reader would name them. An ERP account's key is a synthetic
 * "manu@erp.kol"; its display name is the ERP user name. The audit log keeps
 * the key, which is what identifies the account.
 */
function personName(req) {
  return req.sp?.user?.displayName || req.sp?.actor || 'someone';
}

async function loadOpenSet(req, res) {
  await ensureSupplierPortalReady();
  const set = await DocumentSet.findById(req.params.id);
  if (!set) { res.status(404).json({ error: 'Document set not found.' }); return null; }
  if (set.status === 'POSTED') { res.status(409).json({ error: 'This document set has already been posted.' }); return null; }
  if (!set.context?.supplierLedgerId) { res.status(400).json({ error: 'The supplier ledger has not been selected.' }); return null; }
  return set;
}

router.post('/document-sets/:id/match', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;

    // Off unless asked: closed lines are for seeing where an invoice belonged,
    // and every match to one is blocked from posting by INV002.
    const includeClosed = req.body?.includeClosed === true || req.query.includeClosed === 'true';
    const inputs = await matchingInputs(set, { includeClosed });
    const lines = plainLinesOf(set);

    // A line a person placed keeps its PO line. Its pending is re-read from the
    // PO book, because it may have moved since the choice was made.
    const byDetailId = new Map(inputs.poLines.map((po) => [Number(po.TransactionDetailID), po]));
    const fixed = [];
    const lost = new Set();
    lines.forEach((line, index) => {
      if (!line.matchManual || line.unplacedByHand) return;
      const po = byDetailId.get(Number(line.matchedPoTransactionDetailId));
      if (po) fixed.push({ index, po });
      else lost.add(index);
    });

    // The whole invoice at once: the printed PO number decides, a rejection
    // floor refuses word-only matches, and pending is spent as lines are placed.
    // Lines a person took off every PO line are not offered to the matcher,
    // so they neither move nor use up a PO line's pending.
    const offered = lines.map((line, index) => ({ line, index })).filter(({ line }) => !line.unplacedByHand);
    const offeredAt = new Map(offered.map(({ index }, i) => [index, i]));
    const placed = matchInvoiceLines({
      lines: offered.map(({ line }) => line),
      poLines: inputs.poLines,
      items: inputs.items,
      poNumbers: set.extractedHeader?.poNumbers,
      includeClosed,
      receipts: inputs.receipts,
      fixed: fixed.map((f) => ({ ...f, index: offeredAt.get(f.index) })),
    });

    const matched = lines.map((line, i) => {
      if (line.unplacedByHand) return { ...line, ...UNMATCHED };
      const { po, basis, closed, manual } = placed[offeredAt.get(i)];
      if (manual) {
        return {
          ...line, ...UNMATCHED, ...fieldsForPo(line, po, { ...inputs, closed }),
          matchManual: true, matchBasis: line.matchBasis,
        };
      }
      // Every match field is reset first, so a line that no longer matches
      // does not keep showing the PO it matched the last time.
      const note = lost.has(i)
        ? ' (The PO line chosen by hand is no longer available, so this was matched automatically.)'
        : '';
      const base = { ...line, ...UNMATCHED, matchManual: false, matchBasis: `${basis}${note}` };
      if (!po) return base;
      return { ...base, ...fieldsForPo(line, po, { ...inputs, closed }) };
    });

    const reply = await checkAndSave(set, matched, inputs);
    return res.json({ ...reply, includeClosed });
  } catch (err) { return next(err); }
});

/**
 * A person puts one invoice line on one PO line - or takes it off one.
 *
 * For when the matcher gets it wrong or finds nothing. The PO line is looked
 * up server-side among THIS supplier's lines; the client sends only its id, so
 * a choice can never carry another supplier's PO or a made-up pending. The
 * chosen line survives "Match again" until it is cleared.
 */
router.post('/document-sets/:id/lines/:lineNo/assign', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;

    const lineNo = Number(req.params.lineNo);
    const lines = plainLinesOf(set);
    const index = lines.findIndex((l) => Number(l.lineNo) === lineNo);
    if (index === -1) return res.status(404).json({ error: `There is no line ${req.params.lineNo}.` });

    const detailId = req.body?.poTransactionDetailId;
    const choosing = !(req.body?.unplace === true || detailId === null || detailId === undefined || detailId === '');
    const inputs = choosing ? await poLineInputs(set, req.body?.poTransactionId) : await checkInputs(set);
    let action;

    if (req.body?.unplace === true) {
      // From the Pending POs grid: this invoice line is on no PO line, and
      // "Match again" must not put it back.
      lines[index] = {
        ...lines[index], ...UNMATCHED, matchManual: true, unplacedByHand: true,
        matchBasis: `Taken off its PO line by ${personName(req)}.`,
      };
      action = 'LINE_UNPLACED_BY_HAND';
    } else if (detailId === null || detailId === undefined || detailId === '') {
      lines[index] = {
        ...lines[index], ...UNMATCHED, matchManual: false, unplacedByHand: false,
        matchBasis: `Match cleared by ${personName(req)}; it will be matched automatically next time.`,
      };
      action = 'LINE_MATCH_CLEARED';
    } else {
      const po = inputs.poLines.find((p) => Number(p.TransactionDetailID) === Number(detailId));
      if (!po) {
        return res.status(404).json({ error: "That PO line is not one of this supplier's PO lines." });
      }
      const closed = isClosed(po);
      // Say plainly what the person's choice disagrees with, so a reviewer can
      // see a deliberate override for what it is.
      const assessed = assessCandidate(lines[index], po, {
        items: inputs.items, headerPoNumbers: poNumbersFrom(set.extractedHeader?.poNumbers),
      });
      lines[index] = {
        ...lines[index], ...UNMATCHED, ...fieldsForPo(lines[index], po, { ...inputs, closed }),
        matchManual: true,
        unplacedByHand: false,
        matchBasis: `Chosen by ${personName(req)}${assessed.reasons.length ? ` - ${assessed.reasons.join(', ')}` : ''}.`,
      };
      action = 'LINE_MATCHED_BY_HAND';
    }

    const reply = await checkAndSave(set, lines, inputs);
    await AuditLog.create({
      action,
      entity: 'documentSet',
      entityId: String(set._id),
      site: set.site,
      actor: req.sp.actor,
      after: { lineNo, poTransactionDetailId: detailId ?? null },
    });
    return res.json(reply);
  } catch (err) { return next(err); }
});

/**
 * Add a line from a PO line - the ERP's "pick a PO line, it becomes a batch
 * row". The PO line is looked up server-side among THIS supplier's lines.
 *
 * The quantity starts at 0, as on the ERP's own screen, so nothing is received
 * in full by default: a person enters what actually arrived. The rate starts
 * at the PO rate. A zero-quantity line cannot be posted (the writer refuses it).
 */
router.post('/document-sets/:id/lines', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;

    const detailId = Number(req.body?.poTransactionDetailId);
    const inputs = await poLineInputs(set, req.body?.poTransactionId);
    const po = inputs.poLines.find((p) => Number(p.TransactionDetailID) === detailId);
    if (!po) return res.status(404).json({ error: "That PO line is not one of this supplier's PO lines." });

    const lines = plainLinesOf(set);
    const lineNo = lines.reduce((m, l) => Math.max(m, Number(l.lineNo) || 0), 0) + 1;
    const qty = Math.max(0, num(req.body?.qty) ?? 0);
    const rate = Math.round((num(po.PurchaseRate) ?? 0) * 100) / 100;
    const base = {
      lineNo,
      description: po.ItemName ?? null,
      qty,
      rate,
      amount: Math.round(qty * rate * 100) / 100,
      uom: String(po.PurchaseUnit || '').trim() || po.StockUnit || null,
      hsn: inputs.hsn.get(po.ItemID)?.HSNCode ?? null,
      poRef: null,
      warehouseId: null,
    };
    lines.push({
      ...base, ...UNMATCHED, ...fieldsForPo(base, po, { ...inputs, closed: isClosed(po) }),
      matchManual: true,
      addedByHand: true,
      matchBasis: `Added by ${personName(req)} from ${po.PoVoucherNo}.`,
    });

    const reply = await checkAndSave(set, lines, inputs);
    await AuditLog.create({
      action: 'LINE_ADDED_BY_HAND', entity: 'documentSet', entityId: String(set._id),
      site: set.site, actor: req.sp.actor, after: { lineNo, poTransactionDetailId: detailId },
    });
    return res.status(201).json({ ...reply, lineNo });
  } catch (err) { return next(err); }
});

/**
 * Change one line - its quantity, rate, or warehouse - or every line's
 * warehouse (`lineNo` = all).
 *
 * The warehouse belongs to the GRN line, as in the ERP's own screen; the
 * header carries 0. It is checked against the site's warehouse list, so a
 * stray id cannot reach the ERP. A changed quantity or rate re-prices the
 * line and re-runs every check; the PO match stands.
 */
router.patch('/document-sets/:id/lines/:lineNo', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;
    const body = req.body || {};
    const all = req.params.lineNo === 'all';

    let warehouseId;
    if (body.warehouseId !== undefined) {
      warehouseId = Number(body.warehouseId);
      if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
        return res.status(400).json({ error: 'Choose a warehouse.' });
      }
      const known = (await warehouses(set.site)).some((w) => Number(w.WarehouseID) === warehouseId);
      if (!known) return res.status(400).json({ error: `Warehouse ${warehouseId} is not a ${set.site} warehouse.` });
    }

    const edits = {};
    if (body.qty !== undefined) edits.qty = num(body.qty);
    if (body.stockQty !== undefined) edits.stockQty = num(body.stockQty);
    if (body.rate !== undefined) edits.rate = num(body.rate);
    // The trade discount, as a percentage or an amount; null clears it.
    for (const k of ['discountPct', 'discountAmount']) {
      if (body[k] !== undefined) edits[k] = body[k] === null || body[k] === '' ? null : num(body[k]);
    }
    if (body.description !== undefined) edits.description = body.description === null ? null : String(body.description);
    // The kg on the supplier's bill, for the purchase invoice only. null clears it.
    if (body.billedKg !== undefined) edits.billedKg = body.billedKg === null || body.billedKg === '' ? null : num(body.billedKg);
    const editing = Object.keys(edits).length > 0;
    if (editing && all) return res.status(400).json({ error: 'Quantity and rate are changed one line at a time.' });
    if ((edits.billedKg !== undefined && edits.billedKg !== null && !(edits.billedKg > 0))
      || (body.billedKg !== undefined && body.billedKg !== null && body.billedKg !== '' && edits.billedKg === null)) {
      return res.status(400).json({ error: 'The billed kg must be a number above zero.' });
    }
    if ((edits.qty !== undefined && (edits.qty === null || edits.qty < 0))
      || (edits.stockQty !== undefined && (edits.stockQty === null || edits.stockQty < 0))
      || (edits.rate !== undefined && (edits.rate === null || edits.rate < 0))) {
      return res.status(400).json({ error: 'Quantity and rate must be numbers, zero or more.' });
    }
    if ((edits.discountPct !== undefined && edits.discountPct !== null && !(edits.discountPct >= 0 && edits.discountPct < 100))
      || (edits.discountAmount !== undefined && edits.discountAmount !== null && !(edits.discountAmount >= 0))
      || ['discountPct', 'discountAmount'].some((k) => body[k] !== undefined && body[k] !== null && body[k] !== '' && edits[k] === null)) {
      return res.status(400).json({ error: 'A discount is a percentage from 0 to under 100, or an amount of zero or more.' });
    }

    const lines = plainLinesOf(set);
    let touched = 0;
    for (const line of lines) {
      if (!all && Number(line.lineNo) !== Number(req.params.lineNo)) continue;
      touched++;
      if (warehouseId !== undefined) line.warehouseId = warehouseId;
      if (editing) {
        if (edits.billedKg !== undefined && edits.billedKg !== null && !billsByKgStocksSheets(line)) {
          return res.status(400).json({ error: `Line ${line.lineNo} is not paper bought by the kg and stocked in sheets: its purchase invoice bills the GRN's quantity.` });
        }
        Object.assign(line, edits);
        // Receipt Qty in either unit fills in the other, as on the ERP's screen.
        if (edits.stockQty !== undefined && edits.qty === undefined) line.qty = purchaseQtyFromStock(edits.stockQty, line);
        if (edits.qty !== undefined && edits.stockQty === undefined) line.stockQty = stockQtyFromPurchase(edits.qty, line);
        // A sheet count a person typed is kept through every re-match; one
        // worked out from the kg is worked out again.
        if (edits.stockQty !== undefined) line.stockQtyByHand = true;
        else if (edits.qty !== undefined) line.stockQtyByHand = false;
        const priced = edits.qty !== undefined || edits.stockQty !== undefined || edits.rate !== undefined || edits.billedKg !== undefined;
        if (priced) {
          // The amount is what the bill charges: billed kg x rate where there is one.
          const q = num(piQty(line));
          const r = num(line.rate);
          line.amount = q !== null && r !== null ? Math.round(q * r * 100) / 100 : line.amount;
        }
        if (priced || edits.discountPct !== undefined || edits.discountAmount !== undefined) {
          Object.assign(line, repricedDiscount(line, edits));
        }
      }
    }
    if (!touched) return res.status(404).json({ error: `There is no line ${req.params.lineNo}.` });
    if (editing) clearEditedFlags(set, set.toObject(), req, lines);

    if (!editing) {
      set.extractedLines = lines;
      await set.save();
      return res.json({ ok: true, warehouseId, lines: touched });
    }
    return res.json(await checkAndSave(set, lines, await checkInputs(set)));
  } catch (err) { return next(err); }
});

/** Remove a line from a draft. Nothing in the ERP is touched: this is not posted. */
router.delete('/document-sets/:id/lines/:lineNo', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;
    const lines = plainLinesOf(set);
    const kept = lines.filter((l) => Number(l.lineNo) !== Number(req.params.lineNo));
    if (kept.length === lines.length) return res.status(404).json({ error: `There is no line ${req.params.lineNo}.` });
    // A removed line's red flags go with it.
    clearEditedFlags(set, set.toObject(), req, kept);

    const reply = await checkAndSave(set, kept, await checkInputs(set));
    await AuditLog.create({
      action: 'LINE_REMOVED', entity: 'documentSet', entityId: String(set._id),
      site: set.site, actor: req.sp.actor, after: { lineNo: Number(req.params.lineNo) },
    });
    return res.json(reply);
  } catch (err) { return next(err); }
});

/**
 * The supplier's PO lines, for the Pending POs tab: open only, or with
 * closed ones too. Read-only; choosing one goes through /assign.
 */
router.get('/document-sets/:id/po-lines', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });
    if (!set.context?.supplierLedgerId) return res.status(400).json({ error: 'The supplier ledger has not been selected.' });

    const includeClosed = req.query.includeClosed === 'true';
    const ledgerIds = await supplierLedgersFor(set.site, set.context.supplierLedgerId);
    const rows = await openPoLines(set.site, { ledgerIds, includeCompleted: includeClosed });
    const lines = rows
      .filter((po) => includeClosed || !isClosed(po))
      .map((po) => ({
        transactionDetailId: Number(po.TransactionDetailID),
        transactionId: Number(po.TransactionID),
        poVoucherNo: po.PoVoucherNo,
        poDate: po.PoDate,
        itemId: Number(po.ItemID),
        itemCode: po.ItemCode ?? null,
        itemName: po.ItemName ?? null,
        subGroup: po.SubGroupName ?? null,
        // Both units, as the ERP's GRN screen shows them: P.U. is what was
        // ordered and billed, S.U. is what goes into stock.
        orderedQty: po.PurchaseOrderQuantity,
        orderedStockQty: po.ChallanWeight ?? null,
        receivedQty: po.ReceivedQty,
        pendingQty: po.PendingQty,
        pendingStockQty: po.PendingStockQty ?? null,
        purchaseUnit: po.PurchaseUnit ?? null,
        stockUnit: po.StockUnit ?? null,
        rate: po.PurchaseRate,
        tolerancePct: po.PurchaseTolerance ?? null,
        poRefRemark: (po.PurchaseReferenceRemark || '').trim() || null,
        jobCardNo: (po.RefJobCardContentNo || '').trim() || null,
        refClient: po.ClientName ?? null,
        closed: isClosed(po),
      }));
    return res.json({ includeClosed, lines });
  } catch (err) { return next(err); }
});

// -- the GRN register: posted GRNs, and editing or deleting them -------------

const DAY = 86400000;

/** Which GRNs GRN Creator posted, by TransactionID -> the document set. */
async function madeHere(site, transactionIds) {
  if (!transactionIds.length) return new Map();
  const sets = await DocumentSet.find({ site, 'posted.grnTransactionId': { $in: transactionIds } })
    .select('_id posted.grnTransactionId').lean();
  return new Map(sets.map((x) => [Number(x.posted.grnTransactionId), String(x._id)]));
}

function sendError(res, err) {
  return res.status(err.status || 500).json({ error: err.message, ...(err.plan ? { plan: err.plan } : {}) });
}

/**
 * Every live GRN of a date range - made in the ERP or here - with whether it
 * has been issued from and whether its purchase invoice exists.
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 7 days), ?supplierLedgerId, ?q.
 * At most 500, newest first; `truncated` says when there were more.
 */
router.get('/grns', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 7 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'Give dates as YYYY-MM-DD.' });
    if (to - from > 366 * DAY) return res.status(400).json({ error: 'Choose a range of a year or less.' });
    const supplier = Number(req.query.supplierLedgerId) || null;
    const ledgerIds = supplier ? await supplierLedgersFor(req.sp.site, supplier) : null;
    const LIMIT = 500;
    const grns = await listGrns(req.sp.site, { from, to, ledgerIds, search: req.query.q ? String(req.query.q) : null, limit: LIMIT });
    const made = await madeHere(req.sp.site, grns.map((g) => g.transactionId));
    return res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      canEdit: canEditGrns(req.sp.user),
      writesEnabled: erpWritesEnabled(),
      truncated: grns.length >= LIMIT,
      grns: grns.map((g) => ({
        ...g,
        madeIn: made.has(g.transactionId) ? 'GRN Creator' : 'ERP',
        documentSetId: made.get(g.transactionId) ?? null,
      })),
    });
  } catch (err) { return next(err); }
});

/** One posted GRN, with what may and may not be changed on each line. */
router.get('/grns/:transactionId', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const grn = await loadGrn((t, p) => query(req.sp.site, t, p), Number(req.params.transactionId));
    if (!grn) return res.status(404).json({ error: 'No such GRN - it may have been deleted.' });
    const made = await madeHere(req.sp.site, [grn.transactionId]);
    return res.json({
      ...grn,
      madeIn: made.has(grn.transactionId) ? 'GRN Creator' : 'ERP',
      canEdit: canEditGrns(req.sp.user),
      writesEnabled: erpWritesEnabled(),
    });
  } catch (err) { return next(err); }
});

/**
 * Freight rows of Additional charges, each on a freight ledger of this site.
 * TaxPercentage as the ERP writes it: 18 on Inward Freight, 0 on the rest.
 */
/**
 * The Additional charges a person added: freight, packing & forwarding,
 * commission, other charges. GST and round-off rows are the writer's own and
 * cannot be added by hand. Every charge goes into the taxable value before
 * GST, as freight does - true of all 699 "Freight Charge" rows the ERP holds.
 * TaxPercentage is the ledger's own (18 on the Inward Freight ledgers, 0 on
 * the rest), as the ERP writes it.
 */
const AUTO_CHARGE_KINDS = new Set(['CGST', 'SGST', 'IGST', 'ROUND_OFF']);

function resolveFreightRows(ledgers, rows) {
  const addable = new Map(ledgers.filter((l) => !AUTO_CHARGE_KINDS.has(l.kind)).map((l) => [Number(l.LedgerID), l]));
  const out = [];
  for (const r of rows || []) {
    if (!(Number(r.amount) > 0)) continue;
    const ledger = addable.get(Number(r.ledgerId));
    if (!ledger) return { error: `Ledger ${r.ledgerId} cannot be added as a charge: GST and round off are added automatically.` };
    out.push({
      ledgerId: Number(ledger.LedgerID), amount: Math.round(Number(r.amount) * 100) / 100,
      name: ledger.LedgerName, taxPercentage: Number(ledger.TaxPercentage) || 0,
    });
  }
  return { rows: out };
}

/**
 * Everything a purchase invoice for one posted GRN starts from: its lines at
 * their PO rates, with GST from the item's HSN and the supplier's state.
 */
async function grnInvoiceDraft(site, transactionId) {
  const grn = await loadGrn((t, p) => query(site, t, p), transactionId);
  if (!grn) return { status: 404, error: 'No such GRN - it may have been deleted.' };
  if (grn.purchaseInvoices.length) {
    return { status: 409, error: `${grn.voucherNo} already has purchase invoice ${grn.purchaseInvoices.map((p) => p.voucherNo).join(', ')}.` };
  }
  const header = await query(site, `
    SELECT DISTINCT ITD.PurchaseTransactionID FROM ItemTransactionDetail ITD
    WHERE ITD.TransactionID = @tid AND ITD.CompanyID = @companyId AND ISNULL(ITD.IsDeletedTransaction,0) = 0
  `, { tid: Number(transactionId), companyId: COMPANY_ID });
  const poTransactionIds = header.map((r) => Number(r.PurchaseTransactionID)).filter((n) => n > 0);
  const [poRows, hsn, split, defaults] = await Promise.all([
    poTransactionIds.length ? openPoLines(site, { transactionIds: poTransactionIds, includeCompleted: true }) : [],
    hsnForItems(site, grn.lines.map((l) => l.itemId)),
    taxSplitFor({ site, extractedHeader: {}, context: { supplierLedgerId: grn.supplierLedgerId } }),
    supplierLedgersFor(site, grn.supplierLedgerId).then((ledgerIds) => receivingDefaults(site, { ledgerIds })),
  ]);
  const poByDetail = new Map(poRows.map((p) => [Number(p.TransactionDetailID), p]));
  const hsnByItem = new Map([...hsn].map(([k, v]) => [Number(k), v]));
  // What this GRN itself received on each PO line: PendingQty already has it
  // taken off, and the over-receipt flag wants what was pending before it.
  const thisGrnQty = new Map();
  for (const l of grn.lines) {
    const k = Number(l.poTransactionDetailId);
    thisGrnQty.set(k, (thisGrnQty.get(k) || 0) + (num(l.qty) || 0));
  }
  const lines = grn.lines.map((l) => {
    const po = poByDetail.get(Number(l.poTransactionDetailId)) || {};
    const h = hsnByItem.get(Number(l.itemId));
    return {
      transactionDetailId: l.transactionDetailId,
      lineNo: l.lineNo,
      itemId: l.itemId,
      itemCode: l.itemCode,
      itemName: l.itemName,
      itemGroupId: po.ItemGroupID ?? po.MasterItemGroupID ?? null,
      itemGroupName: po.ItemGroupName ?? null,
      poTransactionId: po.TransactionID ? Number(po.TransactionID) : null,
      poVoucherNo: l.poVoucherNo,
      poDate: po.PoDate ?? null,
      poFYear: po.FYear ?? null,
      poQty: po.PurchaseOrderQuantity ?? null,
      poTransactionDetailId: l.poTransactionDetailId ?? null,
      poPendingQty: num(po.PendingQty) === null ? null
        : Math.round((num(po.PendingQty) + (thisGrnQty.get(Number(l.poTransactionDetailId)) || 0)) * 1000) / 1000,
      qty: l.qty,
      stockQty: l.stockQty,
      purchaseUnit: l.purchaseUnit,
      stockUnit: l.stockUnit,
      matchedPoRate: num(po.PurchaseRate),
      rate: num(po.PurchaseRate) === null ? null : Math.round(num(po.PurchaseRate) * 100) / 100,
      widthMm: po.ItemWidth ?? null,
      expectedHsn: h?.HSNCode ?? null,
      productHsnId: po.ProductHSNID ?? null,
      wtPerPacking: l.wtPerPacking,
      ...gstFor(h, split),
    };
  });
  return { grn, lines, taxSplit: split, defaults };
}

/** The purchase invoice a GRN without one would get. Read-only. */
router.get('/grns/:transactionId/purchase-invoice', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const draft = await grnInvoiceDraft(req.sp.site, Number(req.params.transactionId));
    if (draft.error) return res.status(draft.status).json({ error: draft.error });
    const { grn } = draft;
    return res.json({
      transactionId: grn.transactionId,
      voucherNo: grn.voucherNo,
      voucherDate: grn.voucherDate,
      supplierLedgerId: grn.supplierLedgerId,
      supplierName: grn.supplierName,
      deliveryNoteNo: grn.header.deliveryNoteNo,
      deliveryNoteDate: grn.header.deliveryNoteDate,
      taxSplit: draft.taxSplit,
      lines: draft.lines,
      defaults: draft.defaults,
      writesEnabled: erpWritesEnabled(),
    });
  } catch (err) { return next(err); }
});

/**
 * Make that purchase invoice. ?dryRun=true says what would be written.
 * Body: {purchaseLedgerId, billNo, billDate, remark, roundOff,
 *        freightCharges: [{ledgerId, amount}], rates: {transactionDetailId: rate},
 *        billedKg: {transactionDetailId: kg}}.
 * The lines are the GRN's own, read again here - never the page's copy.
 */
router.post('/grns/:transactionId/purchase-invoice', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const site = req.sp.site;
    const body = req.body || {};
    const dryRun = req.query.dryRun === 'true' || body.dryRun === true;
    const draft = await grnInvoiceDraft(site, Number(req.params.transactionId));
    if (draft.error) return res.status(draft.status).json({ error: draft.error });

    const purchaseLedgerId = Number(body.purchaseLedgerId);
    if (!(await purchaseLedgers(site)).some((l) => Number(l.LedgerID) === purchaseLedgerId)) {
      return res.status(400).json({ error: 'Choose a purchase ledger of this site.' });
    }
    const ledgers = await chargeLedgers(site);
    const freight = resolveFreightRows(ledgers, body.freightCharges);
    if (freight.error) return res.status(400).json({ error: freight.error });

    const rates = body.rates || {};
    // {transactionDetailId: kg}: the kg on the bill, for paper bought by the kg
    // and stocked in sheets. The GRN's own kg and sheets are not touched.
    const billed = body.billedKg || {};
    for (const [id, kg] of Object.entries(billed)) {
      const line = draft.lines.find((l) => String(l.transactionDetailId) === String(id));
      if (kg === null || kg === '') continue;
      if (!line) return res.status(400).json({ error: `GRN line ${id} is not on this GRN.` });
      if (!billsByKgStocksSheets(line)) return res.status(400).json({ error: `Line ${line.lineNo} is not paper bought by the kg and stocked in sheets: its purchase invoice bills the GRN's quantity.` });
      if (!(num(kg) > 0)) return res.status(400).json({ error: `The billed kg on line ${line.lineNo} must be a number above zero.` });
    }
    const lines = draft.lines.map((l) => {
      const rate = rates[l.transactionDetailId] !== undefined ? num(rates[l.transactionDetailId]) : l.rate;
      const kg = billed[l.transactionDetailId];
      const withKg = { ...l, rate, billedKg: kg === undefined || kg === null || kg === '' ? null : num(kg) };
      return { ...withKg, amount: rate === null ? null : Math.round(piQty(withKg) * rate * 100) / 100 };
    });
    const header = {
      invoiceNo: draft.grn.header.deliveryNoteNo,
      invoiceDate: draft.grn.header.deliveryNoteDate,
      billNo: (body.billNo || '').trim() || draft.grn.header.deliveryNoteNo,
      billDate: body.billDate || draft.grn.header.deliveryNoteDate,
      remark: body.remark ?? '',
      freight: freight.rows.reduce((s, f) => s + f.amount, 0),
      roundOff: num(body.roundOff) || 0,
    };
    const context = {
      supplierLedgerId: draft.grn.supplierLedgerId,
      purchaseLedgerId,
      freightLedgerId: freight.rows[0]?.ledgerId ?? null,
      freightCharges: freight.rows,
      userId: Number(req.sp.context?.erpUserId),
      branchId: 1,
      chargeLedgers: Object.fromEntries(['CGST', 'SGST', 'IGST', 'ROUND_OFF'].map((kind) => [
        kind, ledgers.find((l) => l.kind === kind)?.LedgerID ?? null,
      ])),
    };

    let result;
    try {
      result = await postPurchaseInvoiceForGrn({ site, grnTransactionId: draft.grn.transactionId, header, lines, context, dryRun });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!dryRun) {
      await AuditLog.create({
        action: 'PI_POSTED_FOR_GRN', entity: 'erpGrn', entityId: String(draft.grn.transactionId),
        site, actor: req.sp.actor, after: { grnVoucherNo: draft.grn.voucherNo, piVoucherNo: result.pi.voucherNo },
      });
    }
    return res.json({ ...result, writesEnabled: erpWritesEnabled() });
  } catch (err) { return next(err); }
});

/** Guard for both writes: the ids must belong to this site. Anyone signed in may edit. */
async function checkEditRequest(req, res, edit = {}) {
  const site = req.sp.site;
  const whs = (edit.lines || []).map((l) => l.warehouseId).filter((v) => v !== undefined && v !== null);
  if (whs.length) {
    const known = new Set((await warehouses(site)).map((w) => Number(w.WarehouseID)));
    const bad = whs.find((w) => !known.has(Number(w)));
    if (bad !== undefined) { res.status(400).json({ error: `Warehouse ${bad} is not a ${site} warehouse.` }); return false; }
  }
  if (edit.header?.receivedBy !== undefined && edit.header.receivedBy !== null) {
    const people = new Set((await employeeLedgers(site)).map((e) => Number(e.LedgerID)));
    if (!people.has(Number(edit.header.receivedBy))) {
      res.status(400).json({ error: "Received by must be one of the site's employees." });
      return false;
    }
  }
  return true;
}

/**
 * Edit a posted GRN: header fields, and each line's quantity, warehouse, or
 * removal. ?dryRun=true (or writes off) says what would change and writes
 * nothing. Body: {header, lines, expectedModifiedDate}.
 */
router.post('/grns/:transactionId/edit', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const body = req.body || {};
    const edit = { header: body.header || {}, lines: Array.isArray(body.lines) ? body.lines : [] };
    if (!(await checkEditRequest(req, res, edit))) return undefined;
    const dryRun = req.query.dryRun === 'true' || body.dryRun === true;
    let result;
    try {
      result = await editGrn(req.sp.site, {
        transactionId: Number(req.params.transactionId), edit, dryRun,
        userId: req.sp.context?.erpUserId, expectedModifiedDate: body.expectedModifiedDate,
      });
    } catch (err) { if (err.status) return sendError(res, err); throw err; }
    if (!dryRun) {
      await AuditLog.create({
        action: 'GRN_EDITED', entity: 'erpGrn', entityId: String(req.params.transactionId),
        site: req.sp.site, actor: req.sp.actor, after: { voucherNo: result.voucherNo, plan: result.plan },
      });
    }
    return res.json({ ...result, writesEnabled: erpWritesEnabled() });
  } catch (err) { return next(err); }
});

/** Delete a posted GRN. ?dryRun=true says whether it could be. Body: {expectedModifiedDate}. */
router.post('/grns/:transactionId/delete', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    if (!(await checkEditRequest(req, res))) return undefined;
    const body = req.body || {};
    const dryRun = req.query.dryRun === 'true' || body.dryRun === true;
    const tid = Number(req.params.transactionId);
    let result;
    try {
      result = await deleteGrn(req.sp.site, {
        transactionId: tid, dryRun, userId: req.sp.context?.erpUserId, expectedModifiedDate: body.expectedModifiedDate,
      });
    } catch (err) { if (err.status) return sendError(res, err); throw err; }
    if (!dryRun) {
      await DocumentSet.updateOne(
        { site: req.sp.site, 'posted.grnTransactionId': tid },
        { $set: { 'posted.deletedAt': new Date(), 'posted.deletedBy': req.sp.actor } },
      );
      await AuditLog.create({
        action: 'GRN_DELETED', entity: 'erpGrn', entityId: String(tid),
        site: req.sp.site, actor: req.sp.actor, after: { voucherNo: result.voucherNo, lines: result.lines },
      });
    }
    return res.json({ ...result, writesEnabled: erpWritesEnabled() });
  } catch (err) { return next(err); }
});

/**
 * A posted GRN's lines, each saying whether it may be deleted: a line stock
 * has been issued from may not, until its issue lines are deleted. Read-only.
 * By voucher number (REC04597_26_27) or by TransactionID.
 */
router.get('/grn-lines', async (req, res, next) => {
  try {
    const voucherNo = req.query.voucherNo ? String(req.query.voucherNo).trim() : null;
    const grnTransactionId = req.query.transactionId ? Number(req.query.transactionId) : null;
    if (!voucherNo && !grnTransactionId) return res.status(400).json({ error: 'Give a GRN voucher number or TransactionID.' });
    const result = await grnLinesWithIssues(req.sp.site, { voucherNo, grnTransactionId });
    if (!result) return res.status(404).json({ error: `No GRN ${voucherNo || grnTransactionId} in ${req.sp.site}.` });
    return res.json(result);
  } catch (err) { return next(err); }
});

/** Starting values for received-by, warehouse and the two ledgers. */
router.get('/document-sets/:id/defaults', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });
    if (!set.context?.supplierLedgerId) return res.status(400).json({ error: 'The supplier ledger has not been selected.' });
    const ledgerIds = await supplierLedgersFor(set.site, set.context.supplierLedgerId);
    return res.json(await receivingDefaults(set.site, {
      ledgerIds, erpUserId: req.sp.context?.erpUserId ?? set.context?.userId ?? null,
    }));
  } catch (err) { return next(err); }
});

/** Correct extracted values, then re-run the checks. */
router.patch('/document-sets/:id', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });
    if (set.status === 'POSTED') {
      return res.status(409).json({ error: 'This document set has already been posted.' });
    }

    const before = set.toObject();
    if (req.body?.extractedHeader) {
      set.extractedHeader = { ...set.extractedHeader, ...req.body.extractedHeader };
    }
    if (req.body?.extractedLines) {
      /**
       * Only what was read off the invoice may be corrected here. Match fields
       * come from the matcher, or from a person through /assign - never from
       * the client, which could otherwise write a PO match and a pending of its
       * own choosing and post it. A corrected line also invalidates the match:
       * the checks that cleared it were about the old values. A line placed by
       * hand keeps its choice; "Match again" re-reads it from the PO book.
       */
      const existing = new Map(plainLinesOf(set).map((l) => [Number(l.lineNo), l]));
      set.extractedLines = req.body.extractedLines.map((l) => {
        const was = existing.get(Number(l.lineNo)) || {};
        // A field the page did not send keeps what the reader found.
        const kept = correctedLine(l, was, EDITABLE_LINE_FIELDS);
        return {
          ...kept,
          warehouseId: was.warehouseId ?? null,
          ...(was.addedByHand ? { addedByHand: true } : {}),
          ...(was.unplacedByHand ? { unplacedByHand: true } : {}),
          ...(was.stockQtyByHand ? { stockQtyByHand: true } : {}),
          ...(was.matchManual ? {
            matchManual: true,
            matchedPoTransactionDetailId: was.matchedPoTransactionDetailId,
            matchBasis: was.matchBasis,
          } : {}),
        };
      });
      set.checks = [];
      set.poCandidates = [];
      set.status = 'EXTRACTED';
    }
    if (req.body?.context) {
      // CreatedBy is whoever is signed in, never what the client says it is.
      const { userId, ...rest } = req.body.context;

      const changing = rest.supplierLedgerId !== undefined
        && Number(rest.supplierLedgerId) !== Number(set.context?.supplierLedgerId);
      if (changing) {
        const id = Number(rest.supplierLedgerId);
        const known = (await supplierLedgers(set.site)).some((l) => Number(l.LedgerID) === id);
        if (!known) {
          return res.status(400).json({ error: `Ledger ${rest.supplierLedgerId} is not a ${set.site} supplier ledger.` });
        }
        // Every PO match pointed at the old supplier's POs - including lines a
        // person placed by hand. None of them can stand for a different supplier.
        set.extractedLines = plainLinesOf(set).map((l) => ({
          ...l, ...UNMATCHED, matchManual: false, matchBasis: null,
        }));
        set.checks = [];
        // Nor can an ignored check: it excused the old supplier's PO, not the new one's.
        set.ignoredChecks = [];
        set.poCandidates = [];
        set.status = 'EXTRACTED';
      }
      set.context = { ...set.context, ...rest };
    }
    clearEditedFlags(set, before, req);
    await set.save();

    await AuditLog.create({
      action: 'DOCUMENT_SET_CORRECTED',
      entity: 'documentSet',
      entityId: String(set._id),
      site: set.site,
      actor: req.sp.actor,
      before: { header: before.extractedHeader, context: before.context },
      after: { header: set.extractedHeader, context: set.context },
      reason: req.body?.reason || null,
    });

    return res.json(set);
  } catch (err) { return next(err); }
});

/**
 * Clear the red flags on values that changed. `before` is the set as it was
 * (toObject()); `lines`, when given, are the lines about to be saved.
 */
function clearEditedFlags(set, before, req, lines = null) {
  if (!(before.fieldFlags || []).length) return;
  const now = set.toObject();
  set.fieldFlags = resolveEditedFlags(
    before.fieldFlags,
    { header: before.extractedHeader, lines: before.extractedLines },
    { header: now.extractedHeader, lines: lines ?? now.extractedLines },
    personName(req),
  );
}

/** Mark a red-flagged field checked: "I looked, the value is right." Body: {field}. */
router.post('/document-sets/:id/flags/confirm', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;
    const field = String(req.body?.field || '');
    const { flags, found } = confirmFlag(set.toObject().fieldFlags, field, personName(req));
    if (!found) return res.status(404).json({ error: `No flag on ${field}.` });
    set.fieldFlags = flags;
    await set.save();
    await AuditLog.create({
      action: 'FIELD_FLAG_CONFIRMED', entity: 'documentSet', entityId: String(set._id),
      site: set.site, actor: req.sp.actor, after: { field },
    });
    return res.json({ fieldFlags: set.fieldFlags });
  } catch (err) { return next(err); }
});

/**
 * Ignore a blocking check: "I know - post it anyway". Body: {code, lineNo, reason}.
 *
 * The reason is required, and who ignored it is whoever is signed in, never
 * what the client says. Only a block that is failing in the stored checks can
 * be ignored, and not the ones in NOT_IGNORABLE. The reply is the checks', as
 * from /match.
 */
router.post('/document-sets/:id/checks/ignore', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;
    const stored = set.toObject();
    const result = ignoreCheck(stored.ignoredChecks || [], stored.checks || [], {
      code: req.body?.code,
      lineNo: req.body?.lineNo,
      reason: req.body?.reason,
      by: req.sp.actor,
      byName: personName(req),
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    set.ignoredChecks = result.ignored;
    const reply = await saveChecks(set, stored.checks || []);
    const added = result.ignored[result.ignored.length - 1];
    await AuditLog.create({
      action: 'CHECK_IGNORED', entity: 'documentSet', entityId: String(set._id),
      site: set.site, actor: req.sp.actor,
      after: { code: added.code, lineNo: added.lineNo, message: added.message },
      reason: added.reason,
    });
    return res.json(reply);
  } catch (err) { return next(err); }
});

/** Take an ignore back: the check blocks posting again. Body: {code, lineNo}. */
router.post('/document-sets/:id/checks/unignore', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    const set = await loadOpenSet(req, res);
    if (!set) return undefined;
    const stored = set.toObject();
    const { ignored, found } = undoIgnore(stored.ignoredChecks || [], { code: req.body?.code, lineNo: req.body?.lineNo });
    if (!found) return res.status(404).json({ error: `${req.body?.code || 'That check'} is not ignored.` });
    set.ignoredChecks = ignored;
    const reply = await saveChecks(set, stored.checks || []);
    await AuditLog.create({
      action: 'CHECK_IGNORE_UNDONE', entity: 'documentSet', entityId: String(set._id),
      site: set.site, actor: req.sp.actor,
      after: { code: String(req.body?.code ?? ''), lineNo: req.body?.lineNo ?? null },
    });
    return res.json(reply);
  } catch (err) { return next(err); }
});

/**
 * Post: GRN + purchase invoice + PO line closure, in one transaction.
 *
 * A blocking check posts only once a person has ignored it with a reason,
 * stored on the set through /checks/ignore. A warning needs a recorded reason.
 * Both rules are enforced here rather than in the client, because the client
 * is a tablet in a warehouse and the rule has to hold regardless.
 */
router.post('/document-sets/:id/post', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });
    if (set.status === 'POSTED') {
      return res.status(409).json({
        error: 'Already posted.',
        posted: set.posted,
      });
    }

    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

    const flagged = openFlags(set.fieldFlags);
    if (flagged.length && !dryRun) {
      return res.status(422).json({
        error: `${flagged.length} field${flagged.length > 1 ? 's are' : ' is'} still red-flagged: `
          + `${flagged.map((f) => f.field).join(', ')}. Correct each one, or mark it checked.`,
        fieldFlags: flagged,
      });
    }

    // A closed PO line is in the record only because someone asked to see where
    // the invoice belonged. INV002 already blocks it; this refusal does not
    // depend on the checks having been run, or run since the last match.
    const onClosed = (set.extractedLines || []).filter((l) => l.matchedPoClosed);
    if (onClosed.length && !dryRun) {
      const nos = onClosed.map((l) => String(l.lineNo));
      const which = nos.length > 1
        ? `Lines ${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]} are matched to closed PO lines`
        : `Line ${nos[0]} is matched to a closed PO line`;
      return res.status(422).json({ error: `${which}. Match again against open POs before posting.` });
    }

    // From the stored checks and the stored ignores only: an ignore whose
    // check now passes, or that has no reason, excuses nothing.
    const stored = set.toObject();
    const ignored = liveIgnores(stored.ignoredChecks || [], stored.checks || []);
    const unresolved = unresolvedBlocks(stored.checks || [], ignored);
    if (unresolved.length) {
      return res.status(422).json({
        error: 'Blocking checks must be resolved, or ignored with a reason, before posting.',
        checks: unresolved,
      });
    }

    const needReason = warningsNeedingReason(set.checks);
    const reasons = new Map((req.body?.overrides || []).map((o) => [o.code, o.reason]));
    const missing = needReason.filter((c) => !reasons.get(c.code));
    if (missing.length && !dryRun) {
      return res.status(422).json({
        error: 'Each warning needs a reason before posting.',
        checks: missing,
      });
    }

    const ledgers = await chargeLedgers(set.site);
    const chargeLedgerIds = Object.fromEntries(
      ['CGST', 'SGST', 'IGST', 'ROUND_OFF'].map((kind) => [
        kind, ledgers.find((l) => l.kind === kind)?.LedgerID ?? null,
      ]),
    );

    const { userId: ignoredUserId, ...bodyContext } = req.body?.context || {};
    const context = {
      ...set.context,
      ...bodyContext,
      // CreatedBy on every ERP row is the person posting, from their session.
      userId: Number(req.sp.context?.erpUserId ?? set.context?.userId),
      branchId: bodyContext.branchId ?? set.context?.branchId ?? 1,
      chargeLedgers: chargeLedgerIds,
    };
    const rows = resolveFreightRows(ledgers, context.freightCharges);
    if (rows.error) return res.status(400).json({ error: rows.error });
    context.freightCharges = rows.rows;

    const lines = set.extractedLines
      .filter((l) => l.matchedPoTransactionId)
      .map((l) => ({
        lineNo: l.lineNo,
        itemId: l.matchedItemId,
        itemGroupId: l.itemGroupId ?? null,
        poTransactionId: l.matchedPoTransactionId,
        poTransactionDetailId: l.matchedPoTransactionDetailId,
        poVoucherNo: l.poVoucherNo,
        poQty: l.poQty,
        poPendingQty: l.poPendingQty,
        qty: l.qty,
        stockQty: l.stockQty ?? stockQtyFor(l),
        rate: l.rate,
        amount: l.amount,
        // The trade discount as read: the writer posts the line net of it.
        discountPct: l.discountPct ?? null,
        discountAmount: l.discountAmount ?? null,
        taxableValue: l.taxableValue ?? null,
        purchaseUnit: l.uom,
        stockUnit: l.stockUnit ?? null,
        productHsnId: l.productHsnId ?? null,
        wtPerPacking: l.wtPerPacking,
        warehouseId: l.warehouseId ?? null,
        itemDescription: l.description,
        itemName: l.itemName ?? null,
        gstPercentage: l.gstPercentage ?? null,
        cgstPercentage: l.cgstPercentage ?? null,
        sgstPercentage: l.sgstPercentage ?? null,
        igstPercentage: l.igstPercentage ?? null,
      }));

    const result = await postDocumentSet({
      site: set.site,
      header: set.extractedHeader,
      lines,
      context,
      dryRun,
    });

    if (dryRun) return res.json({ dryRun: true, ...result, erpWritesEnabled: erpWritesEnabled() });

    set.status = 'POSTED';
    set.posted = {
      grnTransactionId: result.grn.transactionId,
      grnVoucherNo: result.grn.voucherNo,
      piTransactionId: result.pi.transactionId,
      piVoucherNo: result.pi.voucherNo,
      postedAt: new Date(),
      postedBy: req.sp.actor,
      stockRefreshOk: result.stockRefresh?.ok ?? null,
      stockRefreshError: result.stockRefresh?.error ?? null,
    };
    // The accepted warnings are stamped onto the stored checks, so the reason
    // lives with the voucher rather than in a log nobody reads.
    for (const c of set.checks) {
      const reason = reasons.get(c.code);
      if (!c.passed && c.severity === 'WARN' && reason) {
        c.overrideReason = reason;
        c.overriddenBy = req.sp.actor;
        c.overriddenAt = new Date();
      }
    }
    set.markModified('checks');
    // The ignored blocks are already stamped onto the checks by saveChecks;
    // the list of them stays on the posted set as well, as it stood.
    set.ignoredChecks = ignored;
    await set.save();

    await AuditLog.create({
      action: 'GRN_AND_PI_POSTED',
      entity: 'documentSet',
      entityId: String(set._id),
      site: set.site,
      actor: req.sp.actor,
      after: set.posted,
      reason: [
        ...[...reasons.entries()].map(([code, reason]) => `${code}: ${reason}`),
        ...ignored.map((o) => `${o.code}${o.lineNo === null || o.lineNo === undefined ? '' : ` line ${o.lineNo}`} IGNORED by ${o.byName || o.by}: ${o.reason}`),
      ].join('; ') || null,
      meta: {
        closedPoLines: result.closedLines,
        ignoredChecks: ignored,
        // A discount posted into the rate, as printed: the ERP's lines carry none.
        discountNote: discountNote(priceLines({ header: set.extractedHeader, lines })) || null,
      },
    });

    return res.json({ documentSet: set, ...result });
  } catch (err) { return next(err); }
});

/**
 * TESTING ONLY - clear out unposted document sets.
 *
 * Exists so a test run can start clean. It is off unless the server sets
 * SP_ALLOW_DRAFT_DELETE=true, and off means the routes answer 404 rather than
 * 403: a production server does not advertise a mass-delete it will refuse.
 * Do not set the variable on Render.
 *
 * Three guards, each independent of the others:
 *  - a POSTED set is never touched. Posted sets are tied to real GRN and
 *    purchase-invoice vouchers in the ERP, and the delete re-applies the
 *    status filter itself, so a set posted between the count and the delete
 *    survives;
 *  - only the signed-in site's sets, never the other plant's;
 *  - only stored files under RECEIVING_PREFIX, so a malformed slot can never
 *    reach another app's objects in the shared bucket.
 */
const RECEIVING_PREFIX = 'supplier-portal/receiving/';

function draftDeleteEnabled() {
  return (process.env.SP_ALLOW_DRAFT_DELETE ?? '').trim().toLowerCase() === 'true';
}

function storageKeysOf(set) {
  const slots = set.slots || {};
  return ['supplierInvoice', 'eWayBill', 'packingList']
    .flatMap((name) => slots[name] || [])
    .map((page) => page?.storageKey)
    .filter((key) => typeof key === 'string' && key.startsWith(RECEIVING_PREFIX));
}

router.get('/drafts', async (req, res, next) => {
  try {
    if (!draftDeleteEnabled()) return res.status(404).json({ error: 'Not found.' });
    await ensureSupplierPortalReady();
    const site = req.sp.site;
    const [drafts, posted] = await Promise.all([
      DocumentSet.countDocuments({ site, status: { $ne: 'POSTED' } }),
      DocumentSet.countDocuments({ site, status: 'POSTED' }),
    ]);
    res.json({ enabled: true, site, drafts, posted });
  } catch (err) { next(err); }
});

router.delete('/drafts', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    if (!draftDeleteEnabled()) return res.status(404).json({ error: 'Not found.' });
    await ensureSupplierPortalReady();
    const site = req.sp.site;
    const dryRun = req.query.dryRun === 'true';

    const drafts = await DocumentSet.find({ site, status: { $ne: 'POSTED' } })
      .select('_id slots status extractedHeader.invoiceNo createdAt').lean();
    const ids = drafts.map((d) => d._id);

    if (dryRun) {
      return res.json({
        dryRun: true,
        site,
        drafts: drafts.length,
        files: drafts.reduce((n, d) => n + storageKeysOf(d).length, 0),
        sets: drafts.map((d) => ({
          id: String(d._id),
          status: d.status,
          invoiceNo: d.extractedHeader?.invoiceNo ?? null,
          createdAt: d.createdAt,
        })),
      });
    }

    // The status filter is applied again here, not trusted from the find.
    const result = await DocumentSet.deleteMany({ _id: { $in: ids }, status: { $ne: 'POSTED' } });

    // Delete files only for sets that are really gone. If anything survived -
    // posted in the meantime - its file stays with it.
    let gone = drafts;
    if (result.deletedCount < ids.length) {
      const survivors = new Set(
        (await DocumentSet.find({ _id: { $in: ids } }).select('_id').lean()).map((d) => String(d._id)),
      );
      gone = drafts.filter((d) => !survivors.has(String(d._id)));
    }

    const keys = gone.flatMap(storageKeysOf);
    let files = { deleted: [], errors: [] };
    if (keys.length) {
      try {
        files = await deleteObjects(keys);
      } catch (err) {
        // The records are already gone; say so rather than failing the call.
        files = { deleted: [], errors: keys.map((key) => ({ key, message: err.message })) };
      }
    }

    await AuditLog.create({
      action: 'TEST_DRAFTS_DELETED',
      entity: 'documentSet',
      entityId: 'bulk',
      site,
      actor: req.sp.actor,
      reason: 'Testing cleanup (SP_ALLOW_DRAFT_DELETE)',
      meta: {
        deletedCount: result.deletedCount,
        ids: gone.map((d) => String(d._id)),
        filesDeleted: files.deleted.length,
        fileErrors: files.errors,
      },
    });

    return res.json({
      site,
      deleted: result.deletedCount,
      skippedAsPosted: ids.length - result.deletedCount,
      filesDeleted: files.deleted.length,
      fileErrors: files.errors,
    });
  } catch (err) { return next(err); }
});

router.get('/document-sets', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const { status, limit = 50, skip = 0 } = req.query;
    const filter = { site: req.sp.site };
    if (status) filter.status = status;

    const [documentSets, total] = await Promise.all([
      DocumentSet.find(filter).sort({ createdAt: -1 })
        .skip(Number(skip)).limit(Math.min(Number(limit), 200)).lean(),
      DocumentSet.countDocuments(filter),
    ]);
    res.json({ documentSets, total });
  } catch (err) { next(err); }
});

router.get('/document-sets/:id', async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id).lean();
    if (!set) return res.status(404).json({ error: 'Document set not found.' });
    return res.json(set);
  } catch (err) { return next(err); }
});

function inferShipToState(extracted) {
  const gstin = extracted.shipToGstin || extracted.buyerGstin;
  const code = String(gstin ?? '').slice(0, 2);
  // 19 is West Bengal, 24 Gujarat — the two CDC ships to.
  if (code === '19') return 'West Bengal';
  if (code === '24') return 'Gujarat';
  return null;
}

/** A discount figure as a positive number: bills print it "-22,108.80" or "(-)". */
function positive(n) {
  return n === null || n === undefined ? null : Math.abs(n);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[₹\s]/g, '').replace(/(?<=\d),(?=\d)/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  if (!value) return null;
  const dmy = String(value).match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = new Date(year, Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export default router;
