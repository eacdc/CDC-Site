/**
 * Most specific first: an exact groupId+category rule beats a "*"+category
 * rule, which beats DEFAULT_OWNER_PHONE. Returns null only when there is no
 * default configured either — in which case nobody can be alerted, and the
 * caller must say so loudly rather than dropping the concern.
 */
export function resolveRouting(groupId, category, rows, defaults) {
  const exact = rows.find((r) => r.groupId === groupId && r.category === category);
  const wildcard = rows.find((r) => r.groupId === '*' && r.category === category);
  const row = exact ?? wildcard;

  if (row) {
    return {
      ownerPhone: row.ownerPhone,
      cooldownMin: row.cooldownMin ?? defaults.cooldownMin,
      escalateAfterMin: row.escalateAfterMin ?? defaults.escalateAfterMin,
      matched: exact ? 'group_category' : 'any_group_category',
    };
  }

  if (!defaults.ownerPhone) return null;
  return {
    ownerPhone: defaults.ownerPhone,
    cooldownMin: defaults.cooldownMin,
    escalateAfterMin: defaults.escalateAfterMin,
    matched: 'default',
  };
}
