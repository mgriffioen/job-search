/**
 * The two facts a 👎 reason needs that cannot be read off a job title.
 *
 * Neither is a filter and neither touches the score. Both exist for one purpose:
 * so "Too technical" and "Wrong industry" can generalise past the single posting
 * they were said on. Nothing here runs until she presses a chip — the board
 * publishes these fields and then ignores them.
 *
 * They are computed in the pipeline rather than in the browser because the full
 * description is only available here; jobs.json carries a 460-character excerpt,
 * which is nowhere near enough to tell a programming job from a proofreading one.
 */

import { normalizeForMatch, containsPhrase } from './text.mjs';

/**
 * How much of the description is read. Same window the matcher uses: a posting
 * says what the job is at the top, and the boilerplate about benefits and equal
 * opportunity at the bottom is not evidence of anything.
 */
const BODY_CHARS = 1800;

/**
 * How many technical phrases before a posting counts as technical.
 *
 * One, because the list is built to make one enough. Technical literacy is not
 * the complaint — HTML, CSS, templates, spreadsheets, Jira and CMSs are her
 * daily tools and appear nowhere in it — so every phrase left is decisive on
 * its own: "sdet", "test automation", "write code".
 *
 * This started at two, on the reasoning that one passing mention should not
 * convict a posting. Measured against the real board, two found nothing at all:
 * 122 of 126 published postings contained none of these phrases and the other
 * four contained exactly one — among them a Quality Assurance Analyst asking
 * for automated tests, which is exactly the posting the chip exists for. Half
 * the sources return a snippet rather than a full description, so a
 * two-mention rule was really a rule about how verbose the board was.
 */
const TECHNICAL_THRESHOLD = 1;

/** The searchable text of a posting: title, tags, and the top of the body. */
function haystack(job) {
  return normalizeForMatch(
    `${job.title || ''} ${(job.tags || []).join(' ')} ${(job.description || job.excerpt || '').slice(0, BODY_CHARS)}`
  );
}

/**
 * Whether writing code appears to be the job rather than a tool of it.
 * Returns the matched phrases so the reason can say what it saw.
 */
export function detectTechnical(job, phrases = []) {
  const text = haystack(job);
  const hits = phrases.filter((phrase) => containsPhrase(text, phrase));
  return { technical: hits.length >= TECHNICAL_THRESHOLD, hits: hits.slice(0, 4) };
}

/**
 * Which lines of business the posting is in, strongest first.
 *
 * Capped at two: a posting that claims to be in five industries has told you
 * nothing, and an industry she blames should be one she would recognise. A
 * posting matching none carries no industry at all, and the "Wrong industry"
 * chip simply does not reach it — which is the honest outcome, rather than
 * inventing a category to blame.
 */
export function detectIndustries(job, industries = []) {
  const text = haystack(job);
  const scored = [];

  for (const industry of industries) {
    const hits = industry.phrases.filter((phrase) => containsPhrase(text, phrase));
    if (hits.length) scored.push({ label: industry.label, hits: hits.length });
  }

  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 2).map((s) => s.label);
}
