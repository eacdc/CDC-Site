/**
 * Most specific first:
 *
 *   1. an exact groupId+category rule
 *   2. the group's own person, set on the group in Admin
 *   3. a "*"+category rule
 *   4. DEFAULT_OWNER_PHONE
 *
 * The group's person sits above the wildcard on purpose. A client group has one
 * person who owns that customer, and they should get everything from that group
 * without somebody writing eight routing rows - one per category - to say so.
 * A rule naming both this group and this category is still more specific, so it
 * stays on top.
 *
 * Returns null only when there is no default configured either — in which case
 * nobody can be alerted, and the caller must say so loudly rather than dropping
 * the concern.
 */
export function resolveRouting(groupId, category, rows, defaults) {
  const fromRow = (row, matched) => ({
    ownerPhone: row.ownerPhone,
    cooldownMin: row.cooldownMin ?? defaults.cooldownMin,
    escalateAfterMin: row.escalateAfterMin ?? defaults.escalateAfterMin,
    matched,
  });

  const exact = rows.find((r) => r.groupId === groupId && r.category === category);
  if (exact) return fromRow(exact, 'group_category');

  if (defaults.groupOwnerPhone) {
    return {
      ownerPhone: defaults.groupOwnerPhone,
      cooldownMin: defaults.cooldownMin,
      escalateAfterMin: defaults.escalateAfterMin,
      matched: 'group',
    };
  }

  const wildcard = rows.find((r) => r.groupId === '*' && r.category === category);
  if (wildcard) return fromRow(wildcard, 'any_group_category');

  if (!defaults.ownerPhone) return null;
  return {
    ownerPhone: defaults.ownerPhone,
    cooldownMin: defaults.cooldownMin,
    escalateAfterMin: defaults.escalateAfterMin,
    matched: 'default',
  };
}
