/**
 * Builds the v2 matching profile by overlaying config/profile.v2.json onto the
 * shared config/profile.json.
 *
 * The overlay carries only what defines the v2 matching model. Search terms,
 * engagement signals, skills, penalties and the location gate are inherited, so
 * the two boards see exactly the same postings and differ only in how those
 * postings are scored. A copied profile would drift the moment a search term was
 * added to one and not the other, and the comparison would quietly stop meaning
 * anything.
 */

/** Deep-merges only what the overlay actually sets; arrays replace wholesale. */
function mergeRanking(base, overlay) {
  return { ...base, ...(overlay || {}) };
}

export function buildV2Profile(base, overlay) {
  if (!overlay) return null;

  const dropped = new Set(overlay.dropTitleGroups || []);
  const overrides = overlay.overrideTitlePhrases || {};

  const titles = base.titles
    .filter((group) => !dropped.has(group.label))
    .map((group) => (overrides[group.label] ? { ...group, phrases: overrides[group.label] } : group));

  return {
    ...base,
    titles,
    capabilities: overlay.capabilities || [],
    roleFamilies: overlay.roleFamilies || [],
    ranking: mergeRanking(base.ranking, overlay.ranking),
  };
}
