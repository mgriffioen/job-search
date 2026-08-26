#!/usr/bin/env node
/**
 * Pulls postings from every enabled source, normalizes, de-duplicates, scores
 * them under each matching model, confirms the top of the default board is
 * still open, and writes docs/data/{,v2/,v3/}{jobs,meta}.json.
 *
 * Design rule: a single failing source must never fail the run. Each adapter
 * is isolated, and its error is recorded in meta.json so the site can show
 * which boards were reachable on the last update.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { normalizeJob, dedupeJobs, hostOf } from './lib/normalize.mjs';
import { evaluateLocation } from './lib/location.mjs';
import { scoreJob, matchTier } from './lib/score.mjs';
import { scoreJob as scoreJobV2 } from './lib/score-v2.mjs';
import { scoreJob as scoreJobV3, matchTier as matchTierV3 } from './lib/score-v3.mjs';
import { scoreJob as scoreJobV4 } from './lib/score-v4.mjs';
import { buildV2Profile, buildV3Profile, buildV4Profile } from './lib/profiles.mjs';
import { verifyListings } from './lib/verify.mjs';

import * as remotive from './sources/remotive.mjs';
import * as remoteok from './sources/remoteok.mjs';
import * as jobicy from './sources/jobicy.mjs';
import * as himalayas from './sources/himalayas.mjs';
import * as weworkremotely from './sources/weworkremotely.mjs';
import * as workingnomads from './sources/workingnomads.mjs';
import * as arbeitnow from './sources/arbeitnow.mjs';
import * as adzuna from './sources/adzuna.mjs';
import * as jsearch from './sources/jsearch.mjs';
import * as jooble from './sources/jooble.mjs';
import * as companyboards from './sources/companyboards.mjs';

const SOURCES = [
  companyboards,
  jsearch,
  adzuna,
  jooble,
  remotive,
  weworkremotely,
  himalayas,
  jobicy,
  remoteok,
  workingnomads,
  arbeitnow,
];

// Earlier = preferred when the same job appears on several boards.
const SOURCE_PRIORITY = SOURCES.map((s) => s.id);

const ROOT = new URL('../', import.meta.url);
const CONFIG_DIR = new URL('config/', ROOT);
const DATA_DIR = new URL('docs/data/', ROOT);

/** Missing or unparseable is not an error here — the first run has neither. */
async function readJsonIfPresent(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const startedAt = new Date();
  const profile = JSON.parse(await readFile(new URL('profile.json', CONFIG_DIR), 'utf8'));

  // The last run's meta.json is the only state that survives between runs, and
  // it is committed with every update. A metered source reads its own previous
  // report from it to know what quota it has left before spending anything.
  // v2 and v3 are overlays on the same profile, so every board searches
  // identically and they differ only in scoring. A missing overlay simply means
  // that board is not built.
  const v2Overlay = await readJsonIfPresent(new URL('profile.v2.json', CONFIG_DIR));
  const v2Profile = buildV2Profile(profile, v2Overlay);
  const v3Overlay = await readJsonIfPresent(new URL('profile.v3.json', CONFIG_DIR));
  const v3Profile = buildV3Profile(profile, v3Overlay);
  // v4 overlays v3 rather than the base profile: it keeps every axis and every
  // phrase v3 defined and adds the occupational fit gate in front of them.
  const v4Overlay = await readJsonIfPresent(new URL('profile.v4.json', CONFIG_DIR));
  const v4Profile = buildV4Profile(profile, v3Overlay, v4Overlay);

  const previousMeta = await readJsonIfPresent(new URL('meta.json', DATA_DIR));
  const previousReports = new Map((previousMeta?.sources ?? []).map((report) => [report.id, report]));

  const raw = [];
  const sourceReports = [];

  for (const source of SOURCES) {
    const report = { id: source.id, label: source.label, status: 'ok', fetched: 0, warnings: [] };
    const warn = (message) => {
      report.warnings.push(message);
      console.warn(`  ! ${source.label}: ${message}`);
    };

    if (source.enabled === false) {
      report.status = 'disabled';
      sourceReports.push(report);
      continue;
    }

    if (typeof source.isConfigured === 'function' && !(await source.isConfigured({ configDir: CONFIG_DIR }))) {
      report.status = 'skipped';
      report.detail = source.skipReason || 'Not configured';
      console.log(`- ${source.label}: skipped (${report.detail})`);
      sourceReports.push(report);
      continue;
    }

    const t0 = Date.now();
    try {
      const rows = await source.fetchJobs({
        profile,
        configDir: CONFIG_DIR,
        warn,
        previous: previousReports.get(source.id) ?? null,
        // Lets a source add its own fields to meta.json — the quota reading a
        // metered source needs to hand forward to the next run.
        record: (patch) => Object.assign(report, patch),
      });
      for (const row of rows) {
        const job = normalizeJob(row, { source: source.id, sourceLabel: source.label });
        if (job) raw.push(job);
      }
      report.fetched = rows.length;
      report.ms = Date.now() - t0;
      console.log(`+ ${source.label}: ${rows.length} postings (${report.ms}ms)`);
    } catch (err) {
      report.status = 'error';
      report.detail = err.message;
      report.ms = Date.now() - t0;
      console.error(`x ${source.label}: ${err.message}`);
    }

    sourceReports.push(report);
  }

  console.log(`\nNormalized ${raw.length} postings; de-duplicating…`);
  const deduped = dedupeJobs(raw, SOURCE_PRIORITY);
  console.log(`${deduped.length} unique postings.`);

  const now = new Date();

  // All four boards are built from this one fetch. Scoring is pure CPU, so the
  // extra models cost nothing at the APIs — which matters, because JSearch is
  // billed per request and running the pipeline once per model would multiply
  // every call. v4 is what the site opens on; v1, v2 and v3 stay alongside it
  // so a change to the matching can be seen rather than argued about.
  const boards = [
    { id: 'v1', label: 'Title-driven', profile, scoreJob, tier: matchTier, dir: DATA_DIR },
    v2Profile && {
      id: 'v2',
      label: 'Ability-based',
      profile: v2Profile,
      scoreJob: scoreJobV2,
      tier: matchTier,
      dir: new URL('v2/', DATA_DIR),
    },
    v3Profile && {
      id: 'v3',
      label: 'Fit profile',
      profile: v3Profile,
      scoreJob: scoreJobV3,
      // v3 grades on the specification's five bands rather than v1's four
      // tiers, so the tier function travels with the board.
      tier: (match) => matchTierV3(match, v3Profile),
      tierOrder: (v3Profile.bands || []).map((band) => band.tier),
      tierLabels: Object.fromEntries((v3Profile.bands || []).map((band) => [band.tier, band.label])),
      // Only this board pays for liveness checks: it publishes few enough
      // postings that verifying its top slice is affordable, and it is the
      // board the spec asks to confirm before presenting anything as open.
      verify: true,
      dir: new URL('v3/', DATA_DIR),
    },
    v4Profile && {
      id: 'v4',
      label: 'Occupational fit',
      profile: v4Profile,
      scoreJob: scoreJobV4,
      tier: (match) => matchTierV3(match, v4Profile),
      tierOrder: (v4Profile.bands || []).map((band) => band.tier),
      tierLabels: Object.fromEntries((v4Profile.bands || []).map((band) => [band.tier, band.label])),
      verify: true,
      dir: new URL('v4/', DATA_DIR),
    },
  ].filter(Boolean);

  let primary = null;

  for (const board of boards) {
    const built = buildBoard(deduped, board.profile, board.scoreJob, now, { tier: board.tier, tierOrder: board.tierOrder });

    // Confirming a posting is still open costs one request each, so it runs
    // over the published slice only, after scoring has decided what is worth
    // checking. Closed postings are dropped outright; everything else keeps a
    // label saying how sure we are.
    let verification = null;
    if (board.verify) {
      verification = await verifyListings(built.jobs, { warn: (m) => console.warn(`  ! liveness: ${m}`) });
      if (verification.closed) {
        built.jobs = built.jobs.filter((job) => job.availability !== 'closed');
        built.dropped.closed = verification.closed;
        built.tiers = countTiers(built.jobs, board.tierOrder);
      }
    }

    const meta = {
      generatedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      model: {
        id: board.id,
        label: board.label,
        tierOrder: board.tierOrder ?? ['strong', 'good', 'possible', 'stretch'],
        tierLabels: board.tierLabels ?? null,
        axisWeights: board.profile.axisWeights ?? null,
        // Named once here rather than on every posting: the board's 👍/👎
        // model stores work-signal ids, and the cards need their labels to say
        // what a rating was learned from.
        workSignalLabels: board.profile.workSignals
          ? Object.fromEntries(board.profile.workSignals.map((group) => [group.id, group.label]))
          : null,
        // v4 only: how many postings the Surprise Me shelf may show at once.
        // The client reads it rather than hard-coding a number the board owns.
        surpriseMax: board.profile.surprise?.maxShown ?? null,
      },
      candidate: board.profile.candidate,
      ranking: board.profile.ranking,
      filters: {
        maxAgeDays: board.profile.search.maxAgeDays,
        minMatchScore: board.profile.search.minMatchScore,
      },
      counts: {
        fetched: raw.length,
        unique: deduped.length,
        published: built.jobs.length,
        dropped: built.dropped,
      },
      tiers: built.tiers,
      ...(verification ? { verification: verification.report } : {}),
      freshLast48h: built.jobs.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length,
      projectBased: built.jobs.filter((j) => j.projectBased).length,
      discoveries: built.jobs.filter((j) => j.discovery).length,
      // v4 only: how many surprises are on the shelf, and how the occupational
      // gate classified what survived. Zero surprises is a normal day.
      surprises: built.jobs.filter((j) => j.surprise).length,
      occupations: built.jobs.some((j) => j.occupation)
        ? countOccupations(built.jobs)
        : null,
      sources: sourceReports,
    };

    await mkdir(board.dir, { recursive: true });
    await writeFile(new URL('jobs.json', board.dir), `${JSON.stringify(built.jobs, null, 0)}\n`);
    await writeFile(new URL('meta.json', board.dir), `${JSON.stringify(meta, null, 2)}\n`);

    console.log(
      `\n[${board.id}] ${board.label}: published ${built.jobs.length} jobs\n` +
        `  dropped: ${built.dropped.location} out-of-area, ${built.dropped.stale} stale, ` +
        `${built.dropped.lowMatch} below match threshold, ${built.dropped.excluded} excluded` +
        (built.dropped.wrongOccupation ? `, ${built.dropped.wrongOccupation} wrong occupation` : '') +
        (built.dropped.aiWork ? ` (${built.dropped.aiWork} of them AI training/evaluation)` : '') +
        (built.dropped.closed ? `, ${built.dropped.closed} no longer open` : '') +
        `\n  tiers: ${Object.entries(meta.tiers).map(([tier, count]) => `${count} ${tier}`).join(' / ')}` +
        (meta.discoveries ? `\n  new directions: ${meta.discoveries}` : '') +
        (meta.surprises ? `\n  surprise me: ${meta.surprises}` : '') +
        (verification ? `\n  liveness: ${verification.report.checked} checked, ${verification.report.live} confirmed open, ${verification.report.closed} closed, ${verification.report.unknown} unresolved` : '')
    );

    // The Actions run summary reports the board the site actually opens on.
    if (board.id === 'v4' || (!primary && board.id === 'v1')) primary = { meta, jobs: built.jobs };
  }

  if (primary) await writeStepSummary(primary.meta, primary.jobs);
}


