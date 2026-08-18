/**
 * Match scoring — MODEL V2 (ability-based).
 *
 * The board runs two matching models side by side so they can be compared on
 * the same postings. `score.mjs` is v1, the title-driven model that is live;
 * this is v2, which scores what she can do ahead of what the job is called.
 *
 * This file deliberately duplicates v1's helpers rather than sharing them. The
 * two models differ in the caps and the shape of the title signal, so sharing
 * would mean parameterising v1's internals — and v1 is the live board, which
 * should not move because an experiment alongside it changed. The cost is
 * duplication; the benefit is that neither model can break the other.
 *
 * Everything outside the matching model — search terms, engagement, penalties,
 * location — is inherited from the same profile v1 uses, so a difference between
 * the two boards is attributable to the model and nothing else.
 *
 * Two independent axes are produced for every job:
 *   match   0-100  how well the posting fits the résumé
 *   recency 0-100  exponential decay on the posting date
 * and one blended `rank` used for the default sort order.
 *
 * The scorer also returns human-readable `reasons` so the UI can explain
 * *why* something ranked where it did — that is the part that makes the
 * list trustworthy enough to act on.
 *
 * WHAT THIS SCORES ON, AND WHY
 *
 * An earlier version scored mostly on job titles: a recognised title was worth
 * more than half the available points, so a posting called "QA Specialist" beat
 * a posting that described her exact abilities under a name she had never
 * searched for. That is a job board that can only find the job she already has.
 *
 * The weighting now follows how a career counsellor reads a posting. What
 * someone can *do* carries the score; the title only corroborates it. Her core
 * ability — checking complex material against a standard and finding what is
 * wrong with it — is wanted by technical writing, documentation, data quality,
 * compliance review, localisation and accessibility teams, none of which
 * advertise for a "QA Specialist".
 *
 * So capabilities are the largest axis, and a posting that matches enough of
 * them is allowed to rank well with no recognised title at all. Those postings
 * are flagged `discovery` so the board can show them as what they are: work she
 * could do, under a name she would not have thought to search for.
 */

import { normalizeForMatch, containsPhrase, daysBetween } from './text.mjs';

// Capability is the biggest single axis by design; title is now worth less
// than the tools she uses. Together these sum to 100, so `match` is a
// percentage of everything a posting could have offered.
// Contract / freelance / project framing, scored exactly as v1 scores it: a
// bonus on top rather than part of the denominator. Both boards must treat this
// identically or the comparison confounds the model with the target.
const ENGAGEMENT_CAP = 12;
const CAPABILITY_CAP = 46;
const TITLE_CAP = 22;
const SKILL_CAP = 22;
const CONTEXT_CAP = 10;
const PENALTY_FLOOR = -38;
const MAX_RAW = CAPABILITY_CAP + TITLE_CAP + SKILL_CAP + CONTEXT_CAP;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * The longest matching phrase, not merely the first. "Data Quality Analyst"
 * matches both "data quality" and "data quality analyst"; the longer one
 * describes the posting more exactly, which matters both for what gets quoted
 * back as the reason and for deciding which label fits best.
 */
function longestMatch(phrases, normalizedText) {
  let best = null;
  for (const phrase of phrases || []) {
    if (!containsPhrase(normalizedText, phrase)) continue;
    if (!best || phrase.length > best.length) best = phrase;
  }
  return best;
}

function matchGroup(group, normalizedText) {
  const hits = [];
  for (const entry of group) {
    const matched = longestMatch(entry.phrases, normalizedText);
    if (matched) hits.push({ label: entry.label, weight: entry.weight, phrase: matched });
  }
  return hits;
}

/**
 * Combination groups need one hit from every list, in any order and anywhere
 * in the text. "QA Analyst, Lifecycle Marketing" and "Lifecycle Marketing QA"
 * are the same job; contiguous phrase matching only catches the second.
 */
export function matchCombinations(groups, normalizedText) {
  const hits = [];
  for (const group of groups || []) {
    const matched = [];
    for (const set of group.all) {
      const found = set.find((phrase) => containsPhrase(normalizedText, phrase));
      if (!found) break;
      matched.push(found);
    }
    if (matched.length === group.all.length) {
      hits.push({ label: group.label, weight: group.weight, phrase: matched.join(' + ') });
    }
  }
  return hits;
}

/**
 * Role-family titles are matched separately from her incumbent titles, because
 * the two mean opposite things. An incumbent title ("QA Specialist") confirms
 * the job she already has. A family title ("Instructional Designer") is the
 * whole point of the board: a door she would not have knocked on.
 *
 * They therefore score lower than a bullseye but still count as a recognised
 * title, and they carry the family's rationale forward so the card can say why
 * an unfamiliar name belongs in her list.
 */
