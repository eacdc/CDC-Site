/**
 * CDC Supplier Portal — ERP constants.
 *
 * Everything here was verified against the live `IndusEnterprise` (Kolkata)
 * database in August 2026 and is treated as a contract, not a preference.
 *
 * IMPORTANT — what may and may not live in this file:
 *   - Structural facts (voucher IDs, column semantics, tolerances, formats)
 *     are the same in both databases and belong here.
 *   - Instance values (WarehouseID, LedgerID, UserID, ItemID, ProductHSNID)
 *     differ per database and must be loaded at runtime. The few ID tables
 *     below are marked KOLKATA REFERENCE ONLY and exist for documentation and
 *     for seeding a dev environment — never import them into request paths.
 *
 * See docs/SUPPLIER_PORTAL.md §2.1 for why.
 */

/** Both databases run CompanyID 2. Verified August 2026. */
export const COMPANY_ID = 2;

/** The two sites, each backed by its own database. Never default a site. */
export const SITES = ['KOL', 'AHM'];

/** Plant labels used on quotes and rate history. 1:1 with a site. */
export const PLANTS = { KOL: 'KOLKATA', AHM: 'AHMEDABAD' };

/** Reverse map, for reading plant strings off documents. */
export const SITE_BY_PLANT = { KOLKATA: 'KOL', AHMEDABAD: 'AHM' };

/** `ItemTransactionMain.VoucherID`. Negative by ERP convention. */
export const VOUCHER = {
  INDENT: -8,
  PURCHASE_REQUISITION: -9,
  PURCHASE_ORDER: -11,
  GRN: -14,
  STOCK_JOURNAL: -16,
  ITEM_ALLOCATION: -17,
  ITEM_ISSUE: -19,
  CONSUMPTION: -25,
  PURCHASE_INVOICE: -32,
  GPN: -50,
  DISPATCH: -51,
};

/** Voucher number prefixes, by voucher id. */
export const VOUCHER_PREFIX = {
  [VOUCHER.PURCHASE_ORDER]: 'PO',
  [VOUCHER.GRN]: 'REC',
  [VOUCHER.PURCHASE_INVOICE]: 'PI',
};

/**
 * `{Prefix}{MaxVoucherNo padded to 5}_{FYear}` — e.g. `PO02359_26_27`.
 * FYear is already in `26_27` form in the database.
 */
export function formatVoucherNo(voucherId, maxVoucherNo, fYear) {
  const prefix = VOUCHER_PREFIX[voucherId];
  if (!prefix) throw new Error(`No voucher prefix defined for VoucherID ${voucherId}`);
  return `${prefix}${String(maxVoucherNo).padStart(5, '0')}_${fYear}`;
}

/**
 * `ItemGroupMaster` — only nine groups exist. `nameId` is `ItemGroupNameID`,
 * which is the join key to `ItemSubGroupMaster` (NOT `ItemGroupID`).
 * These IDs are group *definitions* and are stable across both databases.
 */
export const ITEM_GROUPS = {
  2: { name: 'REEL', nameId: -2 },
  3: { name: 'INK & ADDITIVES', nameId: -3 },
  4: { name: 'VARNISHES & COATINGS', nameId: -4 },
  5: { name: 'LAMINATION FILM', nameId: -5 },
  6: { name: 'FOIL', nameId: -6 },
  7: { name: 'SHIPPER CARTON', nameId: -7 },
  8: { name: 'OTHER MATERIAL', nameId: -9 },
  13: { name: 'ROLL', nameId: -14 },
  14: { name: 'PAPER', nameId: -1 },
};

/**
 * Groups the portal matches at *item* level. Reel (2), shipper carton (7) and
 * paper (14) price off a spec band rather than a fixed SKU set, so their
 * quotes are captured as spec-band rates instead (§11.5).
 */
export const ITEM_LEVEL_GROUPS = [3, 4, 5, 6, 8];

/** Groups whose quotes are stored against a spec key, not an ItemID. */
export const SPEC_LEVEL_GROUPS = [2, 5, 6, 7, 14];

/**
 * Sub-groups that carry meaning, all children of -9 (Other Material) unless
 * noted. Sub-group is a *scoring boost* in the matcher and never a hard
 * filter — see KNOWN_SUBGROUP_DEFECTS.
 */
export const ITEM_SUBGROUPS = {
  5: 'Adhesive and Chemicals',
  7: 'Packing Materials',
  27: 'Printing Plates',
  36: 'Binding Materials',
  37: 'Blanket',
  38: 'C/C Matrix',
  39: 'Chemicals',
  40: 'Consumable Item',
  41: 'Hard Board',
  42: 'Machine Oil',
  48: 'Window Film',
};

/**
 * Master defects to code around. Documented so nobody "fixes" the workarounds.
 */
