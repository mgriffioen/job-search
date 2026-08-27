/**
 * The pipeline, end to end, without the network.
 *
 * There is one matching rule now, so these tests are mostly about proving it
 * really is only one: that nothing is silently dropped for being low-scoring,
 * off-profile, or the wrong kind of work. The board's job is to show what
 * matched; deciding what to do about it belongs to the person reading it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { matchTerms, relevanceOf, recencyOf, seniorityOf, evaluate, looselyContains } from '../scripts/lib/match.mjs';
import { buildBoard, countTerms, countMatchedIn } from '../scripts/fetch-jobs.mjs';
import { normalizeJob, dedupeJobs, dedupeKey, isSameOrganisation, hostOf } from '../scripts/lib/normalize.mjs';
import { evaluateLocation, detectWorkType } from '../scripts/lib/location.mjs';
import { normalizeForMatch, containsPhrase, stripHtml, toIsoDate, excerpt } from '../scripts/lib/text.mjs';
import { selectRotating } from '../scripts/lib/rotate.mjs';

const profile = JSON.parse(await readFile(new URL('../config/profile.json', import.meta.url), 'utf8'));

const NOW = new Date('2026-08-27T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

/** A posting with sensible defaults, so each test only states what it is about. */
function job(overrides = {}) {
  return normalizeJob(
    {
      title: 'Proofreader',
      company: 'Acme Publishing',
      url: 'https://example.com/jobs/1',
      location: 'Remote, USA',
      description: 'Review marketing copy for accuracy.',
      postedAt: daysAgo(2),
      remoteFlag: true,
      ...overrides,
    },
    { source: 'test', sourceLabel: 'Test Board' }
  );
}

/* ---------------------------------------------------------------
   The config itself
   --------------------------------------------------------------- */

test('the search terms are one flat list, with no duplicates', () => {
  assert.ok(Array.isArray(profile.searchTerms));
  assert.ok(profile.searchTerms.length >= 50, 'the list should be wide, not a shortlist');
  assert.equal(new Set(profile.searchTerms).size, profile.searchTerms.length, 'duplicate search terms');
  assert.ok(profile.searchTerms.every((t) => typeof t === 'string' && t === t.toLowerCase()));
});

test('the roles she asked for are all in the list', () => {
  const wanted = [
    'qa specialist', 'quality assurance specialist', 'proofreader', 'copy editor',
    'content editor', 'content reviewer', 'content quality specialist', 'editorial specialist',
    'production editor', 'content auditor', 'freelance proofreader', 'contract editor',
    'marketing qa', 'email qa specialist', 'product content specialist', 'assessment editor',
  ];
  for (const term of wanted) {
    assert.ok(profile.searchTerms.includes(term), `missing search term: ${term}`);
  }
});

test('broad terms are short, because the sources that use them index everything', () => {
  assert.ok(profile.broadTerms.every((t) => t.split(' ').length <= 2), 'a broad term is too specific to match anything');
});

test('there is no scoring model left to tune', () => {
  for (const dead of ['titles', 'skills', 'context', 'penalties', 'excludeTitlePhrases', 'titleCombinations', 'engagement', 'bands', 'axisWeights']) {
    assert.equal(profile[dead], undefined, `${dead} should be gone — the board has one rule`);
  }
  assert.equal(profile.search.minMatchScore, undefined, 'nothing is dropped for scoring too low');
});

/* ---------------------------------------------------------------
   The one matching rule
   --------------------------------------------------------------- */

test('a title carrying a search term matches; one that does not, does not', () => {
  assert.ok(matchTerms('Proofreader', profile.searchTerms).length);
  assert.ok(matchTerms('Senior Copy Editor', profile.searchTerms).length);
  assert.equal(matchTerms('Staff Software Engineer', profile.searchTerms).length, 0);
  assert.equal(matchTerms('Registered Nurse', profile.searchTerms).length, 0);
});

