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
  DOWN_REASONS,
  reasonApplies,
  reasonExplains,
  MAX_ADJUSTMENT,
  annualisePay,
  factsOf,
  setReason,
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
  assert.ok(notes.length <= 3, 'a note listing every category explains nothing');
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

/* ---------------------------------------------------------------
   The "why" behind a 👎

   "Not for me" says a posting was wrong. The reason says which part, and that
   is the whole point: it lets one rating generalise correctly instead of
   quietly marking down the employer and the search term for a fault that
   belonged to neither.
   --------------------------------------------------------------- */

test('every reason generalises through a fact the board actually publishes', () => {
  const facts = factsOf(job({ salary: '$50,000 – $60,000', seniority: 'senior', mode: 'writing' }));
  for (const reason of DOWN_REASONS) {
    if (!reason.dimension) continue;
    const known = ['writing', 'technical', 'industry', 'senior', 'junior', 'pay', 'flexible'];
    assert.ok(known.includes(reason.dimension), `${reason.id} generalises through nothing`);
  }
  assert.equal(facts.mode, 'writing');
  assert.equal(facts.seniority, 'senior');
  assert.equal(facts.pay, 60000);
});

test('a reason is only kept on a 👎', () => {
  const writer = job({ mode: 'writing' });
  const up = recordFeedback(emptyPreferences(), writer, 'up', 'writing');
  assert.equal(ratingFor(up, 'test:1').reason, null);
  const down = recordFeedback(emptyPreferences(), writer, 'down', 'writing');
  assert.equal(ratingFor(down, 'test:1').reason, 'writing');
});

test('an unrecognised reason becomes a plain 👎 rather than a dead dimension', () => {
  const prefs = recordFeedback(emptyPreferences(), job(), 'down', 'astrology');
  assert.equal(ratingFor(prefs, 'test:1').reason, null);
});

test('setting a reason does not disturb the verdict or re-date the rating', () => {
  const senior = job({ seniority: 'senior' });
  const prefs = recordFeedback(emptyPreferences(), senior, 'down');
  const at = ratingFor(prefs, 'test:1').at;
  const withReason = setReason(prefs, senior, 'senior');
  assert.equal(ratingFor(withReason, 'test:1').verdict, 'down');
  assert.equal(ratingFor(withReason, 'test:1').reason, 'senior');
  assert.equal(ratingFor(withReason, 'test:1').at, at);
});

test('a reason can be taken back off without losing the 👎', () => {
  const senior = job({ seniority: 'senior' });
  const prefs = setReason(recordFeedback(emptyPreferences(), senior, 'down', 'senior'), senior, null);
  assert.equal(ratingFor(prefs, 'test:1').verdict, 'down');
  assert.equal(ratingFor(prefs, 'test:1').reason, null);
});

test('a reason cannot be attached to a 👍 after the fact', () => {
  const senior = job({ seniority: 'senior' });
  const prefs = setReason(recordFeedback(emptyPreferences(), senior, 'up'), senior, 'senior');
  assert.equal(ratingFor(prefs, 'test:1').reason ?? null, null);
});

test('SAYING WHY NEVER PUNISHES HARDER THAN SAYING NOTHING', () => {
  // The reason redirects blame; it does not add to it. If naming the fault cost
  // the posting more than staying silent, the chips would be a trap.
  const writer = job({ mode: 'writing' });
  const silent = adjustmentFor(writer, buildModel(rateMany(emptyPreferences(), writer, 'down', 3)));

  let named = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    named = recordFeedback(named, { ...writer, id: `w:${i}` }, 'down', 'writing');
  }
  const explained = adjustmentFor(writer, buildModel(named));

  assert.ok(explained.points <= 0 && silent.points <= 0);
  assert.ok(
    Math.abs(explained.points) <= Math.abs(silent.points) + 6,
    `naming the reason cost ${explained.points} against ${silent.points} for saying nothing`
  );
});

