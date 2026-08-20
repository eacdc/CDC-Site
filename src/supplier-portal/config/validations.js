/**
 * The validation catalogue (§18).
 *
 * Every check has a stable code and a fixed severity so that a stored failure
 * stays readable after the code that raised it has changed. Checks are stored
 * on the record they were raised against, which is what makes an override
 * auditable.
 *
 * Severity contract:
 *   BLOCK — cannot be overridden by anyone. The action does not proceed.
 *   WARN  — proceeds only with a recorded reason.
 *   INFO  — recorded, never gates anything.
 */

export const SEVERITY = { BLOCK: 'BLOCK', WARN: 'WARN', INFO: 'INFO' };

export const VALIDATIONS = {
  // ── Extraction (M1) ──────────────────────────────────────────────────────
  EXT001: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Document is an exact duplicate of one already uploaded' },
  EXT002: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Document is a near-duplicate of one already uploaded' },
  EXT003: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'No effective date found on the document' },
  EXT004: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'UOM could not be resolved for this line' },
  EXT005: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'Normalised rate differs from last paid by more than 10x' },
  EXT006: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Duplicate product code within one document' },
  EXT007: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Multi-column worksheet — price column has not been nominated' },
  EXT008: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Supplier GSTIN not recognised' },
  /**
   * These two gate approval rather than upload. A quote whose supplier or plant
   * is unsettled can still be uploaded, extracted and read — what it cannot do
   * is write rate history, because a rate filed against the wrong supplier or
   * the wrong plant is worse than no rate at all: it is silently believed.
   *
   * They are BLOCK and therefore not overridable, which is not a hardship —
   * confirming the identification clears them, and that is one click.
   */
  EXT009: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Supplier has not been identified — confirm who sent this quote' },
  EXT010: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Plant has not been identified — confirm which plant this quote prices' },
  /**
   * Raised instead of EXT004-per-line when NO line carries a unit, which means
   * the document states none anywhere rather than that a row was misread. One
   * missing fact should be one question.
   */
  EXT012: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'No unit is printed anywhere on this document — set the unit these rates are quoted in' },
  /**
   * INFO, not WARN: nothing is wrong with a scan, and demanding a typed reason
   * for every photocopied price list would train people to type one without
   * reading. It exists so the reviewer knows the rates were transcribed from a
   * picture rather than copied from characters, and checks them accordingly.
   */
  EXT011: { severity: SEVERITY.INFO, scope: 'DOCUMENT', message: 'Read from a scan — rates were transcribed from page images' },

  // ── Matching (M2) ────────────────────────────────────────────────────────
  MAP001: { severity: SEVERITY.WARN, scope: 'LINE', message: 'No candidate CDC item found', queueReason: 'NO_CANDIDATE' },
  MAP002: { severity: SEVERITY.WARN, scope: 'LINE', message: 'Ambiguous — several distinct candidates', queueReason: 'AMBIGUOUS' },
  MAP003: { severity: SEVERITY.WARN, scope: 'LINE', message: 'Match confidence below threshold', queueReason: 'LOW_CONFIDENCE' },
  MAP004: { severity: SEVERITY.WARN, scope: 'LINE', message: 'A newer ItemID may be a better match than the existing mapping', queueReason: 'NEW_ITEM_BETTER_MATCH' },
  MAP005: { severity: SEVERITY.WARN, scope: 'LINE', message: 'Mapped item has no purchase history' },

  // ── PO check (M4) ────────────────────────────────────────────────────────
  PO001: { severity: SEVERITY.WARN,  scope: 'PO_LINE', message: 'PO rate is more than 2% above the best current quote' },
  PO002: { severity: SEVERITY.BLOCK, scope: 'PO_LINE', message: "PO rate is above this supplier's own current quote" },
  PO003: { severity: SEVERITY.WARN,  scope: 'PO_LINE', message: 'No current quote exists for this item at this plant' },
  PO004: { severity: SEVERITY.WARN,  scope: 'PO_LINE', message: 'The quote being compared against has expired' },
  PO005: { severity: SEVERITY.INFO,  scope: 'PO_LINE', message: 'Comparison quote is SOFT — indicative only' },
  PO006: { severity: SEVERITY.WARN,  scope: 'PO_LINE', message: 'PO rate differs from last paid by more than 15%' },
  PO007: { severity: SEVERITY.WARN,  scope: 'PO_LINE', message: 'Supplier is not a historical supplier for this item group' },
  PO008: { severity: SEVERITY.BLOCK, scope: 'PO_LINE', message: "PO UOM differs from the item's PurchaseUnit" },

  // ── Invoice → GRN → PI (M5) ──────────────────────────────────────────────
  INV001: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Invoice has already been posted (invoice no + supplier GSTIN)' },
  INV002: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'No open PO found for this supplier and item' },
  INV003: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'Received quantity exceeds PO pending quantity by more than 10%' },
  INV004: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'Sheets-to-kg mismatch beyond ±1%' },
  INV005: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'Invoice rate does not match PO rate' },
  INV006: { severity: SEVERITY.BLOCK, scope: 'LINE',     message: 'Line total does not equal quantity x rate' },
  INV007: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Sum of lines does not equal the invoice subtotal' },
  INV008: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Taxable value does not equal subtotal + freight' },
  INV009: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'GST amount does not equal taxable x rate' },
  INV010: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Grand total does not equal taxable + tax + round off' },
  INV011: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Round off is outside ±₹1' },
  INV012: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Tax type disagrees with supplier state vs ship-to state' },
  INV013: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Buyer GSTIN is not CDC' },
  INV014: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'E-way bill number malformed or absent above the threshold' },
  INV015: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Invoice date is in the future' },
  INV016: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'Invoice date is more than 90 days old' },
  INV017: { severity: SEVERITY.WARN,  scope: 'LINE',     message: "HSN on the invoice does not match the item's HSN" },
  INV018: { severity: SEVERITY.BLOCK, scope: 'DOCUMENT', message: 'Freight is present but no freight ledger has been selected' },
  INV019: { severity: SEVERITY.WARN,  scope: 'DOCUMENT', message: 'PO is already fully received' },
};

/**
 * Build a stored check result. `passed` is carried explicitly rather than
 * inferred from presence, so a review screen can show what was checked and
 * came back clean — a check that silently disappears when it passes is
 * indistinguishable from one that never ran.
 */
export function check(code, passed, { message, actualValue, expectedValue, lineNo } = {}) {
  const def = VALIDATIONS[code];
  if (!def) throw new Error(`Unknown validation code: ${code}`);
  return {
    code,
    severity: def.severity,
    scope: def.scope,
    passed: Boolean(passed),
    message: message || def.message,
    actualValue: actualValue ?? null,
    expectedValue: expectedValue ?? null,
    ...(lineNo === undefined ? {} : { lineNo }),
  };
}

/** True when any failing check is a BLOCK — i.e. the action cannot proceed. */
export function hasBlockingFailure(checks = []) {
  return checks.some((c) => !c.passed && c.severity === SEVERITY.BLOCK);
}

/** Failing checks that need a recorded reason before proceeding. */
export function warningsNeedingReason(checks = []) {
  return checks.filter((c) => !c.passed && c.severity === SEVERITY.WARN);
}
