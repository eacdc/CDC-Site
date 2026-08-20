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
import { supplierLedgers, suppliedItemGroups } from './erp-ledgers.js';
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
 * Map every supplier ledger at a site to a group, returning the ones that
 * could not be placed. Unplaced ledgers are surfaced rather than auto-grouped:
 * a wrong grouping silently corrupts every comparison that follows, and the
 * cost of asking is one screen.
 *
 * @returns {Promise<{assigned: number, unmatched: Array}>}
 */
export async function reconcileLedgers(site, { autoCreate = false } = {}) {
  await ensureSupplierPortalReady();
  const ledgers = await supplierLedgers(site);
  const groups = await SupplierGroup.find({}).lean();

  const assignedIds = new Set(
    groups.flatMap((g) => ledgerIdsForSite(g, site)),
  );

  const unmatched = [];
  let assigned = 0;

  for (const ledger of ledgers) {
    if (assignedIds.has(ledger.LedgerID)) continue;

    const suggestion = suggestGroup(ledger.LedgerName, groups);
    if (suggestion && suggestion.score >= 0.85) {
      await SupplierGroup.updateOne(
        { _id: suggestion.group._id },
        { $addToSet: { ledgerRefs: { site, ledgerId: ledger.LedgerID } } },
      );
      assigned += 1;
      continue;
    }

    if (autoCreate) {
      // A ledger with no plausible group becomes its own group. That is the
      // honest default: it says "one supplier, one ledger" rather than
      // guessing at a relationship nobody has confirmed.
      const created = await SupplierGroup.create({
        name: ledger.LedgerName.trim(),
        ledgerRefs: [{ site, ledgerId: ledger.LedgerID }],
        isInternal: INTERNAL_LEDGER_PATTERNS.some((p) => p.test(ledger.LedgerName || '')),
      });
      groups.push(created.toObject());
      assigned += 1;
      continue;
    }

    unmatched.push({
      ledgerId: ledger.LedgerID,
      ledgerName: ledger.LedgerName,
      suggestion: suggestion
        ? { groupId: suggestion.group._id, name: suggestion.group.name, score: suggestion.score }
        : null,
    });
  }

  return { assigned, unmatched };
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
  let updated = 0;

  for (const group of groups) {
    const ledgerIds = ledgerIdsForSite(group, site);
    if (!ledgerIds.length) continue;
    const itemGroupIds = await suppliedItemGroups(site, ledgerIds);
    if (!itemGroupIds.length) continue;
    await SupplierGroup.updateOne(
      { _id: group._id },
      { $addToSet: { historicalItemGroupIds: { $each: itemGroupIds } } },
    );
    updated += 1;
  }

  return { updated };
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
