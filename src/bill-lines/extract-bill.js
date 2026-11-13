/**
 * One CDC Bills GRN bill: read its supplier invoice lines, find it in Indus,
 * and suggest which ERP line each supplier line is.
 *
 * The invoice is read by the same pipeline GRN Creator uses (turned upright,
 * close-ups, self-check, one retry), so a fix there is a fix here.
 *
 * A bill is DONE only when everything agrees: it linked to exactly one PI,
 * the lines add up, and every goods line has a confident suggestion. Anything
 * else is NEEDS_REVIEW with the reasons listed - the pilot's job is to count
 * those reasons, not to hide them.
 */

import { viewUrl } from '../lib/r2-storage.js';
import { readInvoice } from '../supplier-portal/services/extraction/invoice-pipeline.js';
import { invoiceProblems, toNumber } from '../supplier-portal/services/extraction/invoice-review.js';
import { findPostings, decideLink, piWithLines, grnLines, resolveGstin } from './erp-link.js';
import { suggestPiLines, totalsCheck, lineNumbers, normaliseInvoiceNo } from './line-match.js';
import { withUsage } from './usage.js';

export const EXTRACTOR_VERSION = 'bill-lines-1';

/** Below this, a suggestion is a guess a person should look at. */
const CONFIDENT = 0.85;

/** Fields read from PurchaseBills. Nothing else is fetched, nothing is written. */
export const BILL_PROJECTION = {
  set_type: 1, invoice_number: 1, invoice_date: 1, supplier_name: 1, supplier_gstin: 1,
  grn_voucher_number: 1, cdc_unit: 1, taxable_value: 1, is_cancelled_voucher: 1,
  'slots.supplier_invoice.pages.page_no': 1, 'slots.supplier_invoice.pages.r2_key': 1,
};

export function billSummary(bill) {
  const pages = [...(bill.slots?.supplier_invoice?.pages || [])]
    .filter((p) => p.r2_key)
    .sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0));
  return {
    invoiceNo: bill.invoice_number ?? null,
    invoiceDate: bill.invoice_date ?? null,
    supplierName: bill.supplier_name ?? null,
    supplierGstin: bill.supplier_gstin ?? null,
    piVoucherNo: bill.grn_voucher_number ?? null,
    unit: bill.cdc_unit ?? null,
    taxableValue: bill.taxable_value ?? null,
    pageKeys: pages.map((p) => p.r2_key),
  };
}

/**
 * The ERP side of a bill: which PI (or GRN) it is, and its lines. Kolkata is
 * tried first; Ahmedabad only when Kolkata finds nothing, since a bill's
 * "unit" is free text read off the invoice and cannot be trusted to say.
 *
 * `read` is this tool's own reading of the invoice. CDC Bills' header fields
 * are often misread on older bills - GSTINs a character out, invoice numbers
 * garbled - so when its values find nothing, the invoice number and GSTIN read
 * here are tried instead. The link records which were used (`via`).
 */
export async function linkBill(summary, read = null) {
  const attempts = [{ via: 'BILL_KEYS', gstin: summary.supplierGstin, invoiceNo: summary.invoiceNo }];
  if (read) attempts.push({ via: 'READ_KEYS', gstin: read.supplierGstin, invoiceNo: read.invoiceNo });

  // The best outcome over all attempts: a later NOT_FOUND must not hide an earlier AMBIGUOUS.
  const RANK = { LINKED: 3, GRN_ONLY: 2, AMBIGUOUS: 1, NOT_FOUND: 0 };
  let site = null;
  let link = null;
  search: for (const attempt of attempts) {
    for (const s of ['KOL', 'AHM']) {
      const resolved = await resolveGstin(s, attempt.gstin);
      const found = decideLink(await findPostings(s, {
        gstin: resolved.gstin, invoiceNo: attempt.invoiceNo, piVoucherNo: summary.piVoucherNo,
      }));
      found.via = attempt.via;
      found.gstinCorrected = resolved.corrected ? { read: resolved.read, ledger: resolved.gstin } : null;
      if (!link || RANK[found.status] > RANK[link.status]) { link = found; site = s; }
      if (found.status === 'LINKED') break search;
      if (found.status !== 'NOT_FOUND') break;
    }
  }
  if (link.status === 'NOT_FOUND') site = null;

  let erpLines = [];
  let piVoucherNo = null;
  if (link.status === 'LINKED') {
    const pi = await piWithLines(site, link.piTransactionId);
    erpLines = pi?.lines || [];
    piVoucherNo = pi?.voucherNo ?? null;
  } else if (link.status === 'GRN_ONLY') {
    erpLines = await grnLines(site, link.grnTransactionIds);
  }
  return { site, link: { ...link, piVoucherNo }, erpLines };
}

/**
 * @param {Object} bill      a PurchaseBills document, BILL_PROJECTION fields
 * @param {Object} provider  from getProvider()
 * @param {Object} [opts]    { linked } a linkBill() result already in hand
 * @returns the PurchaseBillLines document to save (not saved here)
 */
