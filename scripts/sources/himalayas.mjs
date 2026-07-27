/**
 * Himalayas — free public API, no key.
 * https://himalayas.app/api
 */

import { getJson } from '../lib/http.mjs';

export const id = 'himalayas';
export const label = 'Himalayas';
export const enabled = true;

// Himalayas caps the page size at 20 regardless of what you ask for, so the
// only way to get depth here is more pages.
const PAGES = 12;
const LIMIT = 20;

export async function fetchJobs({ warn }) {
  const jobs = [];

  for (let page = 0; page < PAGES; page += 1) {
    const url = `https://himalayas.app/jobs/api?limit=${LIMIT}&offset=${page * LIMIT}`;
    let payload;
    try {
      payload = await getJson(url);
    } catch (err) {
      warn(`page ${page + 1}: ${err.message}`);
      break;
    }
    const rows = payload?.jobs || [];
    if (!rows.length) break;

    for (const job of rows) {
      jobs.push({
        sourceId: String(job.guid || job.id || job.applicationLink),
        title: job.title,
        company: job.companyName,
        companyLogo: job.companyLogo,
        url: job.applicationLink || job.url,
        description: job.description || job.excerpt,
        location: [].concat(job.locationRestrictions || []).join(', '),
        locationRestriction: [].concat(job.locationRestrictions || []).join(', '),
        employmentTypes: [].concat(job.employmentType || []),
        salary: job.salary,
        salaryMin: job.minSalary,
        salaryMax: job.maxSalary,
        postedAt: job.pubDate || job.timeStamp,
        tags: [].concat(job.categories || [], job.seniority || []),
        remoteFlag: true,
      });
    }

    if (rows.length < LIMIT) break;
  }

  return jobs;
}
