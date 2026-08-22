/**
 * Match scoring — MODEL V3 (fit profile).
 *
 * v1 scores a job title. v2 scores a list of abilities. Both answer with one
 * number, which is the wrong shape for the decision actually being made: a
 * posting can be exactly the work she wants and still ask for a credential she
 * does not have, or meet every stated requirement and be a copywriting job in
 * disguise. One number cannot say which, so it says neither.
 *
 * v3 scores four separate axes and reports all of them:
 *
 *   WORK FIT          35%  What would she actually spend the day doing?
 *   EXPERIENCE FIT    30%  How much of that has she already done, whatever it was called?
 *   QUALIFICATION FIT 20%  How closely does she meet what the employer asks for?
 *   LIFESTYLE FIT     15%  Remote, contract, part-time, flexible.
 *
 * The rules come from the matching specification, and the parts worth knowing
 * before changing anything:
 *
 * TITLES ARE CORROBORATION, NOT EVIDENCE. A recognised title is worth at most
 * 22 of the 90 raw work-fit points. What carries the axis is what the posting
 * says the job involves, and — more than any single concept — which concepts
 * appear *together*. "Proofreading" alone is a word; "proofreading against
 * brand standards for digital content" is her job. That is what `combinations`
 * scores, and why the spec says those matter more than an exact title match.
 *
 * WRITING IS NOT DISQUALIFYING; WRITING AS THE JOB IS. Editing roles rewrite
 * sentences. So the copywriting test is a balance, not a keyword: count the
 * concepts on each side, and only penalise when creating outweighs reviewing.
 * The same distinction governs the technical signals — reading HTML is her
 * daily work and scores positively, while building test automation is a
 * different career and is penalised.
 *
 * EXPERIENCE FIT IS A COVERAGE RATIO, NOT A TALLY. Of everything this posting
 * asks for, how much has she done? A tally rewards long postings; a ratio
 * rewards postings whose demands she actually meets, which is what the spec's
 * transferable-experience logic asks for. Demands she has *not* performed sit
 * in `experienceGaps` and are the denominator's other half — that is what
 * separates "she has not held this title" (fine) from "she has not done this
 * work" (not fine).
 *
 * ONE LEARNABLE TOOL MUST NOT SINK A GOOD JOB. "AP Style required" costs three
 * points and is reported as a learnable gap with a note. A law degree costs
 * twenty-six and is reported as a true gap. The spec is explicit about this
 * distinction and it is the one most matchers get wrong.
 */

import { normalizeForMatch, containsPhrase, daysBetween } from './text.mjs';
import { evaluateLocation } from './location.mjs';

// Raw work-fit points. The denominator is the sum of the three positive caps,
// so a posting that maxes every one of them scores 100 before penalties.
const SIGNAL_CAP = 46;
const COMBINATION_CAP = 22;
const FAMILY_CAP = 22;
const WORK_MAX = SIGNAL_CAP + COMBINATION_CAP + FAMILY_CAP;

/** What a recognised title is worth, by how central the family is to the search. */
const FAMILY_TIER_WEIGHT = { core: 22, priority: 18, adjacent: 12 };

// Experience fit is a ratio, and a ratio over small numbers is noise: a posting
// that happens to name one thing she has done should not read as a perfect
// match. This prior is worth PRIOR_WEIGHT points of evidence at PRIOR_FIT, so a
// posting has to actually say something before the ratio moves far from neutral.
const PRIOR_WEIGHT = 18;
const PRIOR_FIT = 0.5;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The longest matching phrase, not merely the first: "content quality analyst"
 * describes a posting more exactly than "content quality", and it is the
 * longer one that should be quoted back as the reason.
 */
function longestMatch(phrases, normalizedText) {
  let best = null;
  for (const phrase of phrases || []) {
    if (!containsPhrase(normalizedText, phrase)) continue;
    if (!best || phrase.length > best.length) best = phrase;
  }
  return best;
}

function matchGroup(groups, normalizedText) {
  const hits = [];
  for (const entry of groups || []) {
    const matched = longestMatch(entry.phrases, normalizedText);
    if (matched) hits.push({ ...entry, phrase: matched });
  }
  return hits;
}

/**
 * Combination groups need one phrase from every list, anywhere in the posting,
 * in any order. This is the part of the model the spec weights most heavily:
 * concepts appearing together are what distinguish a posting describing this
 * work from one that happens to use a word.
 */
