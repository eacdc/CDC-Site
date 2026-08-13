/**
 * Build the DB helper callbacks used by the verification engine.
 * Separated so routes and the background queue can share the same logic.
 */
import { PurchaseBill } from '../db-purchase-bills.js';

export function buildDbHelpers(excludeId) {
  const exclude = excludeId ? { _id: { $ne: excludeId } } : {};
  return {
    findExistingByDedupKey: async (key) => {
      if (!key) return null;
      return PurchaseBill.findOne({ bill_dedup_key: key, ...exclude }).lean();
    },
    findExistingByDedupKeys: async (keys) => {
      const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
      if (list.length === 0) return null;
      return PurchaseBill.findOne({ bill_dedup_key: { $in: list }, ...exclude }).lean();
    },
    findByTallyVoucher: async (no) => {
      if (!no) return null;
      return PurchaseBill.findOne({ tally_voucher_number: no, ...exclude }).lean();
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
