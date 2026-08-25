/**
 * Learned ranking preferences — the 👍 / 👎 / 🚫 model.
 *
 * The four axes score a posting against a written specification. This scores it
 * against what she has actually said, one job at a time, and nudges the sort
 * order accordingly. The two are deliberately separate: the axes and the bands
 * mean what the specification says they mean, so feedback moves the **rank**
 * (where a job sits in the list) and never the **match** (what the board claims
 * about the fit). A card whose position was changed says so and says why.
 *
 * WHAT IT LEARNS FROM
 *
 * Not the job — the job will be gone in a fortnight. Each rating stores a
 * snapshot of the *features* of the job it was made on: the role family, the
 * kinds of work in the description, the industry, the employer, the shape of
 * the engagement. Those features are what carry forward, so twenty ratings turn
 * into a preference over categories rather than a list of dead links.
 *
 * The optional reason after 👎 is the other half. "Not for me" tells you a job
 * was wrong; "too technical" tells you *which part* was wrong, and that is what
 * lets a single rating generalise correctly instead of quietly punishing the
 * industry and the employer for a fault that belonged to neither.
 *
 * WHY THE NUMBERS ARE SMALL AND CLAMPED
 *
 * Feedback is sparse, noisy and given in a hurry. A model that lets three
 * impatient thumbs-down bury a whole role family would be worse than no model
 * at all — the point of this board is to surface work she would not have
 * searched for, and an over-eager learner closes exactly those doors. So every
 * feature saturates after three consistent ratings, and the total is capped at
 * ±15 rank points: enough to reorder neighbours, never enough to hide a
 * category she has not actually rejected.
 *
 * This module is pure and has no DOM in it, so the same code runs in the
 * browser and under `node --test`. It lives in docs/ because that is the
 * directory GitHub Pages serves; the tests import it across the tree.
 */

/**
 * The three verdicts, and what each is worth before feature weighting.
 *
 * THEY MEAN DIFFERENT THINGS, AND v4 MAKES THEM LEARN DIFFERENTLY.
 *
 * 👍 MORE LIKE THIS — the occupation, the responsibilities, the content type,
 * the industry and the shape of the engagement were all right. Learns from
 * everything.
 *
 * 👎 NOT FOR ME — the occupation may be perfectly valid; this particular
 * opportunity is not wanted. It learns cautiously and never concludes that
 * every attribute of the posting is disliked. Rejecting one full-time job must
 * not produce a negative weight on full-time work.
 *
 * 🚫 WRONG KIND OF WORK — an occupational mismatch. It learns hard, and only
 * about the occupation: the job family, the professional domain and the
 * dominant function. It must NEVER learn a negative weight on the transferable
 * skills the posting happened to name, because "review", "proofreading",
 * "accuracy" and "verification" are what she is good at. A Commercial
 * Lawyer marked 🚫 has to teach "legal work is wrong" and nothing whatsoever
 * about proofreading.
 */
export const VERDICTS = {
  up: { id: 'up', weight: 1, label: 'More like this', icon: '👍' },
  down: { id: 'down', weight: -1, label: 'Not for me', icon: '👎' },
  wrong: { id: 'wrong', weight: -2, label: 'Wrong kind of work', icon: '🚫' },
};

/**
 * What each verdict is allowed to learn from.
 *
 * OCCUPATIONAL_KINDS are the facts a 🚫 is actually about — which occupation
 * this is, which professional domain, and whether the job creates content or
 * reviews it. TRANSFERABLE_KINDS (`work:`) are the abilities the posting named,
 * and are exactly what a 🚫 must not touch.
 *
 * PROTECTED_KINDS are the explicit preferences: remote, United States,
 * full-time, part-time and contract are all wanted, and were stated rather than
 * inferred. Nothing in the ratings may produce a negative weight on them —
 * several rejected postings happening to be full-time is a coincidence of
 * what was advertised, not a preference, and a board that concluded otherwise
 * would quietly delete a category she asked for.
 */
const OCCUPATIONAL_KINDS = new Set(['occupation', 'family', 'industry', 'function']);
const PROTECTED_KINDS = new Set(['shape']);

export function mayLearn(verdict, kind) {
  if (verdict === 'wrong') return OCCUPATIONAL_KINDS.has(kind);
  if (verdict === 'down') return !PROTECTED_KINDS.has(kind);
  return true;
}

/**
 * The optional follow-up to 👎. `dimension` is what the reason generalises to;
 * a reason with none only affects this job's own features.
 */
