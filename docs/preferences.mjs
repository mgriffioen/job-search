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
 * The optional follow-up to 👎.
 *
 * "Not for me" tells you a posting was wrong. "Too much writing" tells you
 * WHICH PART was wrong, and that is what lets a single rating generalise
 * correctly instead of quietly marking down the employer and the search term
 * for a fault that belonged to neither.
 *
 * `dimension` is the fact the reason generalises through; every one of these is
 * a field the board actually publishes, so a reason can never be a promise the
 * data cannot keep. A reason with a null dimension affects only this posting.
 *
 * "Wrong industry" is deliberately absent: this board carries no industry
 * field, and a chip that silently did nothing would be worse than no chip.
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
 * Whether a reason has something on THIS posting to generalise through.
 *
 * Every reason is always offered. This decides one thing only: whether the
 * blame redirect below applies. An earlier version used it to disable chips,
 * which was a mistake worth recording — on a real board it left most cards
 * offering two of the eight, and the row read as broken.
 *
 * The mistake underneath was treating the board's reading as the authority.
 * Seniority is guessed from the title and industry from a phrase list; both are
 * often wrong, and she is the one who read the posting. "Too senior" on a job
 * this code called mid-level is her correcting it, and it still teaches every
 * posting the board *did* call senior. What must not happen is a reason costing
 * more than silence — that is what the redirect is for, and it is why this
 * function still exists.
 */
export function reasonApplies(reasonId, job) {
  return reasonAppliesToFacts(reasonId, factsOf(job));
}

/** The same question, asked of a rating's stored facts rather than a posting. */
export function reasonAppliesToFacts(reasonId, snapshot = {}) {
  const facts = {
    mode: snapshot.mode ?? null,
    technical: Boolean(snapshot.technical),
    industries: snapshot.industries || [],
    seniority: snapshot.seniority ?? null,
    pay: snapshot.pay ?? null,
    flexible: Boolean(snapshot.flexible),
  };
  switch (reasonId) {
    case 'writing':
      return facts.mode === 'writing';
    case 'technical':
      return facts.technical;
    case 'industry':
      return facts.industries.length > 0;
    case 'senior':
      return facts.seniority === 'senior';
    case 'junior':
      return facts.seniority === 'junior';
    case 'pay':
      return facts.pay !== null;
    case 'flexible':
      // Nothing to say about flexibility on a posting that is already contract
      // or part-time.
      return !facts.flexible;
    default:
      return true;
  }
}

/** What each reason teaches, for the chip's tooltip. */
export function reasonExplains(reasonId) {
  switch (reasonId) {
    case 'writing':
      return 'Pushes down roles that make content rather than check it.';
    case 'technical':
      return 'Pushes down postings that treat writing code as the job.';
    case 'industry':
      return 'Pushes down this posting’s industry.';
    case 'senior':
      return 'Pushes down senior-titled roles.';
    case 'junior':
      return 'Pushes down junior-titled roles.';
    case 'pay':
      return 'Treats this pay as the floor, and pushes down anything at or below it.';
    case 'flexible':
      return 'Pushes down roles offering neither contract nor part-time work.';
    default:
      return 'Recorded against this posting only.';
  }
}

/**
 * How much one saturated dimension is worth. Larger than a feature weight,
 * because a reason is something she said rather than something inferred.
 */
const DIMENSION_WEIGHT = { writing: 3, technical: 3, senior: 4, junior: 4, flexible: 3 };

/**
 * "Wrong industry" per rating that named it, charged to that industry alone.
 *
 * Kept separate from the dimension counts because it is the one reason that
 * names a *category* rather than a property: "too senior" is true of a posting,
 * "wrong industry" is true of healthcare. Charging it through a shared counter
 * would have punished every industry for the one she meant.
 */
const INDUSTRY_PENALTY = 2.5;

/** A dimension stops accumulating after this many ratings name it. */
const DIMENSION_SATURATION = 3;

/** Flat penalty for a posting at or below pay she has already turned down. */
const PAY_PENALTY = 5;

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
const FEATURE_WEIGHT = { term: 3.0, company: 1.8, industry: 1.2, seniority: 1.0, shape: 0.8 };

/** Consistent ratings stop counting after this many — see the note above. */
const FEATURE_SATURATION = 3;

/**
 * The most one *kind* of feature may contribute, in either direction. Keeps the
 * signal where the evidence is rather than letting the weakest features win by
 * weight of numbers.
 */