test('the longest matching term wins, because it is the most specific thing true', () => {
  const hits = matchTerms('Marketing Copy Editor', profile.searchTerms);
  assert.equal(hits[0].term, 'marketing copy editor');
  assert.ok(hits.some((h) => h.term === 'copy editor'), 'the shorter terms are kept too');
  assert.ok(hits.some((h) => h.term === 'editor'));
});

test('matching is on whole words, so "editor" does not match "editorial" alone', () => {
  const norm = normalizeForMatch('Editorial Assistant');
  assert.equal(containsPhrase(norm, 'editor'), false);
  assert.ok(containsPhrase(norm, 'editorial assistant'));
});

test('punctuation and casing do not defeat a match', () => {
  for (const title of ['PROOFREADER', 'Proofreader (Remote)', 'Proofreader/Copy-Editor', 'Proofreader — Contract']) {
    assert.ok(matchTerms(title, profile.searchTerms).length, `no match for: ${title}`);
  }
});

test('the number is title coverage, not a verdict on the job', () => {
  const exact = matchTerms('Proofreader', profile.searchTerms);
  assert.equal(relevanceOf('Proofreader', exact[0]), 100);

  const long = 'Senior Copy Editor, Trust and Safety Operations';
  const partial = matchTerms(long, profile.searchTerms);
  assert.ok(relevanceOf(long, partial[0]) < 100);
  assert.ok(relevanceOf(long, partial[0]) >= 40, 'a real match is never scored near zero');
});

test('a longer title scores lower than a shorter one on the same term', () => {
  const short = 'Copy Editor';
  const long = 'Senior Copy Editor, Global Brand Team, EMEA';
  const a = relevanceOf(short, matchTerms(short, profile.searchTerms)[0]);
  const b = relevanceOf(long, matchTerms(long, profile.searchTerms)[0]);
  assert.ok(a > b);
});

test('seniority is read from the title, for the ratings model to learn from', () => {
  assert.equal(seniorityOf('Senior Copy Editor'), 'senior');
  assert.equal(seniorityOf('Lead Content Editor'), 'senior');
  assert.equal(seniorityOf('Junior Proofreader'), 'junior');
  assert.equal(seniorityOf('Editorial Assistant'), 'junior');
  assert.equal(seniorityOf('Copy Editor'), 'mid');
});

test('recency decays and unknown dates are assumed, never dropped', () => {
  const fresh = recencyOf(daysAgo(0), profile.ranking, NOW);
  const old = recencyOf(daysAgo(28), profile.ranking, NOW);
  assert.ok(fresh.score > old.score);
  assert.equal(fresh.assumed, false);

  const unknown = recencyOf(null, profile.ranking, NOW);
  assert.equal(unknown.assumed, true);
  assert.equal(unknown.ageDays, profile.ranking.assumedAgeDaysWhenUnknown);
});

test('evaluate returns null only when no term appears anywhere it may', () => {
  const nothing = job({ title: 'Warehouse Associate', description: 'Lift boxes.', tags: [] });
  assert.equal(evaluate(nothing, profile, NOW), null);
  assert.ok(evaluate(job({ title: 'Proofreader' }), profile, NOW));
});

/* ---------------------------------------------------------------
   Where a term was found, and what that is worth

   Most sources are searched by keyword and return whatever matched their full
   text, so a title-only rule threw away almost everything the search had just
   found — 17 of 1,026 postings on a real run. Reading the tags and the body
   fixes that, and the number says which it was.
   --------------------------------------------------------------- */

test('a title match outranks a tag match, which outranks a description match', () => {
  const inTitle = evaluate(job({ title: 'Content Quality Specialist', tags: [], description: 'x' }), profile, NOW);
  const inTags = evaluate(job({ title: 'Marketing Associate', tags: ['content quality specialist'], description: 'x' }), profile, NOW);
  const inBody = evaluate(job({ title: 'Marketing Associate', tags: [], description: 'You will act as a content quality specialist.' }), profile, NOW);

  assert.equal(inTitle.matchedIn, 'title');
  assert.equal(inTags.matchedIn, 'tags');
  assert.equal(inBody.matchedIn, 'description');
  assert.ok(inTitle.relevance > inTags.relevance);
  assert.ok(inTags.relevance > inBody.relevance);
});

