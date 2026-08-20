/**
 * ERP item reads.
 *
 * The ERP is the single source of truth and is never cached. Item masters grow
 * constantly — a nightly sync would be wrong within hours — so every function
 * here reads live and takes `site` as its first argument.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - It never selects `ItemMaster.PurchaseRate`, `LastPurchaseRate` or
 *    `LastPurchaseOrderNo`. The ERP does not maintain them. Last-paid rate is
 *    derived from PO lines in `lastPaidRates()`.
 *  - It never selects the stock columns. CDC's own reporting computes stock
 *    from transactions and so does this application.
 */

import { query, sql, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER, TOLERANCES, ITEM_LEVEL_GROUPS } from '../config/constants.js';

/**
 * The standard filter pair. `ItemTransactionMain` has NO `IsCancelled` column —
 * referencing it throws Msg 207 — so the main-table filter is deletion only.
 */
const ITD_FILTER = `
  AND ISNULL(ITD.IsDeletedTransaction,0) = 0
  AND ISNULL(ITD.IsCancelled,0) = 0`;
const ITM_FILTER = `
  AND ISNULL(ITM.IsDeletedTransaction,0) = 0`;

/** Columns worth reading off ItemMaster. The rest are unreliable or unused. */
const ITEM_COLUMNS = `
  IM.ItemID, IM.ItemCode, IM.ItemName, IM.ItemDescription,
  IM.ItemGroupID, IM.ItemSubGroupID, IM.ProductHSNID,
  IM.StockUnit, IM.PurchaseUnit, IM.WtPerPacking, IM.UnitPerPacking,
  IM.ConversionFactor, IM.Quality, IM.GSM, IM.Manufecturer, IM.InkColour,
  IM.PantoneCode, IM.ItemSize, IM.SizeW, IM.SizeL, IM.Thickness, IM.BF,
  IM.CertificationType, IM.LeadTime, IM.ISItemActive`;

/**
 * Fetch items by id. Returns a Map keyed by ItemID so callers can look up
 * without re-scanning.
 */
