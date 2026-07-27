/**
 * RemoteOK — free public API, no key.
 * https://remoteok.com/api  (first array element is a legal notice, not a job)
 */

import { getJson } from '../lib/http.mjs';

export const id = 'remoteok';
export const label = 'RemoteOK';
export const enabled = true;

export async function fetchJobs() {
  const payload = await getJson('https://remoteok.com/api', {
    headers: { Referer: 'https://remoteok.com/' },
  });
  const rows = Array.isArray(payload) ? payload : [];

  return rows
    .filter((row) => row && (row.position || row.title) && row.company)
    .map((row) => ({
      sourceId: String(row.id || row.slug),
      title: row.position || row.title,
      company: row.company,
      companyLogo: row.company_logo || row.logo,
      url: row.url || (row.slug ? `https://remoteok.com/remote-jobs/${row.slug}` : null),
      applyUrl: row.apply_url,
      description: row.description,
      location: row.location,
      locationRestriction: row.location,
      employmentTypes: [].concat(row.tags || []).filter((t) => /time|contract|intern/i.test(String(t))),
      salaryMin: row.salary_min,
      salaryMax: row.salary_max,
      postedAt: row.date || row.epoch,
      tags: row.tags,
      remoteFlag: true,
    }));
}
