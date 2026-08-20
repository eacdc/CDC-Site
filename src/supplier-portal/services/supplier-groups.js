/**
 * Supplier grouping.
 *
 * One supplier commonly has several LedgerIDs — Siegwerk has five, split by
 * branch — and LedgerIDs are per-database, so the same firm has a different id
 * in Kolkata and Ahmedabad. Grouping them is mandatory: without it "who is
 * cheapest" compares branches against each other and supplier scoring
 * fragments into meaningless slices.
 *
 * Grouping also has to survive two cases that are not branches at all:
 *
 *   - **Trader vs principal.** Kamal Enterprises quotes KK 2102 and KK Easy
 *     Bond; the POs are raised on K K Emulsions Pvt Ltd. Same commercial
 *     relationship, two legal entities.
 *   - **Renames and second identities.** SR Graphic and Neographic are one
 *     firm — Neographics quotes are signed "For SR Graphic".
 */

import {
  ensureSupplierPortalReady, SupplierGroup, SupplierItem, RateHistory,
} from '../db/mongo.js';
import { supplierLedgers, suppliedItemGroupsByLedger } from './erp-ledgers.js';
import { normaliseName, tokenSetRatio } from '../lib/text.js';
import { INTERNAL_LEDGER_PATTERNS } from '../config/constants.js';

/**
 * Groups CDC confirmed in August 2026. Seeded on first run so the initial
 * mapping pass is not blocked on a grouping exercise; the purchase team edits
 * them afterwards through the admin screen.
 */
export const SEED_GROUPS = [
  { name: 'Siegwerk', aliases: ['Siegwerk India', 'SIEGWORK', 'Siegwerk India Pvt Ltd'] },
  { name: 'Kodak', aliases: ['Kodak India', 'KODAK INDIA PRIVATE LIMITED'] },
  { name: 'Kurz', aliases: ['Kurz India', 'Kurz India Pvt Ltd'] },
  { name: 'Pidilite', aliases: ['Pidilite Industries'] },
  { name: 'Bagla', aliases: ['Bagla Polifilms', 'BAGLA POLIFILMS LIMITED'] },
  { name: 'GSN', aliases: ['GSN Udyog', 'GSN Packaging'] },
  // Same firm under two names; Neographics quotes are signed "For SR Graphic".
  { name: 'SR Graphic', aliases: ['Neographic', 'Neographics'] },
  // Trader and principal: quotes arrive from one, POs go to the other.
  { name: 'K K Emulsions', aliases: ['Kamal Enterprises', 'KK Emulsions'], tradesAs: ['Kamal Enterprises'] },
];

/** Fetch every group, with ledger refs resolved for a site. */
export async function listGroups({ includeInternal = false } = {}) {
  await ensureSupplierPortalReady();
  const filter = includeInternal ? {} : { isInternal: { $ne: true } };
  return SupplierGroup.find(filter).sort({ name: 1 }).lean();
}

/** The ledger ids a group trades under at one site. */
export function ledgerIdsForSite(group, site) {
  if (!group?.ledgerRefs?.length) return [];
  return group.ledgerRefs.filter((r) => r.site === site).map((r) => r.ledgerId);
}

/** Find the group a ledger belongs to. */
export async function groupForLedger(site, ledgerId) {
  await ensureSupplierPortalReady();
  return SupplierGroup.findOne({
    ledgerRefs: { $elemMatch: { site, ledgerId: Number(ledgerId) } },
  }).lean();
}

/**
 * Map every supplier ledger at a site to a group.
 *
 * Two modes, and the choice between them is about scale rather than taste.
 *
 * Without `autoCreate`, unplaced ledgers come back for a human to place. That
 * is right when there are a dozen: a wrong grouping silently corrupts every
 * comparison that follows, and the cost of asking is one screen.
 *
 * With `autoCreate`, each unplaced ledger becomes its own group. That is right
 * on a first run, where CDC's ERP holds ~1,300 supplier ledgers and there are
 * eight groups to match against — a screen offering 1,300 dropdowns of eight
 * options is not asking a question, it is refusing to start. One group per
 * ledger is the honest default: it asserts "one supplier, one ledger" rather
 * than guessing at a relationship nobody has confirmed, and the branches that
 * do belong together get merged later, when somebody notices.
 *
 * Everything is done in bulk. At this size a round trip per ledger is not slow
 * so much as fatal — it outlives the request.
 *
 * @returns {Promise<{assigned: number, created: number, unmatched: Array, gstins: Object}>}
 */
