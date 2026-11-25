/**
 * Create PO: the reads.
 *
 * Backs the Create PO tool (eacdc/Create-PO). Everything comes from the ERP:
 * the tool does not use the supplier portal's prices or supplier groups
 * (Manu, 25 Nov 2026: "no connection needed for now, we will re-establish it
 * when needed"). A line's price is checked against the last rate paid to the
 * same supplier for the item (LAST_PAID_CAP_DAYS), and the buyer sees, before
 * ordering, the free stock of the same or a similar item from
 * GetItemDetailsWithBufferTotal_Manu_v4, on the floor and on open POs kept apart.
 *
 * Everything here reads; po-save.js writes.
 */

import { query, assertSite, sql } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER } from '../config/constants.js';
import { getItem, getItems, hsnForItems, lastPaidRates, searchItems } from './erp-items.js';
import { supplierLedgers } from './erp-ledgers.js';
import { normaliseGstin } from './supplier-groups.js';
import { PAPER_GROUP_IDS } from './paper/band.js';

/**
 * Where goods are delivered. The text is what the ERP's own POs carry
 * (Kolkata: Panchla on 4,233 POs a year, Tangra on 1,738). Ahmedabad's is the
 * same address with the stored literal "rn" line breaks taken out.
 */
export const DELIVERY_ADDRESSES = {
  KOL: [
    { id: 'panchla', label: 'Panchla (M.J. Industrial Park)',
      address: 'M.J. Industrial Park, Nh-6 Bombay Road Mouza - Satgharia, J.L.No.27, P.O. - Bikihakola, P.S.- Panchla, Dist- Howrah, Pin - 711322' },
    { id: 'tangra', label: 'Tangra',
      address: 'Tangra Industrial Estate - II, 45, Radhanath Chowdhury Road, Kolkata - 700015, India' },
  ],
  AHM: [
    { id: 'dhanvada', label: 'Ahmedabad (Super Industrial Park)',
      address: 'CDC Printers Pvt. Ltd., Super Industrial Park, Plot No. : 46, 47, 52, 53, Village : Dhanvada Taluka : Bavla, Ahmedabad Pin : 382220' },
  ],
};

/** A fixed list instead of the ERP's free text, which holds about 20 spellings of the same terms. */
export const PAYMENT_TERMS = ['Advance', 'Immediate', 'Payment in 30 Days', 'Payment in 45 Days',
  'Payment in 60 Days', 'Payment in 75 Days', 'Payment in 90 Days', 'Payment in 120 Days'];

/** What the ERP's PO screen starts with. Every PO this year carries COM and INR. */
export const DEFAULT_PAYMENT_TERMS = 'Payment in 30 Days';
export const PURCHASE_DIVISION = 'COM';
export const CURRENCY_CODE = 'INR';

/**
 * The ERP's free-text terms ("Payment in45Days", "IMMIDIATE", "90 DAYS",
 * "Payment in 90 Days\t") as one of PAYMENT_TERMS, or null.
 */
export function normalisePaymentTerms(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/advance/.test(t)) return 'Advance';
  if (/imm?[ie]d/.test(t)) return 'Immediate';
  const m = t.match(/(\d+)\s*day/);
  if (!m) return null;
  const label = `Payment in ${Number(m[1])} Days`;
  return PAYMENT_TERMS.includes(label) ? label : null;
}

export const TRANSPORT_MODES = ['By Road', 'By Hand', 'Courier', 'By Air'];

/** The standing terms printed on every PO, as on the ERP's own printout. */
export const PO_TERMS = [
  'Quantity - We reserve the right to return excess material beyond the given tolerance.',
  'Quality - As per the company\'s specification, solely and completely as per the competence of the supplier. Quality inspection will be at our site.',
  'Rejection - All rejections shall be returned at the supplier\'s cost.',
  'Invoicing - The invoice shall carry the reference and details given in this PO, accompanied by a packing list and quality certificate.',
  'Confidentiality - The supplier shall keep specifications, drawings and samples confidential and not disclose them to any third party without prior written permission.',
];