export function matchCombinations(groups, normalizedText) {
  const hits = [];
  for (const group of groups || []) {
    const matched = [];
    for (const set of group.all) {
      const found = longestMatch(set, normalizedText);
      if (!found) break;
      matched.push(found);
    }
    if (matched.length === group.all.length) {
      hits.push({ label: group.label, weight: group.weight, phrases: matched });
    }
  }
  return hits;
}

/**
 * Distinct concepts matched from a flat phrase list.
 *
 * Counting matched phrases directly would count "review", "reviewing" and
 * "reviews" as three signals and let a synonym-rich list beat a concept-rich
 * posting. Collapsing on the first six characters of the phrase, punctuation
 * and spaces removed, folds those spellings back into one.
 */
export function countConcepts(phrases, normalizedText) {
  const concepts = new Set();
  for (const phrase of phrases || []) {
    if (!containsPhrase(normalizedText, phrase)) continue;
    concepts.add(phrase.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6));
  }
  return concepts;
}

/**
 * Junior, mid or senior, read off the title.
 *
 * Only the title, deliberately: descriptions say "you will work with senior
 * stakeholders" constantly, and the level of the job being advertised is what
 * the "too senior" / "too junior" feedback is about.
 */
export function seniorityOf(profile, normTitle) {
  const config = profile.seniority || {};
  if (longestMatch(config.senior, normTitle)) return 'senior';
  if (longestMatch(config.junior, normTitle)) return 'junior';
  return 'mid';
}

/** Which role family this title belongs to, if any. Longest match wins. */
function matchFamily(profile, normTitle) {
  let best = null;
  for (const family of profile.roleFamilies || []) {
    const phrase = longestMatch(family.titles, normTitle);
    if (!phrase) continue;
    if (!best || phrase.length > best.phrase.length) best = { ...family, phrase };
  }
  return best;
}

/* ------------------------------------------------------------------ axes */

/**
 * WORK FIT — what the day actually involves.
 *
 * Signals decay per additional concept so that breadth still counts but a
 * posting cannot win on keyword volume alone; combinations do not decay,
 * because two co-occurring concepts is precisely the signal being bought.
 */
function scoreWork(profile, normTitle, normAll, family) {
  const reasons = [];

  const signalHits = matchGroup(profile.workSignals, normAll).sort((a, b) => b.weight - a.weight);
  let signals = 0;
  signalHits.forEach((hit, index) => {
    const points = hit.weight * 0.9 ** index;
    signals += points;
    if (index < 8) reasons.push({ kind: 'work', label: hit.label, detail: `“${hit.phrase}”`, points: round1(points) });
  });
  signals = clamp(signals, 0, SIGNAL_CAP);

  const comboHits = matchCombinations(profile.combinations, normAll);
  let combos = 0;
  for (const hit of comboHits) {
    combos += hit.weight;
    reasons.push({
      kind: 'combination',
      label: hit.label,
      detail: hit.phrases.map((p) => `“${p}”`).join(' + '),
      points: hit.weight,
    });
  }
  combos = clamp(combos, 0, COMBINATION_CAP);

  let familyPoints = 0;
  if (family) {
    familyPoints = FAMILY_TIER_WEIGHT[family.tier] ?? FAMILY_TIER_WEIGHT.adjacent;
    reasons.push({
      kind: 'family',
      label: family.label,
      detail: `Title: “${family.phrase}”`,
      points: familyPoints,
    });
  }

  const orientation = scoreOrientation(profile, normTitle, normAll);
  if (orientation.adjustment) {
    reasons.push({
      kind: orientation.adjustment > 0 ? 'work' : 'penalty',
      label: orientation.adjustment > 0 ? 'Reviewing others’ work, not writing it' : 'Mostly writing original copy',
      detail: `${orientation.reviewCount} review signal(s) vs ${orientation.creationCount} creation signal(s)`,
      points: round1(orientation.adjustment),
    });
  }

  const automation = scoreAutomation(profile, normAll);
  if (automation.penalty) {
    reasons.push({
      kind: 'penalty',
      label: 'Coding / test-automation requirements',
      detail: automation.matched.slice(0, 4).map((p) => `“${p}”`).join(', '),
      points: -automation.penalty,
    });
  }

  const raw = signals + combos + familyPoints - automation.penalty + orientation.adjustment;
  return {
    score: clamp(Math.round((raw / WORK_MAX) * 100), 0, 100),
    reasons,
    signalCount: signalHits.length,
    signalLabels: signalHits.map((h) => h.label),
    // Carried onto the card so the 👍/👎 model can learn over the kinds of work
    // a posting involves rather than over the posting itself. Ids only — the
    // labels travel once in meta.json rather than on every posting.
    signalIds: signalHits.map((hit) => hit.id).filter(Boolean),
    combinationLabels: comboHits.map((h) => h.label),
    orientation,
    automation,
  };
}

