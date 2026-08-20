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
import { runInvoiceChecks } from '../services/invoice-checks.js';
import { postDocumentSet, erpWritesEnabled } from '../services/erp-receiving.js';
import { openPoLines, findPostedInvoice } from '../services/erp-po.js';
import { getItems, hsnForItems } from '../services/erp-items.js';
import { groupForLedger, ledgerIdsForSite } from '../services/supplier-groups.js';
import { chargeLedgers } from '../services/erp-ledgers.js';
import { hasBlockingFailure, warningsNeedingReason } from '../config/validations.js';
import { createUploadUrl, viewUrl } from '../../lib/r2-storage.js';
import { normaliseName } from '../lib/text.js';

const router = Router();
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
    const extracted = await provider.extractInvoice({ pages });

    set.extractedHeader = {
      invoiceNo: extracted.invoiceNo,
      invoiceDate: parseDate(extracted.invoiceDate),
      supplierGstin: extracted.supplierGstin,
      buyerGstin: extracted.buyerGstin,
      shipToGstin: extracted.shipToGstin,
      supplierState: extracted.supplierState,
      shipToState: inferShipToState(extracted),
      eWayBillNo: extracted.eWayBillNo,
      vehicleNo: extracted.vehicleNo,
      taxType: extracted.taxType,
      subTotal: num(extracted.subTotal),
      freight: num(extracted.freight),
      taxable: num(extracted.taxable),
      cgst: num(extracted.cgst),
      sgst: num(extracted.sgst),
      igst: num(extracted.igst),
      roundOff: num(extracted.roundOff),
      grandTotal: num(extracted.grandTotal),
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
      qty: num(l.qty),
      uom: l.uom,
      rate: num(l.rate),
      amount: num(l.amount),
    }));
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
router.post('/document-sets/:id/match', requireRole('STORE', 'BUYER', 'APPROVER'), async (req, res, next) => {
  try {
    await ensureSupplierPortalReady();
    const set = await DocumentSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Document set not found.' });

    const site = set.site;
    const ledgerId = set.context?.supplierLedgerId;
    if (!ledgerId) return res.status(400).json({ error: 'The supplier ledger has not been selected.' });

    const group = await groupForLedger(site, ledgerId);
    // Every ledger the supplier trades under, so an invoice from the Haryana
    // branch still finds a PO raised on the head office.
    const ledgerIds = group ? ledgerIdsForSite(group, site) : [ledgerId];

    const poLines = await openPoLines(site, { ledgerIds: ledgerIds.length ? ledgerIds : [ledgerId] });
    const itemIds = [...new Set(poLines.map((l) => l.ItemID))];
    const [items, hsn, alreadyPosted] = await Promise.all([
      getItems(site, itemIds),
      hsnForItems(site, itemIds),
      findPostedInvoice(site, { invoiceNo: set.extractedHeader?.invoiceNo, ledgerIds }),
    ]);

    const matched = set.extractedLines.map((line) => {
      const po = bestPoLineFor(line, poLines, items);
      if (!po) return { ...line, matchedPoTransactionId: null };
      const item = items.get(po.ItemID);
      return {
        ...line,
        matchedPoTransactionId: po.TransactionID,
        matchedPoTransactionDetailId: po.TransactionDetailID,
        matchedItemId: po.ItemID,
        matchedPoRate: po.PurchaseRate,
        poPendingQty: po.PendingQty,
        poQty: po.PurchaseOrderQuantity,
        poVoucherNo: po.PoVoucherNo,
        expectedHsn: hsn.get(po.ItemID)?.HSNCode ?? null,
        wtPerPacking: item?.WtPerPacking ?? null,
        unitPerPacking: item?.UnitPerPacking ?? null,
        widthMm: item?.SizeW ?? null,
        lengthMm: item?.SizeL ?? null,
        gsm: line.gsm ?? item?.GSM ?? null,
      };
    });

    const checks = runInvoiceChecks({
      header: set.extractedHeader,
      lines: matched,
      alreadyPosted,
      context: set.context,
    });

    set.extractedLines = matched;
    set.poCandidates = [...new Set(matched.map((l) => l.matchedPoTransactionId).filter(Boolean))];
    set.checks = checks;
    set.status = hasBlockingFailure(checks) ? 'NEEDS_REVIEW' : 'MATCHED';
    await set.save();

    return res.json({
      documentSet: set,
      checks,
      isBlocked: hasBlockingFailure(checks),
      warningsNeedingReason: warningsNeedingReason(checks),
    });
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
    if (req.body?.extractedLines) set.extractedLines = req.body.extractedLines;
    if (req.body?.context) set.context = { ...set.context, ...req.body.context };
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
 * Post: GRN + purchase invoice + PO line closure, in one transaction.
 *
 * A blocking check cannot be overridden by anyone. A warning needs a recorded
 * reason. Both rules are enforced here rather than in the client, because the
 * client is a tablet in a warehouse and the rule has to hold regardless.
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

    if (hasBlockingFailure(set.checks)) {
      return res.status(422).json({
        error: 'Blocking checks must be resolved before posting. These cannot be overridden.',
        checks: set.checks.filter((c) => !c.passed && c.severity === 'BLOCK'),
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

    const context = {
      ...set.context,
      ...(req.body?.context || {}),
      branchId: req.body?.context?.branchId ?? set.context?.branchId ?? 1,
      chargeLedgers: chargeLedgerIds,
    };

    const lines = set.extractedLines
      .filter((l) => l.matchedPoTransactionId)
      .map((l) => ({
        itemId: l.matchedItemId,
        itemGroupId: l.itemGroupId ?? null,
        poTransactionId: l.matchedPoTransactionId,
        poTransactionDetailId: l.matchedPoTransactionDetailId,
        poVoucherNo: l.poVoucherNo,
        poQty: l.poQty,
        poPendingQty: l.poPendingQty,
        qty: l.qty,
        stockQty: l.totalUnits ?? l.qty,
        rate: l.rate,
        amount: l.amount,
        purchaseUnit: l.uom,
        stockUnit: l.stockUnit ?? null,
        productHsnId: l.productHsnId ?? null,
        wtPerPacking: l.wtPerPacking,
        itemDescription: l.description,
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
    await set.save();

    await AuditLog.create({
      action: 'GRN_AND_PI_POSTED',
      entity: 'documentSet',
      entityId: String(set._id),
      site: set.site,
      actor: req.sp.actor,
      after: set.posted,
      reason: [...reasons.entries()].map(([code, reason]) => `${code}: ${reason}`).join('; ') || null,
      meta: { closedPoLines: result.closedLines },
    });

    return res.json({ documentSet: set, ...result });
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

/**
 * Best open PO line for an invoice line.
 *
 * Matched on the item first — a description that names an item CDC has on an
 * open PO from this supplier is almost always that item. Where several PO
 * lines carry the same item, the one whose rate agrees with the invoice wins,
 * then the oldest.
 */
function bestPoLineFor(line, poLines, items) {
  const description = normaliseName(line.description || '');
  if (!description) return null;

  const scored = poLines
    .filter((po) => po.PendingQty > 0)
    .map((po) => {
      const item = items.get(po.ItemID);
      const name = normaliseName(`${item?.ItemName || ''} ${po.ItemDescription || ''}`);
      const tokens = name.split(' ').filter((t) => t.length > 2);
      const hits = tokens.filter((t) => description.includes(t)).length;
      const coverage = tokens.length ? hits / tokens.length : 0;

      // Rate agreement is strong corroboration: an invoice priced at the PO
      // rate is almost certainly for that PO line.
      const rateAgrees = Number.isFinite(line.rate) && Number.isFinite(po.PurchaseRate)
        && Math.abs(line.rate - po.PurchaseRate) <= 0.01;

      return { po, score: coverage + (rateAgrees ? 0.5 : 0) };
    })
    .filter((s) => s.score >= 0.4)
    .sort((a, b) => b.score - a.score || new Date(a.po.PoDate) - new Date(b.po.PoDate));

  return scored[0]?.po || null;
}

function inferShipToState(extracted) {
  const gstin = extracted.shipToGstin || extracted.buyerGstin;
  const code = String(gstin ?? '').slice(0, 2);
  // 19 is West Bengal, 24 Gujarat — the two CDC ships to.
  if (code === '19') return 'West Bengal';
  if (code === '24') return 'Gujarat';
  return null;
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
