/**
 * Builds the v2 and v3 matching profiles by overlaying config/profile.v2.json
 * and config/profile.v3.json onto the shared config/profile.json.
 *
 * Each overlay carries only what defines its matching model. Search terms,
 * engagement signals, skills, penalties and the location gate are inherited, so
 * every board sees exactly the same postings and they differ only in how those
 * postings are scored. A copied profile would drift the moment a search term was
 * added to one and not the others, and the comparison would quietly stop meaning
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

/**
 * v3 replaces the matching model wholesale rather than editing v1's title
 * groups: it scores four axes off its own vocabulary and never reads `titles`,
 * `skills` or `context`. What it does inherit is everything that decides which
 * postings exist at all — the search terms, the location gate, the shared
 * penalties and the hard title exclusions — plus `engagement`, which it uses
 * only to set the contract/freelance flag the board filters on.
 *
 * Its `search` block is merged rather than replaced, so it keeps the shared
 * blocked domains and age ceiling while setting its own publish threshold.
 */
export function buildV3Profile(base, overlay) {
  if (!overlay) return null;

  return {
    ...base,
    search: { ...base.search, ...(overlay.search || {}) },
    ranking: mergeRanking(base.ranking, overlay.ranking),
    axisWeights: overlay.axisWeights,
    bands: overlay.bands || [],
    freshnessBuckets: overlay.freshnessBuckets || [],
    roleFamilies: overlay.roleFamilies || [],
    workSignals: overlay.workSignals || [],
    combinations: overlay.combinations || [],
    orientation: overlay.orientation || {},
    automation: overlay.automation || {},
    experience: overlay.experience || [],
    experienceGaps: overlay.experienceGaps || [],
    qualification: overlay.qualification || {},
    lifestyle: overlay.lifestyle || {},
    industries: overlay.industries || [],
    thinPosting: overlay.thinPosting || {},
    workGate: overlay.workGate || {},
    workSignalCaps: overlay.workSignalCaps || {},
    seniority: overlay.seniority || {},
    discovery: overlay.discovery || {},
  };
}

/**
 * v4 is an overlay ON THE v3 OVERLAY. It keeps every axis, signal, combination
 * and band v3 defined and adds the occupational fit gate in front of them, so
 * the two boards differ by exactly the thing being tested and nothing else. A
 * v4 that copied v3's 1,900-line vocabulary would start drifting from it the
 * first time a phrase was added to one and not the other, and a comparison
 * between the boards would stop meaning anything — the same reasoning that put
 * v2 and v3 on this shared base in the first place.
 *
 * `orientationAdditions` are merged rather than replacing: the strategy and
 * ownership language v4 counts on the creation side is an addition to v3's
 * lists, not a fork of them.
 */
export function buildV4Profile(base, v3Overlay, v4Overlay) {
  if (!v4Overlay) return null;
  const v3Profile = buildV3Profile(base, v3Overlay);
  if (!v3Profile) return null;

  const additions = v4Overlay.orientationAdditions || {};
  const orientation = {
    ...v3Profile.orientation,
    ...(v4Overlay.orientation || {}),
    creationTitles: [
      ...(v3Profile.orientation?.creationTitles || []),
      ...(additions.creationTitlesAdded || []),
    ],
    creationPhrases: [
      ...(v3Profile.orientation?.creationPhrases || []),
      ...(additions.creationPhrasesAdded || []),
    ],
  };

  return {
    ...v3Profile,
    search: { ...v3Profile.search, ...(v4Overlay.search || {}) },
    ranking: mergeRanking(v3Profile.ranking, v4Overlay.ranking),
    orientation,
    occupationGate: v4Overlay.occupationGate || {},
    credentialGate: v4Overlay.credentialGate || {},
    aiWorkGate: v4Overlay.aiWorkGate || {},
    surprise: v4Overlay.surprise || {},
    protectedPreferences: v4Overlay.protectedPreferences || {},
  };
}
