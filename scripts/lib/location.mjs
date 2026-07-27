/**
 * Decides whether a posting is realistically open to a candidate living in
 * Kalamazoo, Michigan.
 *
 * With `location.remoteOnly` set (the default), a job qualifies only if it is
 * stated remote *and* a Michigan resident could hold it. That means three
 * things get dropped:
 *   - on-site and hybrid roles, wherever they are;
 *   - postings with no positive indication of being remote;
 *   - remote roles fenced to a region or state list that excludes Michigan,
 *     e.g. "Remote — Europe" or "Remote (California, New York)".
 *
 * Turning `remoteOnly` off restores the earlier behaviour, where on-site and
 * hybrid roles within commuting range of Kalamazoo also qualify.
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

/** Phrases that mean "the whole country", so a state list is not a fence. */
const NATIONWIDE_HINTS = [
  'usa', 'u.s', 'u.s.a', 'us', 'united states', 'united states of america',
  'nationwide', 'anywhere', 'worldwide', 'global', 'north america', 'americas',
  'any state', 'all states', 'us only', 'usa only', 'us based',
  // Deliberately not "remote": that describes the work arrangement, not the
  // geographic scope, and "Remote — California" is still a California fence.
];

/**
 * Catches "Remote (California, New York)" — a US-eligible posting that a
 * Michigan resident still cannot take. Only triggers when specific states are
 * named and no nationwide phrasing is present.
 */
function isFencedToOtherStates(normLocation) {
  const named = US_STATE_NAMES.filter((state) => containsPhrase(normLocation, state));
  if (!named.length) return false;
  if (named.includes('michigan')) return false;
  if (NATIONWIDE_HINTS.some((p) => containsPhrase(normLocation, p))) return false;
  return named;
}

/**
 * @returns {{eligible: boolean, workType: string, scope: string, reason: string}}
 *   scope: 'remote-anywhere' | 'remote-us' | 'local'
 *        | 'not-remote' | 'out-of-range' | 'non-us' | 'state-restricted'
 */
export function evaluateLocation(job, profile) {
  const cfg = profile.location;
  const remoteOnly = cfg.remoteOnly !== false;
  const locationText = [job.location, job.locationRestriction].filter(Boolean).join(', ');
  const normLocation = normalizeForMatch(locationText);
  const workType = job.workType || 'unknown';

  const isLocal =
    cfg.commuteCities.some((city) => containsPhrase(normLocation, city)) ||
    cfg.commuteStates.some((state) => containsPhrase(normLocation, state));

  if (workType === 'onsite' || workType === 'hybrid') {
    const kind = workType === 'hybrid' ? 'Hybrid' : 'On-site';

    if (remoteOnly) {
      return { eligible: false, workType, scope: 'not-remote', reason: `${kind} role` };
    }
    if (isLocal) {
      return { eligible: true, workType, scope: 'local', reason: `${kind} near Kalamazoo` };
    }
    return { eligible: false, workType, scope: 'out-of-range', reason: `${kind} outside commuting range` };
  }

  // Remote-only mode needs positive evidence, not just the absence of an office.
  if (remoteOnly && workType !== 'remote') {
    return { eligible: false, workType, scope: 'not-remote', reason: 'No indication the role is remote' };
  }

  const hasNonUsHint = NON_US_HINTS.some((p) => containsPhrase(normLocation, p));
  const hasUsHint =
    cfg.usAliases.some((p) => containsPhrase(normLocation, p)) ||
    US_STATE_NAMES.some((p) => containsPhrase(normLocation, p)) ||
    /\b(us|usa)\b/.test(normLocation);

  if (hasNonUsHint && !hasUsHint) {
    return { eligible: false, workType, scope: 'non-us', reason: `Restricted to ${locationText}` };
  }

  const fenced = isFencedToOtherStates(normLocation);
  if (fenced) {
    return {
      eligible: false,
      workType,
      scope: 'state-restricted',
      reason: `Remote, but limited to ${fenced.join(', ')} — not Michigan`,
    };
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
