/**
 * Suppliers.
 *
 * A supplier here is one ERP ledger, and every supplier ledger becomes one on
 * sync. There is no grouping step: nobody creates a supplier, and nobody
 * assigns a quote to one before uploading it.
 *
 * That is a deliberate reversal. The earlier design made "supplier group" a
 * concept the purchase team had to maintain — seed a group, place 1,279
 * ledgers into it, then upload against it — on the theory that comparison
 * needs branches unified. It does not. If two ledgers are the same firm and
 * both quote the same rate, the PO check stays quiet either way; if one is
 * cheaper, you want to see it whether or not the system knows they are
 * related. Grouping bought two narrow things and cost a week of data entry.
 *
 * What it did buy, and why a supplier is still its own record rather than a
 * bare LedgerID:
 *
 *   - **Rate history across a rename.** Neographic this year, SR Graphic next.
 *     Ledger-keyed, the second quote has nothing to compare against and the
 *     price-increase check never fires.
 *   - **Cross-plant.** LedgerIDs are per-database — Print Sales has one id in
 *     `IndusEnterprise` and an unrelated one in `IndusEnterprise2`. Keyed on
 *     the raw id, Kolkata's negotiated rate is invisible to Ahmedabad forever,
 *     with no way to ever connect the two.
 *
 * Both are answered by `mergeGroups`, which is a pointer change precisely
 * because a supplier is its own record. Keyed on LedgerIDs, merging would be a
 * data migration and would therefore never happen.
 *
 * So: independent by default, merged when somebody notices. The word "group"
 * does not appear in the interface; it survives here only as the collection
 * name, which is not worth a migration to change.
 */

import {
  ensureSupplierPortalReady, SupplierGroup, SupplierItem, RateHistory,
} from '../db/mongo.js';
import { supplierLedgers, suppliedItemGroupsByLedger } from './erp-ledgers.js';
import { normaliseName, tokenSetRatio } from '../lib/text.js';
import { INTERNAL_LEDGER_PATTERNS } from '../config/constants.js';

/** Fetch every supplier. */
export async function listGroups({ includeInternal = false } = {}) {
  await ensureSupplierPortalReady();
  const filter = includeInternal ? {} : { isInternal: { $ne: true } };
  return SupplierGroup.find(filter).sort({ name: 1 }).lean();
}

/**
 * Suppliers whose name or alias contains `q`, for the type-ahead on the
 * confirmation screen.
 *
 * Substring rather than fuzzy: this backs a box someone is typing into, where
 * they already know roughly what they are looking for. Fuzzy ranking is for
 * `suggestGroup`, which has to guess without being told anything.
 */
export async function searchGroups(q, { limit = 20, includeInternal = false } = {}) {
  await ensureSupplierPortalReady();

  const filter = includeInternal ? {} : { isInternal: { $ne: true } };
  const text = String(q ?? '').trim();
  if (text) {
    // Escaped — a supplier name containing "(" would otherwise be an invalid
    // expression and throw rather than simply not matching.
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { aliases: rx }];
  }

  return SupplierGroup.find(filter).sort({ name: 1 }).limit(limit).lean();
}

/** The ledger ids a supplier trades under at one site. */
export function ledgerIdsForSite(group, site) {
  if (!group?.ledgerRefs?.length) return [];
  return group.ledgerRefs.filter((r) => r.site === site).map((r) => r.ledgerId);
}

/** Find the supplier a ledger belongs to. */
export async function groupForLedger(site, ledgerId) {
  await ensureSupplierPortalReady();
  return SupplierGroup.findOne({
    ledgerRefs: { $elemMatch: { site, ledgerId: Number(ledgerId) } },
  }).lean();
}

/**
 * Sync suppliers from the ERP: every supplier ledger at this site that has no
 * supplier record gets one.
 *
 * Linking an existing supplier to a new ledger happens **only on an exact
 * normalised name**. Fuzzy matching used to link automatically at 0.85, and
 * that threshold is where the design was actively wrong: `stripCorporateSuffixes`
 * removes "Pvt", "Ltd", "India", "Enterprises", "Trading" — so "Print India
 * Solution", "India Sales Agency" and "Graphic Sales" all collapse toward each
 * other and toward "Print Sales". Silently linking two unrelated firms
 * corrupts every rate comparison that follows, and nothing about the result
 * looks wrong afterwards. Fuzzy is still computed, but only as a *suggestion*
 * a person acts on — see `suggestGroup`.
 *
 * Everything runs in bulk. At ~1,300 ledgers a round trip each is not slow so
 * much as fatal — it outlives the request.
 *
 * @returns {Promise<{assigned: number, created: number, total: number, gstins: Object}>}
 */
