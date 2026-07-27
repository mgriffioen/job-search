/**
 * Working Nomads — free public JSON feed, no key.
 * https://www.workingnomads.com/api/exposed_jobs/
 */

import { getJson } from '../lib/http.mjs';

export const id = 'workingnomads';
export const label = 'Working Nomads';
export const enabled = true;

export async function fetchJobs() {
  const payload = await getJson('https://www.workingnomads.com/api/exposed_jobs/');
  const rows = Array.isArray(payload) ? payload : payload?.results || [];

  return rows
    .filter((row) => row && row.title)
    .map((row) => ({
      sourceId: String(row.id || row.url),
      title: row.title,
      company: row.company_name || row.company,
      url: row.url,
      description: row.description,
      location: row.location,
      locationRestriction: row.location,
      employmentTypes: row.tags ? String(row.tags).split(',') : [],
      postedAt: row.pub_date || row.created,
      tags: [row.category_name, ...String(row.tags || '').split(',')].filter(Boolean),
      remoteFlag: true,
    }));
}
