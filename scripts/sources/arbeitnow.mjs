/**
 * Arbeitnow — free public API, no key.
 * https://www.arbeitnow.com/blog/job-board-api
 *
 * Heavily EU-weighted, so most results are dropped by the location gate.
 * Kept enabled because it occasionally surfaces US-remote marketing roles and
 * costs one request; set `enabled = false` if the noise bothers you.
 */

import { getJson } from '../lib/http.mjs';

export const id = 'arbeitnow';
export const label = 'Arbeitnow';
export const enabled = true;

export async function fetchJobs() {
  const payload = await getJson('https://www.arbeitnow.com/api/job-board-api');
  const rows = payload?.data || [];

  return rows.map((row) => ({
    sourceId: row.slug,
    title: row.title,
    company: row.company_name,
    url: row.url,
    description: row.description,
    location: row.location,
    locationRestriction: row.remote ? row.location : '',
    employmentTypes: row.job_types,
    postedAt: row.created_at,
    tags: row.tags,
    remoteFlag: row.remote === true,
  }));
}
