import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOWN_REASONS,
  MAX_ADJUSTMENT,
  adjustmentFor,
  annualisePay,
  buildModel,
  clearFeedback,
  emptyPreferences,
  featuresOf,
  normalisePreferences,
  ratingFor,
  recordFeedback,
  summarise,
} from '../docs/preferences.mjs';

/**
 * The board's own module, imported straight out of docs/ — the same file the
 * browser loads, so these tests cannot pass against an implementation the site
 * does not actually run.
 */

const LABELS = {
  proofreading: 'Proofreading and copy editing',
  'product-content': 'Product, catalog and e-commerce content',
};

const job = (overrides = {}) => ({
  id: 'demo:1',
  title: 'Content Quality Specialist',
  company: 'Northline Retail',
  employmentTypes: ['contract'],
  projectBased: true,
  rank: 80,
  salary: null,
  scores: { work: 90, experience: 90, qualification: 85, lifestyle: 80 },
  family: { id: 'content-editorial-quality', label: 'Content & editorial quality', tier: 'core' },
  signals: {
    work: ['proofreading', 'product-content'],
    industries: ['Retail / e-commerce / consumer brands'],
    creation: 0,
    automation: 0,
    seniority: 'mid',
  },
  ...overrides,
});

test('a posting is described by its categories, not by itself', () => {
  // What makes a rating outlive the posting it was made on.
  const features = featuresOf(job());
  assert.ok(features.includes('family:content-editorial-quality'));
  assert.ok(features.includes('work:proofreading'));
  assert.ok(features.includes('industry:retail-e-commerce-consumer-brands'));
  assert.ok(features.includes('company:northline-retail'));
  assert.ok(features.includes('shape:contract'));
  assert.ok(features.includes('shape:project'));
  assert.ok(!features.some((f) => f.includes('demo:1')), 'the posting id is never a feature');
});

test('no ratings means no adjustment at all', () => {
  const model = buildModel(emptyPreferences());
  assert.deepEqual(adjustmentFor(job(), model, LABELS), { points: 0, notes: [] });
  assert.match(summarise(model), /No ratings yet/);
});

test('a thumbs-up lifts other postings in the same categories', () => {
  let prefs = emptyPreferences();
  prefs = recordFeedback(prefs, job({ id: 'a' }), 'up');

  const model = buildModel(prefs);
  const other = job({ id: 'b', company: 'Different Co' });
  const adjustment = adjustmentFor(other, model, LABELS);

  assert.ok(adjustment.points > 0, `expected a lift, got ${adjustment.points}`);
  assert.ok(adjustment.notes.length, 'and the card must be able to say why');
  assert.match(adjustment.notes.join(' '), /content & editorial quality/i);
});

test('a thumbs-down pushes them down, and 🚫 pushes harder', () => {
  const down = buildModel(recordFeedback(emptyPreferences(), job({ id: 'a' }), 'down'));
  const wrong = buildModel(recordFeedback(emptyPreferences(), job({ id: 'a' }), 'wrong'));

  const other = job({ id: 'b', company: 'Different Co' });
  const downPoints = adjustmentFor(other, down, LABELS).points;
  const wrongPoints = adjustmentFor(other, wrong, LABELS).points;

  assert.ok(downPoints < 0);
  assert.ok(wrongPoints < downPoints, 'the stronger verdict must move it further');
});

test('one impatient category cannot be buried by repetition', () => {
  // The whole point of the board is surfacing work she would not have searched
  // for. A learner that lets four fast rejections close a family off is worse
  // than no learner.
  let prefs = emptyPreferences();
  for (let i = 0; i < 12; i += 1) {
    prefs = recordFeedback(prefs, job({ id: `job-${i}`, company: `Company ${i}` }), 'wrong');
  }
  const adjustment = adjustmentFor(job({ id: 'new', company: 'Fresh Co' }), buildModel(prefs), LABELS);
  assert.ok(Math.abs(adjustment.points) <= MAX_ADJUSTMENT, `capped at ±${MAX_ADJUSTMENT}`);
});