// ── reference ───────────────────────────────────────────────────────────────

/** Dropdown lists, the company block for the printout and the next PO number, for one plant. */
export async function poReference(site, { today = new Date() } = {}) {
  assertSite(site);
  const fyYear = financialYearStart(today).getUTCFullYear();
  const [rows, last] = await Promise.all([
    query(site, `
      SELECT TOP 1 CompanyName, Address, City, State, Pincode, GSTIN, CINNo, PAN, MobileNO, Email
      FROM CompanyMaster
      WHERE ISNULL(IsDeletedTransaction,0) = 0
    `),
    // Deleted POs count: the ERP never hands their numbers out again.
    query(site, `
      SELECT MAX(MaxVoucherNo) AS LastNo
      FROM ItemTransactionMain
      WHERE CompanyID = @companyId AND VoucherID = @po AND FYear = @fy
    `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, fy: `${fyYear}-${fyYear + 1}` }),
  ]);
  const c = rows[0] || {};
  return {
    // A preview, as the ERP shows it. The number is fixed only when the PO is saved.
    nextPoNo: poNumber((Number(last[0]?.LastNo) || 0) + 1, fyYear),
    division: PURCHASE_DIVISION,
    currency: CURRENCY_CODE,
    defaultPaymentTerms: DEFAULT_PAYMENT_TERMS,
    deliveryAddresses: DELIVERY_ADDRESSES[site],
    company: {
      name: c.CompanyName || 'CDC Printers Pvt. Ltd.',
      lines: [c.Address, [c.MobileNO && `Phone ${c.MobileNO}`, c.Email].filter(Boolean).join(' · ')].filter(Boolean),
      state: c.State || null,
      gstin: c.GSTIN || null,
      cin: c.CINNo || null,
      pan: c.PAN || null,
    },
    paymentTerms: PAYMENT_TERMS,
    transportModes: TRANSPORT_MODES,
    terms: PO_TERMS,
  };
}

/** 3999 in the year starting April 2026 -> "PO03999_26_27", the ERP's own format. */
export function poNumber(seq, fyStartYear) {
  const yy = (y) => String(y % 100).padStart(2, '0');
  return `PO${String(seq).padStart(5, '0')}_${yy(fyStartYear)}_${yy(fyStartYear + 1)}`;
}

// ── pending requisitions ──────────────────────────────────────────────────────

/**
 * Purchase requisition lines of this financial year that no PO has picked up.
 *
 * Stores raise indents per job, the buyer groups them into a PREQ, and the
 * PREQ becomes a PO (Kolkata job paper; Ahmedabad raises none). A PO line
 * points back with `RequisitionTransactionID`. A line counts as pending until
 * any PO line for the same requisition and item exists, as on the ERP's own
 * Pending Requisitions screen (about 650 lines in Nov 2026). Subtracting
 * partial quantities instead tripled the list: POs ordered under a substitute
 * item, or in kg without sheets, never "complete" a requisition line.
 *
 * A PREQ line carries no client, so the client is the first job's, from the
 * job number in RefJobCardContentNo.
 */