test('a one-word term is decisive in a title and ignored in a paragraph', () => {
  // Any posting on earth can mention an editor; "Editor" as a title is the job.
  const body = job({
    title: 'Chief Financial Officer',
    tags: [],
    description: 'Works with our editor and reviews proofreading from time to time.',
  });
  assert.equal(evaluate(body, profile, NOW), null, 'a one-word term matched in the body');

  const title = job({ title: 'Editor', tags: [], description: 'x' });
  assert.equal(evaluate(title, profile, NOW).matchedIn, 'title');
});

test('a one-word term is allowed in the tags, which are labels rather than prose', () => {
  const tagged = job({ title: 'Marketing Associate', tags: ['proofreader'], description: 'x' });
  assert.equal(evaluate(tagged, profile, NOW).matchedIn, 'tags');
});

test('a multi-word term may match in the body — nothing says it by accident', () => {
  const posting = job({
    title: 'Marketing Associate',
    tags: [],
    description: 'The role is effectively an editorial operations specialist embedded in the brand team.',
  });
  const result = evaluate(posting, profile, NOW);
  assert.equal(result.matchedIn, 'description');
  assert.equal(result.matchedTerm, 'editorial operations specialist');
});

test('only the top of the description is read, not the benefits boilerplate', () => {
  const posting = job({
    title: 'Warehouse Associate',
    tags: [],
    description: `${'Lorem ipsum filler. '.repeat(160)} We also employ a content quality specialist.`,
  });
  assert.equal(evaluate(posting, profile, NOW), null, 'matched a term past the point anyone reads');
});

test('the mix of where things matched is reported', () => {
  const counts = countMatchedIn([
    { matchedIn: 'title' }, { matchedIn: 'title' }, { matchedIn: 'description' },
  ]);
  assert.deepEqual(counts, { title: 2, tags: 0, description: 1 });
});

/* ---------------------------------------------------------------
   What the board publishes — and what it refuses to hide
   --------------------------------------------------------------- */

test('a title match is published however unpromising the rest of the posting is', () => {
  const built = buildBoard(
    [job({ title: 'Copy Editor', description: 'x', company: 'Someone', url: 'https://e.com/2' })],
    profile,
    NOW
  );
  assert.equal(built.jobs.length, 1);
  assert.equal(built.dropped.noTermMatch, 0);
});

test('nothing is dropped for being off-profile, low-scoring or the wrong occupation', () => {
  // Every one of these was suppressed by an earlier version of this board.
  const awkward = [
    job({ title: 'Content Moderator', company: 'Trust Co', url: 'https://e.com/a' }),
    job({ title: 'AI Content Reviewer', company: 'Model Labs', url: 'https://e.com/b' }),
    job({ title: 'Video Editor', company: 'Studio', url: 'https://e.com/c' }),
    job({ title: 'Managing Editor', company: 'Paper', url: 'https://e.com/d' }),
    job({ title: 'Bilingual Copy Editor', company: 'Global', url: 'https://e.com/e' }),
    job({ title: 'Technical Editor', company: 'Docs Inc', url: 'https://e.com/f' }),
  ];
  const built = buildBoard(awkward, profile, NOW);
  assert.equal(built.jobs.length, awkward.length, 'the board suppressed something it should have shown');
  assert.deepEqual(Object.keys(built.dropped).sort(), ['location', 'noTermMatch', 'stale']);
});

test('a posting with no search term anywhere is the only relevance rejection', () => {
  const nurse = job({ title: 'Registered Nurse', url: 'https://e.com/n', tags: [], description: 'Provide patient care on a remote telehealth line.' });
  const built = buildBoard([nurse], profile, NOW);
  assert.equal(built.jobs.length, 0);
  assert.equal(built.dropped.noTermMatch, 1);
});