test('"too much writing" moves writing roles and leaves reviewing ones alone', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job({ mode: 'writing' }), id: `w:${i}`, company: `Co ${i}` }, 'down', 'writing');
  }
  const model = buildModel(prefs);

  const anotherWriter = job({ id: 'w:new', title: 'Staff Writer', company: 'Elsewhere', mode: 'writing', matchedTerms: ['staff writer'], matchedTerm: 'staff writer' });
  const reviewer = job({ id: 'r:new', title: 'Proofreader', company: 'Elsewhere', mode: 'reviewing', matchedTerms: ['proofreader'], matchedTerm: 'proofreader' });

  assert.ok(adjustmentFor(anotherWriter, model).points < 0, 'a different writing role was not moved');
  assert.equal(adjustmentFor(reviewer, model).points, 0, 'a reviewing role was punished for writing');
});

test('"too senior" learns the seniority and not the search term', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job({ seniority: 'senior' }), id: `s:${i}`, company: `Co ${i}` }, 'down', 'senior');
  }
  const model = buildModel(prefs);

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const senior = job({ id: 's:new', ...unrelated, seniority: 'senior' });
  const mid = job({ id: 'm:new', ...unrelated, seniority: 'mid' });
  assert.ok(adjustmentFor(senior, model).points < adjustmentFor(mid, model).points);
});

test('a stated reason applies in full the first time, unlike an inference', () => {
  // One 👎 is a data point and whispers. One "too senior" is a statement.
  const senior = job({ seniority: 'senior' });
  const bare = adjustmentFor(senior, buildModel(recordFeedback(emptyPreferences(), job({ id: 'x', seniority: 'senior' }), 'down')));
  const stated = adjustmentFor(senior, buildModel(recordFeedback(emptyPreferences(), job({ id: 'x', seniority: 'senior' }), 'down', 'senior')));
  assert.ok(Math.abs(stated.points) > Math.abs(bare.points));
});

test('"pay too low" sets a floor, and the floor is the best pay turned down', () => {
  let prefs = recordFeedback(emptyPreferences(), job({ id: 'p1', salary: '$40,000' }), 'down', 'pay');
  prefs = recordFeedback(prefs, job({ id: 'p2', salary: '$55,000' }), 'down', 'pay');
  const model = buildModel(prefs);
  assert.equal(model.payFloor, 55000);

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const below = job({ id: 'p3', ...unrelated, salary: '$50,000' });
  const above = job({ id: 'p4', ...unrelated, salary: '$95,000' });
  assert.ok(adjustmentFor(below, model).points < 0);
  assert.equal(adjustmentFor(above, model).points, 0);
});

test('pay is annualised so an hourly rate is comparable with a salary', () => {
  assert.equal(annualisePay('$30/hr'), 62400);
  assert.equal(annualisePay('$1,500 per week'), 78000);
  assert.equal(annualisePay('$8,000 a month'), 96000);
  assert.equal(annualisePay('$75,000 – $82,000'), 82000, 'a range is judged on its top, not its bottom');
  assert.equal(annualisePay('Competitive'), null);
  assert.equal(annualisePay(null), null);
});

test('"not flexible" moves full-time-only roles and not contract ones', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job(), id: `f:${i}`, company: `Co ${i}`, employmentTypes: ['full-time'] }, 'down', 'flexible');
  }
  const model = buildModel(prefs);

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const rigid = job({ id: 'f:new', ...unrelated, employmentTypes: ['full-time'] });
  const flexible = job({ id: 'c:new', ...unrelated, employmentTypes: ['contract'] });
  assert.ok(adjustmentFor(rigid, model).points < 0);
  assert.equal(adjustmentFor(flexible, model).points, 0);
});

test('a stated reason is explained on the card before the inferred categories', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job({ seniority: 'senior' }), id: `s:${i}` }, 'down', 'senior');
  }
  const { notes } = adjustmentFor(job({ seniority: 'senior' }), buildModel(prefs));
  assert.ok(notes.length);
  assert.match(notes[0], /senior/, 'the reason she gave should lead the explanation');
});

test('the cap still holds once reasons are stacked on top of categories', () => {
  let prefs = emptyPreferences();
  const nasty = job({ mode: 'writing', seniority: 'senior', employmentTypes: ['full-time'], salary: '$30,000' });
  for (let i = 0; i < 12; i += 1) {
    prefs = recordFeedback(prefs, { ...nasty, id: `n:${i}` }, 'down', ['writing', 'senior', 'flexible', 'pay'][i % 4]);
  }
  const { points } = adjustmentFor(nasty, buildModel(prefs));
  assert.ok(points >= -MAX_ADJUSTMENT, `${points} is past the cap`);
});

