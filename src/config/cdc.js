/**
 * CDC Bills Digitization — central configuration
 *
 * - CDC_CONFIG: legal identity, GSTINs, addresses, units
 * - TOLERANCES: numeric tolerances used by the verification engine
 * - EWAY_THRESHOLDS: GST e-way bill mandatory thresholds (INR)
 *
 * Keep this file pure JS data only — no side-effects. The verification engine
 * imports these constants synchronously at module load.
 */

export const CDC_CONFIG = {
  legal_name: 'CDC PRINTERS PVT LTD',
  pan: 'AABCC2946B',
  // All known CDC GSTINs. Add the Ahmedabad GSTIN here when issued.
  gstins: ['19AABCC2946B1ZZ'],
  state: 'West Bengal',
  state_code: '19',
  addresses: [
    'Mouza Satgharia, J L No 27, PS Panchla, Howrah 711322',
    '45 Radhanath Chowdhury Road, Tangra Industrial Estate II, Kolkata 700015',
  ],
  // Canonical unit names that may be seen on Tally/GRN documents.
  units: ['Tangra Unit', 'Panchla Unit', 'Ahmedabad Unit'],
};

export const TOLERANCES = {
  amount: 10,             // grand total / taxable value mismatch allowed (rounding)
  tax_amount: 2,          // CGST/SGST/IGST sub-calc tolerance
  round_off: 1,           // round-off line tolerance
  date_gap_max_days: 60,  // voucher_date - bill_date
  fuzzy_supplier_name: 0.7,
  fuzzy_buyer_name: 0.8,
};

export const EWAY_THRESHOLDS = {
  interstate: 50000,
  intrastate: 100000,
};

/**
 * Returns true if the given GSTIN belongs to CDC. Case-insensitive,
 * whitespace-tolerant.
 */
export function isCdcGstin(gstin) {
  if (!gstin) return false;
  const norm = String(gstin).trim().toUpperCase().replace(/\s+/g, '');
  return CDC_CONFIG.gstins.some(g => g.toUpperCase() === norm);
}

/**
 * Extract the PAN embedded in a 15-char GSTIN (positions 3..12, 1-indexed
 * inclusive — i.e. characters 3 through 12, which in JS substring is [2,12)).
 */
export function panFromGstin(gstin) {
  if (!gstin) return null;
  const norm = String(gstin).trim().toUpperCase().replace(/\s+/g, '');
  if (norm.length < 12) return null;
  return norm.substring(2, 12);
}
