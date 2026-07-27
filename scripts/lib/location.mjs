/**
 * Decides whether a posting is realistically open to a candidate living in
 * Kalamazoo, Michigan.
 *
 * Two ways to qualify:
 *   1. Remote, with no restriction or a restriction that includes the US.
 *   2. On-site/hybrid within commuting range of Kalamazoo.
 *
 * Anything else (remote but EU-only, on-site in Austin, …) is filtered out.
 */

import { normalizeForMatch, containsPhrase } from './text.mjs';

const NON_US_HINTS = [
  'united kingdom', 'uk only', 'europe', 'emea', 'eu only', 'european union', 'germany',
  'deutschland', 'france', 'spain', 'portugal', 'netherlands', 'poland', 'romania', 'ukraine',
  'india', 'philippines', 'pakistan', 'bangladesh', 'nigeria', 'kenya', 'south africa',
  'australia', 'new zealand', 'singapore', 'japan', 'china', 'brazil', 'argentina', 'colombia',
  'mexico', 'chile', 'peru', 'canada only', 'apac', 'latam', 'latin america', 'ireland',
  'sweden', 'norway', 'denmark', 'finland', 'italy', 'greece', 'turkey', 'israel', 'uae',
  'switzerland', 'austria', 'belgium', 'czech', 'hungary', 'bulgaria', 'serbia', 'croatia',
  'vietnam', 'indonesia', 'thailand', 'malaysia', 'korea', 'hong kong', 'taiwan',
];

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas',
  'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
];

const REMOTE_HINTS = [
  'remote', 'work from home', 'work from anywhere', 'wfh', 'anywhere', 'telecommute',
  'distributed', 'virtual', 'home based', 'home-based', 'fully remote', '100% remote',
];

const HYBRID_HINTS = ['hybrid', 'flex office', 'partially remote', 'remote-friendly', 'in-office days'];

const ONSITE_HINTS = ['on-site', 'on site', 'onsite', 'in-person', 'in office', 'in-office'];

/** 'remote' | 'hybrid' | 'onsite' | 'unknown' */
export function detectWorkType({ location = '', title = '', description = '', remoteFlag }) {
  const haystack = normalizeForMatch(`${title} ${location} ${description.slice(0, 1500)}`);

  if (HYBRID_HINTS.some((p) => containsPhrase(haystack, p))) return 'hybrid';
  if (remoteFlag === true) return 'remote';
  if (REMOTE_HINTS.some((p) => containsPhrase(haystack, p))) return 'remote';
  if (ONSITE_HINTS.some((p) => containsPhrase(haystack, p))) return 'onsite';
  if (remoteFlag === false) return 'onsite';
  return 'unknown';
}

/**
 * @returns {{eligible: boolean, workType: string, scope: string, reason: string}}
 *   scope: 'remote-anywhere' | 'remote-us' | 'local' | 'out-of-range' | 'non-us'
 */
export function evaluateLocation(job, profile) {
  const cfg = profile.location;
  const locationText = [job.location, job.locationRestriction].filter(Boolean).join(', ');
  const normLocation = normalizeForMatch(locationText);
  const workType = job.workType || 'unknown';

  const isLocal =
    cfg.commuteCities.some((city) => containsPhrase(normLocation, city)) ||
    cfg.commuteStates.some((state) => containsPhrase(normLocation, state));

  // On-site / hybrid: only workable if it is near home.
  if (workType === 'onsite' || workType === 'hybrid') {
    if (isLocal) {
      return {
        eligible: true,
        workType,
        scope: 'local',
        reason: `${workType === 'hybrid' ? 'Hybrid' : 'On-site'} near Kalamazoo`,
      };
    }
    return {
      eligible: false,
      workType,
      scope: 'out-of-range',
      reason: `${workType === 'hybrid' ? 'Hybrid' : 'On-site'} outside commuting range`,
    };
  }

  // Remote (or unknown-but-remote-board): check the geographic restriction.
  const hasNonUsHint = NON_US_HINTS.some((p) => containsPhrase(normLocation, p));
  const hasUsHint =
    cfg.usAliases.some((p) => containsPhrase(normLocation, p)) ||
    US_STATE_NAMES.some((p) => containsPhrase(normLocation, p)) ||
    /\b(us|usa)\b/.test(normLocation);

  if (hasNonUsHint && !hasUsHint) {
    return { eligible: false, workType, scope: 'non-us', reason: `Restricted to ${locationText}` };
  }

  if (!locationText.trim()) {
    return { eligible: true, workType, scope: 'remote-anywhere', reason: 'Remote, no stated restriction' };
  }

  if (hasUsHint) {
    const anywhere = ['anywhere', 'worldwide', 'global'].some((p) => containsPhrase(normLocation, p));
    return {
      eligible: true,
      workType,
      scope: anywhere ? 'remote-anywhere' : 'remote-us',
      reason: anywhere ? 'Remote, open worldwide' : `Remote, US-eligible (${locationText})`,
    };
  }

  // Remote with a restriction we could not classify: keep it, flag it.
  return {
    eligible: true,
    workType,
    scope: 'remote-us',
    reason: `Remote — verify eligibility (${locationText})`,
  };
}