/**
 * Scores and filters the deduplicated postings under one matching model.
 *
 * Taken out of main() so both models can run over the same postings without the
 * pipeline being duplicated — the gates (blocked domain, location, staleness,
 * threshold) must stay identical between boards or a difference in the results
 * would say more about the plumbing than about the models.
 */
export function buildBoard(deduped, profile, score, now, options = {}) {
  const tierOf = options.tier || matchTier;
  const maxAgeDays = profile.search.maxAgeDays;
  const minMatch = profile.search.minMatchScore;
  // The spec's freshness rule: a posting past staleAfterDays is only worth
  // showing if it is unusually strong. Boards that do not set it keep the
  // single maxAgeDays cliff.
  const staleAfterDays = profile.search.staleAfterDays ?? null;
  const staleKeepMinMatch = profile.search.staleKeepMinMatch ?? 100;
  const dropped = { location: 0, stale: 0, lowMatch: 0, excluded: 0, blockedDomain: 0, wrongOccupation: 0, aiWork: 0 };
  const scored = [];

  const blockedDomains = (profile.search.blockedDomains || []).map((d) => d.toLowerCase());
  const isBlocked = (url) => {
    const host = hostOf(url);
    return host ? blockedDomains.some((d) => host === d || host.endsWith(`.${d}`)) : false;
  };

  for (const job of deduped) {
    // Checked before scoring: a posting you cannot actually reach is worth
    // nothing regardless of how well it matches.
    if (isBlocked(job.url) && isBlocked(job.applyUrl)) {
      dropped.blockedDomain += 1;
      continue;
    }

    const location = evaluateLocation(job, profile);
    if (!location.eligible) {
      dropped.location += 1;
      continue;
    }

    // The location verdict is handed to the scorer rather than recomputed:
    // v3 scores how open the posting is as part of lifestyle fit.
    const result = score(job, profile, now, { location });

    if (result.excluded) {
      dropped.excluded += 1;
      continue;
    }
    /**
     * v4's occupational fit gate. A posting whose occupation is a different
     * profession, or whose stated credential she cannot hold, is dropped here
     * rather than published with a low score: the specification asks for these
     * to be suppressed, and a board that lists them at 20 is still asking her
     * to read them. The count is reported so the suppression stays visible.
     */
    if (result.suppressed) {
      dropped.wrongOccupation += 1;
      // AI training and evaluation is counted separately as well as in the
      // total. It is the newest of the suppression rules and the one most
      // likely to need tuning, so the run has to say how often it fired rather
      // than burying it among the lawyers and the nurses.
      if (result.details?.occupation?.id === 'ai-training') dropped.aiWork += 1;
      continue;
    }
    if (result.ageDays !== null && result.ageDays > maxAgeDays) {
      dropped.stale += 1;
      continue;
    }
    if (
      staleAfterDays !== null &&
      result.ageDays !== null &&
      result.ageDays > staleAfterDays &&
      result.match < staleKeepMinMatch
    ) {
      dropped.stale += 1;
      continue;
    }
    if (result.match < minMatch) {
      dropped.lowMatch += 1;
      continue;
    }

    // The full description is only needed for scoring — keep the file small.
    const { description, ...rest } = job;

    // The role may match perfectly, but a posting that will not say who is
    // hiring is worth less than an identical one that will. This adjusts
    // where it sorts, not how well it matched.
    const rank = job.employerUnknown
      ? Math.round(result.rank * (1 - (profile.ranking.unnamedEmployerPenalty ?? 0.25)) * 10) / 10
      : result.rank;

    scored.push({
      ...rest,
      locationScope: location.scope,
      locationReason: location.reason,
      match: result.match,
      matchTier: tierOf(result.match),
      // Contract / freelance / project-shaped work, which the board filters on.
      projectBased: result.projectBased,
      // v2 only: a role outside her current title, and why it was suggested.
      ...(result.discovery !== undefined ? { discovery: result.discovery, family: result.family } : {}),
      // v4 only: the Surprise Me shelf — an unfamiliar title whose work is
      // unusually well aligned anyway.
      ...(result.surprise !== undefined ? { surprise: result.surprise } : {}),
      recency: result.recency,
      rank,
      ageDays: result.ageDays,
      ageAssumed: result.ageAssumed,
      reasons: result.reasons,
      breakdown: result.breakdown,
      // v3 only: the four axis scores and the written report that goes with
      // them. Spread rather than nested so the card can read them directly.
      ...(result.details || {}),
    });
  }

  scored.sort((a, b) => b.rank - a.rank);
  const jobs = scored.slice(0, profile.search.maxJobsStored);
  return { jobs, dropped, tiers: countTiers(jobs, options.tierOrder) };
}

