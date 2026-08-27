/**
 * Jooble — a free aggregator that indexes many of the same postings as the
 * big boards, and names the originating site in each result's `source` field.
 *
 * Broader and less quota-limited than JSearch, though its coverage of any one
 * board is patchier. Running both and letting de-duplication merge them gives
 * better coverage than either alone.
 *
 *   1. Request a free key at https://jooble.org/api/about
 *   2. Add it as the JOOBLE_API_KEY repository secret
 *
 * Note: the key goes in the URL path, which is Jooble's design, not a mistake.
 */

import { request } from '../lib/http.mjs';
import { selectRotating } from '../lib/rotate.mjs';

export const id = 'jooble';
export const label = 'Jooble';
export const enabled = true;

export function isConfigured() {
  return Boolean(process.env.JOOBLE_API_KEY);
}

export const skipReason = 'JOOBLE_API_KEY not set — see README';

// Jooble indexes the whole market and matches loosely, so it takes the broad
// terms rather than the specific ones — and takes them from the shared rotation
// so a term added to the profile reaches this source too, which a hard-coded
// list here quietly prevented for months.
const QUERIES_PER_RUN = 10;

async function search(keywords, page) {
  const body = await request(`https://jooble.org/api/${process.env.JOOBLE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords, location: 'Remote', page: String(page) }),
    retries: 1,
  });
  return JSON.parse(body);
}

export async function fetchJobs({ profile, warn }) {
  const jobs = [];
  const queries = selectRotating(
    profile.broadTerms?.length ? profile.broadTerms : profile.searchTerms,
    QUERIES_PER_RUN
  );

  for (const keywords of queries) {
    let payload;
    try {
      payload = await search(keywords, 1);
    } catch (err) {
      warn(`"${keywords}": ${err.message}`);
      continue;
    }

    for (const job of payload?.jobs || []) {
      jobs.push({
        sourceId: String(job.id),
        title: job.title,
        company: job.company,
        url: job.link,
        description: job.snippet,
        location: job.location,
        locationRestriction: job.location,
        employmentTypes: [job.type].filter(Boolean),
        salary: job.salary,
        postedAt: job.updated,
        // Jooble reports the board it found the posting on.
        publisher: job.source,
        tags: [job.source].filter(Boolean),
      });
    }
  }

  return jobs;
}