test('published postings carry the term that found them, for the ratings model', () => {
  const built = buildBoard([job({ title: 'Marketing Copy Editor' })], profile, NOW);
  const [row] = built.jobs;
  assert.equal(row.matchedTerm, 'marketing copy editor');
  assert.ok(row.matchedTerms.includes('copy editor'), 'the shorter terms travel with it');
  assert.equal(typeof row.relevance, 'number');
  assert.equal(typeof row.seniority, 'string');
});

test('the description is dropped from what gets published, to keep the file small', () => {
  const built = buildBoard([job()], profile, NOW);
  assert.equal(built.jobs[0].description, undefined);
  assert.ok(built.jobs[0].excerpt.length, 'but the excerpt survives');
});

test('a stale posting is dropped, and an undated one is not', () => {
  const stale = job({ title: 'Proofreader', postedAt: daysAgo(profile.search.maxAgeDays + 10), url: 'https://e.com/s' });
  assert.equal(buildBoard([stale], profile, NOW).jobs.length, 0);

  const undated = job({ title: 'Proofreader', postedAt: null, url: 'https://e.com/u' });
  assert.equal(buildBoard([undated], profile, NOW).jobs.length, 1, 'an unknown date is not evidence of staleness');
});

test('results are sorted by rank, best first', () => {
  const built = buildBoard(
    [
      job({ title: 'Senior Copy Editor for the Global Brand Team', url: 'https://e.com/1', postedAt: daysAgo(30) }),
      job({ title: 'Proofreader', url: 'https://e.com/2', postedAt: daysAgo(1) }),
    ],
    profile,
    NOW
  );
  assert.equal(built.jobs[0].title, 'Proofreader');
  assert.ok(built.jobs[0].rank >= built.jobs[1].rank);
});

test('the term counts say which terms are actually earning their place', () => {
  const counts = countTerms([
    { matchedTerm: 'proofreader' },
    { matchedTerm: 'proofreader' },
    { matchedTerm: 'copy editor' },
  ]);
  assert.deepEqual(counts, { proofreader: 2, 'copy editor': 1 });
  assert.deepEqual(Object.keys(counts), ['proofreader', 'copy editor'], 'most productive first');
});

/* ---------------------------------------------------------------
   Location — the one filter that is not about relevance
   --------------------------------------------------------------- */

test('remote and US-eligible is kept', () => {
  const result = evaluateLocation(job({ location: 'Remote, USA' }), profile);
  assert.equal(result.eligible, true);
});

test('on-site and hybrid are dropped', () => {
  for (const posting of [
    job({ location: 'Austin, TX', description: 'On-site position.', remoteFlag: false }),
    job({ location: 'Chicago, IL', description: 'Hybrid — three days in office.' }),
  ]) {
    assert.equal(evaluateLocation(posting, profile).eligible, false);
  }
});

test('remote but fenced to other states is dropped; Michigan or nationwide is kept', () => {
  assert.equal(evaluateLocation(job({ location: 'Remote (California, New York)' }), profile).eligible, false);
  assert.equal(evaluateLocation(job({ location: 'Remote — Michigan' }), profile).eligible, true);
  assert.equal(evaluateLocation(job({ location: 'Remote, US nationwide' }), profile).eligible, true);
});

test('remote but restricted to another country is dropped', () => {
  assert.equal(evaluateLocation(job({ location: 'Remote — Europe' }), profile).eligible, false);
  assert.equal(evaluateLocation(job({ location: 'Remote (India)' }), profile).eligible, false);
});

test('work type is read from the posting, not assumed', () => {
  assert.equal(detectWorkType({ location: 'Remote', title: '', description: '' }), 'remote');
  assert.equal(detectWorkType({ location: 'Boston', title: '', description: 'Hybrid role' }), 'hybrid');
  assert.equal(detectWorkType({ location: 'Boston', title: '', description: 'On-site' }), 'onsite');
  assert.equal(detectWorkType({ location: 'Boston', title: '', description: '' }), 'unknown');
});