test('"too technical" only touches postings that are actually technical', () => {
  const technical = job({ id: 'b', company: 'Other Co', signals: { ...job().signals, automation: 3 } });
  const plain = job({ id: 'c', company: 'Other Co' });

  const prefs = recordFeedback(emptyPreferences(), job({ id: 'a' }), 'down', 'technical');
  const model = buildModel(prefs);

  const technicalPoints = adjustmentFor(technical, model, LABELS).points;
  const plainPoints = adjustmentFor(plain, model, LABELS).points;

  assert.ok(technicalPoints < plainPoints, 'the reason has to distinguish the two');
  assert.match(adjustmentFor(technical, model, LABELS).notes.join(' '), /too technical/i);
});

test('"too much writing" only touches postings that lean on writing', () => {
  const writey = job({ id: 'b', company: 'Other Co', signals: { ...job().signals, creation: 4 } });
  const plain = job({ id: 'c', company: 'Other Co' });
  const model = buildModel(recordFeedback(emptyPreferences(), job({ id: 'a' }), 'down', 'writing'));

  assert.ok(adjustmentFor(writey, model, LABELS).points < adjustmentFor(plain, model, LABELS).points);
});

test('"too senior" and "too junior" read the level off the posting', () => {
  const model = buildModel(recordFeedback(emptyPreferences(), job({ id: 'a' }), 'down', 'senior'));
  const senior = job({ id: 'b', company: 'Other Co', signals: { ...job().signals, seniority: 'senior' } });
  const junior = job({ id: 'c', company: 'Other Co', signals: { ...job().signals, seniority: 'junior' } });

  assert.ok(adjustmentFor(senior, model, LABELS).points < adjustmentFor(junior, model, LABELS).points);
});

test('"wrong industry" blames the industry rather than the whole posting', () => {
  // Four ratings apiece, because the inferred half of the model deliberately
  // whispers until it has seen a few — see CONFIDENCE_RATINGS.
  const rate = (reason) => {
    let prefs = emptyPreferences();
    for (let i = 0; i < 4; i += 1) prefs = recordFeedback(prefs, job({ id: `a${i}` }), 'down', reason);
    return buildModel(prefs);
  };
  const plain = rate(null);
  const industry = rate('industry');

  // Same industry, nothing else in common: the reason must bite harder.
  const sameIndustry = job({
    id: 'b',
    company: 'Other Co',
    family: { id: 'copyediting-proofreading', label: 'Copy editing & proofreading', tier: 'core' },
    employmentTypes: ['full-time'],
    projectBased: false,
    signals: { ...job().signals, work: [] },
  });

  assert.ok(
    adjustmentFor(sameIndustry, industry, LABELS).points < adjustmentFor(sameIndustry, plain, LABELS).points
  );
});

test('"poor pay" learns a floor and applies it to comparable pay', () => {
  const rejected = job({ id: 'a', salary: '$18 – $20 / hour' });
  const model = buildModel(recordFeedback(emptyPreferences(), rejected, 'down', 'pay'));

  const lowPaid = job({ id: 'b', company: 'Other Co', salary: '$36,000 – $40,000' });
  const wellPaid = job({ id: 'c', company: 'Other Co', salary: '$85,000 – $95,000' });
  const silent = job({ id: 'd', company: 'Other Co', salary: null });

  const low = adjustmentFor(lowPaid, model, LABELS);
  assert.ok(low.points < adjustmentFor(wellPaid, model, LABELS).points);
  assert.match(low.notes.join(' '), /stated pay/i);
  assert.equal(
    adjustmentFor(silent, model, LABELS).points,
    adjustmentFor(wellPaid, model, LABELS).points,
    'a posting that does not state pay has not been judged on it'
  );
});

test('pay is annualised so hourly and salaried figures compare', () => {
  assert.equal(annualisePay('$25 / hour'), 52000);
  assert.equal(annualisePay('$20 – $24 per hr'), 49920);
  assert.equal(annualisePay('$70,000 – $85,000'), 85000);
  assert.equal(annualisePay('$1,500 per week'), 78000);
  assert.equal(annualisePay('Competitive'), null);
  assert.equal(annualisePay(null), null);
  assert.equal(annualisePay('$45'), 93600, 'a bare figure that small can only be an hourly rate');
});