export const KNOWN_SUBGROUP_DEFECTS = [
  'Carton Boxes (28) and Corrugated Boxes (29) sit under 7 (Packing Materials) instead of -7 (Shipper Carton) — a dropped minus sign.',
  'Lamination Roll (43) sits under -4 (Varnishes) instead of -5 (Lamination Film).',
  'Orphan sub-groups with no matching group: -8 Corrugated Sheets, -11 Wire-O, -12 Ribbon.',
  'Group 14 (Paper) carries no sub-group on any item. Group 6 (Foil) is entirely sub-group 35.',
  'Group 3 (Ink) items sit on -3, the top level; ink children 30-34 are unused.',
  'Sub-group 40 (Consumable Item) is a junk drawer and a poor discriminator.',
];

/**
 * ItemMaster columns that carry no usable information (§6). Reading any of
 * these is a bug; they are listed so the ERP read layer can assert on them.
 */
export const UNRELIABLE_ITEM_COLUMNS = [
  // Always blank.
  'ManufecturerItemCode',
  // Carries no information — copies the group name.
  'ItemType',
  // Rate columns the ERP does not maintain. Derive from PO history instead.
  'PurchaseRate', 'LastPurchaseRate', 'LastPurchaseOrderNo',
  // Stock columns CDC's own code ignores. Compute from transactions.
  'PhysicalStock', 'BookedStock', 'AllocatedStock', 'IncomingStock',
  'FloorStock', 'UnapprovedStock', 'IndentStock', 'RequisitionStock',
  'PhysicalStockValue', 'RequisitionStockValue', 'IndentStockValue',
  'IncomingStockValue', 'UnapprovedStockValue', 'AllocatedStockValue',
  'BookedStockValue', 'FloorStockValue',
];

/**
 * `Manufecturer` means three different things depending on the group. Only
 * group 3 may treat it as a brand.
 */
export const MANUFACTURER_MEANING = {
  3: 'BRAND',      // SIEGWERK, DIC, SAKATA (note: SIEGWORK is also spelled in data)
  14: 'ORIGIN',    // "Imported"
  2: 'ORIGIN',
  5: 'SUPPLIER',   // the ERP grid labels this column "Supplier"
  6: 'SUPPLIER',
  7: 'SUPPLIER',
};

/** Pantone codes hide in ItemName/InkColour/PantoneCode interchangeably. */
export const PANTONE_PATTERN = /\d{3,4}\s*[CU]\b/i;

/** Tax and charge ledgers, `LedgerCodePrefix = 'T'`. KOLKATA REFERENCE ONLY. */
export const KOL_CHARGE_LEDGERS = {
  CGST: 6,
  SGST: 7,
  IGST: 8,
  ROUND_OFF: 8524,
  PACKING_AND_FORWARDING: 8627,
  COMMISSION: 8628,
  OTHER_CHARGES: 8629,
  // The 18/12/5 refers to the GST rate of the *material carried*, not of the
  // freight. All three carry TaxPercentage 18, which is correct.
  INWARD_FREIGHT_18: 9621,
  INWARD_FREIGHT_12: 9622,
  INWARD_FREIGHT_5: 9623,
};

/** Warehouses. KOLKATA REFERENCE ONLY — load live via erp-ledgers. */
export const KOL_WAREHOUSES = {
  13: { name: 'Panchla-Paper warehouse', productionUnitId: 2, isFloor: false },
  14: { name: 'Floor-Tangra', productionUnitId: 1, isFloor: true },
  15: { name: 'Tangra-Paper', productionUnitId: 1, isFloor: false },
  16: { name: 'Floor-Panchla-Paper', productionUnitId: 2, isFloor: true },
  17: { name: 'Panchla-Outside 1', productionUnitId: 2, isFloor: false },
  18: { name: 'Panchla-Outside 2', productionUnitId: 2, isFloor: false },
  19: { name: 'Panchla-C.M', productionUnitId: 2, isFloor: false },
};

/**
 * Three separate ID spaces on one voucher. Getting these wrong is the most
 * likely bug in receiving.
 */
export const ID_SPACES = {
  UserID: 'UserMaster',
  CreatedBy: 'UserMaster',
  CompletedBy: 'UserMaster',
  VoucherItemApprovedBy: 'UserMaster',
  ReceivedBy: "LedgerMaster where LedgerType = 'Employees'",
  LedgerID: "LedgerMaster where LedgerType = 'Sundry Creditors'",
};

/** CDC's own legal identity. Used by the invoice checks. */
export const CDC_IDENTITY = {
  gstin: '19AABCC2946B1ZZ',
  pan: 'AABCC2946B',
  state: 'West Bengal',
  stateCode: '19',
};

