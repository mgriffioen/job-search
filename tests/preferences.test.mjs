/**
 * The training model.
 *
 * The board publishes everything that matches a search term, which means it is
 * deliberately wide and some of it is wrong. These tests are about the two ways
 * that can go badly: learning too little to be worth the buttons, and learning
 * so eagerly that three impatient thumbs-down close a category she never
 * actually rejected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ADJUSTMENT,
  adjustmentFor,
  buildModel,
  clearFeedback,
  emptyPreferences,
  featuresOf,
  mayLearn,
  normalisePreferences,
  ratingFor,
  recordFeedback,
  summarise,
} from '../docs/preferences.mjs';

/** A published posting, in the shape jobs.json actually carries. */
function job(overrides = {}) {
  return {
    id: 'test:1',
    title: 'Marketing Copy Editor',
    company: 'Acme Publishing',
    matchedTerm: 'marketing copy editor',
    matchedTerms: ['marketing copy editor', 'copy editor', 'editor'],
    seniority: 'mid',
    employmentTypes: ['full-time'],
    relevance: 100,
    rank: 80,
    ...overrides,
  };
}

/** Rates n distinct postings the same way, so saturation can be exercised. */
function rateMany(prefs, template, verdict, n) {
  let next = prefs;
  for (let i = 0; i < n; i += 1) {
    next = recordFeedback(next, { ...template, id: `test:${verdict}:${i}` }, verdict);
  }
  return next;
}

/* ---------------------------------------------------------------
   What a rating remembers
   --------------------------------------------------------------- */

test('a rating stores categories, not the posting — the posting will be gone', () => {
  const features = featuresOf(job());
  assert.ok(features.includes('term:marketing-copy-editor'));
  assert.ok(features.includes('term:copy-editor'), 'the shorter terms are learned too');
  assert.ok(features.includes('company:acme-publishing'));
  assert.ok(features.includes('shape:full-time'));
  assert.ok(!features.some((f) => f.includes('example.com')), 'nothing that dies with the link');
});

test('every term the title matched is learned, not only the best one', () => {
  // Otherwise a 👍 on "Freelance Proofreader" would teach nothing about
  // "Proofreader", and the lesson would only ever apply to identical titles.
  const features = featuresOf(job({ matchedTerms: ['freelance proofreader', 'proofreader'] }));
  assert.ok(features.includes('term:freelance-proofreader'));
  assert.ok(features.includes('term:proofreader'));
});

test('a middling seniority is not a category', () => {
  assert.ok(!featuresOf(job({ seniority: 'mid' })).some((f) => f.startsWith('seniority:')));
  assert.ok(featuresOf(job({ seniority: 'senior' })).includes('seniority:senior'));
});

test('rating the same posting twice replaces rather than accumulates', () => {
  let prefs = recordFeedback(emptyPreferences(), job(), 'up');
  prefs = recordFeedback(prefs, job(), 'down');
  assert.equal(Object.keys(prefs.ratings).length, 1);
  assert.equal(ratingFor(prefs, 'test:1').verdict, 'down');
});

test('a rating can be taken back', () => {
  const prefs = clearFeedback(recordFeedback(emptyPreferences(), job(), 'up'), 'test:1');
  assert.equal(ratingFor(prefs, 'test:1'), null);
});

test('an unknown verdict is refused rather than stored', () => {
  const prefs = recordFeedback(emptyPreferences(), job(), 'maybe');
  assert.equal(Object.keys(prefs.ratings).length, 0);
});

/* ---------------------------------------------------------------
   What each verdict is allowed to conclude
   --------------------------------------------------------------- */

test('🚫 learns only about the term and the employer', () => {
  assert.equal(mayLearn('wrong', 'term'), true);
  assert.equal(mayLearn('wrong', 'company'), true);
  assert.equal(mayLearn('wrong', 'shape'), false);
  assert.equal(mayLearn('wrong', 'seniority'), false);
});

test('👎 never concludes anything about the shape of the work', () => {
  // Turning down one full-time job is not a preference against full-time work,
  // and a board that decided otherwise would delete a category she asked for.
  assert.equal(mayLearn('down', 'shape'), false);
  assert.equal(mayLearn('down', 'term'), true);
  assert.equal(mayLearn('down', 'seniority'), true);
});

test('👍 learns from everything', () => {
  for (const kind of ['term', 'company', 'shape', 'seniority']) {
    assert.equal(mayLearn('up', kind), true);
  }
});

test('the rules are applied when the model is built, so old ratings are re-read', () => {
  // A rating stored before these rules existed must not keep an older model's
  // conclusions forever.
  const prefs = rateMany(emptyPreferences(), job({ employmentTypes: ['contract'] }), 'wrong', 3);
  const model = buildModel(prefs);
  assert.equal(model.features['shape:contract'], undefined, 'a 🚫 taught a negative weight on contract work');
  assert.ok(model.features['term:marketing-copy-editor'] < 0);
});

/* ---------------------------------------------------------------
   How far it is allowed to move anything
   --------------------------------------------------------------- */

