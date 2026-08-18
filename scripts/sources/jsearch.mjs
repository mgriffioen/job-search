/**
 * JSearch (via RapidAPI) — the practical way to get LinkedIn, Indeed and
 * ZipRecruiter postings onto this board.
 *
 * None of those three offer a public API, but Google for Jobs indexes them,
 * and JSearch serves Google for Jobs results with the originating board named
 * in `job_publisher`. That publisher name is carried through to the card and
 * the board filter, so a LinkedIn posting shows up labelled LinkedIn.
 *
 * Free tier is roughly 200 requests/month and RapidAPI bills for every request
 * past it, so this adapter meters itself. Each run takes an even share of what
 * the quota has left over the runs the period still has room for, and keeps a
 * reserve back that nothing is allowed to touch — see scripts/lib/quota.mjs.
 *
 *   1. Sign up at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 *   2. Subscribe to the Basic (free) plan — the key alone is not enough
 *   3. Add the key as the RAPIDAPI_KEY repository secret
 */

import { getJsonWithHeaders } from '../lib/http.mjs';
import { describeQuota, planRunBudget, readQuotaHeaders, runIndex } from '../lib/quota.mjs';

export const id = 'jsearch';
export const label = 'Google Jobs';
export const enabled = true;

export function isConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

export const skipReason = 'RAPIDAPI_KEY not set — see README (this is what brings in LinkedIn/Indeed/ZipRecruiter)';

/**
 * Every query costs a request against a ~200/month quota, so running the whole
 * keyword list twice a day is not affordable. Instead each run takes a moving
 * window of it, advancing every run, so the full list is covered over a couple
 * of days rather than the tail never running at all.
 *
 * `perRun` is whatever the quota budget allowed this run, so the window narrows
 * as the quota tightens; the rotation keeps coverage broad either way.
 *
 * The window is derived from the clock rather than stored state, so it keeps
 * advancing without anything to persist between runs.
 */
export function selectQueries(all, perRun, now = new Date(), runsPerDay = 2) {
  if (!all.length || perRun <= 0) return [];
  if (perRun >= all.length) return [...all];

  const index = runIndex(now, runsPerDay);
  const start = ((index * perRun) % all.length + all.length) % all.length;
  return [...all, ...all].slice(start, start + perRun);
}

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
  // null, not [] — "no array anywhere" is a shape change worth reporting,
  // whereas a query that legitimately matched nothing returns an empty array.
  return null;
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
    return 'RapidAPI monthly quota exhausted, or its per-second rate limit was hit (429). ' +
      'The budget in scripts/lib/quota.mjs paces against the quota headers, so an exhausted quota ' +
      'here means search.jsearchQuota.reserve in config/profile.json is too small a cushion — raise it.';
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
  return getJsonWithHeaders(searchUrl(path, query), {
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
    // Every attempt is a request the plan may be billed for, so a failed call
    // is not retried here: the rotation brings the query back next run, twelve
    // hours later, at no cost. Other sources are free and still retry.
    retries: 0,
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

/**
 * Wraps a call so the meter is read from every response, success or failure —
 * a 429 carries the most important reading of all, and a run that ends without
 * updating the meter would leave the next run pacing off stale numbers.
 */
async function meteredCall(path, query, state) {
  state.spent += 1;
  try {
    const { data, headers } = await call(path, query);
    state.quota = readQuotaHeaders(headers) ?? state.quota;
    return data;
  } catch (err) {
    state.quota = readQuotaHeaders(err?.headers) ?? state.quota;
    throw err;
  }
}

/** True once the reserve is all that is left — the hard stop, mid-run. */
function reserveReached(state, reserve) {
  return typeof state.quota?.remaining === 'number' && state.quota.remaining - reserve <= 0;
}

export async function fetchJobs({ profile, warn, previous, record = () => {} }) {
  const jobs = [];
  let path = null;

  const settings = profile.search.jsearchQuota ?? {};
  const reserve = settings.reserve ?? 0;
  const runsPerDay = settings.runsPerDay ?? 2;
  const maxPerRun = profile.search.jsearchQueriesPerRun ?? 3;

  // The previous run's reading, carried in meta.json. The decision has to be
  // made before the first request, which is the one moment no fresh reading of
  // our own exists.
  const state = { quota: previous?.quota ?? null, spent: 0 };

  // JSEARCH_ENABLED=false spends nothing without pretending the source is
  // unconfigured. The workflow sets it on push-triggered runs: editing a script
  // should not cost requests from a metered quota, and the next scheduled run
  // is at most twelve hours away.
  const budget = process.env.JSEARCH_ENABLED === 'false'
    ? { allowed: 0, remaining: state.quota?.remaining ?? null, reason: 'not a scheduled run — holding the metered quota for the next one' }
    : planRunBudget(state.quota, {
      maxPerRun,
      reserve,
      runsPerDay,
      fallbackLimit: settings.monthlyLimit ?? null,
      periodDays: settings.periodDays ?? 31,
    });

  const report = () => record({
    quota: state.quota,
    budget: { allowed: budget.allowed, spent: state.spent, reserve, reason: budget.reason },
  });

  if (budget.allowed <= 0) {
    // Not a warning: declining to spend is this source working as designed, and
    // flagging it red on the site would misreport a healthy run.
    console.log(`  · ${label}: no requests this run — ${budget.reason}`);
    report();
    return jobs;
  }

  const queries = selectQueries(profile.search.queries, budget.allowed, new Date(), runsPerDay);
  console.log(`  · ${label}: budget ${budget.allowed}/${maxPerRun} request(s) — ${budget.reason}`);

  for (const query of queries) {
    if (reserveReached(state, reserve)) {
      // Not a warning: stopping here is the budget working, and flagging it on
      // the site would report a healthy run as a broken board.
      console.log(`  · ${label}: stopping after ${state.spent} request(s) — ${describeQuota(state.quota)}, holding the ${reserve}-request reserve`);
      break;
    }

    let payload;

    if (path) {
      try {
        payload = await meteredCall(path, query, state);
      } catch (err) {
        warn(`"${query}": ${explain(err)}`);
        continue;
      }
    } else {
      const failures = [];
      for (const candidate of CANDIDATE_PATHS) {
        // Probing spends real requests, so it stops at the reserve like
        // anything else rather than being treated as overhead that is free.
        if (reserveReached(state, reserve)) break;
        try {
          payload = await meteredCall(candidate, query, state);
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
        report();
        return jobs;
      }

      if (path !== CANDIDATE_PATHS[0]) {
        warn(`Using ${path} — JSearch has moved off ${CANDIDATE_PATHS[0]}; make it the first candidate to save two requests per run.`);
      }
    }

    const rows = extractJobs(payload);
    if (rows === null) {
      warn(`"${query}": 200 OK but no jobs array found (top-level keys: ${Object.keys(payload || {}).join(', ')})`);
      continue;
    }
    if (!rows.length) continue; // a query that matched nothing is not a fault

    const mapped = rows.map(mapJob);
    const usable = mapped.filter((job) => job.title && job.company);
    if (rows.length && !usable.length) {
      warn(`"${query}": ${rows.length} rows returned but none had a title/company — field names have changed (row keys: ${Object.keys(rows[0]).slice(0, 12).join(', ')})`);
    }

    jobs.push(...usable);
  }

  console.log(`  · ${label}: spent ${state.spent} request(s) — ${describeQuota(state.quota)}`);
  report();
  return jobs;
}