export async function pendingRequisitions(site, { today = new Date() } = {}) {
  assertSite(site);
  const params = {
    companyId: COMPANY_ID, preq: VOUCHER.PURCHASE_REQUISITION, po: VOUCHER.PURCHASE_ORDER,
    fyStart: { type: sql.Date, value: financialYearStart(today) },
  };
  // Three plain queries joined here: as one statement SQL Server planned the
  // job lookup per row and took 7 s; apart they take about 1.5 s together.
  const [reqs, ordered, jobs] = await Promise.all([
    query(site, `
      SELECT ITM.TransactionID, ITM.VoucherNo, ITM.VoucherDate, ITD.TransID, ITD.ItemID,
             ITD.RequiredQuantity, ITD.StockUnit, ITD.RefJobCardContentNo, ITD.ExpectedDeliveryDate,
             IM.ItemCode, IM.ItemName, G.ItemGroupName, U.UserName AS CreatedByName
      FROM ItemTransactionMain ITM
      JOIN ItemTransactionDetail ITD
        ON ITD.TransactionID = ITM.TransactionID AND ITD.CompanyID = ITM.CompanyID
      JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITM.CompanyID
      LEFT JOIN ItemGroupMaster G ON G.ItemGroupID = IM.ItemGroupID AND G.CompanyID = IM.CompanyID
      LEFT JOIN UserMaster U ON U.UserID = ITM.CreatedBy
      WHERE ITM.CompanyID = @companyId
        AND ITM.VoucherID = @preq
        AND ITM.VoucherDate >= @fyStart
        AND ISNULL(ITM.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.IsCancelled,0) = 0
        AND ISNULL(ITD.IsCompleted,0) = 0
        AND ITD.RequiredQuantity > 0
    `, params),
    query(site, `
      SELECT DISTINCT ITD.RequisitionTransactionID, ITD.ItemID
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.VoucherID = @po
       AND ISNULL(ITM.IsDeletedTransaction,0) = 0
       AND ITM.VoucherDate >= @fyStart
      WHERE ITD.CompanyID = @companyId
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.RequisitionTransactionID,0) > 0
    `, params),
    query(site, `
      SELECT J.JobBookingNo, J.LedgerID, ISNULL(LM.LedgerName, J.ClientName) AS ClientName
      FROM JobBookingJobCard J
      LEFT JOIN LedgerMaster LM ON LM.LedgerID = J.LedgerID AND LM.CompanyID = J.CompanyID
      WHERE J.CompanyID = @companyId
        AND J.JobBookingDate >= DATEADD(MONTH, -6, @fyStart)
    `, params),
  ]);

  const done = new Set(ordered.map((o) => `${o.RequisitionTransactionID}:${o.ItemID}`));
  const jobByNo = new Map(jobs.map((j) => [String(j.JobBookingNo).trim().toUpperCase(), j]));

  return reqs
    .filter((r) => !done.has(`${r.TransactionID}:${r.ItemID}`))
    .sort((a, b) => (new Date(b.VoucherDate) - new Date(a.VoucherDate))
      || (Number(b.TransactionID) - Number(a.TransactionID)) || (a.TransID - b.TransID))
    .map((r) => {
      const job = jobByNo.get(firstJobNo(r.RefJobCardContentNo));
      return {
        reqLineId: `${r.TransactionID}:${r.TransID}`,
        requisitionTransactionId: Number(r.TransactionID),
        reqNo: r.VoucherNo,
        reqDate: r.VoucherDate,
        itemId: Number(r.ItemID),
        itemCode: r.ItemCode,
        itemName: r.ItemName,
        groupName: r.ItemGroupName,
        jobRef: r.RefJobCardContentNo,
        clientId: job?.LedgerID != null ? Number(job.LedgerID) : null,
        clientName: job?.ClientName || null,
        reqQty: r.RequiredQuantity,
        pendingQty: r.RequiredQuantity,
        unit: r.StockUnit,
        // The date stores asked for; the ERP's PO screen starts the line with it.
        expectedDate: r.ExpectedDeliveryDate || null,
        createdBy: r.CreatedByName || null,
      };
    });
}

/** "J09030_26_27[1_1],J09031_26_27[1_1]" -> "J09030_26_27". */
export function firstJobNo(ref) {
  const m = String(ref || '').match(/[A-Z]\d+_\d+_\d+/i);
  return m ? m[0].toUpperCase() : null;
}

/** 1 April of the financial year `date` falls in. */
export function financialYearStart(date = new Date()) {
  const d = new Date(date);
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1));
}

// ── suppliers and items ─────────────────────────────────────────────────────

function toSupplier(ledger) {
  return {
    ledgerId: Number(ledger.LedgerID),
    name: ledger.LedgerName,
    gstin: normaliseGstin(ledger.GSTNo),
    state: ledger.State || null,
    city: ledger.City || null,
  };
}

/**
 * The supplier dropdown: every supplier ordered from since the start of last
 * financial year (about 150 in Kolkata), as the ERP lists them. Each carries
 * the payment terms of its last PO, which the screen starts with.
 */
