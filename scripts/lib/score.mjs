/**
 * Match scoring.
 *
 * Two independent axes are produced for every job:
 *   match   0-100  how well the posting fits the résumé
 *   recency 0-100  exponential decay on the posting date
 * and one blended `rank` used for the default sort order.
 *
 * The scorer also returns human-readable `reasons` so the UI can explain
 * *why* something ranked where it did — that is the part that makes the
 * list trustworthy enough to act on.
 */

import { normalizeForMatch, containsPhrase, daysBetween } from './text.mjs';

const TITLE_CAP = 45;
const SKILL_CAP = 35;
const CONTEXT_CAP = 10;
const PENALTY_FLOOR = -38;
const MAX_RAW = TITLE_CAP + SKILL_CAP + CONTEXT_CAP;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function matchGroup(group, normalizedText) {
  const hits = [];
  for (const entry of group) {
    const matched = entry.phrases.find((phrase) => containsPhrase(normalizedText, phrase));
    if (matched) hits.push({ label: entry.label, weight: entry.weight, phrase: matched });
  }
  return hits;
}

/**
 * Title signal: the strongest single title family dominates, with partial
 * credit for a second family (e.g. "Email Marketing QA Specialist").
 */
function scoreTitle(profile, normTitle, normDescription) {
  const titleHits = matchGroup(profile.titles, normTitle).sort((a, b) => b.weight - a.weight);
  const reasons = [];
  let score = 0;

  if (titleHits.length) {
    score = titleHits[0].weight;
    reasons.push({ kind: 'title', label: titleHits[0].label, detail: `Title: “${titleHits[0].phrase}”`, points: titleHits[0].weight });
    if (titleHits[1]) {
      const bonus = Math.round(titleHits[1].weight * 0.25);
      score += bonus;
      reasons.push({ kind: 'title', label: titleHits[1].label, detail: `Also: “${titleHits[1].phrase}”`, points: bonus });
    }
  } else {
    // The title missed, but the role family may still show up in the body.
    const bodyHits = matchGroup(profile.titles, normDescription).sort((a, b) => b.weight - a.weight);
    if (bodyHits.length) {
      const credit = Math.min(9, Math.round(bodyHits[0].weight * 0.2));
      score = credit;
      reasons.push({ kind: 'title', label: bodyHits[0].label, detail: `Mentioned in posting: “${bodyHits[0].phrase}”`, points: credit });
    }
  }

  return { score: clamp(score, 0, TITLE_CAP), reasons };
}

/** Skills use diminishing returns so a keyword-stuffed posting cannot run away with it. */
function scoreSkills(profile, normText) {
  const hits = matchGroup(profile.skills, normText).sort((a, b) => b.weight - a.weight);
  const reasons = [];
  let score = 0;

  hits.forEach((hit, index) => {
    const points = hit.weight * 0.82 ** index;
    score += points;
    if (index < 8) {
      reasons.push({ kind: 'skill', label: hit.label, detail: `“${hit.phrase}”`, points: Math.round(points * 10) / 10 });
    }
  });

  return { score: clamp(score, 0, SKILL_CAP), reasons, hitCount: hits.length };
}

function scoreContext(profile, normText) {
  const hits = matchGroup(profile.context, normText);
  const reasons = [];
  let score = 0;
  hits.forEach((hit, index) => {
    const points = hit.weight * 0.8 ** index;
    score += points;
    reasons.push({ kind: 'context', label: hit.label, detail: `“${hit.phrase}”`, points: Math.round(points * 10) / 10 });
  });
  return { score: clamp(score, 0, CONTEXT_CAP), reasons };
}

/** Penalties count double when the mismatch is in the job title itself. */
function scorePenalties(profile, normTitle, normText) {
  const reasons = [];
  let score = 0;
  for (const entry of profile.penalties) {
    const inTitle = entry.phrases.find((p) => containsPhrase(normTitle, p));
    const inBody = inTitle || entry.phrases.find((p) => containsPhrase(normText, p));
    if (!inBody) continue;
    const points = inTitle ? entry.weight * 2 : entry.weight;
    score += points;
    reasons.push({ kind: 'penalty', label: entry.label, detail: `“${inBody}”${inTitle ? ' (in title)' : ''}`, points });
  }
  return { score: clamp(score, PENALTY_FLOOR, 0), reasons };
}

export function recencyScore(postedAt, profile, now = new Date()) {
  const ranking = profile.ranking;
  let age = daysBetween(postedAt, now);
  let assumed = false;
  if (age === null || age < 0) {
    age = ranking.assumedAgeDaysWhenUnknown;
    assumed = true;
  }
  const value = 100 * Math.exp(-Math.LN2 * (age / ranking.recencyHalfLifeDays));
  return { score: clamp(Math.round(value), 0, 100), ageDays: Math.round(age * 10) / 10, assumed };
}

export function scoreJob(job, profile, now = new Date()) {
  const normTitle = normalizeForMatch(job.title || '');
  const normDescription = normalizeForMatch(job.description || job.excerpt || '');
  const normAll = normalizeForMatch(
    `${job.title || ''} ${job.company || ''} ${(job.tags || []).join(' ')} ${job.description || job.excerpt || ''}`
  );

  const excluded = (profile.excludeTitlePhrases || []).find((p) => containsPhrase(normTitle, p));

  const title = scoreTitle(profile, normTitle, normDescription);
  const skills = scoreSkills(profile, normAll);
  const context = scoreContext(profile, normAll);
  const penalties = scorePenalties(profile, normTitle, normAll);

  const raw = title.score + skills.score + context.score + penalties.score;
  let match = clamp(Math.round((raw / MAX_RAW) * 100), 0, 100);
  if (excluded) match = Math.min(match, 5);

  const recency = recencyScore(job.postedAt, profile, now);

  const { matchWeight, recencyWeight } = profile.ranking;
  const rank = Math.round((match * matchWeight + recency.score * recencyWeight) * 10) / 10;

  const reasons = [...title.reasons, ...skills.reasons, ...context.reasons, ...penalties.reasons]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    match,
    recency: recency.score,
    ageDays: recency.ageDays,
    ageAssumed: recency.assumed,
    rank,
    excluded: Boolean(excluded),
    excludedBy: excluded || null,
    reasons: reasons.slice(0, 12),
    breakdown: {
      title: Math.round(title.score * 10) / 10,
      skills: Math.round(skills.score * 10) / 10,
      context: Math.round(context.score * 10) / 10,
      penalty: Math.round(penalties.score * 10) / 10,
    },
  };
}

/** Coarse label used for the colour band on each card. */
export function matchTier(match) {
  if (match >= 70) return 'strong';
  if (match >= 50) return 'good';
  if (match >= 32) return 'possible';
  return 'stretch';
}
