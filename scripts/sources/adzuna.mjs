/**
 * Adzuna — needs a free API key, and it is the one source that covers
 * *local* Kalamazoo-area postings (everything else here is remote-only).
 *
 * Get a free key at https://developer.adzuna.com/ and set:
 *   ADZUNA_APP_ID  /  ADZUNA_APP_KEY
 * locally in your shell, or as GitHub Actions repository secrets.
 *
 * Without the key this source quietly skips itself.
 */

import { getJson } from '../lib/http.mjs';
import { selectRotating } from '../lib/rotate.mjs';

export const id = 'adzuna';
export const label = 'Adzuna';
export const enabled = true;

export function isConfigured() {
  return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

export const skipReason = 'ADZUNA_APP_ID / ADZUNA_APP_KEY not set — see README';

const SEARCHES = [
  // Only used when profile.location.remoteOnly is off.
  { where: 'Kalamazoo, Michigan', distance: 50, label: 'local', localOnly: true },
  { where: 'Michigan', distance: 0, extra: 'remote', label: 'michigan-remote' },
  { where: '', distance: 0, extra: 'remote', label: 'us-remote' },
];

export async function fetchJobs({ profile, warn }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const jobs = [];
  // Adzuna indexes the entire job market, so a narrow phrase returns nothing.
  // Broad terms plus the remote-only location gate is the productive pairing.
  // Rotated, not truncated: the broad list is longer than one run should
  // send, because each term costs an API call here, but every term still
  // gets its turn over the next few runs.
  const queries = selectRotating(
    profile.broadTerms?.length ? profile.broadTerms : profile.searchTerms,
    profile.search.broadTermsPerRun ?? 12
  );
  const remoteOnly = profile.location.remoteOnly !== false;

  for (const search of SEARCHES) {
    if (search.localOnly && remoteOnly) continue;
    for (const query of queries) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: '50',
        what: search.extra ? `${query} ${search.extra}` : query,
        max_days_old: String(profile.search.maxAgeDays),
        'content-type': 'application/json',
      });
      if (search.where) params.set('where', search.where);
      if (search.distance) params.set('distance', String(search.distance));

      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`;
      let payload;
      try {
        payload = await getJson(url);
      } catch (err) {
        warn(`${search.label} "${query}": ${err.message}`);
        continue;
      }

      // Distinguishes "this term matched nothing" from "the API is answering
      // but we are reading the response wrong" — both otherwise look like 0.
      const results = payload?.results || [];
      if (!results.length) {
        warn(`${search.label} "${query}": 0 results (Adzuna reports ${payload?.count ?? 'no'} total matches)`);
      }

      for (const job of results) {
        const area = job.location?.display_name || '';
        jobs.push({
          sourceId: String(job.id),
          title: job.title,
          company: job.company?.display_name,
          url: job.redirect_url,
          description: job.description,
          location: area,
          locationRestriction: search.label === 'us-remote' ? 'USA' : area,
          employmentTypes: [job.contract_time, job.contract_type].filter(Boolean),
          salaryMin: job.salary_min,
          salaryMax: job.salary_max,
          postedAt: job.created,
          tags: [job.category?.label].filter(Boolean),
          // Let the text detector decide; Adzuna has no reliable remote flag.
          remoteFlag: undefined,
        });
      }
    }
  }

  return jobs;
}
