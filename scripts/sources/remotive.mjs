/**
 * Remotive — free public API, no key.
 * https://github.com/remotive-com/remote-jobs-api
 *
 * Remotive's terms ask that listings link back to the Remotive URL and that
 * the source is credited; both are done in the UI.
 */

import { getJson } from '../lib/http.mjs';

export const id = 'remotive';
export const label = 'Remotive';
export const enabled = true;

export async function fetchJobs({ profile, warn }) {
  const jobs = [];
  // Unmetered, so run the whole list rather than a slice of it.
  const queries = profile.search.queries.slice(0, 16);

  for (const query of queries) {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=60`;
    let payload;
    try {
      payload = await getJson(url);
    } catch (err) {
      // Rate limiting on one term should not cost us the other seven.
      warn(`"${query}": ${err.message}`);
      continue;
    }

    for (const job of payload?.jobs || []) {
      jobs.push({
        sourceId: String(job.id),
        title: job.title,
        company: job.company_name,
        companyLogo: job.company_logo,
        url: job.url,
        description: job.description,
        location: job.candidate_required_location,
        locationRestriction: job.candidate_required_location,
        employmentTypes: job.job_type ? [job.job_type] : [],
        salary: job.salary,
        postedAt: job.publication_date,
        tags: [job.category, ...(job.tags || [])].filter(Boolean),
        remoteFlag: true,
      });
    }
  }

  return jobs;
}