export const DOWN_REASONS = [
  { id: 'writing', label: 'Too much writing', dimension: 'writing' },
  { id: 'technical', label: 'Too technical', dimension: 'technical' },
  { id: 'industry', label: 'Wrong industry', dimension: 'industry' },
  { id: 'senior', label: 'Too senior', dimension: 'senior' },
  { id: 'junior', label: 'Too junior', dimension: 'junior' },
  { id: 'pay', label: 'Poor pay', dimension: 'pay' },
  { id: 'flexible', label: 'Not flexible', dimension: 'flexible' },
  { id: 'other', label: 'Other', dimension: null },
];

/**
 * How much one saturated feature is worth. The occupation is the whole
 * judgement and counts most; a single work signal is one sentence in a
 * description and counts least. An employer sits high because two bad postings
 * from the same outfit usually means the third is bad too.
 */
const FEATURE_WEIGHT = {
  occupation: 2.6,
  family: 2.2,
  function: 1.4,
  work: 0.7,
  industry: 1.2,
  company: 1.6,
  shape: 0.7,
};

/** Consistent ratings stop counting after this many — see the note above. */
const FEATURE_SATURATION = 3;

/**
 * The most one *kind* of feature may contribute, in either direction.
 *
 * Without this the weakest features win by weight of numbers: nearly every
 * posting on this board mentions proofreading, accuracy and style guides, so a
 * single 👎 leaked a few points onto everything and the card said "−5.9 from
 * your ratings" about a job she had never seen. Capping per kind keeps the
 * signal where the evidence is — the role family and the industry she actually
 * rejected — and leaves the shared vocabulary as a tiebreak.
 */
const KIND_CAP = { occupation: 8, family: 7, function: 4, industry: 4, company: 4, work: 3, shape: 2 };

/** Below this the model has not learned enough to be worth saying out loud. */
const MIN_VISIBLE = 1.5;

/**
 * How many ratings before the *inferred* half of the model speaks at full
 * volume. One 👎 is a data point, not a preference: at first it whispers, and
 * the categories firm up as she keeps rating. The reason chips are exempt —
 * "too technical" is a statement, not an inference, and is applied in full from
 * the first time she says it.
 */
const CONFIDENCE_RATINGS = 4;

/** The most the whole model may move one posting, in rank points. */
export const MAX_ADJUSTMENT = 15;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const slug = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function emptyPreferences() {
  return { version: 1, ratings: {} };
}

/** Tolerates anything in storage, including nothing and rubbish. */
export function normalisePreferences(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ratings !== 'object' || !raw.ratings) {
    return emptyPreferences();
  }
  const ratings = {};
  for (const [id, rating] of Object.entries(raw.ratings)) {
    if (!rating || !VERDICTS[rating.verdict]) continue;
    ratings[id] = {
      verdict: rating.verdict,
      reason: typeof rating.reason === 'string' ? rating.reason : null,
      at: typeof rating.at === 'string' ? rating.at : new Date().toISOString(),
      features: Array.isArray(rating.features) ? rating.features.filter((f) => typeof f === 'string') : [],
      facts: rating.facts && typeof rating.facts === 'object' ? rating.facts : {},
      title: typeof rating.title === 'string' ? rating.title : '',
    };
  }
  return { version: 1, ratings };
}

/**
 * The categories a posting belongs to. Everything the model learns is expressed
 * in these, so a rating outlives the posting that produced it.
 */
export function featuresOf(job) {
  const signals = job.signals || {};
  const features = [];

  /**
   * The occupational half, which v4 added and which is what the 🚫 button is
   * really about: which occupation this posting belongs to, and whether the job
   * makes content or checks it. Boards before v4 emit neither, and a rating
   * given on one of them simply learns less rather than learning wrongly.
   */
  if (signals.occupation) features.push(`occupation:${slug(signals.occupation)}`);
  if (signals.function) features.push(`function:${slug(signals.function)}`);

  if (job.family?.id) features.push(`family:${job.family.id}`);
  for (const id of signals.work || []) features.push(`work:${id}`);
  for (const label of signals.industries || []) features.push(`industry:${slug(label)}`);
  if (job.company) features.push(`company:${slug(job.company)}`);
  for (const type of job.employmentTypes || []) {
    if (type !== 'unspecified') features.push(`shape:${type}`);
  }
  if (job.projectBased) features.push('shape:project');

  return features;
}

/** The facts a reason needs to generalise, snapshotted with the rating. */
export function factsOf(job) {
  const signals = job.signals || {};
  return {
    creation: signals.creation ?? 0,
    automation: signals.automation ?? 0,
    seniority: signals.seniority ?? null,
    lifestyle: job.scores?.lifestyle ?? null,
    projectBased: Boolean(job.projectBased),
    pay: annualisePay(job.salary),
  };
}