test('rating the same posting again replaces the verdict; rating it a third time clears it', () => {
  let prefs = recordFeedback(emptyPreferences(), job(), 'up');
  assert.equal(ratingFor(prefs, 'demo:1').verdict, 'up');

  prefs = recordFeedback(prefs, job(), 'down', 'writing');
  assert.equal(ratingFor(prefs, 'demo:1').verdict, 'down');
  assert.equal(ratingFor(prefs, 'demo:1').reason, 'writing');
  assert.equal(buildModel(prefs).counts.total, 1, 'a change of mind is not two ratings');

  prefs = clearFeedback(prefs, 'demo:1');
  assert.equal(ratingFor(prefs, 'demo:1'), null);
  assert.equal(buildModel(prefs).counts.total, 0);
});

test('a rating survives the posting it was made on', () => {
  // Postings expire in weeks. If the model only knew job ids, every lesson
  // would expire with them.
  const prefs = recordFeedback(emptyPreferences(), job({ id: 'expired' }), 'up');
  const stored = ratingFor(prefs, 'expired');
  assert.ok(stored.features.includes('family:content-editorial-quality'));
  assert.ok(stored.facts, 'and the facts a reason needs to generalise');

  const model = buildModel({ version: 1, ratings: { expired: stored } });
  assert.ok(adjustmentFor(job({ id: 'brand-new', company: 'Someone Else' }), model, LABELS).points > 0);
});

test('storage that has been corrupted or hand-edited does not break the board', () => {
  assert.deepEqual(normalisePreferences(null), emptyPreferences());
  assert.deepEqual(normalisePreferences('nonsense'), emptyPreferences());
  assert.deepEqual(normalisePreferences({ ratings: null }), emptyPreferences());

  const salvaged = normalisePreferences({
    ratings: {
      good: { verdict: 'up', features: ['family:x'], facts: {}, at: '2026-01-01T00:00:00Z' },
      bogus: { verdict: 'sideways' },
      partial: { verdict: 'down' },
    },
  });
  assert.equal(Object.keys(salvaged.ratings).length, 2, 'an unknown verdict is dropped, a thin one is filled in');
  assert.deepEqual(salvaged.ratings.partial.features, []);
});

test('every reason chip either generalises or is explicitly job-specific', () => {
  // "Other" exists so a rating can be given without claiming a pattern; every
  // other chip has to mean something the model can act on.
  const dimensions = DOWN_REASONS.filter((r) => r.dimension).map((r) => r.dimension);
  assert.equal(new Set(dimensions).size, dimensions.length, 'two chips must not fight over one dimension');
  assert.equal(DOWN_REASONS.filter((r) => !r.dimension).map((r) => r.id).join(), 'other');
});

test('ratings on a board that emits no signals are inert rather than wrong', () => {
  // v1 and v2 postings carry no signals; the model must not invent a preference
  // from a company name alone.
  const model = buildModel(recordFeedback(emptyPreferences(), job({ id: 'a' }), 'up'));
  const v1Job = { id: 'v1:1', title: 'Email QA Specialist', company: 'Northline Retail', rank: 70 };
  assert.deepEqual(adjustmentFor(v1Job, model, LABELS), { points: 0, notes: [] });
});

/* ------------------------------------------------------------ asset stamps */

test('the page’s own assets carry a content stamp', async () => {
  /**
   * The board fetches its data with a cache-buster but referenced its own code
   * by bare name, so a browser that had the site open across a deploy ran the
   * old script against the new data. That is exactly how the ratings shipped
   * invisibly: new postings, new scores, no rating buttons.
   *
   * This fails the build when a stamp is stale, which is the only reliable
   * moment to catch it — after the deploy there is no way to reach the browsers
   * that already have the old file.
   */
  const { outdatedStamps } = await import('../scripts/stamp-assets.mjs');
  const stale = await outdatedStamps();
  assert.deepEqual(
    stale,
    [],
    `run "npm run stamp" and commit the result — stale: ${stale.join(', ')}`
  );
});
