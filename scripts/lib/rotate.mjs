/**
 * Rotating query windows.
 *
 * The keyword list is longer than any single run should send: JSearch is billed
 * per request, and the free boards rate-limit. Rather than truncating the list —
 * which would mean the terms at the bottom are never searched at all — each run
 * takes a window of it that advances, so everything is covered over a few runs.
 *
 * The window position comes from the clock rather than stored state, so it keeps
 * advancing with nothing to persist between runs.
 */

const DAY_MS = 24 * 3600 * 1000;

export function runIndex(now = new Date(), runsPerDay = 2) {
  return Math.floor(now.getTime() / (DAY_MS / runsPerDay));
}

export function selectRotating(all, perRun, now = new Date(), runsPerDay = 2) {
  if (!all.length || perRun <= 0) return [];
  if (perRun >= all.length) return [...all];

  const index = runIndex(now, runsPerDay);
  const start = ((index * perRun) % all.length + all.length) % all.length;
  return [...all, ...all].slice(start, start + perRun);
}
