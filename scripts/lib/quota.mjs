/**
 * Request budgeting for metered APIs — currently only JSearch, whose RapidAPI
 * BASIC plan allows ~200 requests a month and bills for every request past it.
 *
 * The problem this solves: a fixed number of requests per run cannot stay under
 * a monthly cap, because the number of runs in a month is not fixed. Scheduled
 * runs, manual runs and push-triggered runs all spend from the same meter, so a
 * busy week of commits silently turns into an overage bill.
 *
 * So the budget is not a constant. Before spending anything, a run asks how much
 * is left and how long the period still has to run, and takes an even share of
 * what remains. Spend early in the period and later runs get less; skip a few
 * runs and they get more. The cap holds either way.
 *
 * RapidAPI reports the meter on every response, so the count is theirs, not a
 * tally of our own that could drift away from it.
 */

export const HEADER_LIMIT = 'x-ratelimit-requests-limit';
export const HEADER_REMAINING = 'x-ratelimit-requests-remaining';
export const HEADER_RESET = 'x-ratelimit-requests-reset';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A run index that advances once per scheduled run without anything stored
 * between runs. Two runs a day means a new index every 12 hours.
 */
export function runIndex(now = new Date(), runsPerDay = 2) {
  return Math.floor(now.getTime() / (DAY_MS / runsPerDay));
}

/**
 * Pulls the meter off a response. Works with a fetch Headers object or a plain
 * object, and returns null when the headers are absent — an API that does not
 * report its meter is not the same as one reporting zero left.
 */
export function readQuotaHeaders(headers, now = new Date()) {
  const num = (name) => {
    const raw = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const limit = num(HEADER_LIMIT);
  const remaining = num(HEADER_REMAINING);
  if (limit === null && remaining === null) return null;

  const resetSeconds = num(HEADER_RESET);
  return {
    limit,
    remaining,
    observedAt: now.toISOString(),
    // RapidAPI counts down the seconds left in the quota period. Stored as an
    // absolute time so a reading stays meaningful in a later run.
    resetAt: resetSeconds === null ? null : new Date(now.getTime() + resetSeconds * 1000).toISOString(),
  };
}

/**
 * How many runs are still expected before the meter resets. At least one — the
 * current run — so the final run of a period may spend what is left rather than
 * dividing by zero or hoarding it into a reset that wipes it.
 */
function runsRemaining(resetAtMs, now, runsPerDay, periodDays) {
  if (!Number.isFinite(resetAtMs)) return Math.max(1, Math.round(periodDays * runsPerDay));
  const msLeft = resetAtMs - now.getTime();
  return Math.max(1, Math.ceil((msLeft / DAY_MS) * runsPerDay));
}

/**
 * Decides how many requests this run may spend.
 *
 * `quota` is the last reading we have, normally carried over from the previous
 * run's meta.json — the decision has to be made before the first request of the
 * run, which is exactly when no fresh reading exists.
 *
 * Returns `allowed` plus a human-readable `reason`, which lands in meta.json and
 * the Actions summary so a run that quietly did less says why.
 */
export function planRunBudget(quota, options = {}) {
  const {
    maxPerRun,
    reserve = 0,
    runsPerDay = 2,
    periodDays = 31,
    fallbackLimit = null,
    now = new Date(),
  } = options;

  if (!(maxPerRun > 0)) {
    return { allowed: 0, remaining: null, reason: 'configured for 0 requests per run' };
  }

  if (!quota || typeof quota.remaining !== 'number') {
    return {
      allowed: maxPerRun,
      remaining: null,
      reason: 'no quota reading yet — this run\'s response headers will set the pace for the next one',
    };
  }

  const resetAtMs = quota.resetAt ? Date.parse(quota.resetAt) : NaN;

  // A reading from a period that has since ended describes a meter that has
  // already rolled over; the plan's own limit is the better guess at what a
  // fresh period holds.
  const rolledOver = Number.isFinite(resetAtMs) && resetAtMs <= now.getTime();
  const remaining = rolledOver ? (quota.limit ?? fallbackLimit ?? maxPerRun) : quota.remaining;

  // The reserve is the whole point of the exercise: it is the cushion that
  // absorbs the requests nobody planned for — a manual run, a retry, a probe
  // against a moved endpoint — without any of them costing money.
  const usable = remaining - reserve;
  if (usable <= 0) {
    return {
      allowed: 0,
      remaining,
      reason: `${remaining} request${remaining === 1 ? '' : 's'} left this period, held back as the overage reserve`,
    };
  }

  const runsLeft = runsRemaining(resetAtMs, now, runsPerDay, periodDays);
  const share = usable / runsLeft;

  // The share is rarely a whole number, and simply flooring it would waste the
  // remainder — at 200/month that is a third of the plan left unspent, which is
  // its own kind of failure. Instead the fraction is carried across runs: a run
  // gets the extra request whenever the running total crosses the next whole
  // one. Averaged over the period that spends exactly the share, while any
  // single run stays inside it.
  //
  // The same arithmetic covers a nearly-spent quota, where the share drops
  // below one and this grants a single request every few runs rather than
  // spending the tail at once and going dark until the meter resets.
  const index = runIndex(now, runsPerDay);
  const base = Math.floor(share);
  const fraction = share - base;
  const carry = fraction > 0 && Math.floor((index + 1) * fraction) > Math.floor(index * fraction) ? 1 : 0;
  const allowed = Math.max(0, Math.min(maxPerRun, base + carry));

  if (allowed >= maxPerRun) {
    return { allowed, remaining, reason: `${usable} spendable across ~${runsLeft} runs left — full budget available` };
  }
  return {
    allowed,
    remaining,
    reason: `pacing ${usable} spendable request${usable === 1 ? '' : 's'} across ~${runsLeft} runs left this period ` +
      `(${share.toFixed(2)}/run)`,
  };
}

/** One-line meter summary for logs, meta.json and the Actions run summary. */
export function describeQuota(quota) {
  if (!quota || typeof quota.remaining !== 'number') return 'quota unknown';
  const used = typeof quota.limit === 'number' ? `${quota.limit - quota.remaining}/${quota.limit} used, ` : '';
  const resetsIn = quota.resetAt ? Date.parse(quota.resetAt) - Date.now() : NaN;
  const days = Number.isFinite(resetsIn) ? `, resets in ${Math.max(0, Math.round(resetsIn / DAY_MS))}d` : '';
  return `${used}${quota.remaining} left${days}`;
}