/**
 * Tier counts for the header tiles. The order comes from the board, because v3
 * grades on the specification's five bands and v1/v2 on four tiers — counting
 * one board's vocabulary on the other's produces a row of zeroes.
 */
export function countTiers(jobs, tierOrder = ['strong', 'good', 'possible', 'stretch']) {
  const counts = Object.fromEntries(tierOrder.map((tier) => [tier, 0]));
  for (const job of jobs) {
    if (job.matchTier in counts) counts[job.matchTier] += 1;
  }
  return counts;
}

/**
 * How many published postings sat in each occupational class. Only v4 carries
 * the field; on the other boards the tile it feeds stays hidden.
 */
export function countOccupations(jobs) {
  const counts = {};
  for (const job of jobs) {
    const cls = job.occupation?.class;
    if (!cls) continue;
    counts[cls] = (counts[cls] || 0) + 1;
  }
  return counts;
}

/** Nice-to-have: surface the top new matches in the GitHub Actions run summary. */
async function writeStepSummary(meta, jobs) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;

  const top = jobs.filter((j) => j.ageDays !== null && j.ageDays <= 3).slice(0, 15);
  const lines = [
    `## Job board updated — ${meta.counts.published} matches on the ${meta.model?.label ?? ''} board (${meta.model?.id ?? 'v1'})`,
    '',
    // Written from whichever tiers this board grades on, so the v3 bands are
    // not silently dropped from the summary.
    `${Object.entries(meta.tiers).map(([tier, count]) => `**${count}** ${tier}`).join(' · ')}` +
      ` · ${meta.freshLast48h} posted in the last 48h`,
    '',
  ];

  if (top.length) {
    lines.push('### Posted in the last 3 days', '', '| Match | Role | Company | Where | Source |', '| --- | --- | --- | --- | --- |');
    for (const job of top) {
      lines.push(
        `| ${job.match} | [${job.title}](${job.url}) | ${job.company} | ${job.location || job.locationScope} | ${job.sources.join(', ')} |`
      );
    }
    lines.push('');
  }

  // Metered sources report where they stand, so the quota is visible here on
  // every run instead of only in a RapidAPI warning email once it is too late.
  if (meta.verification?.enabled) {
    lines.push(
      `${meta.verification.live} of ${meta.verification.checked} checked postings confirmed still open` +
        `, ${meta.verification.closed} closed and dropped, ${meta.verification.unknown} could not be confirmed.`,
      ''
    );
  }

  for (const source of meta.sources.filter((s) => s.quota || s.budget)) {
    const used = typeof source.quota?.limit === 'number' && typeof source.quota?.remaining === 'number'
      ? `**${source.quota.limit - source.quota.remaining} of ${source.quota.limit}** used this period`
      : 'usage not reported';
    const resetsIn = source.quota?.resetAt ? Date.parse(source.quota.resetAt) - Date.now() : NaN;
    const resets = Number.isFinite(resetsIn) ? `, resets in ${Math.max(0, Math.round(resetsIn / 86400000))} days` : '';
    lines.push(
      `### ${source.label} API quota`,
      '',
      `${used}${resets} — spent ${source.budget?.spent ?? 0} of an allowed ${source.budget?.allowed ?? 0} this run.`,
      '',
      `_${source.budget?.reason ?? ''}_`,
      ''
    );
  }

  const failed = meta.sources.filter((s) => s.status === 'error');
  if (failed.length) {
    lines.push('### Sources that failed', '', ...failed.map((s) => `- **${s.label}**: ${s.detail}`), '');
  }

  await writeFile(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

/**
 * Only fetch when run as a command. Importing this module for any reason — a
 * test, a REPL, a one-off script — otherwise hit every job board and overwrote
 * docs/data as a side effect of the import.
 */
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