const KIND_CAP = { term: 12, company: 5, industry: 4, seniority: 3, shape: 2 };

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

/**
 * Stated pay as a comparable yearly figure, or null when the posting does not
 * say. Hourly, weekly and monthly rates are annualised so "pay too low" learned
 * from a contract rate still recognises a poorly-paid salaried role.
 */
export function annualisePay(text) {
  if (!text) return null;
  const raw = String(text).toLowerCase();
  const numbers = [...raw.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!numbers.length) return null;

  // The top of a range: a posting offering "$40,000 – $90,000" has not offered
  // $40,000, and judging it on the bottom would reject it for a number nobody
  // put on the table.
  const top = Math.max(...numbers);
  if (/hour|hourly|\/\s*hr|per hr|an hour/.test(raw)) return Math.round(top * 2080);
  if (/week/.test(raw)) return Math.round(top * 52);
  if (/month/.test(raw)) return Math.round(top * 12);
  // No unit stated: a figure under a few hundred can only be an hourly rate.
  if (top < 400) return Math.round(top * 2080);
  return Math.round(top);
}

/**
 * The facts a reason generalises through, snapshotted with the rating so it
 * outlives the posting.
 */
export function factsOf(job) {
  return {
    mode: job.mode || null,
    technical: Boolean(job.technical),
    industries: job.industries || [],
    seniority: job.seniority || null,
    pay: annualisePay(job.salary),
    // Contract, freelance and part-time work is what "flexible" means here.
    flexible: (job.employmentTypes || []).some((type) => type === 'contract' || type === 'part-time'),
  };
}

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
      // Only a reason the current build knows about survives; an unrecognised
      // one becomes a plain 👎 rather than a dimension nothing applies.
      reason: DOWN_REASONS.some((r) => r.id === rating.reason) ? rating.reason : null,
      at: typeof rating.at === 'string' ? rating.at : new Date().toISOString(),
      features: Array.isArray(rating.features) ? rating.features.filter((f) => typeof f === 'string') : [],
      facts: rating.facts && typeof rating.facts === 'object' ? rating.facts : {},
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
  for (const label of job.industries || []) features.push(`industry:${slug(label)}`);
  if (job.seniority && job.seniority !== 'mid') features.push(`seniority:${job.seniority}`);
  for (const type of job.employmentTypes || []) {
    if (type !== 'unspecified') features.push(`shape:${type}`);
  }

  return features;
}

/**
 * Records a verdict, replacing any previous one for that posting.
 *
 * The reason only means anything on a 👎: a 👍 has nothing to explain, and a 🚫
 * already says what was wrong.
 */
export function recordFeedback(preferences, job, verdict, reason = null) {
  if (!VERDICTS[verdict]) return preferences;
  const next = normalisePreferences(preferences);
  next.ratings[job.id] = {
    verdict,
    reason: verdict === 'down' && DOWN_REASONS.some((r) => r.id === reason) ? reason : null,
    at: new Date().toISOString(),
    features: featuresOf(job),
    facts: factsOf(job),
    title: job.title || '',
    term: job.matchedTerm || '',
  };
  return next;
}

/**
 * Sets or clears the reason on a rating that already exists, without disturbing
 * the verdict or its timestamp — pressing a chip is not re-rating the job.
 */
