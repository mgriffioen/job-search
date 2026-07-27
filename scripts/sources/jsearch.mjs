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
 *   2. Subscribe to the Basic (free) plan — the key alone is not enough
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
 * JSearch has renamed its search endpoint across API versions, and the version
 * a key is bound to is chosen in the RapidAPI dashboard, not by us. Rather than
 * hard-code one path and 404 forever, probe on the first query of a run and
 * reuse whatever answered — costing at most two extra requests, once.
 */
// Ordered by what this account's API version actually answers on, so the
// common case costs no probe requests at all.
const CANDIDATE_PATHS = ['/search-v2', '/search', '/job-search'];

/**
 * v1 returns `data: [...]`; v5's /search-v2 returns `data: { jobs: [...] }`.
 * Accept either rather than assuming, since the version is chosen in the
 * RapidAPI dashboard and can change without any code change here.
 */
export function extractJobs(payload) {
  const candidates = [payload?.data, payload?.data?.jobs, payload?.jobs, payload?.data?.results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/**
 * RapidAPI answers with bare status codes that mean something specific here.
 */
export function explain(err) {
  const message = String(err?.message || err);
  if (message.includes('404')) {
    return 'RapidAPI returned 404 — the request did not reach a subscribed endpoint. ' +
      'Either the app is not subscribed to JSearch, or this API version uses a path not in CANDIDATE_PATHS.';
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

function searchUrl(path, query) {
  const params = new URLSearchParams({
    query: `${query} in USA`,
    page: '1',
    num_pages: '1',
    country: 'us',
    date_posted: 'month',
    work_from_home: 'true',
  });
  return `https://jsearch.p.rapidapi.com${path}?${params}`;
}

function call(path, query) {
  return getJson(searchUrl(path, query), {
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });
}

// v5 dropped the `job_` prefix on several fields; accept both spellings so a
// version flip degrades into missing extras rather than an empty board.
const pick = (job, ...names) => names.map((n) => job?.[n]).find((v) => v !== undefined && v !== null && v !== '');

export function mapJob(job) {
  const city = [pick(job, 'job_city', 'city'), pick(job, 'job_state', 'state')].filter(Boolean).join(', ');
  const isRemote = pick(job, 'job_is_remote', 'is_remote') === true;
  const publisher = pick(job, 'job_publisher', 'publisher');

  return {
    sourceId: pick(job, 'job_id', 'id'),
    title: pick(job, 'job_title', 'title'),
    company: pick(job, 'employer_name', 'company_name', 'company'),
    companyLogo: pick(job, 'employer_logo', 'company_logo'),
    url: pick(job, 'job_apply_link', 'apply_link', 'job_google_link', 'url'),
    applyUrl: pick(job, 'job_apply_link', 'apply_link'),
    description: pick(job, 'job_description', 'description'),
    location: isRemote ? `Remote${city ? ` (${city})` : ''}` : city,
    locationRestriction: isRemote ? city || 'USA' : city,
    employmentTypes: [pick(job, 'job_employment_type', 'employment_type')].filter(Boolean),
    salaryMin: pick(job, 'job_min_salary', 'min_salary'),
    salaryMax: pick(job, 'job_max_salary', 'max_salary'),
    currency: pick(job, 'job_salary_currency', 'salary_currency'),
    postedAt: pick(job, 'job_posted_at_datetime_utc', 'posted_at_datetime_utc', 'job_posted_at_timestamp', 'posted_at'),
    remoteFlag: isRemote,
    // "LinkedIn", "Indeed", "ZipRecruiter", "Glassdoor", a company site…
    publisher,
    tags: [publisher].filter(Boolean),
  };
}

export async function fetchJobs({ warn }) {
  const jobs = [];
  let path = null;

  for (const query of QUERIES) {
    let payload;

    if (path) {
      try {
        payload = await call(path, query);
      } catch (err) {
        warn(`"${query}": ${explain(err)}`);
        continue;
      }
    } else {
      const failures = [];
      for (const candidate of CANDIDATE_PATHS) {
        try {
          payload = await call(candidate, query);
          path = candidate;
          break;
        } catch (err) {
          failures.push(`${candidate} → ${err.message}`);
        }
      }

      if (!path) {
        // Nothing will work this run; report every path tried and stop
        // rather than spending the quota on three more doomed attempts.
        warn(`No endpoint responded. Tried ${failures.join(', ')}. ${explain(new Error(failures[0] || ''))}`);
        return jobs;
      }

      if (path !== CANDIDATE_PATHS[0]) {
        warn(`Using ${path} — JSearch has moved off ${CANDIDATE_PATHS[0]}; make it the first candidate to save two requests per run.`);
      }
    }

    const rows = extractJobs(payload);
    if (!rows.length && payload) {
      warn(`"${query}": 200 OK but no jobs array found (top-level keys: ${Object.keys(payload).join(', ')})`);
      continue;
    }

    const mapped = rows.map(mapJob);
    const usable = mapped.filter((job) => job.title && job.company);
    if (rows.length && !usable.length) {
      warn(`"${query}": ${rows.length} rows returned but none had a title/company — field names have changed (row keys: ${Object.keys(rows[0]).slice(0, 12).join(', ')})`);
    }

    jobs.push(...usable);
  }

  return jobs;
}