test('old ratings with no reason still work', () => {
  const legacy = normalisePreferences({
    version: 1,
    ratings: { a: { verdict: 'down', features: ['term:proofreader'], at: '2026-01-01T00:00:00Z' } },
  });
  const model = buildModel(legacy);
  assert.equal(model.counts.down, 1);
  assert.equal(model.payFloor, null);
  assert.equal(Object.keys(model.dimensions).length, 0);
});

/* ---------------------------------------------------------------
   The two reasons that read the posting rather than its title
   --------------------------------------------------------------- */

test('the chips are the eight the board offers, in order', () => {
  assert.deepEqual(
    DOWN_REASONS.map((r) => r.label),
    ['Too much writing', 'Too technical', 'Wrong industry', 'Too senior', 'Too junior', 'Poor pay', 'Not flexible', 'Other']
  );
});

test('"too technical" moves technical postings and leaves the rest alone', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job(), id: `t:${i}`, company: `Co ${i}`, technical: true }, 'down', 'technical');
  }
  const model = buildModel(prefs);

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const technical = job({ id: 't:new', ...unrelated, technical: true });
  const plain = job({ id: 'p:new', ...unrelated, technical: false });

  assert.ok(adjustmentFor(technical, model).points < 0);
  assert.equal(adjustmentFor(plain, model).points, 0, 'a non-technical posting was punished for coding');
});

test('"wrong industry" blames the industry named, and only that one', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(
      prefs,
      { ...job(), id: `i:${i}`, company: `Co ${i}`, industries: ['Legal'] },
      'down',
      'industry'
    );
  }
  const model = buildModel(prefs);
  assert.equal(model.blamedIndustries.Legal, 3);

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const legal = job({ id: 'l:new', ...unrelated, industries: ['Legal'] });
  const other = job({ id: 'o:new', ...unrelated, industries: ['Retail & e-commerce'] });
  const none = job({ id: 'n:new', ...unrelated, industries: [] });

  assert.ok(adjustmentFor(legal, model).points < 0);
  assert.equal(adjustmentFor(other, model).points, 0, 'an unrelated industry was punished');
  assert.equal(adjustmentFor(none, model).points, 0, 'a posting with no industry was punished');
});

test('naming the industry beats saying nothing, or the chip would be pointless', () => {
  // Charged directly rather than through the feature score, where the
  // saturation clamp would have swallowed it.
  const build = (reason) => {
    let prefs = emptyPreferences();
    for (let i = 0; i < 3; i += 1) {
      prefs = recordFeedback(prefs, { ...job(), id: `x:${i}`, company: `Co ${i}`, industries: ['Legal'] }, 'down', reason);
    }
    return buildModel(prefs);
  };
  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const probe = job({ id: 'probe', ...unrelated, industries: ['Legal'] });

  const named = adjustmentFor(probe, build('industry')).points;
  const silent = adjustmentFor(probe, build(null)).points;
  assert.ok(named < silent, `naming the industry (${named}) should reach further than silence (${silent})`);
});

test('a card says which industry it was marked down for', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job(), id: `i:${i}`, industries: ['Healthcare & life sciences'] }, 'down', 'industry');
  }
  const { notes } = adjustmentFor(job({ industries: ['Healthcare & life sciences'] }), buildModel(prefs));
  assert.ok(notes.some((n) => /healthcare/i.test(n)), notes.join(' | '));
});

test('a 👎 still learns the industry generally, even with no reason given', () => {
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job(), id: `g:${i}`, company: `Co ${i}`, industries: ['Crypto & gaming'] }, 'down');
  }
  const model = buildModel(prefs);
  assert.ok(model.features['industry:crypto-gaming'] < 0);
});

/* ---------------------------------------------------------------
   A reason is only offered where it can say something

   This is not tidiness. A reason REDIRECTS blame away from the search term and
   the employer and onto the fact it names, so choosing one that names nothing
   teaches LESS than a bare 👎 would have. A chip that quietly weakens the
   lesson is worse than no chip.
   --------------------------------------------------------------- */