/* ---------------------------------------------------------------
   Normalizing and de-duplicating
   --------------------------------------------------------------- */

test('a posting with no title, company or usable URL is not a posting', () => {
  const meta = { source: 't', sourceLabel: 'T' };
  assert.equal(normalizeJob({ title: '', company: 'A', url: 'https://e.com' }, meta), null);
  assert.equal(normalizeJob({ title: 'A', company: '', url: 'https://e.com' }, meta), null);
  assert.equal(normalizeJob({ title: 'A', company: 'B', url: 'javascript:alert(1)' }, meta), null);
});

test('the same job on two boards collapses into one, keeping both board names', () => {
  const rows = [
    normalizeJob({ title: 'Copy Editor', company: 'Acme', url: 'https://a.com/1', postedAt: daysAgo(3) }, { source: 'a', sourceLabel: 'A' }),
    normalizeJob({ title: 'Copy Editor', company: 'Acme', url: 'https://b.com/1', postedAt: daysAgo(5) }, { source: 'b', sourceLabel: 'B' }),
  ];
  const deduped = dedupeJobs(rows, ['a', 'b']);
  assert.equal(deduped.length, 1);
  assert.deepEqual(deduped[0].sources.sort(), ['A', 'B']);
});

test('seniority and remote suffixes do not make two records of one job', () => {
  assert.equal(
    dedupeKey({ company: 'Acme', title: 'Copy Editor (Remote)' }),
    dedupeKey({ company: 'Acme', title: 'Copy Editor' })
  );
});

test('a reposting site listing itself as the employer is flagged', () => {
  assert.equal(isSameOrganisation('Lensa', 'Lensa.com'), true);
  assert.equal(isSameOrganisation('Acme Publishing', 'Lensa'), false);
  const row = normalizeJob(
    { title: 'Proofreader', company: 'MySmartPros', url: 'https://e.com/1', publisher: 'vmysmartpros' },
    { source: 't', sourceLabel: 'T' }
  );
  assert.equal(row.employerUnknown, true);
});

test('contract and project wording is recognised as contract work', () => {
  for (const description of ['This is a freelance engagement.', 'Statement of work, per project.', '1099 contractor role.']) {
    const row = job({ description, url: `https://e.com/${description.length}` });
    assert.ok(row.employmentTypes.includes('contract'), `not detected: ${description}`);
  }
});

test('hostOf survives rubbish', () => {
  assert.equal(hostOf('https://www.Example.com/x'), 'example.com');
  assert.equal(hostOf('not a url'), '');
});

/* ---------------------------------------------------------------
   Text helpers
   --------------------------------------------------------------- */

test('markup and entities are stripped before anything else touches the text', () => {
  assert.equal(stripHtml('<p>Hello &amp; welcome</p>').trim(), 'Hello & welcome');
  assert.equal(stripHtml('<script>bad()</script>ok').trim(), 'ok');
});

test('dates in every shape the sources use become one ISO string', () => {
  assert.ok(toIsoDate('2026-05-01').startsWith('2026-05-01'));
  assert.ok(toIsoDate('2026-05-01 12:00:00').startsWith('2026-05-01'));
  assert.ok(toIsoDate(1746100000).startsWith('2025-'));
  assert.equal(toIsoDate('not a date'), null);
  assert.equal(toIsoDate(''), null);
});

test('the excerpt is cut at a sensible boundary', () => {
  const long = `${'word '.repeat(200)}end`;
  assert.ok(excerpt(long).length <= 462);
  assert.equal(excerpt('short'), 'short');
});

/* ---------------------------------------------------------------
   Query rotation — every term gets its turn
   --------------------------------------------------------------- */