/**
 * Reviewing versus creating — the spec's central question about writing.
 * Only a creation-dominant posting is penalised, so a proofreading role that
 * mentions "write clear feedback" is untouched.
 */
function scoreOrientation(profile, normTitle, normAll) {
  const config = profile.orientation || {};
  const review = countConcepts(config.reviewPhrases, normAll);
  const creation = countConcepts(config.creationPhrases, normAll);
  const reviewCount = review.size;
  const creationCount = creation.size;

  // A title is the strongest statement a posting makes about what the job
  // primarily is. "Copywriter" is a writing job however much its description
  // also mentions reviewing, so it is charged separately from the balance.
  const creationTitle = longestMatch(config.creationTitles, normTitle);

  let adjustment = creationTitle ? -(config.creationTitlePenalty ?? 18) : 0;
  if (creationCount > reviewCount) {
    adjustment -= Math.min(
      config.maxCreationPenalty ?? 30,
      (creationCount - reviewCount) * (config.creationPenaltyPerHit ?? 6)
    );
  } else if (reviewCount > creationCount && !creationTitle) {
    adjustment += Math.min(
      config.maxReviewBonus ?? 8,
      (reviewCount - creationCount) * (config.reviewBonusPerHit ?? 2)
    );
  }

  return {
    reviewCount,
    creationCount,
    creationTitle,
    adjustment,
    creationDominant: creationCount > reviewCount || Boolean(creationTitle),
    // Enough original-content language to be worth calling out even when
    // reviewing still dominates — the spec's "watch out for" case.
    heavyCreation:
      Boolean(creationTitle) ||
      (creationCount >= (config.watchOutThreshold ?? 3) && creationCount >= reviewCount),
  };
}

/** Writing code as the job. Reading HTML is not this, and is never penalised. */
function scoreAutomation(profile, normAll) {
  const config = profile.automation || {};
  const matched = (config.phrases || []).filter((phrase) => containsPhrase(normAll, phrase));
  const concepts = countConcepts(config.phrases, normAll).size;
  const penalty = Math.min(config.maxPenalty ?? 30, concepts * (config.penaltyPerHit ?? 7));
  return {
    matched,
    concepts,
    penalty,
    substantial: concepts >= (config.watchOutThreshold ?? 2),
  };
}

/**
 * EXPERIENCE FIT — of what this posting asks for, how much has she done?
 *
 * A ratio rather than a tally, so a long posting cannot out-score a posting
 * whose every demand she meets, and so a demand she has never met (medical
 * editing, newsroom reporting) actually costs something instead of being
 * silently ignored.
 */
function scoreExperience(profile, normAll) {
  const covered = matchGroup(profile.experience, normAll).sort((a, b) => b.weight - a.weight);
  const missing = matchGroup(profile.experienceGaps, normAll).sort((a, b) => b.weight - a.weight);

  const coveredWeight = covered.reduce((sum, hit) => sum + hit.weight, 0);
  const missingWeight = missing.reduce((sum, hit) => sum + hit.weight, 0);

  const ratio =
    (coveredWeight + PRIOR_WEIGHT * PRIOR_FIT) / (coveredWeight + missingWeight + PRIOR_WEIGHT);
  const breadth = Math.min(10, covered.length * 1.5);

  const reasons = covered.slice(0, 6).map((hit) => ({
    kind: 'experience',
    label: hit.label,
    detail: `Asked for: “${hit.phrase}”`,
    points: hit.weight,
  }));
  for (const gap of missing) {
    reasons.push({
      kind: 'penalty',
      label: `Not her experience: ${gap.label}`,
      detail: `“${gap.phrase}”`,
      points: -gap.weight,
    });
  }

  return {
    score: clamp(Math.round(ratio * 100 + breadth), 0, 100),
    reasons,
    covered,
    missing,
  };
}