export async function processBill(bill, provider, { linked = null } = {}) {
  const started = Date.now();
  const summary = billSummary(bill);
  const doc = {
    billId: bill._id,
    extractorVersion: EXTRACTOR_VERSION,
    bill: summary,
    lines: [],
    reviewReasons: [],
  };

  try {
    let { site, link, erpLines } = linked || await linkBill(summary);
    doc.site = site;
    doc.link = { ...link, erpLines };

    if (!summary.pageKeys.length) throw new Error('The bill has no supplier invoice pages.');
    const pages = await Promise.all(summary.pageKeys.map(async (key, i) => ({ url: await viewUrl(key, 900), pageNo: i + 1 })));

    const { result: read, usage } = await withUsage(() => readInvoice(provider, {
      pages,
      hints: summary.supplierName ? { expectedSupplier: summary.supplierName } : {},
    }));
    doc.usage = usage;

    if (link.status !== 'LINKED') {
      ({ site, link, erpLines } = await linkBill(summary, read));
      doc.site = site;
      doc.link = { ...link, erpLines };
    }

    doc.extracted = {
      invoiceNo: read.invoiceNo, invoiceDate: read.invoiceDate, supplierName: read.supplierName,
      supplierGstin: read.supplierGstin, subTotal: read.subTotal, discount: read.discount ?? null,
      freight: read.freight, taxable: read.taxable, grandTotal: read.grandTotal, uncertain: read.uncertain || [],
    };

    const suggestions = suggestPiLines(read.lines || [], erpLines);
    doc.lines = (read.lines || []).map((l, i) => ({
      lineNo: l.lineNo, description: l.description, hsn: l.hsn, gsm: l.gsm, size: l.size,
      qty: l.qty, uom: l.uom, rate: l.rate, amount: l.amount,
      discountPct: l.discountPct ?? null, discountAmount: l.discountAmount ?? null,
      taxableValue: l.taxableValue ?? null, poRef: l.poRef ?? null,
      value: lineNumbers(l).value,
      kind: suggestions[i].kind,
      suggestion: suggestions[i].suggestion,
      candidates: suggestions[i].candidates,
      reason: suggestions[i].reason,
    }));

    const freight = toNumber(read.freight) || 0;
    const billGoods = toNumber(read.subTotal) ?? (toNumber(read.taxable) !== null ? toNumber(read.taxable) - freight : null);
    const piGross = erpLines.some((l) => l.gross !== null)
      ? Math.round(erpLines.reduce((s, l) => s + (l.gross || 0), 0) * 100) / 100
      : null;
    doc.checks = {
      totals: totalsCheck(read.lines || [], { billGoodsValue: billGoods, piGross }),
      invoiceNoAgrees: normaliseInvoiceNo(read.invoiceNo) === normaliseInvoiceNo(summary.invoiceNo),
      gstinAgrees: String(read.supplierGstin || '').toUpperCase() === String(summary.supplierGstin || '').toUpperCase(),
      readerProblems: invoiceProblems(read),
      review: read._review ?? null,
    };

    doc.reviewReasons = reviewReasons(doc);
    doc.status = doc.reviewReasons.length ? 'NEEDS_REVIEW' : 'DONE';
  } catch (err) {
    doc.status = 'FAILED';
    doc.error = err?.message || String(err);
  }
  doc.seconds = Math.round((Date.now() - started) / 100) / 10;
  return doc;
}

/**
 * Pair a saved bill's lines again, with no new reading and no AI cost - for
 * when the matching rules improve. Changes `doc` in place.
 */
export function rematch(doc) {
  const suggestions = suggestPiLines(doc.lines, doc.link?.erpLines || []);
  doc.lines = doc.lines.map((l, i) => ({
    ...l,
    kind: suggestions[i].kind,
    suggestion: suggestions[i].suggestion,
    candidates: suggestions[i].candidates,
    reason: suggestions[i].reason,
  }));
  doc.reviewReasons = reviewReasons(doc);
  doc.status = doc.reviewReasons.length ? 'NEEDS_REVIEW' : 'DONE';
  return doc;
}

/** Every reason this bill cannot be taken as it stands. */
export function reviewReasons(doc) {
  const out = [];
  if (doc.link?.status !== 'LINKED') out.push(`link ${doc.link?.status || 'missing'}`);
  else if (!doc.link.keysAgreed) out.push('linked by one key only');
  if (!doc.lines.length) out.push('no lines read');
  if (doc.checks?.readerProblems?.length) out.push(`reader found ${doc.checks.readerProblems.length} problem(s)`);
  const t = doc.checks?.totals;
  if (t?.bill && !t.bill.ok) out.push('lines do not add up to the bill');
  if (t?.pi && !t.pi.ok) out.push('lines do not add up to the PI');
  // CDC Bills' own reading is often the wrong one; it only matters when Indus cannot settle it.
  if (doc.checks && !doc.checks.invoiceNoAgrees && doc.link?.status !== 'LINKED') out.push('invoice number differs from CDC Bills');
  const goods = doc.lines.filter((l) => l.kind === 'GOODS');
  const unmatched = goods.filter((l) => !l.suggestion).length;
  const weak = goods.filter((l) => l.suggestion && l.suggestion.confidence < CONFIDENT).length;
  if (unmatched) out.push(`${unmatched} line(s) without a suggestion`);
  if (weak) out.push(`${weak} low-confidence suggestion(s)`);
  return out;
}