/**
 * Stated pay as a comparable yearly figure, or null when the posting does not
 * say. Hourly and weekly rates are annualised so "poor pay" learned from a
 * contract rate still recognises a poorly-paid salaried role.
 */
export function annualisePay(text) {
  if (!text) return null;
  const raw = String(text).toLowerCase();
  const numbers = [...raw.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!numbers.length) return null;

  const top = Math.max(...numbers);
  if (/hour|hourly|\/\s*hr|per hr|an hour/.test(raw)) return Math.round(top * 2080);
  if (/week/.test(raw)) return Math.round(top * 52);
  if (/month/.test(raw)) return Math.round(top * 12);
  // No unit stated: a figure under a few hundred can only be an hourly rate.
  if (top < 400) return Math.round(top * 2080);
  return Math.round(top);
}

/** Records a verdict, replacing any previous one for that posting. */
export function recordFeedback(preferences, job, verdict, reason = null) {
  if (!VERDICTS[verdict]) return preferences;
  const next = normalisePreferences(preferences);
  next.ratings[job.id] = {
    verdict,
    reason: reason && DOWN_REASONS.some((r) => r.id === reason) ? reason : null,
    at: new Date().toISOString(),
    features: featuresOf(job),
    facts: factsOf(job),
    title: job.title || '',
  };
  return next;
}

export function clearFeedback(preferences, jobId) {
  const next = normalisePreferences(preferences);
  delete next.ratings[jobId];
  return next;
}

export function ratingFor(preferences, jobId) {
  return preferences?.ratings?.[jobId] || null;
}

/**
 * Turns the ratings into weights. Done in one pass and reused for every card,
 * because the alternative — recomputing per posting — is the same arithmetic
 * repeated a few hundred times per render.
 */
export function buildModel(preferences) {
  const prefs = normalisePreferences(preferences);
  const features = Object.create(null);
  const dimensions = Object.create(null);
  const blamedIndustries = Object.create(null);
  const counts = { up: 0, down: 0, wrong: 0, total: 0 };
  let payFloor = null;

  for (const rating of Object.values(prefs.ratings)) {
    const verdict = VERDICTS[rating.verdict];
    counts[rating.verdict] += 1;
    counts.total += 1;

    const reason = DOWN_REASONS.find((r) => r.id === rating.reason) || null;

    /**
     * A named reason redirects the blame rather than adding to it. "Too
     * technical" says the fault was the tooling, so the role family, the
     * industry and the employer should not also be marked down for it —
     * otherwise saying *why* would punish a posting harder than saying nothing,
     * which is the opposite of what the reason chips are for. They still count
     * for something, because the posting was still rejected.
     */
    const featureShare = reason?.dimension ? 0.4 : 1;
    for (const feature of rating.features) {
      /**
       * The verdict decides what the rating is allowed to teach. Applied here
       * rather than when the rating is recorded so that ratings already in
       * storage — given before v4 drew this distinction — are re-read under the
       * new rules instead of keeping the old model's conclusions forever.
       */
      if (!mayLearn(rating.verdict, feature.split(':')[0])) continue;
      features[feature] = (features[feature] || 0) + verdict.weight * featureShare;
    }

    if (reason?.dimension && reason.dimension !== 'industry') {
      dimensions[reason.dimension] = (dimensions[reason.dimension] || 0) + 1;
    }

    // "Wrong industry" names the industry as the fault, so it is charged
    // against that industry directly rather than added to the feature score —
    // where the saturation clamp would have swallowed it and the reason would
    // have made no difference at all.
    if (reason?.dimension === 'industry') {
      for (const feature of rating.features) {
        if (!feature.startsWith('industry:')) continue;
        blamedIndustries[feature] = (blamedIndustries[feature] || 0) + 1;
      }
    }

    // The worst pay she has actually rejected becomes the line: a posting
    // offering that or less has been judged already.
    if (reason?.dimension === 'pay' && rating.facts?.pay) {
      payFloor = payFloor === null ? rating.facts.pay : Math.max(payFloor, rating.facts.pay);
    }
  }

  return {
    features,
    dimensions,
    blamedIndustries,
    counts,
    payFloor,
    confidence: Math.min(1, counts.total / CONFIDENCE_RATINGS),
  };
}

/**
 * Human-readable name for a feature, for the "why" note on a card. Work-signal
 * labels come from the board's meta rather than from the posting, which keeps
 * jobs.json from carrying the same dozen strings a few hundred times.
 */