/**
 * Years of experience the posting asks for. The largest number wins, because
 * postings that name a range ("3-5 years") and postings that name a floor
 * ("5+ years") both put the requirement at the top of it.
 */
export function requiredYears(text) {
  const matches = [...String(text).matchAll(/(\d{1,2})\s*(?:\+|–|-|to)?\s*(\d{1,2})?\s*(?:\+)?\s*years?/gi)];
  let most = null;
  for (const match of matches) {
    const values = [Number(match[1]), Number(match[2])].filter((n) => Number.isFinite(n) && n > 0 && n <= 25);
    for (const value of values) most = most === null ? value : Math.max(most, value);
  }
  return most;
}

/**
 * QUALIFICATION FIT — the employer's stated requirements.
 *
 * The base is high because ten years in the work plus an honours degree and a
 * graduate degree clears the stated bar for most of these postings. What moves
 * it is the specific asks, and the spec's rule that a learnable tool must not
 * destroy an otherwise excellent match is enforced by the size of the numbers:
 * three points for a style manual, twenty-six for a credential.
 */
function scoreQualification(profile, normAll, rawText) {
  const config = profile.qualification || {};
  const reasons = [];
  let score = config.base ?? 78;

  const years = requiredYears(rawText);
  if (years !== null) {
    if (years <= (config.yearsWithinReach ?? 6)) {
      score += config.bonusYearsClear ?? 7;
      reasons.push({ kind: 'qualification', label: 'Experience bar cleared', detail: `Asks for ${years} years; she has ten`, points: config.bonusYearsClear ?? 7 });
    } else if (years <= (config.yearsRequiredComfortable ?? 10)) {
      score += config.bonusYearsComfortable ?? 3;
      reasons.push({ kind: 'qualification', label: 'Experience bar met', detail: `Asks for ${years} years; she has ten`, points: config.bonusYearsComfortable ?? 3 });
    } else {
      score -= config.penaltyYearsBeyond ?? 12;
      reasons.push({ kind: 'penalty', label: 'Asks for more years than she has', detail: `${years} years requested`, points: -(config.penaltyYearsBeyond ?? 12) });
    }
  }

  const degree = longestMatch(config.degreeAsked?.phrases, normAll);
  if (degree) {
    score += config.degreeAsked.weight ?? 6;
    reasons.push({ kind: 'qualification', label: 'Degree requirement met', detail: `“${degree}” — she holds an honours BA and an MA`, points: config.degreeAsked.weight ?? 6 });
  }
  const advanced = longestMatch(config.advancedDegreeAsked?.phrases, normAll);
  if (advanced) {
    score += config.advancedDegreeAsked.weight ?? 4;
    reasons.push({ kind: 'qualification', label: 'Advanced degree requirement met', detail: `“${advanced}” — she holds a master's`, points: config.advancedDegreeAsked.weight ?? 4 });
  }

  // Learnable: a named tool or manual on top of a competency she already has.
  const learnable = matchGroup(config.learnableGaps, normAll);
  const learnableCost = Math.min(9, learnable.length * 3);
  score -= learnableCost;
  if (learnableCost) {
    reasons.push({
      kind: 'penalty',
      label: 'Learnable gaps',
      detail: learnable.map((gap) => gap.label).join(', '),
      points: -learnableCost,
    });
  }

  // Disqualifying: a credential, a remit or a location constraint she cannot
  // simply pick up.
  const blocking = matchGroup(config.disqualifying, normAll);
  for (const gap of blocking) {
    score -= gap.weight;
    reasons.push({ kind: 'penalty', label: gap.label, detail: `“${gap.phrase}”`, points: -gap.weight });
  }

  return { score: clamp(Math.round(score), 0, 100), reasons, learnable, blocking, years };
}

/**
 * LIFESTYLE FIT — remote is already guaranteed by the location gate, so this
 * axis measures how much freedom the posting offers on top of it.
 */