export async function reconcileLedgers(site) {
  await ensureSupplierPortalReady();
  const ledgers = await supplierLedgers(site);
  const groups = await SupplierGroup.find({}).lean();

  const assignedIds = new Set(groups.flatMap((g) => ledgerIdsForSite(g, site)));

  // Exact normalised name → supplier, across names and aliases alike.
  const byName = new Map();
  for (const group of groups) {
    for (const label of [group.name, ...(group.aliases || [])]) {
      const key = normaliseName(label);
      if (key && !byName.has(key)) byName.set(key, group);
    }
  }

  const links = [];        // ledgers joining an existing supplier
  const fresh = new Map(); // new suppliers, keyed by normalised name

  for (const ledger of ledgers) {
    if (assignedIds.has(ledger.LedgerID)) continue;

    const name = String(ledger.LedgerName || '').trim();
    if (!name) continue;
    const key = normaliseName(name);
    if (!key) continue;

    // A name already on file — from an earlier run or from a supplier created
    // moments ago in this same loop — takes the ledger, rather than causing a
    // duplicate-key failure that would abort the whole sync.
    const existing = byName.get(key);
    if (existing) {
      links.push({ groupId: existing._id, ledgerId: ledger.LedgerID });
      continue;
    }

    const already = fresh.get(key);
    if (already) {
      // Two ledgers printing the identical name are one supplier, not a
      // collision. Both refs go on the one record.
      already.ledgerRefs.push({ site, ledgerId: ledger.LedgerID });
      continue;
    }

    fresh.set(key, {
      name,
      ledgerRefs: [{ site, ledgerId: ledger.LedgerID }],
      isInternal: INTERNAL_LEDGER_PATTERNS.some((p) => p.test(name)),
    });
  }

  if (links.length) {
    await SupplierGroup.bulkWrite(links.map(({ groupId, ledgerId }) => ({
      updateOne: {
        filter: { _id: groupId },
        update: { $addToSet: { ledgerRefs: { site, ledgerId } } },
      },
    })), { ordered: false });
  }

  let created = 0;
  if (fresh.size) {
    // `ordered: false` so one bad row cannot abort the rest. A duplicate name
    // racing in from another session is the expected failure and is not worth
    // stopping for — the ledger stays unplaced until the next sync.
    const result = await SupplierGroup.insertMany([...fresh.values()], {
      ordered: false,
      rawResult: true,
    }).catch((err) => err.result || err);
    created = result?.insertedCount ?? result?.nInserted ?? fresh.size;
  }

  const gstins = await harvestGstins(site, ledgers);

  return { assigned: links.length, created, total: ledgers.length, gstins };
}

/**
 * Copy each ledger's GSTIN onto the supplier that owns it.
 *
 * Run as part of the sync rather than on demand because the value of a GSTIN
 * is being there *before* the quote arrives. Most quotes do not print one, so
 * this is not the common path — but when a document does carry one it settles
 * the identification outright instead of asking a person to choose.
 *
 * `$addToSet` is deliberate — a supplier that re-registers keeps both numbers,
 * and the old GSTIN still identifies the older documents correctly.
 */
export async function harvestGstins(site, ledgers = null) {
  await ensureSupplierPortalReady();
  const rows = ledgers || await supplierLedgers(site);

  const ops = [];
  for (const ledger of rows) {
    const gstin = normaliseGstin(ledger.GSTNo);
    if (!gstin) continue;
    ops.push({
      updateOne: {
        filter: { ledgerRefs: { $elemMatch: { site, ledgerId: ledger.LedgerID } } },
        update: { $addToSet: { gstins: gstin } },
      },
    });
  }

  if (!ops.length) return { updated: 0, withGstin: 0 };

  // One round trip. A thousand ledgers is a thousand updates, and sending them
  // one at a time takes longer than the request it is serving.
  const result = await SupplierGroup.bulkWrite(ops, { ordered: false });
  return { updated: result.modifiedCount || 0, withGstin: ops.length };
}

/** 15 characters, upper case, punctuation stripped. Anything else is not one. */
export function normaliseGstin(value) {
  const text = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return text.length === 15 ? text : null;
}

/**
 * Rank suppliers against a name read off a document, best first.
 *
 * Only ever a suggestion. The output narrows 1,279 suppliers to the handful
 * worth looking at, and a person picks — which is the right division of
 * labour, because a letterhead reading "PRINT SALES PRIVATE LIMITED" against a
 * ledger reading "Print Sales Pvt Ltd" is obvious to a human and merely
 * probable to a scorer.
 *
 * Corporate suffixes are stripped before scoring: "Pvt Ltd" matching "Pvt Ltd"
 * is not evidence of anything, and letting it count scores every Indian
 * company against every other.
 */