function matchRoleFamilies(profile, normTitle) {
  const hits = [];
  for (const family of profile.roleFamilies || []) {
    const matched = longestMatch(family.titles, normTitle);
    if (matched) hits.push({ id: family.id, label: family.label, why: family.why, phrase: matched });
  }
  return hits;
}

/**
 * Title signal: the strongest single title family dominates, with partial
 * credit for a second family (e.g. "Email Marketing QA Specialist").
 */
function scoreTitle(profile, normTitle, normDescription) {
  const titleHits = [
    ...matchGroup(profile.titles, normTitle),
    ...matchCombinations(profile.titleCombinations, normTitle),
  ].sort((a, b) => b.weight - a.weight);
  const familyHits = matchRoleFamilies(profile, normTitle);
  const reasons = [];
  let score = 0;

  /**
   * When a title matches both an incumbent role and an adjacent family, which
   * label is right depends on how core the incumbent hit is. "Email QA
   * Specialist" is her job. But "Localization Project Coordinator" matching the
   * generic phrase "project coordinator" is not a reason to file a localisation
   * role as business as usual — it is precisely the new direction, hidden
   * behind a generic word.
   *
   * So only her genuine core titles outrank a family classification; a weak,
   * generic incumbent hit yields to it.
   */
  const incumbentPriority = profile.ranking.incumbentTitleWeight ?? 38;
  const incumbentIsCore = titleHits.length && titleHits[0].weight >= incumbentPriority;

  // Specificity breaks the tie: "Data Quality Analyst" matches her incumbent
  // "quality analyst", but it also matches the family's "data quality analyst",
  // which describes the job more exactly and is therefore the truer label.
  const familyPhrase = familyHits.length ? familyHits[0].phrase : '';
  const incumbentPhrase = titleHits.length ? String(titleHits[0].phrase) : '';
  const familyIsMoreSpecific = familyPhrase.length > incumbentPhrase.length;

  if (familyHits.length && (!incumbentIsCore || familyIsMoreSpecific)) {
    const family = familyHits[0];
    const weight = profile.ranking.roleFamilyTitleWeight ?? 30;
    score = weight;
    reasons.push({
      kind: 'family',
      label: family.label,
      detail: `New direction: “${family.phrase}”`,
      points: weight,
    });
    return {
      score: clamp(score, 0, TITLE_CAP),
      reasons,
      fromTitle: true,
      topWeight: weight,
      family,
    };
  }

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
    const bodyHits = [
      ...matchGroup(profile.titles, normDescription),
      ...matchCombinations(profile.titleCombinations, normDescription),
    ].sort((a, b) => b.weight - a.weight);
    if (bodyHits.length) {
      const credit = Math.min(9, Math.round(bodyHits[0].weight * 0.2));
      score = credit;
      reasons.push({ kind: 'title', label: bodyHits[0].label, detail: `Mentioned in posting: “${bodyHits[0].phrase}”`, points: credit });
    }
  }

  return {
    score: clamp(score, 0, TITLE_CAP),
    reasons,
    // Whether the strongest signal came from the title itself, and how strong.
    fromTitle: titleHits.length > 0,
    topWeight: titleHits.length ? titleHits[0].weight : 0,
    family: null,
  };
}

/**
 * Capabilities: what she can do, independent of what the job is called.
 *
 * Decay is gentler than skills (0.88 vs 0.82) because breadth is the signal
 * here — a posting that wants six of her abilities is genuinely a better fit
 * than one that wants two, and steep decay would flatten that distinction into
 * noise. `hitCount` is how many distinct abilities the posting asked for, which
 * is what decides whether an unfamiliar title is worth surfacing.
 */
function scoreCapabilities(profile, normText) {
  const hits = matchGroup(profile.capabilities || [], normText).sort((a, b) => b.weight - a.weight);
  const reasons = [];
  let score = 0;

  hits.forEach((hit, index) => {
    const points = hit.weight * 0.88 ** index;
    score += points;
    if (index < 8) {
      reasons.push({ kind: 'capability', label: hit.label, detail: `“${hit.phrase}”`, points: Math.round(points * 10) / 10 });
    }
  });

  return {
    score: clamp(score, 0, CAPABILITY_CAP),
    reasons,
    hitCount: hits.length,
    labels: hits.map((hit) => hit.label),
  };
}

