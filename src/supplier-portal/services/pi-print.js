/**
 * What the printed purchase invoice shows: the ERP's own "Item Purchase
 * Invoice (GRN)" layout, filled from the posted voucher. Read-only.
 *
 * Where each part comes from, checked on PI04732_26_27 (Kolkata, Oct 2026):
 *  - Bill No. / Bill Date are the supplier's InvoiceNo / InvoiceDate.
 *  - Supplier details are the ledger's address and GSTNo.
 *  - Billing details are CompanyMaster (CompanyName, Address1, GSTIN).
 *  - Delivery details are DeliveryAddresses for the production unit of the
 *    warehouse the GRN received into.
 *  - On a line, ReceiptQuantity is in the purchase unit and ChallanQuantity
 *    in the stock unit; "Total Amount" is BasicAmount and "Gross Amount"
 *    NetAmount. IGSTPercentage carries the full rate whichever tax applies,
 *    and is printed as stored.
 *  - Tax Ledger lists ItemPurchaseInvoiceTaxes (CGST, SGST, IGST, freight,
 *    round off) by ledger name.
 *  - Prepared By is the user who created the voucher.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID } from '../config/constants.js';
import { amountInWords } from './erp-receiving.js';

/** The letterhead each site's ERP prints. */
const LETTERHEAD = {
  KOL: {
    name: 'CDC Printers (P) Ltd.',
    lines: [
      ['Regd Off', 'Tangra Industrial Estate - II ,45, Radhanath Chowdhury Road Kolkata - 700015, India'],
      ['Unit II', 'Village - Kulai, P.O.: Bikihakola, P.S.: Panchla, Dist: Howrah, Pin: 711322 , India'],
    ],
  },
  AHM: {
    name: 'CDC Printers (P) Ltd.',
    lines: [
      ['Unit', 'Super Industrial Park, Plot No. : 46, 47, 52, 53, Village : Dhanvada, Taluka : Bavla, Ahmedabad - 382220, India'],
    ],
  },
};

const toNum = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const clean = (v) => String(v ?? '').replace(/\r/g, '').trim();

/**
 * One purchase invoice, by voucher number, ready to print.
 * @returns {Promise<Object|null>} null when there is no live voucher by that number
 */
export async function purchaseInvoiceForPrint(site, voucherNo) {
  assertSite(site);
  const [header] = await query(site, `
    SELECT TOP 1 PM.TransactionID, PM.VoucherNo, PM.VoucherDate, PM.InvoiceNo, PM.InvoiceDate,
           PM.TotalBasicAmount, PM.TotalTaxAmount, PM.NetAmount, PM.Narration,
           S.LedgerName AS SupplierName, S.Address1, S.Address2, S.Address3, S.City, S.District,
           S.State, S.Country, S.Pincode, S.GSTNo,
           U.UserName AS PreparedBy,
           C.CompanyName, C.Address1 AS CompanyAddress, C.GSTIN AS CompanyGstin
    FROM ItemPurchaseInvoiceMain PM
    LEFT JOIN LedgerMaster S ON S.LedgerID = PM.LedgerID AND S.CompanyID = PM.CompanyID
    LEFT JOIN UserMaster U ON U.UserID = PM.CreatedBy
    LEFT JOIN CompanyMaster C ON C.CompanyID = PM.CompanyID
    WHERE PM.CompanyID = @companyId AND PM.VoucherNo = @voucherNo
      AND ISNULL(PM.IsDeletedTransaction,0) = 0
    ORDER BY PM.TransactionID DESC
  `, { companyId: COMPANY_ID, voucherNo: String(voucherNo) });
  if (!header) return null;

  const tid = Number(header.TransactionID);
  const [lines, taxes, delivery] = await Promise.all([
    query(site, `
      SELECT PD.TransID, IM.ItemCode, ISNULL(NULLIF(PD.ItemNarration,''), IM.ItemName) AS ItemName,
             PO.VoucherNo AS PoNo, PD.PurchaseUnit, PD.ReceiptQuantity, PD.StockUnit, PD.ChallanQuantity,
             PD.ReceiptRate, PD.BasicAmount, PD.CGSTPercentage, PD.CGSTAmount, PD.SGSTPercentage, PD.SGSTAmount,
             PD.IGSTPercentage, PD.IGSTAmount, PD.NetAmount
      FROM ItemPurchaseInvoiceDetail PD
      LEFT JOIN ItemMaster IM ON IM.ItemID = PD.ItemID
      LEFT JOIN ItemTransactionMain PO ON PO.TransactionID = PD.PurchaseTransactionID AND PO.CompanyID = PD.CompanyID
      WHERE PD.TransactionID = @tid AND PD.CompanyID = @companyId AND ISNULL(PD.IsDeletedTransaction,0) = 0
      ORDER BY PD.TransID
    `, { tid, companyId: COMPANY_ID }),
    query(site, `
      SELECT T.TransID, L.LedgerName, T.Amount
      FROM ItemPurchaseInvoiceTaxes T
      LEFT JOIN LedgerMaster L ON L.LedgerID = T.LedgerID AND L.CompanyID = T.CompanyID
      WHERE T.TransactionID = @tid AND T.CompanyID = @companyId AND ISNULL(T.IsDeletedTransaction,0) = 0
      ORDER BY T.TransID
    `, { tid, companyId: COMPANY_ID }),
    // The unit the goods went to: the GRN's first line's warehouse.
    query(site, `
      SELECT TOP 1 DA.DeliveryAddress
      FROM ItemPurchaseInvoiceDetail PD
      JOIN ItemTransactionDetail GD ON GD.TransactionID = PD.ParentTransactionID AND GD.CompanyID = PD.CompanyID
      JOIN WarehouseMaster W ON W.WarehouseID = GD.WarehouseID
      JOIN DeliveryAddresses DA ON DA.ProductionUnitID = W.ProductionUnitID AND DA.CompanyID = PD.CompanyID
      WHERE PD.TransactionID = @tid AND PD.CompanyID = @companyId
      ORDER BY PD.TransID, GD.TransactionDetailID
    `, { tid, companyId: COMPANY_ID }),
  ]);

  return shapePrint(site, header, lines, taxes, delivery[0]?.DeliveryAddress);
}

