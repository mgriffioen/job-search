/**
 * Jobicy — free public API, no key.
 * https://jobicy.com/jobs-rss-feed  (v2 JSON endpoint)
 */

import { getJson } from '../lib/http.mjs';

export const id = 'jobicy';
export const label = 'Jobicy';
export const enabled = true;

// Jobicy filters by industry slug; these are the ones adjacent to her work.
const INDUSTRIES = ['marketing', 'copywriting', 'design-multimedia', 'business', 'administration'];

export async function fetchJobs() {
  const jobs = [];

  for (const industry of INDUSTRIES) {
    const url = `https://jobicy.com/api/v2/remote-jobs?count=50&industry=${encodeURIComponent(industry)}&geo=usa`;
    const payload = await getJson(url);
    for (const job of payload?.jobs || []) {
      jobs.push({
        sourceId: String(job.id),
        title: job.jobTitle,
        company: job.companyName,
        companyLogo: job.companyLogo,
        url: job.url,
        description: job.jobDescription || job.jobExcerpt,
        location: job.jobGeo,
        locationRestriction: job.jobGeo,
        employmentTypes: job.jobType,
        salaryMin: job.annualSalaryMin,
        salaryMax: job.annualSalaryMax,
        currency: job.salaryCurrency,
        postedAt: job.pubDate,
        tags: [].concat(job.jobIndustry || [], job.jobLevel || []),
        remoteFlag: true,
      });
    }
  }

  return jobs;
}