export function setReason(preferences, job, reason) {
  const next = normalisePreferences(preferences);
  const rating = next.ratings[job.id];
  if (!rating || rating.verdict !== 'down') return next;
  rating.reason = DOWN_REASONS.some((r) => r.id === reason) ? reason : null;
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
     * A named reason REDIRECTS the blame rather than adding to it.
     *
     * "Too much writing" says the fault was the shape of the work, so the
     * search term, the employer and the seniority should not also be marked
     * down for it — otherwise saying WHY would punish a posting harder than
     * saying nothing, which is the opposite of what the chips are for.
     *
     * The redirect only happens when there is somewhere for the blame to go.
     * She can say "too senior" about a posting this code read as mid-level —
     * she read it and this code guessed — and that is worth recording and
     * worth teaching to every posting the board *did* call senior. But with no
     * senior flag on THIS posting there is nothing here to carry the weight, so
     * the features keep all of it and the rating costs exactly what a bare 👎
     * costs. A reason must never make a rating teach less than silence.
     */
    const redirects = Boolean(reason?.dimension) && reasonAppliesToFacts(reason.id, rating.facts);
    const featureShare = redirects ? 0.4 : 1;

    for (const feature of rating.features) {
      /**
       * The verdict decides what the rating is allowed to teach. Applied here
       * rather than when the rating is recorded, so ratings already in storage
       * are re-read under the current rules instead of keeping an older
       * model's conclusions forever.
       */
      if (!mayLearn(rating.verdict, feature.split(':')[0])) continue;
      features[feature] = (features[feature] || 0) + verdict.weight * featureShare;
    }

    /**
     * Counted whatever this posting looked like. The dimension is a statement
     * about the kind of work she wants, and it is applied later to whichever
     * postings carry the matching fact — so "too senior", said once on a title
     * this code misread, still moves the roles it read correctly.
     */
    if (reason?.dimension && reason.dimension !== 'pay' && reason.dimension !== 'industry') {
      dimensions[reason.dimension] = (dimensions[reason.dimension] || 0) + 1;
    }

    /**
     * "Wrong industry" names the industry as the fault, so it is charged
     * against that industry directly rather than added to the feature score,
     * where the saturation clamp would have swallowed it and saying which
     * industry was wrong would have made no difference at all.
     */
    if (reason?.dimension === 'industry') {
      for (const label of rating.facts?.industries || []) {
        blamedIndustries[label] = (blamedIndustries[label] || 0) + 1;
      }
    }

    /**
     * The best pay she has actually turned down becomes the line: a posting
     * offering that or less has been judged already. Charged directly rather
     * than through a dimension count, because a floor is not something that
     * gets more true the more often it is said.
     */
    if (reason?.dimension === 'pay' && rating.facts?.pay) {
      payFloor = payFloor === null ? rating.facts.pay : Math.max(payFloor, rating.facts.pay);
    }
  }

  return {
    features,
    dimensions,
    blamedIndustries,
    payFloor,
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
    case 'industry':
      return (job.industries || []).find((l) => slug(l) === value) || value.replace(/-/g, ' ');
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

  /**
   * The reason chips, applied to this posting's own facts.
   *
   * Deliberately NOT scaled by confidence. The rest of the model is inference
   * from categories and should whisper until there is evidence; "too senior" is
   * a statement, and applies in full the first time she makes it.
   */
  const facts = factsOf(job);
  const named = [];
  const dimension = (id) => Math.min(model.dimensions?.[id] || 0, DIMENSION_SATURATION);

  if (facts.mode === 'writing' && dimension('writing')) {
    points -= DIMENSION_WEIGHT.writing * dimension('writing');
    named.push('you have said “too much writing” before, and this role makes content rather than checks it');
  }
  if (facts.technical && dimension('technical')) {
    points -= DIMENSION_WEIGHT.technical * dimension('technical');
    named.push('you have said “too technical” before, and this posting treats writing code as the job');
  }
  for (const label of facts.industries) {
    const blamed = Math.min(model.blamedIndustries?.[label] || 0, DIMENSION_SATURATION);
    if (!blamed) continue;
    points -= INDUSTRY_PENALTY * blamed;
    named.push(`you have called ${label.toLowerCase()} the wrong industry before`);
  }
  if (facts.seniority === 'senior' && dimension('senior')) {
    points -= DIMENSION_WEIGHT.senior * dimension('senior');
    named.push('you have passed on senior-titled roles');
  }
  if (facts.seniority === 'junior' && dimension('junior')) {
    points -= DIMENSION_WEIGHT.junior * dimension('junior');
    named.push('you have passed on junior-titled roles');
  }
  if (!facts.flexible && dimension('flexible')) {
    points -= DIMENSION_WEIGHT.flexible * dimension('flexible');
    named.push('you have passed on roles with no flexibility on offer');
  }
  if (model.payFloor && facts.pay && facts.pay <= model.payFloor) {
    points -= PAY_PENALTY;
    named.push('the stated pay is at or below what you have turned down');
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
  // The stated reasons lead: she said those, the categories were inferred.
  const notes = [...named];
  const seen = new Set();
  for (const contribution of contributions) {
    if (notes.length >= 3) break;
    const name = describeFeature(contribution.feature, job);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    notes.push(
      contribution.value > 0
        ? `you rated other “${name}” postings up`
        : `you passed on other “${name}” postings`
    );
  }

  return { points: total, notes: notes.slice(0, 3) };
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