test('with no ratings, nothing moves', () => {
  const { points, notes } = adjustmentFor(job(), buildModel(emptyPreferences()));
  assert.equal(points, 0);
  assert.deepEqual(notes, []);
});

test('one rating whispers rather than shouts', () => {
  const prefs = recordFeedback(emptyPreferences(), job({ id: 'other' }), 'down');
  const { points } = adjustmentFor(job(), buildModel(prefs));
  assert.ok(points < 0);
  assert.ok(Math.abs(points) < MAX_ADJUSTMENT / 2, 'a single 👎 should not be near the cap');
});

test('consistent ratings build up, then saturate', () => {
  const three = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'down', 3)));
  const twelve = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'down', 12)));
  assert.ok(twelve.points <= three.points, 'more ratings should not reverse the direction');
  assert.ok(Math.abs(twelve.points - three.points) < 6, 'twelve ratings should not be four times three');
});

test('nothing may move further than the cap, however hard it is rated', () => {
  const prefs = rateMany(emptyPreferences(), job(), 'wrong', 40);
  const { points } = adjustmentFor(job(), buildModel(prefs));
  assert.ok(points >= -MAX_ADJUSTMENT, `${points} is past the cap`);
});

test('a category she has not rejected is never buried', () => {
  // Twenty 👎 on copy editing must not hide proofreading.
  const prefs = rateMany(emptyPreferences(), job(), 'down', 20);
  const unrelated = job({
    id: 'test:other',
    title: 'Proofreader',
    company: 'Different Co',
    matchedTerm: 'proofreader',
    matchedTerms: ['proofreader'],
  });
  assert.equal(adjustmentFor(unrelated, buildModel(prefs)).points, 0);
});

test('👍 moves a posting up and 👎 moves it down', () => {
  const up = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'up', 3)));
  const down = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'down', 3)));
  assert.ok(up.points > 0);
  assert.ok(down.points < 0);
});

test('a fraction of a point is arithmetic, not a preference, and says nothing', () => {
  const prefs = recordFeedback(emptyPreferences(), job({ id: 'x', matchedTerms: [], matchedTerm: '', company: '' }), 'down');
  const { points, notes } = adjustmentFor(job({ company: 'Unrelated Co', matchedTerms: ['proofreader'] }), buildModel(prefs));
  assert.equal(points, 0);
  assert.deepEqual(notes, []);
});

/* ---------------------------------------------------------------
   Saying why
   --------------------------------------------------------------- */

test('a moved card says which category taught the move', () => {
  const { notes } = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'down', 3)));
  assert.ok(notes.length);
  assert.ok(notes.every((n) => typeof n === 'string' && n.length));
  assert.ok(notes.some((n) => n.includes('passed on')));
});

test('a note never says the same thing twice', () => {
  const { notes } = adjustmentFor(job(), buildModel(rateMany(emptyPreferences(), job(), 'up', 5)));
  assert.equal(new Set(notes).size, notes.length);
  assert.ok(notes.length <= 2, 'a note listing every category explains nothing');
});

test('the summary counts the ratings honestly', () => {
  assert.match(summarise(buildModel(emptyPreferences())), /No ratings yet/);

  let prefs = recordFeedback(emptyPreferences(), job({ id: 'a' }), 'up');
  prefs = recordFeedback(prefs, job({ id: 'b' }), 'down');
  prefs = recordFeedback(prefs, job({ id: 'c' }), 'wrong');
  const text = summarise(buildModel(prefs));
  assert.match(text, /3 ratings/);
  assert.match(text, /1 👍/);
  assert.match(text, /1 👎/);
  assert.match(text, /1 🚫/);
});

/* ---------------------------------------------------------------
   Storage that has been through a real browser
   --------------------------------------------------------------- */

test('rubbish in storage is the same as nothing', () => {
  for (const rubbish of [null, undefined, 'nope', 42, {}, { ratings: null }, { ratings: 'x' }]) {
    assert.deepEqual(normalisePreferences(rubbish), emptyPreferences());
  }
});

test('a half-written rating is discarded rather than trusted', () => {
  const cleaned = normalisePreferences({
    version: 1,
    ratings: {
      good: { verdict: 'up', features: ['term:proofreader'], at: '2026-01-01T00:00:00Z', title: 'P' },
      bad: { verdict: 'sideways' },
      alsoBad: null,
      partial: { verdict: 'down' },
    },
  });
  assert.deepEqual(Object.keys(cleaned.ratings).sort(), ['good', 'partial']);
  assert.deepEqual(cleaned.ratings.partial.features, [], 'a missing feature list becomes an empty one');
  assert.equal(typeof cleaned.ratings.partial.at, 'string');
});

test('normalising is stable, so an export can be re-imported unchanged', () => {
  const prefs = recordFeedback(emptyPreferences(), job(), 'up');
  const round = normalisePreferences(JSON.parse(JSON.stringify(prefs)));
  assert.deepEqual(round, normalisePreferences(round));
  assert.equal(ratingFor(round, 'test:1').verdict, 'up');
});