export async function poSuppliers(site, { today = new Date() } = {}) {
  assertSite(site);
  const since = financialYearStart(today);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const [ledgers, lastPos] = await Promise.all([
    supplierLedgers(site),
    query(site, `
      WITH P AS (
        SELECT ITM.LedgerID, ITM.TermsOfPayment, ITM.VoucherDate,
               ROW_NUMBER() OVER (PARTITION BY ITM.LedgerID ORDER BY ITM.VoucherDate DESC, ITM.TransactionID DESC) AS rn
        FROM ItemTransactionMain ITM
        WHERE ITM.CompanyID = @companyId
          AND ITM.VoucherID = @po
          AND ITM.VoucherDate >= @since
          AND ISNULL(ITM.IsDeletedTransaction,0) = 0
      )
      SELECT LedgerID, TermsOfPayment, VoucherDate FROM P WHERE rn = 1
    `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, since: { type: sql.Date, value: since } }),
  ]);
  const lastPo = new Map(lastPos.map((r) => [Number(r.LedgerID), r]));
  return ledgers
    .filter((l) => lastPo.has(Number(l.LedgerID)))
    .map((l) => {
      const po = lastPo.get(Number(l.LedgerID));
      return {
        ...toSupplier(l),
        lastPoDate: po.VoucherDate || null,
        paymentTerms: normalisePaymentTerms(po.TermsOfPayment),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Items for the "Add item" search. Without search text: those bought - from
 * `supplierLedgerId` when given - within LAST_PAID_CAP_DAYS. With text: also
 * any active ERP item that matches, since an item never bought can be
 * ordered too. Bought ones come first, each with the last rate paid to that
 * supplier when one was given.
 */
export async function poItems(site, { q = '', supplierLedgerId = null, limit = 100 } = {}) {
  assertSite(site);
  const term = String(q || '').trim();
  const wanted = supplierLedgerId != null ? Number(supplierLedgerId) : null;
  const [bought, found] = await Promise.all([
    LAST_PAID_CAP_DAYS > 0 ? query(site, `
      WITH L AS (
        SELECT ITD.ItemID, ITD.PurchaseRate, ITD.PurchaseUnit,
               ROW_NUMBER() OVER (PARTITION BY ITD.ItemID ORDER BY ITM.VoucherDate DESC, ITD.TransactionDetailID DESC) AS rn
        FROM ItemTransactionDetail ITD
        JOIN ItemTransactionMain ITM ON ITM.TransactionID = ITD.TransactionID AND ITM.VoucherID = @po
        JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
        WHERE ITD.CompanyID = @companyId AND ITD.PurchaseRate > 0
          AND ITM.VoucherDate >= DATEADD(DAY, -@days, GETDATE())
          AND ISNULL(ITM.IsDeletedTransaction,0) = 0
          AND ISNULL(ITD.IsDeletedTransaction,0) = 0
          AND ISNULL(ITD.IsCancelled,0) = 0
          ${wanted != null ? 'AND ITM.LedgerID = @ledgerId' : ''}
          ${term ? 'AND (IM.ItemName LIKE @like OR IM.ItemCode LIKE @like)' : ''}
      )
      SELECT TOP 300 ItemID, PurchaseRate, PurchaseUnit FROM L WHERE rn = 1
    `, {
      po: VOUCHER.PURCHASE_ORDER,
      companyId: COMPANY_ID,
      days: { type: sql.Int, value: LAST_PAID_CAP_DAYS },
      ledgerId: { type: sql.BigInt, value: wanted },
      like: `%${term}%`,
    }) : [],
    term ? searchItems(site, term, { limit: 200 }) : [],
  ]);

  const lastPaid = new Map(bought.map((r) => [Number(r.ItemID), r]));
  const ids = [...new Set([...lastPaid.keys(), ...found.map((r) => Number(r.ItemID))])];
  if (!ids.length) return [];

  const [items, hsn] = await Promise.all([getItems(site, ids), hsnForItems(site, ids)]);
  const out = [];
  for (const id of ids) {
    const row = items.get(id) || items.get(String(id));
    if (!row) continue;
    const paid = lastPaid.get(id);
    out.push({
      ...toPoItem(row, hsn.get(row.ItemID) || hsn.get(String(row.ItemID))),
      bought: Boolean(paid),
      // From this supplier; only when a supplier was given.
      lastPaidRate: paid && wanted != null
        ? { rate: Math.round(Number(paid.PurchaseRate) * 10000) / 10000, unit: String(paid.PurchaseUnit || '').trim() }
        : null,
    });
  }
  return out
    .sort((a, b) => (Number(b.bought) - Number(a.bought)) || a.itemName.localeCompare(b.itemName))
    .slice(0, limit);
}

// ── one line: item, prices, last paid, stock ────────────────────────────────

/** The item as the PO screen needs it: units, sizes, pack, HSN and GST %. */
export function toPoItem(row, hsn) {
  const purchaseUnit = String(row.PurchaseUnit || '').trim() || String(row.StockUnit || '').trim();
  return {
    itemId: Number(row.ItemID),
    itemCode: row.ItemCode,
    itemName: row.ItemName,
    groupId: Number(row.ItemGroupID),
    groupName: row.ItemGroupName || null,
    stockUnit: String(row.StockUnit || '').trim(),
    purchaseUnit,
    gsm: numberOrNull(row.GSM),
    sizeW: numberOrNull(row.SizeW),
    sizeL: numberOrNull(row.SizeL),
    qtyPerPack: numberOrNull(row.UnitPerPacking) || null,
    hsnCode: hsn?.HSNCode || null,
    hsnName: hsn?.ProductHSNName || null,
    gstPct: hsn ? Number(hsn.GSTTaxPercentage) || 0 : null,
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

/**
 * Everything one PO line shows: the item, the last rate paid to each
 * supplier for it, the last price paid to anyone, the item master's rate and
 * the buffer stock.
 */
export async function itemContext(site, itemId, { clientId = null } = {}) {
  assertSite(site);
  const id = Number(itemId);
  const row = await getItem(site, id);
  if (!row) return null;

  const [hsn, paid, master, bySupplier] = await Promise.all([
    hsnForItems(site, [id]),
    lastPaidRates(site, [id]),
    // The ERP's PO screen starts the rate here. Few items have it updated
    // (62 of 2,442 bought this year), so it is shown, never trusted as a price.
    query(site, `
      SELECT PurchaseRate FROM ItemMaster WHERE ItemID = @itemId AND CompanyID = @companyId
    `, { itemId: { type: sql.BigInt, value: id }, companyId: COMPANY_ID }),
    supplierLastPaid(site, id),
  ]);
  const item = toPoItem(row, hsn.get(row.ItemID) || hsn.get(String(row.ItemID)));
  const last = paid.get(row.ItemID) || paid.get(String(row.ItemID)) || null;
  const masterRate = Number(master[0]?.PurchaseRate) > 0 ? Number(master[0].PurchaseRate) : null;

  return {
    item,
    masterRate: masterRate != null ? { rate: masterRate, unit: item.purchaseUnit } : null,
    // The most a line may be ordered at from each supplier (LAST_PAID_CAP_DAYS).
    lastPaidBySupplier: bySupplier,
    lastPaid: last ? {
      rate: last.rate, unit: last.uom, supplierName: last.supplierName, poNo: last.voucherNo, poDate: last.date,
    } : null,
    stock: PAPER_GROUP_IDS.includes(item.groupId) ? await bufferStock(site, row, { clientId }) : [],
  };
}

/**
 * A line may be ordered at or below the last rate paid to the same supplier
 * for the item within this many days; above it is a fix the buyer can
 * ignore. An item not bought from the supplier in that time can go at any
 * rate (Manu, 23 and 25 Nov 2026).
 */
export const LAST_PAID_CAP_DAYS = 365;

/**
 * The last rate paid to each supplier for one item, within
 * LAST_PAID_CAP_DAYS: the most a line from that supplier may be ordered at.
 *
 * @returns {Promise<Array<{ledgerId, supplierName, rate, unit, poNo, poDate}>>}
 */
export async function supplierLastPaid(site, itemId, { days = LAST_PAID_CAP_DAYS } = {}) {
  assertSite(site);
  if (!(days > 0)) return [];
  const rows = await query(site, `
    WITH L AS (
      SELECT ITM.LedgerID, ITD.PurchaseRate, ITD.PurchaseUnit, ITM.VoucherNo, ITM.VoucherDate,
             ROW_NUMBER() OVER (PARTITION BY ITM.LedgerID ORDER BY ITM.VoucherDate DESC, ITD.TransactionDetailID DESC) AS rn
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM ON ITM.TransactionID = ITD.TransactionID AND ITM.VoucherID = @po
      WHERE ITD.ItemID = @itemId AND ITD.CompanyID = @companyId AND ITD.PurchaseRate > 0
        AND ITM.VoucherDate >= DATEADD(DAY, -@days, GETDATE())
        AND ISNULL(ITM.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.IsDeletedTransaction,0) = 0
        AND ISNULL(ITD.IsCancelled,0) = 0
    )
    SELECT L.LedgerID, LM.LedgerName, L.PurchaseRate, L.PurchaseUnit, L.VoucherNo, L.VoucherDate
    FROM L
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = L.LedgerID AND LM.CompanyID = @companyId
    WHERE L.rn = 1
  `, {
    itemId: { type: sql.BigInt, value: Number(itemId) },
    companyId: COMPANY_ID,
    po: VOUCHER.PURCHASE_ORDER,
    days: { type: sql.Int, value: days },
  });
  return rows.map((r) => ({
    ledgerId: Number(r.LedgerID),
    supplierName: r.LedgerName || null,
    // PurchaseRate is a `real`: 16.32 comes back as 16.31999969482422.
    rate: Math.round(Number(r.PurchaseRate) * 10000) / 10000,
    unit: String(r.PurchaseUnit || '').trim(),
    poNo: r.VoucherNo,
    poDate: r.VoucherDate,
  }));
}

/**
 * Free stock of this or a similar paper item, from the buffer proc, as the
 * page wants it: one row per item and client tag on the floor, one row per
 * open PO on order.
 */
export async function bufferStock(site, row, { clientId = null } = {}) {
  assertSite(site);
  const rows = await query(site, `
    EXEC dbo.GetItemDetailsWithBufferTotal_Manu_v4
      @Quality = @quality, @GSM = @gsm, @SizeW = @sizeW, @SizeL = @sizeL,
      @CompanyID = @companyId, @ItemID = @itemId, @ClientID = @clientId
  `, {
    quality: { type: sql.NVarChar(255), value: String(row.Quality || '').trim() },
    gsm: { type: sql.Int, value: Math.round(Number(row.GSM) || 0) },
    sizeW: { type: sql.Float, value: Number(row.SizeW) || 0 },
    sizeL: { type: sql.Float, value: Number(row.SizeL) || 0 },
    companyId: COMPANY_ID,
    itemId: { type: sql.BigInt, value: Number(row.ItemID) },
    clientId: { type: sql.BigInt, value: clientId != null && clientId !== '' ? Number(clientId) : null },
  });
  return rows.map(toStockRow);
}

export function toStockRow(r) {
  return {
    section: r.Section,
    stockType: r.StockType,
    matchType: r.MatchType,
    itemId: Number(r.ItemID),
    itemName: r.ItemName,
    gsmDiff: r.GSMDiff,
    sizeWDiff: r.SizeWDiff,
    sizeLDiff: r.SizeLDiff,
    stockKg: r.StockKG,
    bookedKg: r.BookedKG,
    freeKg: r.FreeKG,
    clientTag: r.ClientTag,
    clientTagName: r.ClientTagName || null,
    refNo: r.RefNo || null,
    poDate: r.PODate || null,
    supplierName: r.SupplierName || null,
    expectedDeliveryDate: r.ExpectedDeliveryDate || null,
    daysLate: r.DaysLate,
  };
}

