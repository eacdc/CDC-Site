/**
 * Find the Indus GRN and purchase invoice a CDC Bills bill was posted as.
 *
 * Read only. CDC Bills stores the PI number it read off the GRN sheet in
 * `grn_voucher_number`, and that reading is sometimes wrong - two different
 * suppliers' bills both came back as PI04060_26_27 - so no single key is
 * trusted. Three are tried, each scoped to the supplier's GSTIN:
 *
 *   GRN_INVOICE   GRN header DeliveryNoteNo = the supplier's invoice number
 *   PI_VOUCHER    PI VoucherNo = the number CDC Bills saved
 *   PI_INVOICE    PI InvoiceNo = the supplier's invoice number
 *
 * GRN_INVOICE reaches PIs through the PI lines' ParentTransactionID. In a
 * 30-bill sample (Nov 2026) the first found 29 bills and the second 28, and
 * every bill was found by at least one, so the link is the set of PIs the keys
 * found, and the keys that found it are kept as the evidence.
 *
 * Invoice numbers are compared with spaces removed on both sides, which
 * scans the GRN and PI headers rather than seeking. That is fine for a batch
 * run; a per-upload path should add a computed, indexed column instead.
 */

import { query, assertSite } from '../supplier-portal/db/mssql.js';
import { COMPANY_ID, VOUCHER } from '../supplier-portal/config/constants.js';
import { cleanGstin, nearestGstins } from '../supplier-portal/lib/gstin.js';
import { normaliseInvoiceNo } from './line-match.js';

const NO_SPACES = (col) => `REPLACE(UPPER(LTRIM(RTRIM(${col}))), ' ', '')`;

/**
 * The voucher number CDC Bills' GRN-sheet prompt gives as its example
 * (lib/bill-vision.js). The model copied it onto 3,554 of 3,922 GRN bills
 * (Nov 2026), so on a bill it means "not read", not a voucher.
 */
export const PROMPT_EXAMPLE_PI = 'PI00903_26_27';

const gstinCache = new Map();

/** Every supplier GSTIN on the site's ledgers, loaded once per process. */
async function supplierGstins(site) {
  if (!gstinCache.has(site)) {
    gstinCache.set(site, query(site, `
      SELECT DISTINCT UPPER(LTRIM(RTRIM(GSTNo))) AS GSTNo FROM LedgerMaster
      WHERE CompanyID = @companyId AND LedgerType IN ('Sundry Creditors', 'Suppliers')
        AND ISNULL(GSTNo, '') <> ''
    `, { companyId: COMPANY_ID }).then((rows) => rows.map((r) => r.GSTNo)));
    gstinCache.get(site).catch(() => gstinCache.delete(site));
  }
  return gstinCache.get(site);
}

/**
 * The supplier ledger GSTIN a read GSTIN stands for: itself when a ledger
 * carries it, otherwise the one ledger GSTIN within two characters. CDC Bills
 * read Krishna Vanijya's 19AAACK5777H1Z5 as ...H1ZS and Sudarshan's
 * 19AAHCS1241F1ZJ as 19AABCS2141F1ZJ. A tie is refused, not guessed.
 */
export async function resolveGstin(site, read) {
  const g = cleanGstin(read);
  if (!g) return { gstin: null, corrected: false };
  const known = await supplierGstins(site);
  if (known.includes(g)) return { gstin: g, corrected: false };
  const near = nearestGstins(g, known, 2);
  if (near.gstins.length === 1) return { gstin: near.gstins[0], corrected: true, read: g, distance: near.distance };
  return { gstin: g, corrected: false, unknown: true };
}

/**
 * @param {'KOL'|'AHM'} site
 * @param {{ gstin: string|null, invoiceNo: string|null, piVoucherNo: string|null }} keys
 */
