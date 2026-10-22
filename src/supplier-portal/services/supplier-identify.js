/**
 * Which supplier ledger an invoice is from - the GSTIN first, then the name.
 *
 * A GRN is booked to one ledger, so this resolves to a LedgerID, not a
 * supplier group (quote-identify.js does groups, for quotes).
 *
 * Facts it relies on, verified live on Kolkata, October 2026:
 *  - ONE GSTIN SITS ON SEVERAL LEDGERS. 19AHEPA0785F1ZK (Pranay Udyog) is on
 *    five: a Sundry Debtor, a Client, two Consignees and one Supplier, 8535.
 *    Only supplier ledger types may be considered, or the GRN would be booked
 *    to a debtor.
 *  - Even among supplier ledgers a GSTIN repeats (Krishna Vanijya has four;
 *    Siegwerk has a "KOLKATA" branch ledger). The tie goes to the ledger with
 *    the most recent PO - the one CDC is actually buying through.
 *  - 1,178 of 1,380 supplier ledgers carry a GSTIN, so the name is the
 *    fallback, not the rule.
 *
 * The pure part takes everything as arguments so it can be tested without a
 * database; identifyInvoiceSupplier() does the reading.
 */

import { query, assertSite } from '../db/mssql.js';
import { COMPANY_ID, VOUCHER, SUPPLIER_LEDGER_TYPES, CDC_IDENTITY } from '../config/constants.js';
import { supplierLedgers } from './erp-ledgers.js';
import { normaliseName } from '../lib/text.js';

/** A GSTIN as compared: upper case, letters and digits only, 15 long. */
export function normaliseGstin(value) {
  const t = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^\d{2}[A-Z0-9]{13}$/.test(t) ? t : null;
}

/** Words that say what kind of company it is, not which one. */
const NOISE = new Set([
  'M', 'S', 'MS', 'MESSRS', 'THE', 'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'CO', 'COMPANY',
  'AND', 'LLP', 'INC', 'CORP', 'CORPORATION', 'ENTERPRISE', 'ENTERPRISES', 'INDIA',
]);

/** "M/s. Pranay Udyog Pvt. Ltd." -> "PRANAY UDYOG". */
export function companyKey(name) {
  return normaliseName(name).split(' ').filter((t) => t && !NOISE.has(t)).join(' ');
}