export function suggestGroups(readName, groups, { limit = 6, floor = 0.3 } = {}) {
  const candidate = stripCorporateSuffixes(readName);
  if (!candidate) return [];

  return groups
    .filter((g) => !g.isInternal)
    .map((group) => {
      let best = { score: 0, matchedOn: group.name };
      for (const label of [group.name, ...(group.aliases || [])]) {
        const score = tokenSetRatio(candidate, stripCorporateSuffixes(label));
        if (score > best.score) best = { score, matchedOn: label };
      }
      return { group, ...best };
    })
    .filter((row) => row.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** The single best match, or null. Thin wrapper over `suggestGroups`. */
export function suggestGroup(ledgerName, groups) {
  return suggestGroups(ledgerName, groups, { limit: 1, floor: 0 })[0] || null;
}

const CORPORATE_SUFFIXES = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CO|COMPANY|INDIA|ENTERPRISES?|INDUSTRIES|UDYOG|TRADING|TRADERS?)\b/g;

/** Also drops a trailing branch in parentheses: "Siegwerk (Haryana)". */
export function stripCorporateSuffixes(name) {
  return normaliseName(String(name ?? '').replace(/\([^)]*\)/g, ' '))
    .replace(CORPORATE_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Refresh the item groups a supplier has historically supplied. Tier 0 of the
 * matcher restricts candidates to these, which is what keeps an ink supplier's
 * quote away from shipper cartons.
 */
export async function refreshHistoricalGroups(site) {
  await ensureSupplierPortalReady();
  const groups = await SupplierGroup.find({}).lean();

  // One ERP scan for every ledger at the site, then one bulk write. Asking per
  // supplier instead means ~1,300 round trips to MSSQL and ~1,300 to Mongo,
  // which is not slow so much as fatal — it outlives the request.
  const allLedgerIds = groups.flatMap((g) => ledgerIdsForSite(g, site));
  const byLedger = await suppliedItemGroupsByLedger(site, allLedgerIds);

  const ops = [];
  for (const group of groups) {
    const itemGroupIds = [...new Set(
      ledgerIdsForSite(group, site).flatMap((id) => byLedger.get(id) || []),
    )];
    if (!itemGroupIds.length) continue;
    ops.push({
      updateOne: {
        filter: { _id: group._id },
        update: { $addToSet: { historicalItemGroupIds: { $each: itemGroupIds } } },
      },
    });
  }

  if (!ops.length) return { updated: 0, groups: groups.length };
  await SupplierGroup.bulkWrite(ops, { ordered: false });

  return { updated: ops.length, groups: groups.length };
}

/**
 * Merge one supplier into another: ledger refs, aliases, GSTINs, supplier items
 * and rate history all move, and the source name is kept as an alias so a
 * future quote printing it still identifies.
 *
 * This is the correction path for the whole design. Suppliers are independent
 * by default and merged when somebody notices two are the same firm — SR
 * Graphic and Neographic, or a Kolkata ledger and its Ahmedabad counterpart.
 */
export async function mergeGroups(sourceId, targetId, { actor } = {}) {
  await ensureSupplierPortalReady();
  if (String(sourceId) === String(targetId)) {
    throw new Error('Cannot merge a supplier into itself.');
  }

  const [source, target] = await Promise.all([
    SupplierGroup.findById(sourceId).lean(),
    SupplierGroup.findById(targetId).lean(),
  ]);
  if (!source) throw new Error(`Supplier ${sourceId} not found`);
  if (!target) throw new Error(`Supplier ${targetId} not found`);

  await SupplierGroup.updateOne({ _id: target._id }, {
    $addToSet: {
      ledgerRefs: { $each: source.ledgerRefs || [] },
      aliases: { $each: [source.name, ...(source.aliases || [])] },
      gstins: { $each: source.gstins || [] },
      historicalItemGroupIds: { $each: source.historicalItemGroupIds || [] },
    },
  });

  const [items, rates] = await Promise.all([
    SupplierItem.updateMany({ supplierGroupId: source._id }, { $set: { supplierGroupId: target._id } }),
    RateHistory.updateMany({ supplierGroupId: source._id }, { $set: { supplierGroupId: target._id } }),
  ]);

  await SupplierGroup.deleteOne({ _id: source._id });

  return {
    mergedInto: target.name,
    movedItems: items.modifiedCount,
    movedRates: rates.modifiedCount,
    actor: actor || null,
  };
}