export async function findPostings(site, { gstin, invoiceNo, piVoucherNo }) {
  assertSite(site);
  const inv = normaliseInvoiceNo(invoiceNo);
  const pi = normaliseInvoiceNo(piVoucherNo) === PROMPT_EXAMPLE_PI ? null : normaliseInvoiceNo(piVoucherNo);
  const gst = gstin ? String(gstin).trim().toUpperCase() : null;

  const rows = await query(site, `
    ;WITH Sup AS (
      SELECT LedgerID FROM LedgerMaster
      WHERE CompanyID = @companyId AND @gst IS NOT NULL AND UPPER(LTRIM(RTRIM(GSTNo))) = @gst
    ),
    Grn AS (
      SELECT ITM.TransactionID
      FROM ItemTransactionMain ITM
      WHERE ITM.CompanyID = @companyId AND ITM.VoucherID = @grn
        AND ISNULL(ITM.IsDeletedTransaction,0) = 0
        AND @inv IS NOT NULL AND ${NO_SPACES('ITM.DeliveryNoteNo')} = @inv
        AND ITM.LedgerID IN (SELECT LedgerID FROM Sup)
    ),
    Pi AS (
      SELECT P.TransactionID, 'PI_VOUCHER' AS KeyName
      FROM ItemPurchaseInvoiceMain P
      WHERE P.CompanyID = @companyId AND ISNULL(P.IsDeletedTransaction,0) = 0
        AND @pi IS NOT NULL AND UPPER(P.VoucherNo) = @pi
        AND P.LedgerID IN (SELECT LedgerID FROM Sup)
      UNION ALL
      SELECT P.TransactionID, 'PI_INVOICE'
      FROM ItemPurchaseInvoiceMain P
      WHERE P.CompanyID = @companyId AND ISNULL(P.IsDeletedTransaction,0) = 0
        AND @inv IS NOT NULL AND ${NO_SPACES('P.InvoiceNo')} = @inv
        AND P.LedgerID IN (SELECT LedgerID FROM Sup)
      UNION ALL
      SELECT DISTINCT D.TransactionID, 'GRN_INVOICE'
      FROM ItemPurchaseInvoiceDetail D
      JOIN ItemPurchaseInvoiceMain P ON P.TransactionID = D.TransactionID AND P.CompanyID = D.CompanyID
      WHERE D.CompanyID = @companyId AND ISNULL(D.IsDeletedTransaction,0) = 0 AND ISNULL(D.IsDeleted,0) = 0
        AND ISNULL(P.IsDeletedTransaction,0) = 0
        AND D.ParentTransactionID IN (SELECT TransactionID FROM Grn)
    )
    SELECT 'GRN' AS Kind, TransactionID, 'GRN_INVOICE' AS KeyName FROM Grn
    UNION ALL
    SELECT 'PI', TransactionID, KeyName FROM Pi
  `, { companyId: COMPANY_ID, grn: VOUCHER.GRN, gst, inv, pi });

  const grnIds = [...new Set(rows.filter((r) => r.Kind === 'GRN').map((r) => Number(r.TransactionID)))];
  const piKeys = new Map();
  for (const r of rows.filter((x) => x.Kind === 'PI')) {
    const id = Number(r.TransactionID);
    if (!piKeys.has(id)) piKeys.set(id, new Set());
    piKeys.get(id).add(r.KeyName);
  }
  return { grnIds, piKeys };
}

/**
 * Decide the link from what the keys found.
 *
 *   LINKED      exactly one PI
 *   AMBIGUOUS   two or more PIs - the keys disagree, a person picks
 *   GRN_ONLY    a GRN but no PI yet: the lines can still be paired on quantity
 *   NOT_FOUND   nothing
 */
export function decideLink({ grnIds = [], piKeys = new Map() }) {
  const piIds = [...piKeys.keys()];
  if (piIds.length === 1) {
    const keys = [...piKeys.get(piIds[0])].sort();
    return { status: 'LINKED', piTransactionId: piIds[0], keys, keysAgreed: keys.length > 1, grnTransactionIds: grnIds };
  }
  if (piIds.length > 1) {
    return {
      status: 'AMBIGUOUS',
      piTransactionId: null,
      candidates: piIds.map((id) => ({ piTransactionId: id, keys: [...piKeys.get(id)].sort() })),
      grnTransactionIds: grnIds,
    };
  }
  if (grnIds.length) return { status: 'GRN_ONLY', piTransactionId: null, keys: ['GRN_INVOICE'], grnTransactionIds: grnIds };
  return { status: 'NOT_FOUND', piTransactionId: null, keys: [], grnTransactionIds: [] };
}