test('reasonApplies reports whether a posting can carry the blame', () => {
  assert.equal(reasonApplies('writing', job({ mode: 'writing' })), true);
  assert.equal(reasonApplies('writing', job({ mode: 'reviewing' })), false);

  assert.equal(reasonApplies('technical', job({ technical: true })), true);
  assert.equal(reasonApplies('technical', job({ technical: false })), false);

  assert.equal(reasonApplies('industry', job({ industries: ['Legal'] })), true);
  assert.equal(reasonApplies('industry', job({ industries: [] })), false);

  assert.equal(reasonApplies('senior', job({ seniority: 'senior' })), true);
  assert.equal(reasonApplies('senior', job({ seniority: 'mid' })), false);
  assert.equal(reasonApplies('junior', job({ seniority: 'junior' })), true);

  assert.equal(reasonApplies('pay', job({ salary: '$60,000' })), true);
  assert.equal(reasonApplies('pay', job({ salary: null })), false);

  assert.equal(reasonApplies('flexible', job({ employmentTypes: ['full-time'] })), true);
  assert.equal(reasonApplies('flexible', job({ employmentTypes: ['contract'] })), false);

  // "Other" names nothing on purpose, so it always applies.
  assert.equal(reasonApplies('other', job()), true);
});

test('a reason is recorded on any posting, whatever the board made of it', () => {
  // She read the posting; this code only guessed at it. A reason she cannot
  // give is a reason the board is overruling, and an earlier version did
  // exactly that — leaving most cards offering two of the eight chips.
  const reviewer = job({ mode: 'reviewing' });
  assert.equal(ratingFor(recordFeedback(emptyPreferences(), reviewer, 'down', 'writing'), 'test:1').reason, 'writing');

  const bare = recordFeedback(emptyPreferences(), reviewer, 'down');
  assert.equal(ratingFor(setReason(bare, reviewer, 'writing'), 'test:1').reason, 'writing');
});

test('a reason given on a posting the board read differently still teaches', () => {
  // "Too senior" said on a title this code called mid-level must still move
  // the postings it did call senior. Otherwise correcting the board is a
  // rating thrown away.
  let prefs = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    prefs = recordFeedback(prefs, { ...job({ seniority: 'mid' }), id: `m:${i}`, company: `Co ${i}` }, 'down', 'senior');
  }
  const model = buildModel(prefs);
  assert.equal(model.dimensions.senior, 3, 'the statement was discarded');

  const unrelated = { company: 'Elsewhere', matchedTerm: 'proofreader', matchedTerms: ['proofreader'] };
  const senior = job({ id: 's:new', ...unrelated, seniority: 'senior' });
  const mid = job({ id: 'm:new', ...unrelated, seniority: 'mid' });
  assert.ok(adjustmentFor(senior, model).points < 0, 'senior roles were not moved');
  assert.equal(adjustmentFor(mid, model).points, 0);
});

test('a reason with nothing here to carry it costs exactly what silence costs', () => {
  // The blame redirect only fires where there is a fact to redirect onto. With
  // none on this posting, the features keep their full weight, so the rating is
  // never weaker than a plain 👎 — the failure this guards against.
  const reviewer = job({ mode: 'reviewing' });
  const silent = adjustmentFor(reviewer, buildModel(rateMany(emptyPreferences(), reviewer, 'down', 3)));

  let named = emptyPreferences();
  for (let i = 0; i < 3; i += 1) {
    named = recordFeedback(named, { ...reviewer, id: `r:${i}` }, 'down', 'writing');
  }
  assert.equal(adjustmentFor(reviewer, buildModel(named)).points, silent.points);
});

test('every reason says what it teaches', () => {
  for (const reason of DOWN_REASONS) {
    const what = reasonExplains(reason.id);
    assert.ok(typeof what === 'string' && what.length > 10, `${reason.id} explains nothing`);
  }
});

test('every chip is selectable on every posting', () => {
  // The regression that prompted this: on a real board most cards offered two
  // of the eight, and the row read as though the choices had been lost.
  const bare = { id: 'x', title: 'Proofreader', company: 'Acme', matchedTerm: 'proofreader', matchedTerms: ['proofreader'], employmentTypes: ['contract'], seniority: 'mid', mode: 'reviewing', technical: false, industries: [], relevance: 100, rank: 80 };
  for (const reason of DOWN_REASONS) {
    const prefs = recordFeedback(emptyPreferences(), bare, 'down', reason.id);
    assert.equal(ratingFor(prefs, 'x').reason, reason.id, `${reason.id} was refused`);
  }
});
