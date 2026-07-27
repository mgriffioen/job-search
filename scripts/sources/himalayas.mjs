/**
 * Himalayas — free public API, no key.
 * https://himalayas.app/api
 */

import { getJson } from '../lib/http.mjs';

export const id = 'himalayas';
export const label = 'Himalayas';
export const enabled = true;

const PAGES = 4;
const LIMIT = 100;

export async function fetchJobs() {
  const jobs = [];

  for (let page = 0; page < PAGES; page += 1) {
    const url = `https://himalayas.app/jobs/api?limit=${LIMIT}&offset=${page * LIMIT}`;
    const payload = await getJson(url);
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
