/**
 * Company career pages, straight from their applicant tracking system.
 *
 * These are the highest-signal postings you can get: no aggregator delay, no
 * recruiter spam, and often roles that never reach the job boards. Add the
 * companies Emily actually wants to work for to config/company-boards.json.
 *
 * Supported ATS (all have free, unauthenticated JSON endpoints):
 *   greenhouse  → boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
 *   lever       → api.lever.co/v0/postings/<token>?mode=json
 *   ashby       → api.ashbyhq.com/posting-api/job-board/<token>
 *
 * Finding a token: open the company's careers page and look at the URL, e.g.
 *   job-boards.greenhouse.io/acmecorp   → ats "greenhouse", token "acmecorp"
 *   jobs.lever.co/acmecorp              → ats "lever",      token "acmecorp"
 *   jobs.ashbyhq.com/acmecorp           → ats "ashby",      token "acmecorp"
 */

import { readFile } from 'node:fs/promises';
import { getJson } from '../lib/http.mjs';

export const id = 'companyboards';
export const label = 'Company career page';
export const enabled = true;

let cachedBoards = null;

async function loadBoards(configDir) {
  if (cachedBoards) return cachedBoards;
  try {
    const raw = await readFile(new URL('company-boards.json', configDir), 'utf8');
    const parsed = JSON.parse(raw);
    cachedBoards = (parsed.boards || []).filter((b) => b && b.ats && b.token);
  } catch {
    cachedBoards = [];
  }
  return cachedBoards;
}

export async function isConfigured({ configDir }) {
  return (await loadBoards(configDir)).length > 0;
}

export const skipReason = 'No companies listed in config/company-boards.json';

const ADAPTERS = {
  async greenhouse(board) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
    const payload = await getJson(url);
    return (payload?.jobs || []).map((job) => ({
      sourceId: `gh-${board.token}-${job.id}`,
      title: job.title,
      company: board.name || board.token,
      url: job.absolute_url,
      description: job.content,
      location: job.location?.name,
      locationRestriction: job.location?.name,
      postedAt: job.updated_at || job.first_published,
      tags: (job.metadata || []).map((m) => m?.value).filter((v) => typeof v === 'string'),
    }));
  },

  async lever(board) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
    const payload = await getJson(url);
    return (Array.isArray(payload) ? payload : []).map((job) => ({
      sourceId: `lv-${board.token}-${job.id}`,
      title: job.text,
      company: board.name || board.token,
      url: job.hostedUrl || job.applyUrl,
      applyUrl: job.applyUrl,
      description: [job.descriptionPlain, ...(job.lists || []).map((l) => `${l.text}: ${l.content}`)].join('\n'),
      location: job.categories?.location,
      locationRestriction: job.categories?.location,
      employmentTypes: [job.categories?.commitment].filter(Boolean),
      postedAt: job.createdAt,
      tags: [job.categories?.team, job.categories?.department].filter(Boolean),
      remoteFlag: /remote/i.test(job.workplaceType || ''),
    }));
  },

  async ashby(board) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}?includeCompensation=true`;
    const payload = await getJson(url);
    return (payload?.jobs || []).map((job) => ({
      sourceId: `ab-${board.token}-${job.id}`,
      title: job.title,
      company: board.name || payload?.name || board.token,
      url: job.jobUrl || job.applyUrl,
      applyUrl: job.applyUrl,
      description: job.descriptionPlain || job.descriptionHtml,
      location: job.location,
      locationRestriction: job.location,
      employmentTypes: [job.employmentType].filter(Boolean),
      salary: job.compensation?.compensationTierSummary,
      postedAt: job.publishedAt || job.updatedAt,
      tags: [job.department, job.team].filter(Boolean),
      remoteFlag: job.isRemote,
    }));
  },
};

export async function fetchJobs({ configDir, warn }) {
  const boards = await loadBoards(configDir);
  const jobs = [];

  for (const board of boards) {
    const adapter = ADAPTERS[String(board.ats).toLowerCase()];
    if (!adapter) {
      warn(`Unknown ATS "${board.ats}" for ${board.name || board.token}`);
      continue;
    }
    try {
      jobs.push(...(await adapter(board)));
    } catch (err) {
      // One dead board should never sink the rest of the run.
      warn(`${board.name || board.token} (${board.ats}): ${err.message}`);
    }
  }

  return jobs;
}
