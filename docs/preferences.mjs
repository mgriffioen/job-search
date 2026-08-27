/**
 * The training model — 👍 / 👎 / 🚫.
 *
 * The board itself does not judge. It matches a title against a list of terms
 * and publishes everything that matches, which means the list is wide on
 * purpose and some of it will be wrong. This is how it gets narrower: rate the
 * cards, and the order of the list moves towards what was rated up.
 *
 * WHAT IT LEARNS FROM
 *
 * Not the job — the job will be gone in a fortnight. Each rating stores the
 * *categories* the posting belonged to: the search term its title matched, the
 * employer, the shape of the engagement, the seniority. Those carry forward, so
 * twenty ratings become a preference over categories rather than a list of dead
 * links.
 *
 * The matched term is the important one, and it is why this works on a board
 * with no scoring model. "Video Editor" is on the page because it matched the
 * term `editor`; "Marketing Copy Editor" is there because it matched
 * `marketing copy editor`. A 👎 on the first teaches `editor` and leaves the
 * second untouched. The term list learns its own shape.
 *
 * WHY THE NUMBERS ARE SMALL AND CLAMPED
 *
 * Feedback is sparse, noisy and given in a hurry. A model that lets three
 * impatient thumbs-down bury a whole category would be worse than none — the
 * point of a wide list is to surface work she would not have searched for, and
 * an over-eager learner closes exactly those doors. So every feature saturates
 * after three consistent ratings, and the total is capped at ±20 rank points:
 * enough to reorder the list, never enough to hide a category outright.
 *
 * Ratings move the **rank** (where a posting sits) and never the **relevance**
 * number on the card, which means one fixed thing: how much of the title the
 * matched term accounted for. A card whose position moved says so, and why.
 *
 * This module is pure and has no DOM in it, so the same code runs in the
 * browser and under `node --test`. It lives in docs/ because that is the
 * directory GitHub Pages serves; the tests import it across the tree.
 */

/**
 * The three verdicts, and what each is worth before feature weighting.
 *
 * 👍 MORE LIKE THIS — right kind of work. Learns from everything.
 *
 * 👎 NOT FOR ME — this particular posting is not wanted, but the category may
 * be fine. Learns cautiously, and never concludes that every attribute of the
 * posting is disliked: turning down one full-time job must not produce a
 * negative weight on full-time work.
 *
 * 🚫 WRONG KIND OF WORK — the term that found this should not have. Learns
 * hard, and only about the term and the employer. It must never learn a
 * negative weight on the shape of the engagement or the seniority, because
 * those are not what made it wrong.
 */
export const VERDICTS = {
  up: { id: 'up', weight: 1, label: 'More like this', icon: '👍' },
  down: { id: 'down', weight: -1, label: 'Not for me', icon: '👎' },
  wrong: { id: 'wrong', weight: -2, label: 'Wrong kind of work', icon: '🚫' },
};

/**
 * What each verdict may learn from.
 *
 * `shape` (full-time, part-time, contract, project) is protected outright:
 * every one of those was asked for, and several rejected postings happening to
 * be full-time is a fact about what was advertised, not a preference. A board
 * that concluded otherwise would quietly delete a category she wanted.
 */
const CATEGORICAL_KINDS = new Set(['term', 'company']);
const PROTECTED_KINDS = new Set(['shape']);

export function mayLearn(verdict, kind) {
  if (verdict === 'wrong') return CATEGORICAL_KINDS.has(kind);
  if (verdict === 'down') return !PROTECTED_KINDS.has(kind);
  return true;
}

/**
 * How much one saturated feature is worth. The matched term is the whole
 * reason the posting is on the page, so it counts most. An employer sits high
 * because two bad postings from the same outfit usually means the third is bad
 * too. Seniority is a hint, not a category.
 */
const FEATURE_WEIGHT = { term: 3.0, company: 1.8, seniority: 1.0, shape: 0.8 };

/** Consistent ratings stop counting after this many — see the note above. */
const FEATURE_SATURATION = 3;

/**
 * The most one *kind* of feature may contribute, in either direction. Keeps the
 * signal where the evidence is rather than letting the weakest features win by
 * weight of numbers.
 */
const KIND_CAP = { term: 12, company: 5, seniority: 3, shape: 2 };

/** Below this the model has not learned enough to be worth saying out loud. */
const MIN_VISIBLE = 1.5;

/**
 * How many ratings before the model speaks at full volume. One 👎 is a data
 * point, not a preference: at first it whispers, and the categories firm up as
 * she keeps rating.
 */
const CONFIDENCE_RATINGS = 4;

/** The most the whole model may move one posting, in rank points. */
export const MAX_ADJUSTMENT = 20;

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
      at: typeof rating.at === 'string' ? rating.at : new Date().toISOString(),
      features: Array.isArray(rating.features) ? rating.features.filter((f) => typeof f === 'string') : [],
      title: typeof rating.title === 'string' ? rating.title : '',
      term: typeof rating.term === 'string' ? rating.term : '',
    };
  }
  return { version: 1, ratings };
}

