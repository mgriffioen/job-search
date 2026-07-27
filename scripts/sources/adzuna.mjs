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

export const id = 'adzuna';
export const label = 'Adzuna';
export const enabled = true;

export function isConfigured() {
  return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

export const skipReason = 'ADZUNA_APP_ID / ADZUNA_APP_KEY not set — see README';

// Two passes: jobs near home, and US-wide remote jobs.
const SEARCHES = [
  { where: 'Kalamazoo, Michigan', distance: 50, label: 'local' },
  { where: 'Michigan', distance: 0, extra: 'remote', label: 'michigan-remote' },
  { where: '', distance: 0, extra: 'remote', label: 'us-remote' },
];

export async function fetchJobs({ profile }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  const jobs = [];
  const queries = profile.search.queries.slice(0, 6);

  for (const search of SEARCHES) {
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
      const payload = await getJson(url);

      for (const job of payload?.results || []) {
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