test('the rotating window advances and eventually covers the whole list', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  const seen = new Set();
  for (let i = 0; i < 10; i += 1) {
    const at = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 2), i % 2 ? 13 : 1));
    for (const term of selectRotating(all, 2, at)) seen.add(term);
  }
  assert.equal(seen.size, all.length, 'a term never searched is a term wasted');
});

test('a window larger than the list returns the list once', () => {
  assert.deepEqual(selectRotating(['a', 'b'], 5), ['a', 'b']);
  assert.deepEqual(selectRotating([], 5), []);
});

/* ---------------------------------------------------------------
   Cache-busting stamps

   A deploy that ships new code under a URL the browser already has cached
   shows the old page over the new data, which is silent and very confusing.
   The stamps prevent it, and this is what makes a forgotten `npm run stamp`
   fail loudly instead.
   --------------------------------------------------------------- */

test('the asset stamps in docs/ are up to date', async () => {
  const { outdatedStamps } = await import('../scripts/stamp-assets.mjs');
  const stale = await outdatedStamps();
  assert.deepEqual(stale, [], `run \`npm run stamp\` and commit the result`);
});

test('the board records what it threw away, so the term list can be checked', () => {
  const nurse = job({ title: 'Registered Nurse', url: 'https://e.com/n', tags: [], description: 'Patient care.' });
  const built = buildBoard([nurse], profile, NOW);
  assert.equal(built.unmatched.length, 1);
  assert.equal(built.unmatched[0].title, 'Registered Nurse');
  assert.ok(built.unmatched[0].company);
});

/* ---------------------------------------------------------------
   A word slipped into the middle of the title

   Job titles insert a word — Project, Quality, Marketing — as a matter of
   routine, and a strict phrase match calls the result nothing at all. These
   are the real misses that came back in the unmatched sample.
   --------------------------------------------------------------- */

test('a title with one word inserted into the term still matches', () => {
  const result = evaluate(job({ title: 'Digital Content Project Specialist', tags: [], description: 'x' }), profile, NOW);
  assert.ok(result, '"Digital Content Project Specialist" matched nothing');
  assert.equal(result.matchedIn, 'title');
  assert.equal(result.matchedTerm, 'digital content specialist');
});

test('a loose title match scores below an exact one', () => {
  const exact = evaluate(job({ title: 'Digital Content Specialist', tags: [], description: 'x' }), profile, NOW);
  const loose = evaluate(job({ title: 'Digital Content Project Specialist', tags: [], description: 'x' }), profile, NOW);
  assert.ok(exact.relevance > loose.relevance);
});

test('the words must be in order and close together, not merely present', () => {
  const norm = (s) => normalizeForMatch(s);
  assert.ok(looselyContains(norm('Digital Content Project Specialist'), 'digital content specialist'));
  assert.ok(looselyContains(norm('Content Quality Assurance Specialist'), 'content quality specialist'));

  // Out of order, and far apart: not the same role.
  assert.equal(looselyContains(norm('Specialist, Enterprise Content'), 'content specialist'), false);
  assert.equal(
    looselyContains(norm('Content Manager for Partner Programs and Field Enablement Specialist'), 'content specialist'),
    false,
    'a title with the words at opposite ends is not that role'
  );
});

test('a one-word term is never loosened — there is nothing to loosen', () => {
  assert.equal(looselyContains(normalizeForMatch('Video Editor'), 'editor'), false);
});

test('the vocabulary covers the roles the unmatched sample turned up', () => {
  // Every one of these was a real posting the board threw away.
  for (const term of ['content operations', 'curriculum writer', 'freelance writer', 'editorial operations']) {
    assert.ok(profile.searchTerms.includes(term), `missing search term: ${term}`);
  }
  for (const title of ['Sr. Solutions Lead, Content Operations', 'K-5 ELA Curriculum Writer', 'Freelance Writer']) {
    assert.ok(matchTerms(title, profile.searchTerms).length, `still no match for: ${title}`);
  }
});