/** One PI: its header and item lines, with the item master names. */
export async function piWithLines(site, piTransactionId) {
  assertSite(site);
  const rows = await query(site, `
    SELECT P.VoucherNo, P.VoucherDate, P.InvoiceNo, P.LedgerID, LM.LedgerName,
           D.TransactionDetailID, D.ParentTransactionID, D.PurchaseTransactionID, D.ItemID,
           IM.ItemGroupID, IM.ItemCode, IM.ItemName, IM.StockUnit,
           CAST(D.ReceiptQuantity AS DECIMAL(18,3)) AS ReceiptQuantity, D.PurchaseUnit,
           CAST(D.ChallanQuantity AS DECIMAL(18,3)) AS ChallanQuantity,
           CAST(D.ReceiptRate AS DECIMAL(18,4)) AS ReceiptRate,
           CAST(D.GrossAmount AS DECIMAL(18,2)) AS GrossAmount,
           CAST(D.TaxableAmount AS DECIMAL(18,2)) AS TaxableAmount
    FROM ItemPurchaseInvoiceMain P
    JOIN ItemPurchaseInvoiceDetail D ON D.TransactionID = P.TransactionID AND D.CompanyID = P.CompanyID
    JOIN ItemMaster IM ON IM.ItemID = D.ItemID AND IM.CompanyID = D.CompanyID
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = P.LedgerID AND LM.CompanyID = P.CompanyID
    WHERE P.CompanyID = @companyId AND P.TransactionID = @id
      AND ISNULL(D.IsDeletedTransaction,0) = 0 AND ISNULL(D.IsDeleted,0) = 0
    ORDER BY D.TransID, D.TransactionDetailID
  `, { companyId: COMPANY_ID, id: Number(piTransactionId) });
  if (!rows.length) return null;

  const h = rows[0];
  return {
    piTransactionId: Number(piTransactionId),
    voucherNo: h.VoucherNo,
    voucherDate: h.VoucherDate,
    invoiceNo: h.InvoiceNo,
    ledgerId: h.LedgerID,
    ledgerName: h.LedgerName,
    lines: rows.map((r) => ({
      detailId: Number(r.TransactionDetailID),
      grnTransactionId: Number(r.ParentTransactionID),
      poTransactionId: Number(r.PurchaseTransactionID),
      itemId: Number(r.ItemID),
      itemGroupId: Number(r.ItemGroupID),
      itemCode: r.ItemCode,
      itemName: r.ItemName,
      qty: num(r.ReceiptQuantity),
      unit: (r.PurchaseUnit || '').trim() || null,
      challanQty: num(r.ChallanQuantity),
      stockUnit: r.StockUnit,
      rate: num(r.ReceiptRate),
      gross: num(r.GrossAmount),
      taxable: num(r.TaxableAmount),
    })),
  };
}

/**
 * GRN lines, for a bill whose PI has not been posted. No rate lives on an
 * ERP GRN line (GrsRate is NULL), so these pair on quantity only.
 */
export async function grnLines(site, grnTransactionIds = []) {
  assertSite(site);
  const ids = grnTransactionIds.map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const rows = await query(site, `
    SELECT ITD.TransactionDetailID, ITD.TransactionID, ITD.ItemID, IM.ItemGroupID, IM.ItemCode, IM.ItemName,
           CAST(ITD.ChallanWeight AS DECIMAL(18,3)) AS ChallanWeight,
           CAST(ITD.ReceiptQuantity AS DECIMAL(18,3)) AS ReceiptQuantity, IM.StockUnit
    FROM ItemTransactionDetail ITD
    JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId AND ITD.TransactionID IN (${ids.join(',')})
      AND ISNULL(ITD.IsDeletedTransaction,0) = 0 AND ISNULL(ITD.IsCancelled,0) = 0
    ORDER BY ITD.TransactionID, ITD.TransID
  `, { companyId: COMPANY_ID });
  return rows.map((r) => ({
    detailId: Number(r.TransactionDetailID),
    grnTransactionId: Number(r.TransactionID),
    itemId: Number(r.ItemID),
    itemGroupId: Number(r.ItemGroupID),
    itemCode: r.ItemCode,
    itemName: r.ItemName,
    qty: num(r.ChallanWeight),
    challanQty: num(r.ReceiptQuantity),
    stockUnit: r.StockUnit,
    rate: null,
    gross: null,
  }));
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
