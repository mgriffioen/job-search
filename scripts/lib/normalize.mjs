/**
 * Every source adapter returns loosely-shaped objects; this turns them into
 * one canonical Job record so the scorer and the UI only ever see one shape.
 */

import { stripHtml, excerpt, slugify, toIsoDate, normalizeForMatch, containsPhrase } from './text.mjs';
import { detectWorkType } from './location.mjs';

const EMPLOYMENT_PATTERNS = [
  { type: 'part-time', phrases: ['part-time', 'part time', 'parttime'] },
  { type: 'full-time', phrases: ['full-time', 'full time', 'fulltime'] },
  { type: 'contract', phrases: ['contract', 'contractor', 'freelance', 'temporary', 'temp-to-hire', 'seasonal'] },
  { type: 'internship', phrases: ['internship', 'intern'] },
];

function detectEmploymentTypes(rawTypes, title, description) {
  const found = new Set();

  for (const raw of [].concat(rawTypes || []).filter(Boolean)) {
    const t = String(raw).toLowerCase().replace(/[_\s]+/g, '-');
    if (t.includes('part')) found.add('part-time');
    else if (t.includes('full')) found.add('full-time');
    else if (t.includes('contract') || t.includes('freelance') || t.includes('temporary')) found.add('contract');
    else if (t.includes('intern')) found.add('internship');
  }

  if (!found.size) {
    const hay = normalizeForMatch(`${title} ${String(description).slice(0, 2500)}`);
    for (const { type, phrases } of EMPLOYMENT_PATTERNS) {
      if (phrases.some((p) => containsPhrase(hay, p))) found.add(type);
    }
  }

  return found.size ? [...found] : ['unspecified'];
}

function cleanUrl(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!/^https?:\/\//i.test(value)) return null;
  return value;
}

function formatSalary({ salary, salaryMin, salaryMax, currency = 'USD' }) {
  if (salary && String(salary).trim()) return String(salary).trim();
  const min = Number(salaryMin);
  const max = Number(salaryMax);
  const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (min > 0 && max > 0) return `${fmt(min)} – ${fmt(max)}${currency && currency !== 'USD' ? ` ${currency}` : ''}`;
  if (min > 0) return `From ${fmt(min)}`;
  if (max > 0) return `Up to ${fmt(max)}`;
  return null;
}

/**
 * @param {object} raw   loose fields from a source adapter
 * @param {object} meta  { source, sourceLabel }
 */
export function normalizeJob(raw, meta) {
  const title = stripHtml(raw.title || '').replace(/\s+/g, ' ').trim();
  const company = stripHtml(raw.company || '').replace(/\s+/g, ' ').trim();
  if (!title || !company) return null;

  const url = cleanUrl(raw.url);
  if (!url) return null;

  const description = stripHtml(raw.description || '');
  const location = stripHtml(raw.location || '').replace(/\s+/g, ' ').trim();
  const locationRestriction = stripHtml(raw.locationRestriction || '').replace(/\s+/g, ' ').trim();

  const workType = detectWorkType({
    location: `${location} ${locationRestriction}`,
    title,
    description,
    remoteFlag: raw.remoteFlag,
  });

  // Aggregators report which board a posting actually came from. Recording it
  // alongside the adapter name puts "LinkedIn" / "Indeed" / "ZipRecruiter" on
  // the card and into the board filter, rather than hiding them behind the
  // name of the API that fetched them.
  const publisher = stripHtml(raw.publisher || '').replace(/\s+/g, ' ').trim();
  const sources = publisher && publisher !== meta.sourceLabel
    ? [meta.sourceLabel, publisher]
    : [meta.sourceLabel];

  // Reposting sites list themselves as the employer, so the company field
  // comes back as "Remote Click Jobs" and you cannot tell who is hiring.
  // Detecting that generically beats maintaining a blocklist of site names.
  const employerUnknown = Boolean(publisher) && slugify(company) === slugify(publisher);

  return {
    id: `${meta.source}:${raw.sourceId || slugify(`${company}-${title}`)}`,
    source: meta.source,
    sourceLabel: meta.sourceLabel,
    sources,
    title,
    company,
    employerUnknown,
    companyLogo: cleanUrl(raw.companyLogo),
    url,
    applyUrl: cleanUrl(raw.applyUrl) || url,
    location: location || (workType === 'remote' ? 'Remote' : ''),
    locationRestriction,
    workType,
    employmentTypes: detectEmploymentTypes(raw.employmentTypes, title, description),
    salary: formatSalary(raw),
    postedAt: toIsoDate(raw.postedAt),
    tags: [...new Set([].concat(raw.tags || []).filter(Boolean).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12),
    description, // dropped before writing jobs.json; used for scoring only
    excerpt: excerpt(description),
  };
}

/** Stable identity across sources: same company + same role = same job. */
export function dedupeKey(job) {
  const title = slugify(job.title)
    .replace(/-(i|ii|iii|iv|jr|sr|senior|junior|remote|us|usa|full-time|part-time|contract)$/g, '')
    .replace(/^(senior|sr|junior|jr)-/, '');
  return `${slugify(job.company)}|${title}`;
}

/**
 * Collapse duplicates, keeping the record with the most information and
 * recording every board it appeared on.
 */
export function dedupeJobs(jobs, sourcePriority = []) {
  const priority = (source) => {
    const index = sourcePriority.indexOf(source);
    return index === -1 ? sourcePriority.length : index;
  };
  const byKey = new Map();

  for (const job of jobs) {
    const key = dedupeKey(job);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, job);
      continue;
    }

    existing.sources = [...new Set([...existing.sources, ...job.sources])];

    // Prefer the richer / higher-priority record, but keep the earliest known date.
    const better =
      priority(job.source) < priority(existing.source) ||
      (job.description || '').length > (existing.description || '').length * 1.5;

    if (better) {
      const mergedSources = existing.sources;
      const earliest = [existing.postedAt, job.postedAt].filter(Boolean).sort()[0] || null;
      byKey.set(key, { ...job, sources: mergedSources, postedAt: earliest });
    } else if (!existing.postedAt && job.postedAt) {
      existing.postedAt = job.postedAt;
    }
  }

  return [...byKey.values()];
}
