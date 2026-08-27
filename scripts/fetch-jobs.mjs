#!/usr/bin/env node
/**
 * Pulls postings from every enabled source, normalizes, de-duplicates, keeps
 * the ones whose title matches a search term, and writes docs/data/jobs.json
 * and docs/data/meta.json.
 *
 * One board. One pass. Two filters — can she physically take it, and is it
 * still recent — and one relevance rule. Nothing else stands between a posting
 * and the page.
 *
 * Design rule, unchanged and still worth keeping: a single failing source must
 * never fail the run. Each adapter is isolated and its error is recorded in
 * meta.json, so the site can show which boards were reachable.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { normalizeJob, dedupeJobs } from './lib/normalize.mjs';
import { evaluateLocation } from './lib/location.mjs';
import { evaluate } from './lib/match.mjs';

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
  // Duplicates in the term list would be sent to the boards twice and would
  // make the ratings model treat one category as two.
  profile.searchTerms = [...new Set(profile.searchTerms)];
  profile.broadTerms = [...new Set(profile.broadTerms)];

  // The last run's meta.json is the only state that survives between runs, and
  // it is committed with every update. A metered source reads its own previous
  // report from it to know what quota it has left before spending anything.
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

  const built = buildBoard(deduped, profile, new Date());

  const meta = {
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    candidate: profile.candidate,
    ranking: profile.ranking,
    // The vocabulary the board searched on, so the page can say what it looked
    // for and offer the matched terms as filters.
    searchTerms: profile.searchTerms,
    filters: { maxAgeDays: profile.search.maxAgeDays },
    counts: {
      fetched: raw.length,
      unique: deduped.length,
      published: built.jobs.length,
      dropped: built.dropped,
    },
    // How many published postings each term brought in. This is the honest
    // measure of whether a term is earning its place in the list.
    terms: built.termCounts,
    // Where the term was found, across the published set. A board that is
    // mostly description matches is a board whose title vocabulary is too thin.
    matchedIn: countMatchedIn(built.jobs),
    freshLast48h: built.jobs.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length,
    contract: built.jobs.filter((j) => j.employmentTypes.includes('contract')).length,
    sources: sourceReports,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL('jobs.json', DATA_DIR), `${JSON.stringify(built.jobs, null, 0)}\n`);
  await writeFile(new URL('meta.json', DATA_DIR), `${JSON.stringify(meta, null, 2)}\n`);

  console.log(
    `\nPublished ${built.jobs.length} jobs\n` +
      `  dropped: ${built.dropped.location} not remote / out of area, ` +
      `${built.dropped.stale} older than ${profile.search.maxAgeDays} days, ` +
      `${built.dropped.noTermMatch} no search term anywhere\n` +
      `  matched in: ${Object.entries(countMatchedIn(built.jobs)).map(([k, n]) => `${n} ${k}`).join(', ')}\n` +
      `  top terms: ${Object.entries(built.termCounts).slice(0, 8).map(([t, n]) => `${t} (${n})`).join(', ')}`
  );

  await writeStepSummary(meta, built.jobs);
}

/**
 * Applies the three rules to the deduplicated postings.
 *
 * Order matters only for the drop counts: location is checked first because it
 * is the cheapest and the least arguable.
 */
export function buildBoard(deduped, profile, now = new Date()) {
  const maxAgeDays = profile.search.maxAgeDays;
  const dropped = { location: 0, stale: 0, noTermMatch: 0 };
  const kept = [];

  for (const job of deduped) {
    const location = evaluateLocation(job, profile);
    if (!location.eligible) {
      dropped.location += 1;
      continue;
    }

    const result = evaluate(job, profile, now);
    if (!result) {
      dropped.noTermMatch += 1;
      continue;
    }

    if (result.ageDays !== null && !result.ageAssumed && result.ageDays > maxAgeDays) {
      dropped.stale += 1;
      continue;
    }

    // The full description is only needed for matching — keep the file small.
    const { description, ...rest } = job;

    kept.push({
      ...rest,
      locationScope: location.scope,
      locationReason: location.reason,
      relevance: result.relevance,
      matchedIn: result.matchedIn,
      matchedTerm: result.matchedTerm,
      matchedTerms: result.matchedTerms,
      seniority: result.seniority,
      recency: result.recency,
      ageDays: result.ageDays,
      ageAssumed: result.ageAssumed,
      rank: result.rank,
    });
  }

  kept.sort((a, b) => b.rank - a.rank);
  const jobs = kept.slice(0, profile.search.maxJobsStored);
  return { jobs, dropped, termCounts: countTerms(jobs) };
}

/** How many published postings matched in the title, the tags, the body. */
export function countMatchedIn(jobs) {
  const counts = { title: 0, tags: 0, description: 0 };
  for (const job of jobs) counts[job.matchedIn] = (counts[job.matchedIn] || 0) + 1;
  return counts;
}

/** Published postings per matched term, most productive first. */
export function countTerms(jobs) {
  const counts = {};
  for (const job of jobs) counts[job.matchedTerm] = (counts[job.matchedTerm] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/** Nice-to-have: surface the freshest matches in the GitHub Actions run summary. */
async function writeStepSummary(meta, jobs) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;

  const top = jobs.filter((j) => j.ageDays !== null && j.ageDays <= 3).slice(0, 15);
  const lines = [
    `## Job board updated — ${meta.counts.published} matches`,
    '',
    `${meta.counts.unique} unique postings fetched · ${meta.freshLast48h} posted in the last 48h · ${meta.contract} contract or freelance`,
    '',
  ];

  if (top.length) {
    lines.push('### Posted in the last 3 days', '', '| Match | Role | Company | Where | Matched | Source |', '| --- | --- | --- | --- | --- | --- |');
    for (const job of top) {
      lines.push(
        `| ${job.relevance} | [${job.title}](${job.url}) | ${job.company} | ${job.location || job.locationScope} | ${job.matchedTerm} | ${job.sources.join(', ')} |`
      );
    }
    lines.push('');
  }

  // Metered sources report where they stand, so the quota is visible here on
  // every run instead of only in a RapidAPI warning email once it is too late.
  for (const source of meta.sources.filter((s) => s.quota || s.budget)) {
    const used = typeof source.quota?.limit === 'number' && typeof source.quota?.remaining === 'number'
      ? `**${source.quota.limit - source.quota.remaining} of ${source.quota.limit}** used this period`
      : 'usage not reported';
    lines.push(`### ${source.label} API quota`, '', `${used} — spent ${source.budget?.spent ?? 0} of an allowed ${source.budget?.allowed ?? 0} this run.`, '');
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