function scoreLifestyle(profile, job, normAll, scope) {
  const config = profile.lifestyle || {};
  const reasons = [];
  let score = config.base ?? 46;

  const remotePoints =
    scope === 'remote-anywhere' ? config.remoteAnywhere ?? 26
      : scope === 'remote-us' ? config.remoteUS ?? 24
        : config.remoteOther ?? 18;
  score += remotePoints;
  reasons.push({
    kind: 'lifestyle',
    label: scope === 'remote-anywhere' ? 'Remote, no stated restriction' : 'Remote',
    detail: scope,
    points: remotePoints,
  });

  const hits = matchGroup(config.signals, normAll).sort((a, b) => b.weight - a.weight);
  let bonus = 0;
  for (const hit of hits) bonus += hit.weight;
  bonus = Math.min(bonus, config.signalsCap ?? 26);
  score += bonus;
  for (const hit of hits) {
    reasons.push({ kind: 'lifestyle', label: hit.label, detail: `“${hit.phrase}”`, points: hit.weight });
  }

  const drawbacks = matchGroup(config.drawbacks, normAll);
  for (const drawback of drawbacks) {
    score -= drawback.weight;
    reasons.push({ kind: 'penalty', label: drawback.label, detail: `“${drawback.phrase}”`, points: -drawback.weight });
  }

  if (job.salary) {
    score += config.compensationStated ?? 4;
    reasons.push({ kind: 'lifestyle', label: 'Pay stated up front', detail: job.salary, points: config.compensationStated ?? 4 });
  }

  return { score: clamp(Math.round(score), 0, 100), reasons, signals: hits, drawbacks };
}

/** Shared penalties — the wrong-industry, spam and wrong-craft signals. */
function scorePenalties(profile, normTitle, normAll) {
  const reasons = [];
  let score = 0;
  for (const entry of profile.penalties || []) {
    const inTitle = entry.phrases.find((p) => containsPhrase(normTitle, p));
    const inBody = inTitle || entry.phrases.find((p) => containsPhrase(normAll, p));
    if (!inBody) continue;
    const points = inTitle ? entry.weight * 2 : entry.weight;
    score += points;
    reasons.push({ kind: 'penalty', label: entry.label, detail: `“${inBody}”${inTitle ? ' (in title)' : ''}`, points });
  }
  return { score: clamp(score, -38, 0), reasons };
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
  return { score: clamp(Math.round(value), 0, 100), ageDays: round1(age), assumed };
}

/** Which freshness bucket a posting falls in, per the spec's priority ladder. */
export function freshnessBucket(ageDays, profile) {
  const buckets = profile.freshnessBuckets || [];
  for (const bucket of buckets) {
    if (bucket.maxDays === null || bucket.maxDays === undefined) return bucket;
    if (ageDays !== null && ageDays <= bucket.maxDays) return bucket;
  }
  return buckets[buckets.length - 1] || { label: '', rankBonus: 0 };
}

/** The spec's result bands. */
export function bandFor(match, profile) {
  const bands = profile.bands || [];
  return bands.find((band) => match >= band.min) || bands[bands.length - 1] || { tier: 'low', label: 'Low priority', recommendation: 'SKIP' };
}

export function matchTier(match, profile) {
  return bandFor(match, profile).tier;
}

/* --------------------------------------------------------------- report */

/**
 * The prose half of the card. The spec asks for a plain-English account of why
 * a posting matched, what to put in the application, what is missing and what
 * to watch for — written from the same hits that produced the score, so the
 * explanation can never drift from the number.
 */
