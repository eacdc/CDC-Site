/**
 * Build the DB helper callbacks used by the verification engine.
 * Separated so routes and the background queue can share the same logic.
 */
import { PurchaseBill } from '../db-purchase-bills.js';
import { DEFAULT_LOCATION, parseLocation } from '../config/cdc.js';
import { listDedupBases, listSameYearDedupKeys } from './purchase-bill-dedup.js';

export function buildDbHelpers(excludeId) {
  const exclude = excludeId ? { _id: { $ne: excludeId } } : {};
  return {
    // The original of this supplier + invoice + year. Only bills holding a key
    // count: a bill flagged as a duplicate gives its key up, so the original
    // is never reported as a duplicate of its copy.
    findDuplicateOriginal: async (bill) => {
      const bases = listDedupBases(bill);
      if (bases.length === 0) return null;
      const keys = listSameYearDedupKeys(bill);
      const filter = keys.length
        ? { bill_dedup_key: { $in: keys } }
        : { bill_dedup_base: { $in: bases }, bill_dedup_key: { $type: 'string' } };
      return PurchaseBill.findOne({ ...filter, ...exclude }).sort({ uploaded_at: 1 }).lean();
    },
    // Same supplier + invoice in another financial year (allowed, but worth a look).
    findDedupOtherYears: async (bill) => {
      const keys = listSameYearDedupKeys(bill);
      if (keys.length === 0) return [];
      return PurchaseBill.find(
        { bill_dedup_base: { $in: listDedupBases(bill) }, bill_dedup_key: { $type: 'string', $nin: keys }, ...exclude },
        '_id invoice_number invoice_date bill_dedup_key',
      ).limit(5).lean();
    },
    // Voucher numbers repeat across locations, so only the bill's own location counts.
    findByTallyVoucher: async (no, _excludeId, location) => {
      if (!no) return null;
      return PurchaseBill.findOne({
        tally_voucher_number: no,
        location: parseLocation(location) || DEFAULT_LOCATION,
        ...exclude,
      }).lean();
    },
    findByImageHashCandidates: async () => {
      const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000);
      return PurchaseBill.find(
        { invoice_image_phash: { $ne: null, $exists: true }, uploaded_at: { $gte: oneYearAgo }, ...exclude },
        '_id invoice_number invoice_image_phash',
      ).lean();
    },
    findSimilarBills: async (gstin, date, amount, tolerance, daysBack) => {
      if (!gstin || !date || amount == null) return [];
      const d = date instanceof Date ? date : new Date(date);
      const start = new Date(d.getTime() - daysBack * 86400 * 1000);
      return PurchaseBill.find({
        supplier_gstin: gstin,
        invoice_date: { $gte: start, $lte: new Date(d.getTime() + 86400 * 1000) },
        grand_total: { $gte: amount - tolerance, $lte: amount + tolerance },
        ...exclude,
      }, '_id invoice_number invoice_date grand_total supplier_name').lean();
    },
  };
}
