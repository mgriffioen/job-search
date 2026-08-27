/**
 * The whole matching model.
 *
 * One rule: a posting matches if one of the search terms appears in it. Where
 * the term appears decides the number on the card, because that is the only
 * thing a keyword match can honestly tell you:
 *
 *   in the TITLE       the job IS that role         → 40–100, by title coverage
 *   in the TAGS        the board filed it as that   → 45
 *   in the DESCRIPTION the work is mentioned        → 30
 *
 * There are no weighted axes, no penalty lists, no exclusion phrases, no
 * occupational gate and no minimum score. The previous version had all of those
 * stacked in front of each other and published one job out of twelve hundred.
 *
 * WHY THE BODY COUNTS, AND WHY ONLY PARTLY
 *
 * Most sources are searched by keyword and return whatever matched their full
 * text, so a title-only rule throws away almost everything the search just
 * found — on a real run it kept 17 of 1,026 postings, most of them "Video
 * Editor" caught by the generic term `editor`. Reading the body fixes that.
 *
 * But only MULTI-WORD terms may match in the body. A one-word term is decisive
 * in a title and meaningless in the middle of a paragraph: "proofreader" as a
 * title is the job, whereas any posting on earth can mention an editor. So
 * `editor`, `proofreader` and `copywriter` must be in the title or the tags,
 * while `content quality specialist` may be anywhere — nothing says that phrase
 * by accident.
 *
 * The number is not a verdict on the job. Deciding which of these are actually
 * wanted is the ratings model's job, in the browser, over time.
 */

import { normalizeForMatch, containsPhrase, daysBetween } from './text.mjs';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** What a match is worth when it is not in the title. */
const TAG_RELEVANCE = 45;
const BODY_RELEVANCE = 30;

/**
 * How much of the description is read. A posting says what the job is at the
 * top and what the company believes in at the bottom; the boilerplate about
 * benefits and equal opportunity is not evidence of anything.
 */
const BODY_CHARS = 1800;

/** Words in a term or title, after normalisation. Used for the coverage ratio. */
function wordCount(normalized) {
  const trimmed = normalized.trim();
  return trimmed ? trimmed.split(' ').length : 0;
}

/**
 * Every search term found in one piece of text, longest first.
 *
 * Longest wins because it is the most specific thing true about the posting:
 * "Marketing Copy Editor" matches both "editor" and "copy editor", and the
 * second is what the job is. The rest are kept so a rating learns the specific
 * term as well as the generic one.
 */
export function matchTerms(text, searchTerms, { minWords = 1 } = {}) {
  const norm = normalizeForMatch(text || '');
  const hits = [];

  for (const term of searchTerms) {
    const words = wordCount(normalizeForMatch(term));
    if (words < minWords) continue;
    if (!containsPhrase(norm, term)) continue;
    hits.push({ term, words });
  }

  // Longest phrase first; ties broken by the order in the config, which puts
  // the roles she is actually after above the generic fallbacks.
  hits.sort((a, b) => b.words - a.words || searchTerms.indexOf(a.term) - searchTerms.indexOf(b.term));
  return hits;
}

/**
 * How much of the title the matched term accounts for, as 0–100.
 *
 * Floored at 40 so a genuine title match on a very long title still outranks
 * anything found only in the tags or the body.
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
 * Scores one posting. Returns null when no search term appears anywhere it is
 * allowed to, which is the only way a posting is ever rejected on relevance.
 */
export function evaluate(job, profile, now = new Date()) {
  const terms = profile.searchTerms;

  let hits = matchTerms(job.title, terms);
  let matchedIn = 'title';
  let relevance = 0;

  if (hits.length) {
    relevance = relevanceOf(job.title, hits[0]);
  } else {
    // The board's own categories for the posting. A one-word term is fine here:
    // a tag is a deliberate label, not prose.
    hits = matchTerms((job.tags || []).join(' , '), terms);
    matchedIn = 'tags';
    relevance = TAG_RELEVANCE;

    if (!hits.length) {
      // Multi-word terms only — see the note at the top of this file.
      hits = matchTerms((job.description || job.excerpt || '').slice(0, BODY_CHARS), terms, { minWords: 2 });
      matchedIn = 'description';
      relevance = BODY_RELEVANCE;
    }
  }

  if (!hits.length) return null;

  const recency = recencyOf(job.postedAt, profile.ranking, now);

  const { relevanceWeight, recencyWeight } = profile.ranking;
  const rank = Math.round((relevance * relevanceWeight + recency.score * recencyWeight) * 10) / 10;

  return {
    relevance,
    // Where the term was found, so the card can say so rather than implying the
    // posting is titled something it is not.
    matchedIn,
    // The term that decided it, plus any others the same text matched. The card
    // shows the first and the ratings model learns from all of them.
    matchedTerm: hits[0].term,
    matchedTerms: hits.slice(0, 4).map((h) => h.term),
    recency: recency.score,
    ageDays: recency.ageDays,
    ageAssumed: recency.assumed,
    seniority: seniorityOf(job.title),
    rank,
  };
}
