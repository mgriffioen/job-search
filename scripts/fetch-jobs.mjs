#!/usr/bin/env node
/**
 * Pulls postings from every enabled source, normalizes, de-duplicates, scores
 * against config/profile.json, and writes docs/data/{jobs,meta}.json.
 *
 * Design rule: a single failing source must never fail the run. Each adapter
 * is isolated, and its error is recorded in meta.json so the site can show
 * which boards were reachable on the last update.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { normalizeJob, dedupeJobs } from './lib/normalize.mjs';
import { evaluateLocation } from './lib/location.mjs';
import { scoreJob, matchTier } from './lib/score.mjs';

import * as remotive from './sources/remotive.mjs';
import * as remoteok from './sources/remoteok.mjs';
import * as jobicy from './sources/jobicy.mjs';
import * as himalayas from './sources/himalayas.mjs';
import * as weworkremotely from './sources/weworkremotely.mjs';
import * as workingnomads from './sources/workingnomads.mjs';
import * as arbeitnow from './sources/arbeitnow.mjs';
import * as adzuna from './sources/adzuna.mjs';
import * as companyboards from './sources/companyboards.mjs';

const SOURCES = [
  companyboards,
  adzuna,
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

async function main() {
  const startedAt = new Date();
  const profile = JSON.parse(await readFile(new URL('profile.json', CONFIG_DIR), 'utf8'));

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
      const rows = await source.fetchJobs({ profile, configDir: CONFIG_DIR, warn });
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
  const maxAgeDays = profile.search.maxAgeDays;
  const minMatch = profile.search.minMatchScore;

  const dropped = { location: 0, stale: 0, lowMatch: 0, excluded: 0 };
  const scored = [];

  for (const job of deduped) {
    const location = evaluateLocation(job, profile);
    if (!location.eligible) {
      dropped.location += 1;
      continue;
    }

    const score = scoreJob(job, profile, now);

    if (score.excluded) {
      dropped.excluded += 1;
      continue;
    }
    if (score.ageDays !== null && score.ageDays > maxAgeDays) {
      dropped.stale += 1;
      continue;
    }
    if (score.match < minMatch) {
      dropped.lowMatch += 1;
      continue;
    }

    // The full description is only needed for scoring — keep the file small.
    const { description, ...rest } = job;

    scored.push({
      ...rest,
      locationScope: location.scope,
      locationReason: location.reason,
      match: score.match,
      matchTier: matchTier(score.match),
      recency: score.recency,
      rank: score.rank,
      ageDays: score.ageDays,
      ageAssumed: score.ageAssumed,
      reasons: score.reasons,
      breakdown: score.breakdown,
    });
  }

  scored.sort((a, b) => b.rank - a.rank);
  const jobs = scored.slice(0, profile.search.maxJobsStored);

  const meta = {
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    candidate: profile.candidate,
    ranking: profile.ranking,
    filters: { maxAgeDays, minMatchScore: minMatch },
    counts: {
      fetched: raw.length,
      unique: deduped.length,
      published: jobs.length,
      dropped,
    },
    tiers: {
      strong: jobs.filter((j) => j.matchTier === 'strong').length,
      good: jobs.filter((j) => j.matchTier === 'good').length,
      possible: jobs.filter((j) => j.matchTier === 'possible').length,
      stretch: jobs.filter((j) => j.matchTier === 'stretch').length,
    },
    freshLast48h: jobs.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length,
    sources: sourceReports,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL('jobs.json', DATA_DIR), `${JSON.stringify(jobs, null, 0)}\n`);
  await writeFile(new URL('meta.json', DATA_DIR), `${JSON.stringify(meta, null, 2)}\n`);

  console.log(
    `\nPublished ${jobs.length} jobs → docs/data/jobs.json\n` +
      `  dropped: ${dropped.location} out-of-area, ${dropped.stale} stale, ` +
      `${dropped.lowMatch} below match threshold, ${dropped.excluded} excluded\n` +
      `  tiers: ${meta.tiers.strong} strong / ${meta.tiers.good} good / ` +
      `${meta.tiers.possible} possible / ${meta.tiers.stretch} stretch`
  );

  await writeStepSummary(meta, jobs);
}

/** Nice-to-have: surface the top new matches in the GitHub Actions run summary. */
async function writeStepSummary(meta, jobs) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;

  const top = jobs.filter((j) => j.ageDays !== null && j.ageDays <= 3).slice(0, 15);
  const lines = [
    `## Job board updated — ${meta.counts.published} matches`,
    '',
    `**${meta.tiers.strong}** strong · **${meta.tiers.good}** good · ` +
      `**${meta.tiers.possible}** possible · ${meta.freshLast48h} posted in the last 48h`,
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

  const failed = meta.sources.filter((s) => s.status === 'error');
  if (failed.length) {
    lines.push('### Sources that failed', '', ...failed.map((s) => `- **${s.label}**: ${s.detail}`), '');
  }

  await writeFile(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