/** Contract / freelance / project framing — see v1's scoreEngagement. */
function scoreEngagement(profile, normText) {
  const hits = matchGroup(profile.engagement || [], normText).sort((a, b) => b.weight - a.weight);
  const reasons = [];
  let score = 0;
  hits.forEach((hit, index) => {
    const points = hit.weight * 0.85 ** index;
    score += points;
    reasons.push({ kind: 'engagement', label: hit.label, detail: `“${hit.phrase}”`, points: Math.round(points * 10) / 10 });
  });
  return { score: clamp(score, 0, ENGAGEMENT_CAP), reasons, hitCount: hits.length };
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

  const capabilities = scoreCapabilities(profile, normAll);
  const title = scoreTitle(profile, normTitle, normDescription);
  const skills = scoreSkills(profile, normAll);
  const context = scoreContext(profile, normAll);
  const engagement = scoreEngagement(profile, normAll);
  const penalties = scorePenalties(profile, normTitle, normAll);

  const raw = capabilities.score + title.score + skills.score + context.score + engagement.score + penalties.score;
  let match = clamp(Math.round((raw / MAX_RAW) * 100), 0, 100);

  /**
   * Several sources give only a snippet — Jooble and the RSS feeds in
   * particular — so scoring leans on the description more than those postings
   * can support. When the title alone names one of her exact roles and nothing
   * in the posting argues against it, that is sufficient evidence on its own;
   * without this a bullseye title with a two-line body loses to a verbose
   * posting for a job she does not want.
   *
   * Deliberately conditional on there being no penalties, so it cannot rescue
   * "QA Automation Engineer, Marketing".
   */
  const flooredAt = profile.ranking.bullseyeTitleFloor ?? 72;
  const bullseyeWeight = profile.ranking.bullseyeTitleWeight ?? 45;
  const bullseye = !excluded && penalties.score === 0 && title.fromTitle && title.topWeight >= bullseyeWeight;
  if (bullseye && match < flooredAt) match = flooredAt;

  /**
   * The point of the whole exercise: a posting that asks for enough of what she
   * can do, under a title she would never have searched for.
   *
   * Requiring several distinct capabilities rather than one strong one is what
   * keeps this from turning into noise — any posting can say "attention to
   * detail", but a posting that wants error-checking AND working to a written
   * standard AND editorial judgement AND deadline management is describing her
   * job under another name.
   *
   * Penalty-free is required for the same reason it is on the bullseye: this
   * should surface an unfamiliar door, not talk her into a wrong one.
   */
  const viable = !excluded && penalties.score === 0;

  /**
   * Two ways in, with different burdens of proof.
   *
   * A posting whose title names an adjacent family is a confident suggestion:
   * the family exists precisely because her résumé supports it.
   *
   * A posting with no recognisable title at all is a guess from keywords, and
   * has to clear a higher bar — otherwise anything that mentions deadlines,
   * records and customer service starts looking like a career move. Left at the
   * lower bar, "Billing Officer" and "Tier III Service Desk Engineer" qualified.
   */
  const minCapabilities = profile.ranking.discoveryMinCapabilities ?? 5;
  const discovery = viable && Boolean(
    title.family || (!title.fromTitle && capabilities.hitCount >= minCapabilities)
  );

  // Floored so these clear the "possible" band and are actually seen. Without
  // it they sort beneath every routine title match and the feature is decorative.
  const discoveryFloor = profile.ranking.discoveryFloor ?? 52;
  if (discovery && match < discoveryFloor) match = discoveryFloor;

  if (excluded) match = Math.min(match, 5);

  const recency = recencyScore(job.postedAt, profile, now);

  const { matchWeight, recencyWeight } = profile.ranking;
  const rank = Math.round((match * matchWeight + recency.score * recencyWeight) * 10) / 10;

  const reasons = [...capabilities.reasons, ...title.reasons, ...skills.reasons, ...engagement.reasons, ...context.reasons, ...penalties.reasons]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    match,
    recency: recency.score,
    ageDays: recency.ageDays,
    ageAssumed: recency.assumed,
    rank,
    excluded: Boolean(excluded),
    excludedBy: excluded || null,
    // A role she would not have searched for, that wants what she can do.
    discovery,
    // Which adjacent family it belongs to, and why it fits — shown on the card
    // so an unfamiliar title never arrives unexplained.
    family: title.family ? { id: title.family.id, label: title.family.label, why: title.family.why } : null,
    capabilityCount: capabilities.hitCount,
    capabilityLabels: capabilities.labels.slice(0, 6),
    projectBased: engagement.hitCount > 0,
    reasons: reasons.slice(0, 12),
    breakdown: {
      capabilities: Math.round(capabilities.score * 10) / 10,
      engagement: Math.round(engagement.score * 10) / 10,
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