/**
 * The categories a posting belongs to. Everything the model learns is expressed
 * in these, so a rating outlives the posting that produced it.
 *
 * Every term the title matched is recorded, not just the best one: a 👍 on
 * "Freelance Proofreader" should teach `proofreader` as well as the longer
 * phrase, or the lesson would only ever apply to identically-worded titles.
 */
export function featuresOf(job) {
  const features = [];

  for (const term of job.matchedTerms || (job.matchedTerm ? [job.matchedTerm] : [])) {
    features.push(`term:${slug(term)}`);
  }
  if (job.company) features.push(`company:${slug(job.company)}`);
  if (job.seniority && job.seniority !== 'mid') features.push(`seniority:${job.seniority}`);
  for (const type of job.employmentTypes || []) {
    if (type !== 'unspecified') features.push(`shape:${type}`);
  }

  return features;
}

/** Records a verdict, replacing any previous one for that posting. */
export function recordFeedback(preferences, job, verdict) {
  if (!VERDICTS[verdict]) return preferences;
  const next = normalisePreferences(preferences);
  next.ratings[job.id] = {
    verdict,
    at: new Date().toISOString(),
    features: featuresOf(job),
    title: job.title || '',
    term: job.matchedTerm || '',
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
  const counts = { up: 0, down: 0, wrong: 0, total: 0 };

  for (const rating of Object.values(prefs.ratings)) {
    const verdict = VERDICTS[rating.verdict];
    counts[rating.verdict] += 1;
    counts.total += 1;

    for (const feature of rating.features) {
      /**
       * The verdict decides what the rating is allowed to teach. Applied here
       * rather than when the rating is recorded, so ratings already in storage
       * are re-read under the current rules instead of keeping an older
       * model's conclusions forever.
       */
      if (!mayLearn(rating.verdict, feature.split(':')[0])) continue;
      features[feature] = (features[feature] || 0) + verdict.weight;
    }
  }

  return {
    features,
    counts,
    confidence: Math.min(1, counts.total / CONFIDENCE_RATINGS),
  };
}

/** Human-readable name for a feature, for the "why" note on a card. */
function describeFeature(feature, job) {
  const [kind, value] = feature.split(':');
  switch (kind) {
    case 'term':
      // The term as written in the config, not the slug.
      return (job.matchedTerms || [job.matchedTerm]).find((t) => slug(t) === value) || value.replace(/-/g, ' ');
    case 'company':
      return job.company || 'this employer';
    case 'seniority':
      return value === 'senior' ? 'senior-titled roles' : 'junior-titled roles';
    case 'shape':
      return value;
    default:
      return null;
  }
}

/**
 * What the ratings say about one posting: a rank adjustment and the reasons for
 * it, strongest first. Never touches `relevance`.
 */
export function adjustmentFor(job, model) {
  if (!model || !model.counts.total) return { points: 0, notes: [] };

  const contributions = [];
  const byKind = Object.create(null);

  for (const feature of featuresOf(job)) {
    const score = model.features[feature];
    if (!score) continue;
    const kind = feature.split(':')[0];
    const weight = FEATURE_WEIGHT[kind] ?? 0.8;
    const value = clamp(score, -FEATURE_SATURATION, FEATURE_SATURATION) * weight;
    if (!value) continue;
    byKind[kind] = (byKind[kind] || 0) + value;
    contributions.push({ feature, value });
  }

  let points = 0;
  for (const [kind, total] of Object.entries(byKind)) {
    points += clamp(total, -(KIND_CAP[kind] ?? 3), KIND_CAP[kind] ?? 3) * (model.confidence ?? 1);
  }

  const total = clamp(Math.round(points * 10) / 10, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);

  // A fraction of a point is not a preference, it is arithmetic bleeding from
  // categories half the board shares. Saying nothing is the honest answer.
  if (Math.abs(total) < MIN_VISIBLE) return { points: 0, notes: [] };

  contributions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  /**
   * Two features can describe themselves the same way, and a note that says the
   * same thing twice reads as a bug. Name each category once, strongest first.
   */
  const notes = [];
  const named = new Set();
  for (const contribution of contributions) {
    if (notes.length >= 2) break;
    const name = describeFeature(contribution.feature, job);
    if (!name || named.has(name)) continue;
    named.add(name);
    notes.push(
      contribution.value > 0
        ? `you rated other “${name}” postings up`
        : `you passed on other “${name}” postings`
    );
  }

  return { points: total, notes };
}

/** One-line summary for the filter panel. */
export function summarise(model) {
  const { up, down, wrong, total } = model.counts;
  if (!total) return 'No ratings yet — 👍 / 👎 on a card to start teaching the order.';
  const parts = [];
  if (up) parts.push(`${up} 👍`);
  if (down) parts.push(`${down} 👎`);
  if (wrong) parts.push(`${wrong} 🚫`);
  return `Order tuned by ${total} rating${total === 1 ? '' : 's'} (${parts.join(' · ')}).`;
}
