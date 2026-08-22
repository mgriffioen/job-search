/**
 * Liveness verification.
 *
 * A job board is only as good as its worst link. Aggregators keep serving
 * postings for weeks after the employer has closed them, and the specification
 * is explicit: do not present a listing as active without checking, and label
 * it clearly when the check could not settle it.
 *
 * So the published slice of the board is re-fetched, one request per posting,
 * and each is filed as:
 *
 *   open        the link resolved and the page does not say the role is closed
 *   closed      the link is gone (404/410) or the page says so in words
 *   unverified  the check could not run or could not decide — a bot wall, a
 *               timeout, a redirect to a login page, or the budget ran out
 *
 * Three rules keep this honest and cheap:
 *
 * NEVER GUESS CLOSED. Anything short of a definite answer is `unverified`, not
 * `closed`, because a false positive silently deletes a real job — the exact
 * failure this is meant to prevent. Sites that answer 403 to anything without a
 * browser are common, and they are not evidence of anything.
 *
 * SPEND A FIXED BUDGET. A hard cap on requests, on concurrency and on total
 * wall-clock time, so a slow host cannot turn a two-minute run into a
 * twenty-minute one. What the budget does not reach stays `unverified`.
 *
 * NEVER FAIL THE RUN. Every error is caught and recorded. A verification pass
 * that cannot reach the network at all produces a board where nothing is
 * confirmed, which is exactly what the labels are for.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0 Safari/537.36 job-search-board/1.0 (personal job search aggregator)';

/**
 * Wording that means the role itself is gone. Deliberately specific: "closed"
 * and "expired" on their own appear in perfectly live postings ("closed-loop
 * marketing", "expired promotions"), and a loose match here deletes jobs.
 */
export const CLOSED_PHRASES = [
  'no longer accepting applications',
  'no longer accepting application',
  'we are no longer accepting',
  'this job is no longer available',
  'this job is no longer active',
  'this position is no longer available',
  'position is no longer available',
  'this role is no longer available',
  'job posting has expired',
  'this posting has expired',
  'this job has expired',
  'posting is no longer available',
  'the position has been filled',
  'this position has been filled',
  'applications are closed',
  'applications have closed',
  'application period has ended',
  'this job has been closed',
  'this listing has been removed',
  'job not found',
  'sorry, this job is no longer',
];

const MAX_BODY_CHARS = 300_000;

/**
 * Decides what a response says about the posting.
 *
 * Exported separately from the fetching so the decision can be tested without
 * a network: it is the part that can silently delete a real job.
 */
export function classifyResponse({ status, body = '', error = null }) {
  if (error) return { state: 'unverified', detail: error };

  // Gone is gone. Every other status is somebody's opinion: 403 and 429 are bot
  // walls, 5xx is a bad afternoon, 3xx has already been followed.
  if (status === 404 || status === 410) return { state: 'closed', detail: `HTTP ${status}` };
  if (status >= 400) return { state: 'unverified', detail: `HTTP ${status}` };

  const haystack = String(body).slice(0, MAX_BODY_CHARS).toLowerCase();
  const phrase = CLOSED_PHRASES.find((p) => haystack.includes(p));
  if (phrase) return { state: 'closed', detail: `page says “${phrase}”` };

  // An empty 200 tells us nothing — a JavaScript-rendered board will serve one
  // for a closed posting just as happily as for an open one.
  if (haystack.trim().length < 500) return { state: 'unverified', detail: 'empty response body' };

  return { state: 'open', detail: `HTTP ${status}` };
}

async function fetchOnce(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    const body = res.status >= 400 ? '' : await res.text();
    return classifyResponse({ status: res.status, body });
  } catch (err) {
    return classifyResponse({ error: err.name === 'AbortError' ? 'timed out' : err.message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the published postings and annotates each with `availability`.
 *
 * @param {object[]} jobs   published postings, best first — the budget is spent
 *                          from the top, so the highest-ranked are the ones
 *                          actually confirmed
 * @returns {Promise<{report: object, closed: number}>}
 */
export async function verifyListings(jobs, options = {}) {
  const {
    maxChecks = Number(process.env.VERIFY_MAX_CHECKS || 60),
    concurrency = 6,
    timeoutMs = 8000,
    budgetMs = 90_000,
    fetchImpl = globalThis.fetch,
    warn = () => {},
    now = () => Date.now(),
  } = options;

  const enabled = process.env.VERIFY_LISTINGS !== 'false' && typeof fetchImpl === 'function';
  const report = { enabled, checked: 0, live: 0, closed: 0, unknown: 0, skipped: 0, ms: 0 };

  if (!enabled) {
    for (const job of jobs) job.availability = 'unverified';
    report.skipped = jobs.length;
    return { report, closed: 0 };
  }

  const startedAt = now();
  const queue = jobs.slice(0, maxChecks);
  for (const job of jobs.slice(maxChecks)) job.availability = 'unverified';
  report.skipped = Math.max(0, jobs.length - queue.length);

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      if (now() - startedAt > budgetMs) {
        // Out of time rather than out of postings: whatever is left keeps the
        // honest label instead of an assumption.
        for (let i = cursor; i < queue.length; i += 1) {
          if (!queue[i].availability) {
            queue[i].availability = 'unverified';
            report.skipped += 1;
          }
        }
        cursor = queue.length;
        return;
      }

      const job = queue[cursor];
      cursor += 1;

      const target = job.applyUrl || job.url;
      if (!target) {
        job.availability = 'unverified';
        report.skipped += 1;
        continue;
      }

      const verdict = await fetchOnce(target, { timeoutMs, fetchImpl });
      job.availability = verdict.state;
      job.availabilityDetail = verdict.detail;
      job.availabilityCheckedAt = new Date().toISOString();

      report.checked += 1;
      if (verdict.state === 'open') report.live += 1;
      else if (verdict.state === 'closed') report.closed += 1;
      else report.unknown += 1;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } catch (err) {
    // Should not happen — every worker catches its own — but a verification
    // pass must never be the reason a run produces no board at all.
    warn(`verification aborted: ${err.message}`);
    for (const job of jobs) if (!job.availability) job.availability = 'unverified';
  }

  report.ms = now() - startedAt;
  return { report, closed: report.closed };
}