export async function getItems(site, itemIds = []) {
  assertSite(site);
  const ids = [...new Set(itemIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const rows = await query(site, `
    SELECT ${ITEM_COLUMNS},
           SG.ItemSubGroupName, G.ItemGroupName
    FROM ItemMaster IM
    LEFT JOIN ItemGroupMaster G
      ON G.ItemGroupID = IM.ItemGroupID AND G.CompanyID = IM.CompanyID
    -- ItemSubGroupMaster joins on ItemGroupNameID, NOT ItemGroupID.
    LEFT JOIN ItemSubGroupMaster SG
      ON SG.ItemSubGroupID = IM.ItemSubGroupID AND SG.CompanyID = IM.CompanyID
    WHERE IM.CompanyID = @companyId
      AND ISNULL(IM.IsDeleted,0) = 0
      AND IM.ItemID IN (${ids.join(',')})
  `, { companyId: COMPANY_ID });

  return new Map(rows.map((r) => [r.ItemID, r]));
}

/** One item, or null. */
export async function getItem(site, itemId) {
  const map = await getItems(site, [itemId]);
  return map.get(Number(itemId)) || null;
}

/**
 * The candidate universe (§7): items with real purchase history.
 *
 * This single filter removes ink-kitchen mixes (made in-house, never bought),
 * dead master rows, and most duplicate-ItemID ambiguity. In Kolkata it takes
 * ~6,295 active items down to 3,192, and to 546 within the in-scope groups.
 *
 * @param {'KOL'|'AHM'} site
 * @param {Object} [opts]
 * @param {number[]} [opts.itemGroupIds]  defaults to the item-level groups
 * @param {number} [opts.months]
 */
export async function purchasedItemIds(site, { itemGroupIds = ITEM_LEVEL_GROUPS, months = TOLERANCES.purchaseHistoryMonths } = {}) {
  assertSite(site);
  const groupFilter = itemGroupIds?.length
    ? `AND IM.ItemGroupID IN (${itemGroupIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  const rows = await query(site, `
    SELECT DISTINCT ITD.ItemID
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID
     AND ITM.CompanyID = ITD.CompanyID
    JOIN ItemMaster IM
      ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId
      AND ITM.VoucherID IN (@po, @grn)
      AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
      AND IM.ISItemActive = 1
      ${groupFilter}
      ${ITD_FILTER}
      ${ITM_FILTER}
  `, {
    companyId: COMPANY_ID,
    po: VOUCHER.PURCHASE_ORDER,
    grn: VOUCHER.GRN,
    months,
  });

  return rows.map((r) => r.ItemID);
}

/**
 * Candidate items for matching, with the context the matcher and the human
 * queue both need: last-paid rate, last supplier, purchase count, annual
 * spend, sub-group name.
 *
 * Sorted by recency and frequency — a coordinator's first instinct is "what do
 * we actually buy", and that ordering is what makes the queue fast.
 */
export async function matchingCandidates(site, {
  itemGroupIds = ITEM_LEVEL_GROUPS,
  months = TOLERANCES.purchaseHistoryMonths,
  supplierLedgerIds = null,
} = {}) {
  assertSite(site);
  const groupFilter = itemGroupIds?.length
    ? `AND IM.ItemGroupID IN (${itemGroupIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';
  // Restricting to the ledgers a supplier group actually trades under is what
  // makes Tier 0 meaningful: an ink supplier's quote is not matched against
  // shipper cartons.
  const ledgerFilter = supplierLedgerIds?.length
    ? `AND ITM.LedgerID IN (${supplierLedgerIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  return query(site, `
    WITH PoLines AS (
      SELECT ITD.ItemID,
             ITD.PurchaseRate,
             ITM.VoucherDate,
             ITM.LedgerID,
             ITD.PurchaseOrderQuantity,
             ROW_NUMBER() OVER (PARTITION BY ITD.ItemID ORDER BY ITM.VoucherDate DESC, ITD.TransactionDetailID DESC) AS rn
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        -- Last-paid rate must come from PO lines only: GRN lines carry 0 in
        -- both PurchaseRate and GrsRate on most rows, so a "latest transaction
        -- of any type" query returns NULL for the majority of items.
        AND ITM.VoucherID = @po
        AND ITD.PurchaseRate > 0
        AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
        ${ledgerFilter}
        ${ITD_FILTER}
        ${ITM_FILTER}
    ),
    Agg AS (
      SELECT ItemID,
             COUNT(*) AS PurchaseCount,
             SUM(ISNULL(PurchaseRate,0) * ISNULL(PurchaseOrderQuantity,0)) AS SpendInWindow,
             MAX(VoucherDate) AS LastPurchaseDate
      FROM PoLines
      GROUP BY ItemID
    )
    SELECT ${ITEM_COLUMNS},
           SG.ItemSubGroupName,
           G.ItemGroupName,
           L.PurchaseRate AS LastPaidRate,
           L.VoucherDate  AS LastPaidDate,
           L.LedgerID     AS LastSupplierLedgerId,
           LM.LedgerName  AS LastSupplierName,
           A.PurchaseCount,
           A.SpendInWindow,
           A.LastPurchaseDate
    FROM Agg A
    JOIN ItemMaster IM ON IM.ItemID = A.ItemID AND IM.CompanyID = @companyId
    JOIN PoLines L ON L.ItemID = A.ItemID AND L.rn = 1
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = L.LedgerID AND LM.CompanyID = @companyId
    LEFT JOIN ItemGroupMaster G ON G.ItemGroupID = IM.ItemGroupID AND G.CompanyID = IM.CompanyID
    LEFT JOIN ItemSubGroupMaster SG ON SG.ItemSubGroupID = IM.ItemSubGroupID AND SG.CompanyID = IM.CompanyID
    WHERE ISNULL(IM.IsDeleted,0) = 0
      AND IM.ISItemActive = 1
      ${groupFilter}
    ORDER BY A.LastPurchaseDate DESC, A.PurchaseCount DESC
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, months }, { long: true });
}

/**
 * Last-paid rate for specific items, from PO lines only.
 *
 * @returns {Promise<Map<number, {rate, date, ledgerId, supplierName, voucherNo}>>}
 */
export async function lastPaidRates(site, itemIds = []) {
  assertSite(site);
  const ids = [...new Set(itemIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const rows = await query(site, `
    WITH PoLines AS (
      SELECT ITD.ItemID, ITD.PurchaseRate, ITD.PurchaseUnit,
             ITM.VoucherDate, ITM.VoucherNo, ITM.LedgerID,
             ROW_NUMBER() OVER (PARTITION BY ITD.ItemID ORDER BY ITM.VoucherDate DESC, ITD.TransactionDetailID DESC) AS rn
      FROM ItemTransactionDetail ITD
      JOIN ItemTransactionMain ITM
        ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
      WHERE ITD.CompanyID = @companyId
        AND ITM.VoucherID = @po
        AND ITD.PurchaseRate > 0
        AND ITD.ItemID IN (${ids.join(',')})
        ${ITD_FILTER}
        ${ITM_FILTER}
    )
    SELECT P.ItemID, P.PurchaseRate, P.PurchaseUnit, P.VoucherDate, P.VoucherNo,
           P.LedgerID, LM.LedgerName
    FROM PoLines P
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = P.LedgerID AND LM.CompanyID = @companyId
    WHERE P.rn = 1
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER });

  return new Map(rows.map((r) => [r.ItemID, {
    rate: r.PurchaseRate,
    uom: r.PurchaseUnit,
    date: r.VoucherDate,
    voucherNo: r.VoucherNo,
    ledgerId: r.LedgerID,
    supplierName: r.LedgerName,
  }]));
}

/**
 * Full rate history for one item, for the 12-month sparkline and the data
 * quality report.
 */
export async function itemRateHistory(site, itemId, { months = 24 } = {}) {
  assertSite(site);
  return query(site, `
    SELECT ITM.VoucherDate, ITM.VoucherNo, ITM.LedgerID, LM.LedgerName,
           ITD.PurchaseRate, ITD.PurchaseUnit, ITD.PurchaseOrderQuantity
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = ITM.LedgerID AND LM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId
      AND ITM.VoucherID = @po
      AND ITD.ItemID = @itemId
      AND ITD.PurchaseRate > 0
      AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
      ${ITD_FILTER}
      ${ITM_FILTER}
    ORDER BY ITM.VoucherDate ASC
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, itemId: Number(itemId), months });
}

/**
 * Fuzzy item search for the comparator. Searches name, description and
 * sub-group name; the caller adds mapped supplier product names on top.
 */
export async function searchItems(site, term, { limit = 50, itemGroupIds = null } = {}) {
  assertSite(site);
  const text = String(term ?? '').trim();
  if (!text) return [];

  // A bare number is far more likely to be an ItemID or ItemCode than a name
  // fragment, so it is tried as one first.
  const asNumber = /^\d+$/.test(text) ? Number(text) : null;
  const groupFilter = itemGroupIds?.length
    ? `AND IM.ItemGroupID IN (${itemGroupIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  return query(site, `
    SELECT TOP (@limit) ${ITEM_COLUMNS},
           SG.ItemSubGroupName, G.ItemGroupName
    FROM ItemMaster IM
    LEFT JOIN ItemGroupMaster G ON G.ItemGroupID = IM.ItemGroupID AND G.CompanyID = IM.CompanyID
    LEFT JOIN ItemSubGroupMaster SG ON SG.ItemSubGroupID = IM.ItemSubGroupID AND SG.CompanyID = IM.CompanyID
    WHERE IM.CompanyID = @companyId
      AND ISNULL(IM.IsDeleted,0) = 0
      AND IM.ISItemActive = 1
      ${groupFilter}
      AND (
        (@asNumber IS NOT NULL AND (IM.ItemID = @asNumber))
        OR IM.ItemCode LIKE @like
        OR IM.ItemName LIKE @like
        OR IM.ItemDescription LIKE @like
        OR SG.ItemSubGroupName LIKE @like
      )
    ORDER BY
      CASE WHEN IM.ItemName LIKE @prefix THEN 0 ELSE 1 END,
      IM.ItemName
  `, {
    companyId: COMPANY_ID,
    limit: { type: sql.Int, value: Math.min(Number(limit) || 50, 200) },
    asNumber: { type: sql.Int, value: asNumber },
    like: `%${text}%`,
    prefix: `${text}%`,
  });
}

/**
 * Annual spend per item, used to prioritise the mapping queue and to sort
 * every report. Spend is what decides which of 546 mappings matters.
 */
export async function annualSpend(site, { months = 12, itemGroupIds = ITEM_LEVEL_GROUPS } = {}) {
  assertSite(site);
  const groupFilter = itemGroupIds?.length
    ? `AND IM.ItemGroupID IN (${itemGroupIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';

  const rows = await query(site, `
    SELECT ITD.ItemID,
           SUM(ISNULL(ITD.PurchaseRate,0) * ISNULL(ITD.PurchaseOrderQuantity,0)) AS Spend,
           COUNT(*) AS PurchaseCount
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
    JOIN ItemMaster IM ON IM.ItemID = ITD.ItemID AND IM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId
      AND ITM.VoucherID = @po
      AND ITD.PurchaseRate > 0
      AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
      ${groupFilter}
      ${ITD_FILTER}
      ${ITM_FILTER}
    GROUP BY ITD.ItemID
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, months }, { long: true });

  return new Map(rows.map((r) => [r.ItemID, { spend: r.Spend, purchaseCount: r.PurchaseCount }]));
}

/**
 * Which suppliers have supplied a given item, and at what rates. Feeds the
 * cross-supplier spread report and the single-source-risk report.
 */
export async function suppliersForItems(site, itemIds = [], { months = 24 } = {}) {
  assertSite(site);
  const ids = [...new Set(itemIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const rows = await query(site, `
    SELECT ITD.ItemID, ITM.LedgerID, LM.LedgerName,
           MIN(ITD.PurchaseRate) AS MinRate,
           MAX(ITD.PurchaseRate) AS MaxRate,
           COUNT(*) AS BuyCount,
           MAX(ITM.VoucherDate) AS LastDate
    FROM ItemTransactionDetail ITD
    JOIN ItemTransactionMain ITM
      ON ITM.TransactionID = ITD.TransactionID AND ITM.CompanyID = ITD.CompanyID
    LEFT JOIN LedgerMaster LM ON LM.LedgerID = ITM.LedgerID AND LM.CompanyID = ITD.CompanyID
    WHERE ITD.CompanyID = @companyId
      AND ITM.VoucherID = @po
      AND ITD.PurchaseRate > 0
      AND ITD.ItemID IN (${ids.join(',')})
      AND ITM.VoucherDate >= DATEADD(month, -@months, GETDATE())
      ${ITD_FILTER}
      ${ITM_FILTER}
    GROUP BY ITD.ItemID, ITM.LedgerID, LM.LedgerName
  `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER, months });

  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.ItemID)) byItem.set(r.ItemID, []);
    byItem.get(r.ItemID).push({
      ledgerId: r.LedgerID,
      ledgerName: r.LedgerName,
      minRate: r.MinRate,
      maxRate: r.MaxRate,
      buyCount: r.BuyCount,
      lastDate: r.LastDate,
    });
  }
  return byItem;
}

/**
 * Items created since a timestamp. The nightly refresh uses this to spot new
 * ItemIDs that are near-clones of already-mapped ones, which is how the
 * master-duplicate report builds itself.
 */
export async function itemsCreatedSince(site, since, { itemGroupIds = ITEM_LEVEL_GROUPS } = {}) {
  assertSite(site);
  const groupFilter = itemGroupIds?.length
    ? `AND IM.ItemGroupID IN (${itemGroupIds.map(Number).filter(Number.isFinite).join(',')})`
    : '';
  return query(site, `
    SELECT ${ITEM_COLUMNS}, IM.CreatedDate
    FROM ItemMaster IM
    WHERE IM.CompanyID = @companyId
      AND ISNULL(IM.IsDeleted,0) = 0
      AND IM.ISItemActive = 1
      AND IM.CreatedDate >= @since
      ${groupFilter}
    ORDER BY IM.CreatedDate DESC
  `, { companyId: COMPANY_ID, since: { type: sql.DateTime, value: since } });
}

/** HSN detail for items. HSN comes off ItemMaster.ProductHSNID — no lookup logic. */
export async function hsnForItems(site, itemIds = []) {
  assertSite(site);
  const ids = [...new Set(itemIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();

  const rows = await query(site, `
    SELECT IM.ItemID, H.ProductHSNID, H.HSNCode, H.ProductHSNName, H.ProductCategory,
           H.GSTTaxPercentage, H.CGSTTaxPercentage, H.SGSTTaxPercentage, H.IGSTTaxPercentage
    FROM ItemMaster IM
    JOIN ProductHSNMaster H
      ON H.ProductHSNID = IM.ProductHSNID AND H.CompanyID = IM.CompanyID
    WHERE IM.CompanyID = @companyId
      AND IM.ItemID IN (${ids.join(',')})
      AND ISNULL(H.IsDeletedTransaction,0) = 0
  `, { companyId: COMPANY_ID });

  return new Map(rows.map((r) => [r.ItemID, r]));
}