/** Pure: the rows above, as the printed invoice. */
export function shapePrint(site, h, lines = [], taxes = [], deliveryAddress = null) {
  const company = clean(h.CompanyName) || 'CDC Printers Pvt. Ltd.';
  // Ahmedabad's delivery address starts with the company's name on its own line.
  const delivery = clean(deliveryAddress).split('\n').map((s) => s.trim().replace(/,$/, ''))
    .filter((s, i) => s && !(i === 0 && /^CDC Printers/i.test(s))).join(', ');
  const district = [clean(h.District), clean(h.State)].filter(Boolean).join(',');
  const supplierAddress = [
    clean(h.Address1), clean(h.Address2), clean(h.Address3), clean(h.City),
    district || clean(h.Country) ? `Dist./Province -${district}${clean(h.Country) ? ` - ${clean(h.Country)}` : ''}` : '',
    clean(h.Pincode) ? `Pin - ${clean(h.Pincode)}` : '',
  ].filter(Boolean);

  return {
    site,
    letterhead: LETTERHEAD[site] ?? LETTERHEAD.KOL,
    voucherNo: h.VoucherNo,
    voucherDate: h.VoucherDate,
    billNo: clean(h.InvoiceNo) || null,
    billDate: h.InvoiceDate,
    supplier: { name: clean(h.SupplierName), address: supplierAddress, gstin: clean(h.GSTNo) || null },
    billing: { name: company, address: clean(h.CompanyAddress), gstin: clean(h.CompanyGstin) || null },
    delivery: { name: company, address: delivery || clean(h.CompanyAddress), gstin: clean(h.CompanyGstin) || null },
    lines: lines.map((l, i) => ({
      sNo: i + 1,
      itemCode: clean(l.ItemCode),
      poNo: clean(l.PoNo),
      itemName: clean(l.ItemName),
      purchaseUnit: clean(l.PurchaseUnit),
      qtyPu: toNum(l.ReceiptQuantity),
      stockUnit: clean(l.StockUnit),
      qtySu: toNum(l.ChallanQuantity),
      rate: toNum(l.ReceiptRate),
      amount: toNum(l.BasicAmount),
      cgstRate: toNum(l.CGSTPercentage), cgstAmount: toNum(l.CGSTAmount),
      sgstRate: toNum(l.SGSTPercentage), sgstAmount: toNum(l.SGSTAmount),
      igstRate: toNum(l.IGSTPercentage), igstAmount: toNum(l.IGSTAmount),
      gross: toNum(l.NetAmount),
    })),
    taxes: taxes.map((t) => ({ ledger: clean(t.LedgerName), amount: toNum(t.Amount) })),
    totalBasic: toNum(h.TotalBasicAmount),
    netAmount: toNum(h.NetAmount),
    amountInWords: amountInWords(h.NetAmount),
    remark: clean(h.Narration),
    preparedBy: clean(h.PreparedBy),
  };
}