export async function reconcileLedgers(site, { autoCreate = false } = {}) {
  await ensureSupplierPortalReady();
  const ledgers = await supplierLedgers(site);
  const groups = await SupplierGroup.find({}).lean();

  const assignedIds = new Set(groups.flatMap((g) => ledgerIdsForSite(g, site)));
  const byName = new Map(groups.map((g) => [normaliseName(g.name), g]));

  const links = [];       // ledgers going onto an existing group
  const fresh = new Map(); // new groups, keyed by normalised name
  const unmatched = [];

  for (const ledger of ledgers) {
    if (assignedIds.has(ledger.LedgerID)) continue;

    const suggestion = suggestGroup(ledger.LedgerName, groups);
    if (suggestion && suggestion.score >= 0.85) {
      links.push({ groupId: suggestion.group._id, ledgerId: ledger.LedgerID });
      continue;
    }

    if (!autoCreate) {
      unmatched.push({
        ledgerId: ledger.LedgerID,
        ledgerName: ledger.LedgerName,
        suggestion: suggestion
          ? { groupId: suggestion.group._id, name: suggestion.group.name, score: suggestion.score }
          : null,
      });
      continue;
    }

    const name = String(ledger.LedgerName || '').trim();
    if (!name) continue;
    const key = normaliseName(name);

    // A name already on file — whether from a previous run or from a group
    // created moments ago in this loop — takes the ledger rather than causing
    // a duplicate-key failure that would abort the whole reconciliation.
    const existing = byName.get(key);
    if (existing) {
      links.push({ groupId: existing._id, ledgerId: ledger.LedgerID });
      continue;
    }

    const already = fresh.get(key);
    if (already) {
      // Two ledgers printing the identical name are one supplier, not a
      // collision. Both refs go on the one group.
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
    // stopping for — the ledger simply stays unplaced until the next run.
    const result = await SupplierGroup.insertMany([...fresh.values()], {
      ordered: false,
      rawResult: true,
    }).catch((err) => err.result || err);
    created = result?.insertedCount ?? result?.nInserted ?? fresh.size;
  }

  const gstins = await harvestGstins(site, ledgers);

  return { assigned: links.length, created, unmatched, gstins };
}

/**
 * Copy each ledger's GSTIN onto the group that owns it.
 *
 * Run as part of reconciliation rather than on demand because the value of a
 * GSTIN is being there *before* the quote arrives: identification falls back to
 * fuzzy name matching for any supplier whose number has not been harvested yet.
 *
 * `$addToSet` is deliberate — a supplier that re-registers keeps both numbers,
 * and an old GSTIN still identifies the older documents correctly.
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
 * Best-matching group for a ledger name. Compares against the group name and
 * every alias, and strips the corporate suffixes that carry no identity —
 * "Pvt Ltd" matching "Pvt Ltd" is not evidence of anything.
 */
export function suggestGroup(ledgerName, groups) {
  const candidate = stripCorporateSuffixes(ledgerName);
  let best = null;

  for (const group of groups) {
    const names = [group.name, ...(group.aliases || []), ...(group.tradesAs || [])];
    for (const name of names) {
      const score = tokenSetRatio(candidate, stripCorporateSuffixes(name));
      if (!best || score > best.score) best = { group, score, matchedOn: name };
    }
  }

  return best && best.score > 0 ? best : null;
}

const CORPORATE_SUFFIXES = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CO|COMPANY|INDIA|ENTERPRISES?|INDUSTRIES|UDYOG|TRADING|TRADERS?)\b/g;

/** Also drops a trailing branch in parentheses: "Siegwerk (Haryana)". */
export function stripCorporateSuffixes(name) {
  return normaliseName(String(name ?? '').replace(/\([^)]*\)/g, ' '))
    .replace(CORPORATE_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Create the confirmed groups if they do not exist yet. Idempotent. */
export async function seedGroups() {
  await ensureSupplierPortalReady();
  let created = 0;
  for (const seed of SEED_GROUPS) {
    const existing = await SupplierGroup.findOne({ name: seed.name });
    if (existing) continue;
    await SupplierGroup.create({ ...seed, ledgerRefs: [] });
    created += 1;
  }
  return { created, total: SEED_GROUPS.length };
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
  // group instead means ~1,300 round trips to MSSQL and ~1,300 to Mongo, which
  // is not slow so much as fatal — it outlives the request.
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
 * Merge one group into another: ledger refs, aliases, supplier items and rate
 * history all move. Used when the purchase team discovers two groups are the
 * same firm — SR Graphic and Neographic before anyone knew.
 */
export async function mergeGroups(sourceId, targetId, { actor } = {}) {
  await ensureSupplierPortalReady();
  if (String(sourceId) === String(targetId)) {
    throw new Error('Cannot merge a supplier group into itself.');
  }

  const [source, target] = await Promise.all([
    SupplierGroup.findById(sourceId).lean(),
    SupplierGroup.findById(targetId).lean(),
  ]);
  if (!source) throw new Error(`Supplier group ${sourceId} not found`);
  if (!target) throw new Error(`Supplier group ${targetId} not found`);

  await SupplierGroup.updateOne({ _id: target._id }, {
    $addToSet: {
      ledgerRefs: { $each: source.ledgerRefs || [] },
      aliases: { $each: [source.name, ...(source.aliases || [])] },
      tradesAs: { $each: source.tradesAs || [] },
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
