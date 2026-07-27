/**
 * Jobicy — free public API, no key.
 * https://jobicy.com/jobs-rss-feed  (v2 JSON endpoint)
 */

import { getJson } from '../lib/http.mjs';

export const id = 'jobicy';
export const label = 'Jobicy';
export const enabled = true;

/**
 * The unfiltered US feed, then keyword passes. Jobicy answers 400 for an
 * industry slug it does not recognise and its slug list changes, so the broad
 * feed carries the source and the keyword passes only add to it.
 */
function buildUrls(profile) {
  const urls = ['https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa'];
  // `tag` filters a small index, so specific phrases match nothing there.
  const queries = profile.search.broadQueries || profile.search.queries.slice(0, 6);
  for (const query of queries) {
    urls.push(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&tag=${encodeURIComponent(query)}`);
  }
  return urls;
}

export async function fetchJobs({ profile, warn }) {
  const jobs = [];

  for (const url of buildUrls(profile)) {
    let payload;
    try {
      payload = await getJson(url);
    } catch (err) {
      warn(`${new URL(url).search}: ${err.message}`);
      continue;
    }

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
