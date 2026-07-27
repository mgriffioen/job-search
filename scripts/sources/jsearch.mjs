/**
 * JSearch (via RapidAPI) — the practical way to get LinkedIn, Indeed and
 * ZipRecruiter postings onto this board.
 *
 * None of those three offer a public API, but Google for Jobs indexes them,
 * and JSearch serves Google for Jobs results with the originating board named
 * in `job_publisher`. That publisher name is carried through to the card and
 * the board filter, so a LinkedIn posting shows up labelled LinkedIn.
 *
 * Free tier is roughly 200 requests/month, which is why this adapter is
 * deliberately frugal: one request per keyword per run, twice a day.
 *
 *   1. Sign up at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 *   2. Subscribe to the Basic (free) plan
 *   3. Add the key as the RAPIDAPI_KEY repository secret
 */

import { getJson } from '../lib/http.mjs';

export const id = 'jsearch';
export const label = 'Google Jobs';
export const enabled = true;

export function isConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

export const skipReason = 'RAPIDAPI_KEY not set — see README (this is what brings in LinkedIn/Indeed/ZipRecruiter)';

// Keep this list short: each entry costs one request against the free quota.
const QUERIES = [
  'email marketing specialist',
  'quality assurance specialist',
  'proofreader',
  'email production coordinator',
];

/**
 * RapidAPI answers with bare status codes that mean something specific here.
 * A 404 in particular does not mean the endpoint moved — it means the gateway
 * could not route the request to a subscription, which is what happens when a
 * key is created but the Basic plan was never subscribed to.
 */
export function explain(err) {
  const message = String(err?.message || err);
  if (message.includes('404')) {
    return 'RapidAPI returned 404 — the key works but this app is not subscribed to JSearch. ' +
      'Open the JSearch page on RapidAPI and subscribe to the Basic (free) plan.';
  }
  if (message.includes('401') || message.includes('403')) {
    return 'RapidAPI rejected the key (401/403) — check RAPIDAPI_KEY is the X-RapidAPI-Key value ' +
      'for an app subscribed to JSearch.';
  }
  if (message.includes('429')) {
    return 'RapidAPI monthly quota exhausted (429) — reduce QUERIES in scripts/sources/jsearch.mjs ' +
      'or upgrade the plan.';
  }
  return message;
}

export async function fetchJobs({ warn }) {
  const jobs = [];

  for (const query of QUERIES) {
    const params = new URLSearchParams({
      query: `${query} in USA`,
      page: '1',
      num_pages: '1',
      country: 'us',
      date_posted: 'month',
      work_from_home: 'true',
    });

    let payload;
    try {
      payload = await getJson(`https://jsearch.p.rapidapi.com/search?${params}`, {
        headers: {
          'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      });
    } catch (err) {
      warn(`"${query}": ${explain(err)}`);
      continue;
    }

    for (const job of payload?.data || []) {
      const city = [job.job_city, job.job_state].filter(Boolean).join(', ');
      jobs.push({
        sourceId: job.job_id,
        title: job.job_title,
        company: job.employer_name,
        companyLogo: job.employer_logo,
        url: job.job_apply_link || job.job_google_link,
        applyUrl: job.job_apply_link,
        description: job.job_description,
        location: job.job_is_remote ? `Remote${city ? ` (${city})` : ''}` : city,
        locationRestriction: job.job_is_remote ? city || 'USA' : city,
        employmentTypes: [job.job_employment_type].filter(Boolean),
        salaryMin: job.job_min_salary,
        salaryMax: job.job_max_salary,
        currency: job.job_salary_currency,
        postedAt: job.job_posted_at_datetime_utc || job.job_posted_at_timestamp,
        remoteFlag: job.job_is_remote === true,
        // "LinkedIn", "Indeed", "ZipRecruiter", "Glassdoor", a company site…
        publisher: job.job_publisher,
        tags: [job.job_publisher].filter(Boolean),
      });
    }
  }

  return jobs;
}