function buildReport({ job, family, work, experience, qualification, lifestyle, penalties, industries, thin }) {
  const why = [];

  if (family) {
    const tier = family.tier === 'adjacent' ? 'an adjacent' : `a ${family.tier}`;
    why.push(`The title sits in ${tier} family for this search — ${family.label.toLowerCase()} — matching on “${family.phrase}”.`);
  } else if (work.signalCount) {
    why.push('The title is not one she would have searched for; the description is what matched.');
  }

  if (work.signalLabels.length) {
    const named = work.signalLabels.slice(0, 3).map((label) => label.toLowerCase());
    why.push(`The posting asks for ${listPhrase(named)} — work she has done daily for ten years.`);
  }

  if (work.combinationLabels.length) {
    why.push(`Several of these appear together, which is the strongest signal available: ${listPhrase(work.combinationLabels.slice(0, 2).map((l) => l.toLowerCase()))}.`);
  }

  if (work.orientation.creationDominant) {
    why.push(`Note the balance: ${work.orientation.creationCount} signals point at creating content against ${work.orientation.reviewCount} at reviewing it.`);
  } else if (work.orientation.reviewCount >= 3) {
    // Below three the claim is not worth making: one stray "review" in a
    // two-line snippet is not evidence that reviewing dominates anything.
    why.push(`Reviewing and correcting dominate the description — ${work.orientation.reviewCount} signals against ${work.orientation.creationCount} for creating content, which is the half of the work she wants.`);
  }

  if (industries.length) {
    why.push(`${industries[0].label} is her own background.`);
  }

  const watchOuts = [];
  if (work.orientation.creationTitle) {
    watchOuts.push(
      `The title says “${work.orientation.creationTitle}” — this is a writing job, whatever reviewing the description also mentions.`
    );
  } else if (work.orientation.heavyCreation) {
    watchOuts.push(
      `Substantial original copywriting may be buried here — ${work.orientation.creationCount} creation signals against ${work.orientation.reviewCount} review signals. Read the responsibilities before applying.`
    );
  }
  if (work.automation.substantial) {
    watchOuts.push(
      `Technical automation requirements are real, not incidental: ${work.automation.matched.slice(0, 4).join(', ')}. Reading HTML is fine; building test frameworks is not the job she wants.`
    );
  }
  if (family && work.signalCount < 3 && !thin) {
    // Only meaningful when there was a description to read: on a snippet the
    // absence of review language says nothing, and the snippet note covers it.
    watchOuts.push('The title looks right but the description barely describes review work — the title may be misleading.');
  }
  if (qualification.blocking.length) {
    watchOuts.push(`Stated requirement she does not meet: ${qualification.blocking.map((b) => b.label.toLowerCase()).join(', ')}.`);
  }
  for (const reason of penalties.reasons) {
    watchOuts.push(`${reason.label} — ${reason.detail}.`);
  }
  if (thin) {
    watchOuts.push('This board only received a short snippet of the posting, so the scores lean on the title. Open the full description before judging it.');
  }
  if (job.employerUnknown) {
    watchOuts.push('The listing site names itself as the employer, so who is actually hiring is not stated.');
  }

  return {
    whyMatched: why.slice(0, 4).join(' '),
    evidence: experience.covered.slice(0, 4).map((hit) => ({ label: hit.label, evidence: hit.evidence })),
    gaps: {
      learnable: qualification.learnable.map((gap) => ({ label: gap.label, note: gap.note })),
      experience: [
        ...experience.missing.map((gap) => ({ label: gap.label, note: 'The posting asks for work she has not done professionally.' })),
        ...qualification.blocking.map((gap) => ({ label: gap.label, note: `Stated requirement: “${gap.phrase}”.` })),
      ],
    },
    watchOuts,
  };
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* ---------------------------------------------------------------- score */

export function scoreJob(job, profile, now = new Date(), options = {}) {
  const normTitle = normalizeForMatch(job.title || '');
  const body = job.description || job.excerpt || '';
  const rawText = `${job.title || ''} ${body}`;
  const normAll = normalizeForMatch(
    `${job.title || ''} ${job.company || ''} ${(job.tags || []).join(' ')} ${body}`
  );

  const excluded = (profile.excludeTitlePhrases || []).find((p) => containsPhrase(normTitle, p));
  const scope = options.location?.scope || evaluateLocation(job, profile).scope;

  const family = matchFamily(profile, normTitle);
  const work = scoreWork(profile, normTitle, normAll, family);
  const experience = scoreExperience(profile, normAll);
  const qualification = scoreQualification(profile, normAll, rawText);
  const lifestyle = scoreLifestyle(profile, job, normAll, scope);
  const penalties = scorePenalties(profile, normTitle, normAll);
  const industries = matchGroup(profile.industries, normAll);

  const weights = profile.axisWeights || { work: 0.35, experience: 0.3, qualification: 0.2, lifestyle: 0.15 };
  let match = Math.round(
    work.score * weights.work +
      experience.score * weights.experience +
      qualification.score * weights.qualification +
      lifestyle.score * weights.lifestyle
  );

  // Industry familiarity is a nudge, not an axis: a good posting from an
  // unlisted industry must not lose to a weaker one from a listed one.
  match += Math.min(4, industries.reduce((sum, hit) => sum + hit.weight, 0) / 2);
  match = clamp(Math.round(match + penalties.score), 0, 100);

  /**
   * Several sources return a two-line snippet rather than a description. Three
   * of the four axes read the description, so a posting titled exactly what she
   * is looking for can arrive scoring like a mediocre one purely because there
   * is nothing to read. Floor those on the strength of the title alone — and
   * say so on the card, because a floored score is a weaker claim than an
   * earned one.
   */
  const thinConfig = profile.thinPosting || {};
  const thin = body.length < (thinConfig.minChars ?? 300);
  // The floor is a claim made on the strength of a title, so it may not be made
  // over the top of a demand she has never met: "Medical Copy Editor" is a core
  // title and the wrong job.
  const floorEligible =
    thin &&
    family &&
    !excluded &&
    penalties.score === 0 &&
    experience.missing.length === 0 &&
    qualification.blocking.length === 0;
  const floor = floorEligible ? thinConfig.floors?.[family.tier] ?? 0 : 0;
  if (floor && match < floor) match = floor;

  if (excluded) match = Math.min(match, 5);

  const recency = recencyScore(job.postedAt, profile, now);
  const bucket = freshnessBucket(recency.ageDays, profile);
  const band = bandFor(match, profile);

  const report = buildReport({ job, family, work, experience, qualification, lifestyle, penalties, industries, thin });

  /**
   * The spec's recommendation, with two ceilings on top of the band: a demand
   * she has never met, or a posting that is mostly writing, is never an
   * "apply" however well it scores elsewhere. Both are exactly the cases where
   * a number alone would mislead.
   */
  let recommendation = band.recommendation;
  const capped = report.gaps.experience.length > 0 || work.orientation.creationDominant;
  if (capped && (recommendation === 'APPLY ASAP' || recommendation === 'APPLY')) recommendation = 'CONSIDER';

  /**
   * The spec asks for unusual opportunities to be flagged even when they score
   * lower, because they may point at a career category she would not have
   * searched for.
   */
  const discoveryConfig = profile.discovery || {};
  const discovery = Boolean(
    !excluded &&
      penalties.score === 0 &&
      (
        (family && (discoveryConfig.adjacentTiers || ['adjacent']).includes(family.tier)) ||
        (!family && work.signalCount >= (discoveryConfig.minWorkSignals ?? 6))
      )
  );

  const { matchWeight, recencyWeight } = profile.ranking;
  const rank = round1(match * matchWeight + recency.score * recencyWeight + (bucket.rankBonus ?? 0));

  const engagementHits = matchGroup(profile.engagement, normAll);

  const reasons = [
    ...work.reasons,
    ...experience.reasons,
    ...qualification.reasons,
    ...lifestyle.reasons,
    ...penalties.reasons,
  ].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return {
    match,
    recency: recency.score,
    ageDays: recency.ageDays,
    ageAssumed: recency.assumed,
    rank,
    excluded: Boolean(excluded),
    excludedBy: excluded || null,
    discovery,
    family: family ? { id: family.id, label: family.label, why: family.why, tier: family.tier } : null,
    projectBased: engagementHits.length > 0,
    reasons: reasons.slice(0, 14),
    breakdown: {
      work: work.score,
      experience: experience.score,
      qualification: qualification.score,
      lifestyle: lifestyle.score,
      penalty: penalties.score,
    },
    // Everything the card prints beyond the number. Carried through the
    // pipeline as `details` so buildBoard does not need to know about it.
    details: {
      scores: {
        work: work.score,
        experience: experience.score,
        qualification: qualification.score,
        lifestyle: lifestyle.score,
      },
      band: { tier: band.tier, label: band.label },
      recommendation,
      recommendationCapped: capped && recommendation !== band.recommendation,
      whyMatched: report.whyMatched,
      evidence: report.evidence,
      gaps: report.gaps,
      watchOuts: report.watchOuts,
      freshness: { label: bucket.label, ageDays: recency.ageDays, assumed: recency.assumed },
      /**
       * The facts the 👍/👎 ranking model learns over. Emitted as data rather
       * than prose because the client has to be able to compare one posting
       * with the categories of another, months after the first has expired.
       */
      signals: {
        work: work.signalIds,
        industries: industries.map((hit) => hit.label),
        creation: work.orientation.creationCount + (work.orientation.creationTitle ? 1 : 0),
        automation: work.automation.concepts,
        seniority: seniorityOf(profile, normTitle),
      },
      scoredFromSnippet: thin,
      yearsRequested: qualification.years,
    },
  };
}