function describeFeature(feature, job, labels = {}) {
  const [kind, value] = feature.split(':');
  const signals = job.signals || {};
  switch (kind) {
    case 'occupation':
      return job.occupation?.label ? job.occupation.label.toLowerCase() : 'this occupation';
    case 'function':
      // "mixed" is the absence of an answer, and there is no honest way to name
      // it in a sentence about what she prefers. Unnamed features still count
      // towards the adjustment; they just do not get a line explaining it.
      return value === 'creating' ? 'creating content' : value === 'reviewing' ? 'reviewing content' : null;
    case 'family':
      return job.family?.label ? job.family.label.toLowerCase() : 'this role family';
    case 'industry':
      return (signals.industries || [])[0]?.toLowerCase() || 'this industry';
    case 'company':
      return job.company || 'this employer';
    case 'shape':
      return value === 'project' ? 'project-based' : value;
    default:
      return labels[value] ? labels[value].toLowerCase() : 'this kind of work';
  }
}

/**
 * What the ratings say about one posting: a rank adjustment and the reasons for
 * it, in the order they matter. Never touches `match`.
 */
export function adjustmentFor(job, model, labels = {}) {
  if (!model || !model.counts.total || !job.signals) return { points: 0, notes: [] };

  const notes = [];
  let points = 0;

  // Features: strongest contributor first, and only the top few are worth
  // explaining — a note listing nine categories explains nothing.
  const contributions = [];
  const byKind = Object.create(null);
  for (const feature of featuresOf(job)) {
    const score = model.features[feature];
    if (!score) continue;
    const kind = feature.split(':')[0];
    const weight = FEATURE_WEIGHT[kind] ?? 0.7;
    const value = clamp(score, -FEATURE_SATURATION, FEATURE_SATURATION) * weight;
    if (!value) continue;
    byKind[kind] = (byKind[kind] || 0) + value;
    contributions.push({ feature, value, score });
  }
  contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  for (const [kind, total] of Object.entries(byKind)) {
    const cap = KIND_CAP[kind] ?? 3;
    points += clamp(total, -cap, cap) * (model.confidence ?? 1);
  }
  /**
   * Two features can describe themselves the same way — a posting's occupation
   * and its role family are usually the same category under two names — and a
   * note that says the same thing twice reads as a bug. Name each category
   * once, strongest first.
   */
  const named = new Set();
  for (const contribution of contributions) {
    if (notes.length >= 2) break;
    const name = describeFeature(contribution.feature, job, labels);
    if (!name || named.has(name)) continue;
    named.add(name);
    notes.push(
      contribution.value > 0
        ? `you rated other “${name}” postings up`
        : `you passed on other “${name}” postings`
    );
  }

  // Dimensions: the reason chips, applied to this posting's own facts.
  const facts = factsOf(job);
  const dimension = (id) => Math.min(model.dimensions[id] || 0, 3);

  for (const feature of featuresOf(job)) {
    const blamed = model.blamedIndustries?.[feature];
    if (!blamed) continue;
    points -= 2 * Math.min(blamed, 3);
    notes.push(`you have called this industry the wrong one before`);
  }

  if (dimension('writing') && facts.creation >= 2) {
    points -= 3 * dimension('writing');
    notes.push('you have said “too much writing” before, and this one leans that way');
  }
  if (dimension('technical') && facts.automation >= 1) {
    points -= 3 * dimension('technical');
    notes.push('you have said “too technical” before, and this one names coding tools');
  }
  if (dimension('senior') && facts.seniority === 'senior') {
    points -= 4 * dimension('senior');
    notes.push('you have passed on senior-titled roles');
  }
  if (dimension('junior') && facts.seniority === 'junior') {
    points -= 4 * dimension('junior');
    notes.push('you have passed on junior-titled roles');
  }
  if (dimension('flexible') && !facts.projectBased && (facts.lifestyle ?? 100) < 70) {
    points -= 3 * dimension('flexible');
    notes.push('you have passed on roles with no flexibility on offer');
  }
  if (model.payFloor && facts.pay && facts.pay <= model.payFloor) {
    points -= 5;
    notes.push('the stated pay is at or below what you have turned down');
  }

  const total = clamp(Math.round(points * 10) / 10, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);

  // A fraction of a point is not a preference, it is arithmetic bleeding from
  // features half the board shares. Saying nothing is the honest answer.
  if (Math.abs(total) < MIN_VISIBLE) return { points: 0, notes: [] };

  return { points: total, notes: notes.slice(0, 3) };
}

/** One-line summary for the filter panel. */
export function summarise(model) {
  const { up, down, wrong, total } = model.counts;
  if (!total) return 'No ratings yet — 👍 / 👎 on a card to start tuning the order.';
  const parts = [];
  if (up) parts.push(`${up} 👍`);
  if (down) parts.push(`${down} 👎`);
  if (wrong) parts.push(`${wrong} 🚫`);
  return `Ranking tuned by ${total} rating${total === 1 ? '' : 's'} (${parts.join(' · ')}).`;
}