/** Share of words two names have in common (Dice), 0..1. */
function nameSimilarity(a, b) {
  const x = new Set(companyKey(a).split(' ').filter(Boolean));
  const y = new Set(companyKey(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return (2 * common) / (x.size + y.size);
}

const isSupplierType = (l) => !l.LedgerType || SUPPLIER_LEDGER_TYPES.includes(l.LedgerType);

/**
 * Order candidates sharing a GSTIN or a name: active first, then the most
 * recent PO, then the closest name.
 */
function rank(candidates, { name, lastPoDate }) {
  return [...candidates].sort((a, b) =>
    Number(Boolean(b.ISLedgerActive)) - Number(Boolean(a.ISLedgerActive))
    || (lastPoDate.get(Number(b.LedgerID)) || 0) - (lastPoDate.get(Number(a.LedgerID)) || 0)
    || nameSimilarity(name, b.LedgerName) - nameSimilarity(name, a.LedgerName));
}

/** Accept a name match this close, if it is also clearly ahead of the next. */
export const NAME_ACCEPT = 0.8;
const NAME_MARGIN = 0.15;

/**
 * @param {Object} input
 * @param {Array}  input.ledgers     LedgerMaster rows: LedgerID, LedgerName, GSTNo, LedgerType, ISLedgerActive
 * @param {string} [input.gstin]     the supplier GSTIN read off the invoice
 * @param {string} [input.name]      the supplier name read off the invoice
 * @param {Map}    [input.lastPoDate] LedgerID -> time of its latest PO, for ties
 * @returns {{ledgerId: number|null, ledgerName?: string, matchedBy?: 'GSTIN'|'NAME', evidence: string}}
 */
export function identifySupplierLedger({ ledgers = [], gstin, name, lastPoDate = new Map() }) {
  const suppliers = ledgers.filter(isSupplierType);
  const read = normaliseGstin(gstin);
  const cdc = normaliseGstin(CDC_IDENTITY.gstin);
  const notes = [];

  // A model can read CDC's own GSTIN - the buyer's - as the supplier's.
  if (read && read === cdc) notes.push(`the GSTIN read (${read}) is CDC's own, so it was not used`);

  if (read && read !== cdc) {
    const byGstin = suppliers.filter((l) => normaliseGstin(l.GSTNo) === read);
    if (byGstin.length) {
      const [best] = rank(byGstin, { name, lastPoDate });
      const others = byGstin.length - 1;
      return {
        ledgerId: Number(best.LedgerID),
        ledgerName: best.LedgerName,
        matchedBy: 'GSTIN',
        evidence: `GSTIN ${read} on the invoice`
          + (others ? ` (on ${others + 1} supplier ledgers; this one has the most recent PO)` : ''),
      };
    }
    notes.push(`GSTIN ${read} is on no supplier ledger`);
  }

  if (name) {
    const key = companyKey(name);
    const exact = key ? suppliers.filter((l) => companyKey(l.LedgerName) === key) : [];
    if (exact.length) {
      const [best] = rank(exact, { name, lastPoDate });
      return {
        ledgerId: Number(best.LedgerID),
        ledgerName: best.LedgerName,
        matchedBy: 'NAME',
        evidence: `the supplier name "${name}"${notes.length ? ` - ${notes.join('; ')}` : ''}`,
      };
    }

    const scored = suppliers
      .map((l) => ({ l, s: nameSimilarity(name, l.LedgerName) }))
      .sort((a, b) => b.s - a.s);
    const [first, second] = scored;
    if (first && first.s >= NAME_ACCEPT && first.s - (second ? second.s : 0) >= NAME_MARGIN) {
      return {
        ledgerId: Number(first.l.LedgerID),
        ledgerName: first.l.LedgerName,
        matchedBy: 'NAME',
        evidence: `the supplier name "${name}", close to "${first.l.LedgerName}"`
          + (notes.length ? ` - ${notes.join('; ')}` : ''),
      };
    }
    notes.push(`no supplier ledger is clearly called "${name}"`);
  }

  return {
    ledgerId: null,
    evidence: notes.length ? `Could not tell: ${notes.join('; ')}.` : 'The invoice shows no supplier GSTIN or name.',
  };
}

/** Read the supplier ledgers (and, for ties, their latest POs) and identify. */
export async function identifyInvoiceSupplier(site, { gstin, name }) {
  assertSite(site);
  const ledgers = await supplierLedgers(site);

  // Only worth a query when several supplier ledgers share the GSTIN or name.
  const read = normaliseGstin(gstin);
  const key = companyKey(name);
  const tied = ledgers.filter((l) => (read && normaliseGstin(l.GSTNo) === read)
    || (key && companyKey(l.LedgerName) === key));
  const lastPoDate = new Map();
  if (tied.length > 1) {
    const ids = tied.map((l) => Number(l.LedgerID)).filter(Number.isFinite).join(',');
    const rows = await query(site, `
      SELECT LedgerID, MAX(VoucherDate) AS LastPo
      FROM ItemTransactionMain
      WHERE CompanyID = @companyId AND VoucherID = @po AND LedgerID IN (${ids})
        AND ISNULL(IsDeletedTransaction,0) = 0
      GROUP BY LedgerID
    `, { companyId: COMPANY_ID, po: VOUCHER.PURCHASE_ORDER });
    for (const r of rows) lastPoDate.set(Number(r.LedgerID), new Date(r.LastPo).getTime());
  }

  return identifySupplierLedger({ ledgers, gstin, name, lastPoDate });
}