/** House rules confirmed by CDC, August 2026 (§23). */
export const TOLERANCES = {
  /** Over-receipt beyond this fraction of PO pending qty is a hard block. */
  receiptOverPct: 0.10,
  /** A PO line with this fraction or less still pending may be closed. */
  closurePendingPct: 0.10,
  /** Quote validity when the document gives no date at all. */
  defaultValidityDays: 75,
  /** Rate-anchor match window in the matching engine. */
  rateAnchorPct: 0.005,
  /** Sheets-to-kg reconciliation window. */
  sheetKgPct: 0.01,
  /** Normalised rate this many times off last-paid means the UOM is wrong. */
  uomMagnitudeFactor: 10,
  /** Auto-accept threshold for name similarity. */
  nameSimilarityAccept: 0.82,
  /** Auto-accept threshold for LLM adjudication. */
  llmConfidenceAccept: 0.90,
  /** Perceptual-hash Hamming distance treated as a near-duplicate document. */
  phashNearDuplicate: 5,
  /** Rupee tolerance on invoice arithmetic checks. */
  invoiceAmount: 1,
  /** How far back the candidate universe looks for purchase history. */
  purchaseHistoryMonths: 24,
  /** Refresh report horizon. */
  quoteExpiryWarningDays: 30,
};

/** PO checker thresholds (§14). */
export const PO_CHECK = {
  aboveBestQuotePct: 0.02,
  aboveOwnQuotePct: 0.005,
  vsLastPaidPct: 0.15,
};

/** Supplier scorecard on-time window: ±10% of lead time, floored at 2 days. */
export function onTimeToleranceDays(leadDays) {
  return Math.max(0.10 * (Number(leadDays) || 0), 2);
}

/**
 * Brand-defined vs spec-defined defaults (§13.3), keyed by sub-group id with
 * `group:N` fallbacks for groups whose items carry no sub-group. The purchase
 * team corrects these; individual items override via `itemClassification`.
 *
 * BRAND: the brand is part of the identity — rank within brand.
 * SPEC:  the spec fully determines the item — rank suppliers outright.
 */
export const RANKING_DEFAULTS = {
  'group:3': 'BRAND',
  'group:4': 'BRAND',
  'group:5': 'SPEC',
  'group:6': 'BRAND',   // at grade level: Kurz 38-75 vs Shring 10.5
  'group:7': 'SPEC',
  'subgroup:5': 'BRAND',
  'subgroup:7': 'SPEC',
  'subgroup:27': 'BRAND',
  'subgroup:36': 'SPEC',
  'subgroup:37': 'BRAND',
  'subgroup:38': 'SPEC',
  'subgroup:39': 'BRAND',
  'subgroup:40': 'BRAND',  // junk drawer — safer to require a human
  'subgroup:41': 'SPEC',
  'subgroup:42': 'BRAND',
  'subgroup:48': 'SPEC',
};

/**
 * Resolve the ranking mode for an item. Item-level override wins, then
 * sub-group, then group, then BRAND (the conservative default — it forces a
 * human onto cross-supplier comparisons rather than assuming substitutability).
 */
export function rankingMode({ itemOverride, itemSubGroupId, itemGroupId }) {
  if (itemOverride === 'BRAND' || itemOverride === 'SPEC') return itemOverride;
  const bySub = RANKING_DEFAULTS[`subgroup:${itemSubGroupId}`];
  if (bySub) return bySub;
  const byGroup = RANKING_DEFAULTS[`group:${itemGroupId}`];
  if (byGroup) return byGroup;
  return 'BRAND';
}

/**
 * CDC "generic" item names that are in fact aliases for a specific supplier
 * product. Confirmed by exact rate matches; the matcher cannot derive these,
 * so they are seeded (§11.4).
 */
export const SEEDED_ALIASES = [
  { cdcNamePattern: /INK,\s*Maplitho\s*-\s*Process Ink/i, brand: 'SIEGWERK', product: 'Vega Sprint' },
  { cdcNamePattern: /INK,\s*Coated High Pigment\s*-\s*Process Ink/i, brand: 'SAKATA', product: 'SKT Enviro Prime' },
  { cdcNamePattern: /UV Ink\s*-\s*Process/i, brand: 'SIEGWERK', product: 'Sicura Plast 770HS' },
  { cdcNamePattern: /Ink kitchen,\s*Siegwerk-\d+-L/i, brand: 'SIEGWERK', product: 'Vega Prime Paste' },
];

/** Supplier-side token aliases seen in quotes. */
export const SUPPLIER_TOKEN_ALIASES = {
  SKT: 'SAKATA',
  SIEGWORK: 'SIEGWERK',
};

/** Ledger names that are internal transfers, not purchases (§8). */
export const INTERNAL_LEDGER_PATTERNS = [/CDC\s*Printers/i];

/** Stored procedure called after a GRN commits. Best-effort, outside the tx. */
export const STOCK_REFRESH_PROC = 'dbo.UPDATE_ITEM_STOCK_VALUES';
