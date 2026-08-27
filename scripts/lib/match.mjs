/**
 * The whole matching model.
 *
 * One rule: a posting is a match if its TITLE contains one of the search terms.
 * That is it. There are no weighted axes, no penalty lists, no exclusion
 * phrases, no occupational gate and no minimum score — the previous version had
 * all of those stacked in front of each other and published one job out of
 * twelve hundred.
 *
 * The number on the card is not a verdict on the job. It says how much of the
 * title the matched term accounts for, which is the only thing a title match
 * can honestly tell you:
 *
 *   "Proofreader"                      → "proofreader"  is the whole title → 100
 *   "Marketing Copy Editor"            → "copy editor"  is 2 of 3 words    → 83
 *   "Senior Copy Editor, Trust & Safety" → "copy editor" is 2 of 6 words   → 67
 *
 * A long title is not a worse job; it is a less certain match, and it sorts
 * lower for that reason alone. Everything that matches is published. Deciding
 * which of them are actually wanted is the ratings model's job, in the browser,
 * over time.
 */

import { normalizeForMatch, containsPhrase, daysBetween } from './text.mjs';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Words in a term or title, after normalisation. Used for the coverage ratio. */
function wordCount(normalized) {
  const trimmed = normalized.trim();
  return trimmed ? trimmed.split(' ').length : 0;
}

/**
 * Every search term found in the title, longest first.
 *
 * Longest wins because it is the most specific thing true about the posting:
 * "Marketing Copy Editor" matches both "editor" and "copy editor", and the
 * second is what the job is. The rest are kept so the card can show that the
 * title is a match on several counts, and so a rating learns the specific term
 * rather than the generic one.
 */
export function matchTerms(title, searchTerms) {
  const normTitle = normalizeForMatch(title || '');
  const hits = [];

  for (const term of searchTerms) {
    if (!containsPhrase(normTitle, term)) continue;
    hits.push({ term, words: wordCount(normalizeForMatch(term)) });
  }

  // Longest phrase first; ties broken by the order in the config, which puts
  // the roles she is actually after above the generic fallbacks.
  hits.sort((a, b) => b.words - a.words || searchTerms.indexOf(a.term) - searchTerms.indexOf(b.term));
  return hits;
}

/**
 * How much of the title the matched term accounts for, as 0–100.
 *
 * Floored at 40 so a genuine match on a very long title is never confused with
 * a near miss — there is no such thing as a near miss here, only matches.
 */
export function relevanceOf(title, hit) {
  if (!hit) return 0;
  const titleWords = wordCount(normalizeForMatch(title || ''));
  if (!titleWords) return 0;
  const coverage = clamp(hit.words / titleWords, 0, 1);
  return clamp(Math.round(40 + 60 * coverage), 40, 100);
}

export function recencyOf(postedAt, ranking, now = new Date()) {
  let age = daysBetween(postedAt, now);
  let assumed = false;
  if (age === null || age < 0) {
    age = ranking.assumedAgeDaysWhenUnknown;
    assumed = true;
  }
  const value = 100 * Math.exp(-Math.LN2 * (age / ranking.recencyHalfLifeDays));
  return { score: clamp(Math.round(value), 0, 100), ageDays: Math.round(age * 10) / 10, assumed };
}

/**
 * Coarse seniority from the title alone. Not used for filtering — it is one of
 * the things a 👎 can learn from, so that "too senior" generalises past the one
 * posting it was said on.
 */
export function seniorityOf(title) {
  const norm = normalizeForMatch(title || '');
  const senior = ['senior', 'sr', 'lead', 'principal', 'head', 'director', 'manager', 'vp', 'chief'];
  const junior = ['junior', 'jr', 'entry level', 'intern', 'internship', 'apprentice', 'trainee', 'assistant', 'associate'];
  if (senior.some((w) => containsPhrase(norm, w))) return 'senior';
  if (junior.some((w) => containsPhrase(norm, w))) return 'junior';
  return 'mid';
}

/**
 * Scores one posting. Returns null when the title matches nothing, which is the
 * only way a posting is ever rejected on relevance.
 */
export function evaluate(job, profile, now = new Date()) {
  const hits = matchTerms(job.title, profile.searchTerms);
  if (!hits.length) return null;

  const best = hits[0];
  const relevance = relevanceOf(job.title, best);
  const recency = recencyOf(job.postedAt, profile.ranking, now);

  const { relevanceWeight, recencyWeight } = profile.ranking;
  const rank = Math.round((relevance * relevanceWeight + recency.score * recencyWeight) * 10) / 10;

  return {
    relevance,
    // The term that decided it, plus any others the title also matched. The
    // card shows the first and the ratings model learns from it.
    matchedTerm: best.term,
    matchedTerms: hits.slice(0, 4).map((h) => h.term),
    recency: recency.score,
    ageDays: recency.ageDays,
    ageAssumed: recency.assumed,
    seniority: seniorityOf(job.title),
    rank,
  };
}
