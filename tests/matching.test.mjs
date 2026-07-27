import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeForMatch, containsPhrase, toIsoDate, stripHtml, excerpt, slugify } from '../scripts/lib/text.mjs';
import { evaluateLocation, detectWorkType } from '../scripts/lib/location.mjs';
import { scoreJob, matchTier, recencyScore } from '../scripts/lib/score.mjs';
import { normalizeJob, dedupeJobs, dedupeKey } from '../scripts/lib/normalize.mjs';
import { parseRssItems } from '../scripts/lib/xml.mjs';
import { explain as explainJsearch, extractJobs, mapJob as mapJsearchJob, selectQueries } from '../scripts/sources/jsearch.mjs';

const profile = JSON.parse(await readFile(new URL('../config/profile.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-07-27T12:00:00Z');

const job = (overrides = {}) => ({
  title: 'QA Specialist',
  company: 'Example Co',
  location: 'USA',
  locationRestriction: 'USA',
  workType: 'remote',
  description: '',
  tags: [],
  postedAt: '2026-07-26T12:00:00Z',
  ...overrides,
});

/* ------------------------------------------------------------------ text */

test('containsPhrase matches whole words only', () => {
  const text = normalizeForMatch('Senior QA Specialist for email campaigns');
  assert.ok(containsPhrase(text, 'qa specialist'));
  assert.ok(containsPhrase(text, 'email'));
  assert.ok(!containsPhrase(text, 'mail'), 'should not match inside "email"');
  assert.ok(!containsPhrase(text, 'qa specialists'));
});

test('containsPhrase survives punctuation and case', () => {
  const text = normalizeForMatch('Proofreading/copy-editing — brand voice, HTML email.');
  assert.ok(containsPhrase(text, 'proofreading'));
  assert.ok(containsPhrase(text, 'html email'));
  assert.ok(containsPhrase(text, 'brand voice'));
});

test('toIsoDate handles the formats these APIs actually send', () => {
  assert.equal(toIsoDate(1753617600), '2025-07-27T12:00:00.000Z');       // unix seconds
  assert.equal(toIsoDate(1753617600000), '2025-07-27T12:00:00.000Z');    // unix millis
  assert.equal(toIsoDate('2026-07-26 08:30:00'), '2026-07-26T08:30:00.000Z'); // Jobicy
  assert.equal(toIsoDate('2026-07-26T08:30:00'), '2026-07-26T08:30:00.000Z'); // Remotive, no zone
  assert.equal(toIsoDate('Sat, 26 Jul 2026 08:30:00 +0000'), '2026-07-26T08:30:00.000Z'); // RSS
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate('not a date'), null);
});

test('stripHtml removes markup and decodes entities', () => {
  const out = stripHtml('<p>Great &amp; careful <b>QA</b></p><ul><li>Litmus</li></ul><script>bad()</script>');
  assert.ok(out.includes('Great & careful QA'));
  assert.ok(out.includes('Litmus'));
  assert.ok(!out.includes('bad()'));
  assert.ok(!out.includes('<'));
});

test('excerpt truncates on a word boundary', () => {
  const long = 'word '.repeat(200);
  const out = excerpt(long, 50);
  assert.ok(out.length <= 51);
  assert.ok(out.endsWith('…'));
});

test('slugify strips accents', () => {
  assert.equal(slugify('Code à la Mode'), 'code-a-la-mode');
});

/* -------------------------------------------------------------- location */

test('detectWorkType reads hybrid, remote and on-site', () => {
  assert.equal(detectWorkType({ location: 'Hybrid — Chicago, IL', title: '', description: '' }), 'hybrid');
  assert.equal(detectWorkType({ location: 'Remote, USA', title: '', description: '' }), 'remote');
  assert.equal(detectWorkType({ location: 'Chicago, IL', title: '', description: 'This role is on-site.' }), 'onsite');
  assert.equal(detectWorkType({ location: 'Chicago, IL', title: 'Editor', description: '' }), 'unknown');
});

test('remote US-eligible jobs pass the location gate', () => {
  const result = evaluateLocation(job({ location: 'USA', locationRestriction: 'USA' }), profile);
  assert.equal(result.eligible, true);
  assert.equal(result.scope, 'remote-us');
});

test('remote jobs with no restriction pass as worldwide', () => {
  const result = evaluateLocation(job({ location: '', locationRestriction: '' }), profile);
  assert.equal(result.eligible, true);
  assert.equal(result.scope, 'remote-anywhere');
});

test('remote jobs restricted to another region are rejected', () => {
  for (const where of ['Europe', 'UK only', 'India', 'Philippines', 'LATAM']) {
    const result = evaluateLocation(job({ location: where, locationRestriction: where }), profile);
    assert.equal(result.eligible, false, `${where} should be rejected`);
    assert.equal(result.scope, 'non-us');
  }
});

test('remote jobs listing the US alongside other regions are kept', () => {
  const result = evaluateLocation(
    job({ location: 'USA, Canada, Europe', locationRestriction: 'USA, Canada, Europe' }),
    profile
  );
  assert.equal(result.eligible, true);
});

test('on-site and hybrid jobs are rejected, including local ones', () => {
  for (const where of ['Portage, MI', 'Kalamazoo, Michigan', 'Austin, TX']) {
    for (const workType of ['onsite', 'hybrid']) {
      const result = evaluateLocation(job({ workType, location: where }), profile);
      assert.equal(result.eligible, false, `${workType} in ${where} should be rejected`);
      assert.equal(result.scope, 'not-remote');
    }
  }
});

test('postings with no positive sign of being remote are rejected', () => {
  const result = evaluateLocation(job({ workType: 'unknown', location: 'Chicago, IL' }), profile);
  assert.equal(result.eligible, false);
  assert.equal(result.scope, 'not-remote');
});

test('remote roles fenced to states other than Michigan are rejected', () => {
  for (const where of ['Remote — California', 'Remote (New York, New Jersey)', 'Remote - Texas only']) {
    const result = evaluateLocation(job({ location: where, locationRestriction: where }), profile);
    assert.equal(result.eligible, false, `${where} should be rejected`);
    assert.equal(result.scope, 'state-restricted');
  }
});

test('state lists that include Michigan, or that sit inside a nationwide posting, are kept', () => {
  const withMichigan = evaluateLocation(
    job({ location: 'Remote — Michigan, Ohio, Indiana', locationRestriction: 'Remote — Michigan, Ohio, Indiana' }),
    profile
  );
  assert.equal(withMichigan.eligible, true);

  const nationwide = evaluateLocation(
    job({ location: 'Remote (USA) — HQ in California', locationRestriction: 'USA' }),
    profile
  );
  assert.equal(nationwide.eligible, true);
});

test('turning remoteOnly off restores local on-site matching', () => {
  const localProfile = { ...profile, location: { ...profile.location, remoteOnly: false } };

  const local = evaluateLocation(job({ workType: 'onsite', location: 'Portage, MI' }), localProfile);
  assert.equal(local.eligible, true);
  assert.equal(local.scope, 'local');

  const faraway = evaluateLocation(job({ workType: 'onsite', location: 'Austin, TX' }), localProfile);
  assert.equal(faraway.eligible, false);
  assert.equal(faraway.scope, 'out-of-range');
});

/* ---------------------------------------------------------------- scoring */

test('a bullseye role outscores an adjacent one, which outscores an unrelated one', () => {
  const bullseye = scoreJob(
    job({
      title: 'Email QA Specialist',
      description:
        'Proofread HTML email campaigns, test rendering in Litmus, verify brand consistency and links before deployment. Salesforce Marketing Cloud experience a plus.',
    }),
    profile,
    NOW
  );
  const adjacent = scoreJob(
    job({ title: 'Marketing Coordinator', description: 'Support campaign execution and scheduling for the marketing team.' }),
    profile,
    NOW
  );
  const unrelated = scoreJob(
    job({ title: 'Warehouse Associate', description: 'Operate a forklift and pick orders in our distribution center.' }),
    profile,
    NOW
  );

  assert.ok(bullseye.match > adjacent.match, `${bullseye.match} should beat ${adjacent.match}`);
  assert.ok(adjacent.match > unrelated.match, `${adjacent.match} should beat ${unrelated.match}`);
  assert.equal(matchTier(bullseye.match), 'strong');
  assert.ok(unrelated.match < 20);
});

test('test-automation roles are penalised, not promoted', () => {
  const manual = scoreJob(
    job({ title: 'QA Specialist', description: 'Manual testing of marketing emails, writing test cases, proofreading copy.' }),
    profile,
    NOW
  );
  const sdet = scoreJob(
    job({
      title: 'QA Automation Engineer',
      description: 'Build Selenium and Cypress test suites in Java, own the CI/CD pipeline and Jenkins jobs.',
    }),
    profile,
    NOW
  );
  assert.ok(manual.match > sdet.match, `manual ${manual.match} should beat SDET ${sdet.match}`);
  assert.ok(sdet.reasons.some((r) => r.points < 0), 'SDET posting should carry penalties');
});

const TARGET_TITLES = [
  'Marketing QA Specialist',
  'Email QA Analyst',
  'CRM QA Specialist',
  'Lifecycle Marketing QA Analyst',
  'Digital Production QA Coordinator',
  'Campaign QA Specialist',
  'Marketing Operations QA Analyst',
];

// What one of these postings actually reads like.
const REALISTIC_BODY =
  'We are seeking a detail-oriented QA specialist to review email and web campaigns before ' +
  'deployment. You will proofread copy for editorial accuracy, verify links and tracking ' +
  'parameters, test rendering across email clients and browsers, and confirm brand consistency ' +
  'against our style guide. Experience with Litmus, Salesforce Marketing Cloud and Jira preferred.';

test('her target QA roles score as strong matches', () => {
  for (const title of TARGET_TITLES) {
    const result = scoreJob(job({ title, description: REALISTIC_BODY }), profile, NOW);
    assert.equal(matchTier(result.match), 'strong', `"${title}" scored ${result.match}`);
  }
});

test('her target QA roles stay strong even from a snippet-only posting', () => {
  // Jooble and the RSS feeds return a couple of lines, not a full description.
  // A bullseye title must not lose to a verbose posting for a worse job.
  for (const title of TARGET_TITLES) {
    const result = scoreJob(job({ title, description: 'Review campaigns before launch.' }), profile, NOW);
    assert.equal(matchTier(result.match), 'strong', `"${title}" scored only ${result.match} on title alone`);
  }
});

test('the title floor cannot rescue a posting that argues against itself', () => {
  const automation = scoreJob(
    job({
      title: 'Marketing QA Automation Engineer',
      description: 'Build Selenium and Cypress suites in Java, own the Jenkins CI/CD pipeline.',
    }),
    profile,
    NOW
  );
  assert.ok(automation.match < 72, `scored ${automation.match}; penalties must defeat the floor`);
});

test('the title floor does not apply on a description-only match', () => {
  const mentioned = scoreJob(
    job({ title: 'Operations Associate', description: 'You will support our email QA process from time to time.' }),
    profile,
    NOW
  );
  assert.ok(mentioned.match < 72, `scored ${mentioned.match}; a passing mention is not a bullseye title`);
});

test('the same QA roles score just as well when the discipline comes after "QA"', () => {
  // Real postings title these both ways round; contiguous phrase matching
  // only catches one order, which is what titleCombinations exists for.
  const pairs = [
    ['Lifecycle Marketing QA Analyst', 'QA Analyst, Lifecycle Marketing'],
    ['Marketing Operations QA Specialist', 'QA Specialist - Marketing Operations'],
    ['CRM QA Analyst', 'Quality Assurance Analyst, CRM'],
    ['Campaign QA Specialist', 'QA Specialist (Campaign Operations)'],
  ];

  for (const [forward, reversed] of pairs) {
    const a = scoreJob(job({ title: forward, description: REALISTIC_BODY }), profile, NOW);
    const b = scoreJob(job({ title: reversed, description: REALISTIC_BODY }), profile, NOW);
    assert.equal(matchTier(b.match), 'strong', `"${reversed}" scored ${b.match}`);
    assert.ok(
      Math.abs(a.match - b.match) <= 6,
      `word order should not matter: "${forward}" ${a.match} vs "${reversed}" ${b.match}`
    );
  }
});

test('a QA title with no marketing discipline does not get the combination bonus', () => {
  const generic = scoreJob(job({ title: 'QA Analyst, Medical Devices', description: 'ISO 13485 and CAPA experience.' }), profile, NOW);
  const hers = scoreJob(job({ title: 'QA Analyst, Email Marketing' }), profile, NOW);
  assert.ok(hers.match > generic.match, `${hers.match} should beat ${generic.match}`);
});

test('the profile supplies both a specific and a broad query list', () => {
  // Whole-market and tag-filtered sources need broad terms; keyword-search
  // sources reward the specific ones. Regressing either starves a source.
  assert.ok(profile.search.queries.length >= 10);
  assert.ok(profile.search.broadQueries.length >= 5);

  const specific = profile.search.queries.slice(0, 7);
  assert.ok(
    specific.every((q) => /qa/.test(q)),
    'the specific list must lead with her QA niche, since capped sources take from the front'
  );
  assert.ok(
    profile.search.broadQueries.every((q) => q.split(' ').length <= 2),
    'broad terms must stay short enough to match a general index'
  );
});

test('JSearch rotates through the query list across runs at a fixed cost', () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const run = (hoursFromNow) => selectQueries(all, 3, new Date(Date.parse('2026-07-27T00:00:00Z') + hoursFromNow * 3600000));

  const first = run(0);
  assert.equal(first.length, 3, 'per-run cost stays fixed');
  assert.notDeepEqual(run(12), first, 'the window advances between runs');

  // Every query is reached within a few runs rather than the tail never running.
  const seen = new Set();
  for (let i = 0; i < 12; i += 1) run(i * 12).forEach((q) => seen.add(q));
  assert.equal(seen.size, all.length, 'the whole list gets covered');

  assert.deepEqual(selectQueries(all, 99), all, 'a generous budget just runs everything');
  assert.deepEqual(selectQueries([], 3), []);
});

test('video editing roles do not ride in on the word "editor"', () => {
  const copyEditor = scoreJob(
    job({ title: 'Copy Editor, Email & Web', description: 'Proofread marketing email copy, AP style, brand voice.' }),
    profile,
    NOW
  );
  const videoEditor = scoreJob(
    job({
      title: 'Video Editing Specialist',
      description: 'Edit short-form video in Premiere Pro and After Effects for direct-response marketing campaigns.',
    }),
    profile,
    NOW
  );

  assert.ok(
    copyEditor.match > videoEditor.match + 25,
    `copy editor ${copyEditor.match} should clearly beat video editor ${videoEditor.match}`
  );
  assert.ok(videoEditor.match < 30, `video editor scored ${videoEditor.match}, expected well under 30`);
});

test('a good email role survives mentioning video in passing', () => {
  const result = scoreJob(
    job({
      title: 'Email Marketing Specialist',
      description:
        'Own HTML email production in Klaviyo, proofread all copy, test rendering in Litmus. Occasionally source video assets for campaigns.',
    }),
    profile,
    NOW
  );
  assert.ok(result.match >= 50, `scored ${result.match}; an incidental video mention should not sink a real match`);
});

test('roles requiring a language she does not have are pushed down', () => {
  const spanish = scoreJob(
    job({ title: 'Bilingual Copy Editor', description: 'Review Spanish marketing copy for accuracy and tone.' }),
    profile,
    NOW
  );
  const hebrew = scoreJob(
    job({ title: 'Hebrew Freelance Translator & Copy Editor', description: 'Translate and copy edit Hebrew marketing content.' }),
    profile,
    NOW
  );
  assert.ok(spanish.match > hebrew.match, `Spanish ${spanish.match} should beat Hebrew ${hebrew.match}`);
});

test('titles on the hard-exclude list are forced to the bottom', () => {
  const result = scoreJob(
    job({ title: 'Registered Nurse', description: 'Quality assurance of patient charts, attention to detail required.' }),
    profile,
    NOW
  );
  assert.equal(result.excluded, true);
  assert.ok(result.match <= 5);
});

test('scoring explains itself', () => {
  const result = scoreJob(
    job({ title: 'Email Marketing Specialist', description: 'Own HTML email production in Klaviyo. Proofread all copy.' }),
    profile,
    NOW
  );
  assert.ok(result.reasons.length > 2);
  assert.ok(result.reasons.every((r) => r.label && r.detail && typeof r.points === 'number'));
  assert.ok(result.reasons.some((r) => r.kind === 'title'));
});

test('keyword stuffing hits diminishing returns rather than a perfect score', () => {
  const stuffed = scoreJob(
    job({
      title: 'Content Specialist',
      description: profile.skills.flatMap((s) => s.phrases).join(' '),
    }),
    profile,
    NOW
  );
  assert.ok(stuffed.breakdown.skills <= 35, 'skill component is capped');
  assert.ok(stuffed.match < 100);
});

test('recency decays by half every two weeks', () => {
  const fresh = recencyScore(NOW.toISOString(), profile, NOW);
  const twoWeeks = recencyScore(new Date(NOW.getTime() - 14 * 86400000).toISOString(), profile, NOW);
  const fourWeeks = recencyScore(new Date(NOW.getTime() - 28 * 86400000).toISOString(), profile, NOW);

  assert.equal(fresh.score, 100);
  assert.ok(Math.abs(twoWeeks.score - 50) <= 1, `expected ~50, got ${twoWeeks.score}`);
  assert.ok(Math.abs(fourWeeks.score - 25) <= 1, `expected ~25, got ${fourWeeks.score}`);
});

test('a missing date is treated as moderately stale, not as brand new', () => {
  const unknown = recencyScore(null, profile, NOW);
  assert.equal(unknown.assumed, true);
  assert.ok(unknown.score < 50);
});

test('between two equal matches, the newer one ranks higher', () => {
  const shared = { title: 'Email QA Specialist', description: 'Proofread HTML email, Litmus testing.' };
  const newer = scoreJob(job({ ...shared, postedAt: NOW.toISOString() }), profile, NOW);
  const older = scoreJob(
    job({ ...shared, postedAt: new Date(NOW.getTime() - 20 * 86400000).toISOString() }),
    profile,
    NOW
  );
  assert.equal(newer.match, older.match);
  assert.ok(newer.rank > older.rank);
});

/* ------------------------------------------------------------ normalizing */

test('normalizeJob produces a canonical record', () => {
  const result = normalizeJob(
    {
      sourceId: '42',
      title: '  Email QA Specialist ',
      company: 'Example Co',
      url: 'https://example.com/jobs/42',
      description: '<p>Test <b>HTML email</b> before launch.</p>',
      location: 'USA',
      employmentTypes: ['full_time'],
      postedAt: '2026-07-26T08:00:00',
      tags: ['QA', 'QA', ''],
      remoteFlag: true,
    },
    { source: 'demo', sourceLabel: 'Demo' }
  );

  assert.equal(result.title, 'Email QA Specialist');
  assert.equal(result.id, 'demo:42');
  assert.deepEqual(result.employmentTypes, ['full-time']);
  assert.equal(result.workType, 'remote');
  assert.deepEqual(result.tags, ['QA']);
  assert.equal(result.postedAt, '2026-07-26T08:00:00.000Z');
  assert.ok(!result.excerpt.includes('<'));
});

test('normalizeJob rejects records that cannot be acted on', () => {
  const base = { title: 'X', company: 'Y', url: 'https://a.com/1' };
  assert.equal(normalizeJob({ ...base, title: '' }, { source: 's' }), null);
  assert.equal(normalizeJob({ ...base, company: '' }, { source: 's' }), null);
  assert.equal(normalizeJob({ ...base, url: 'javascript:alert(1)' }, { source: 's' }), null);
  assert.equal(normalizeJob({ ...base, url: '' }, { source: 's' }), null);
});

test('part-time is inferred from the text when the source omits it', () => {
  const result = normalizeJob(
    { title: 'Proofreader', company: 'Co', url: 'https://a.com/1', description: 'This is a part-time role, 25 hours per week.' },
    { source: 's', sourceLabel: 'S' }
  );
  assert.ok(result.employmentTypes.includes('part-time'));
});

test('an aggregator records the board a posting actually came from', () => {
  const result = normalizeJob(
    {
      sourceId: 'x1',
      title: 'Email Marketing Specialist',
      company: 'Acme',
      url: 'https://example.com/1',
      publisher: 'LinkedIn',
      remoteFlag: true,
    },
    { source: 'jsearch', sourceLabel: 'Google Jobs' }
  );
  assert.deepEqual(result.sources, ['Google Jobs', 'LinkedIn']);
});

test('a publisher matching the adapter name is not duplicated', () => {
  const result = normalizeJob(
    { sourceId: 'x2', title: 'Proofreader', company: 'Acme', url: 'https://example.com/2', publisher: 'Jooble' },
    { source: 'jooble', sourceLabel: 'Jooble' }
  );
  assert.deepEqual(result.sources, ['Jooble']);
});

test('the same job from an aggregator and a job board collapses into one card', () => {
  const viaLinkedIn = normalizeJob(
    { sourceId: 'a', title: 'Email QA Specialist', company: 'Acme', url: 'https://li.com/a', publisher: 'LinkedIn', description: 'x', remoteFlag: true },
    { source: 'jsearch', sourceLabel: 'Google Jobs' }
  );
  const viaRemotive = normalizeJob(
    { sourceId: 'b', title: 'Email QA Specialist', company: 'Acme', url: 'https://rm.com/b', description: 'x', remoteFlag: true },
    { source: 'remotive', sourceLabel: 'Remotive' }
  );

  const merged = dedupeJobs([viaLinkedIn, viaRemotive], ['jsearch', 'remotive']);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ['Google Jobs', 'LinkedIn', 'Remotive']);
});

test('dedupeKey ignores seniority and posting suffixes', () => {
  assert.equal(
    dedupeKey({ company: 'Acme Inc', title: 'Email QA Specialist (Remote)' }),
    dedupeKey({ company: 'Acme Inc', title: 'Email QA Specialist' })
  );
});

test('duplicates collapse and record every board they appeared on', () => {
  const a = normalizeJob(
    { sourceId: '1', title: 'Email QA Specialist', company: 'Acme', url: 'https://a.com/1', description: 'short', postedAt: '2026-07-20T00:00:00Z' },
    { source: 'remotive', sourceLabel: 'Remotive' }
  );
  const b = normalizeJob(
    { sourceId: '2', title: 'Email QA Specialist', company: 'Acme', url: 'https://b.com/2', description: 'a much longer description '.repeat(20), postedAt: '2026-07-18T00:00:00Z' },
    { source: 'jobicy', sourceLabel: 'Jobicy' }
  );

  const merged = dedupeJobs([a, b], ['remotive', 'jobicy']);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ['Jobicy', 'Remotive']);
  assert.equal(merged[0].postedAt, '2026-07-18T00:00:00.000Z', 'keeps the earliest known posting date');
});

/* ----------------------------------------------------------- error messages */

test('RapidAPI status codes are explained in terms of what to actually do', () => {
  assert.match(explainJsearch(new Error('HTTP 404 Not Found')), /not subscribed to JSearch|path not in CANDIDATE_PATHS/);
  assert.match(explainJsearch(new Error('HTTP 403 Forbidden')), /rejected the key/);
  assert.match(explainJsearch(new Error('HTTP 429 Too Many Requests')), /quota exhausted/);
  assert.equal(explainJsearch(new Error('socket hang up')), 'socket hang up');
});

test('both JSearch response shapes yield the jobs array', () => {
  assert.equal(extractJobs({ data: [{ job_id: '1' }] }).length, 1, 'v1: data is the array');
  assert.equal(extractJobs({ data: { jobs: [{ job_id: '1' }, { job_id: '2' }] } }).length, 2, 'v5: data.jobs');
  assert.deepEqual(extractJobs({ data: { jobs: [] } }), [], 'empty result set is an empty array, not a fault');
  assert.equal(extractJobs({ data: { cursor: 'abc' } }), null, 'no array anywhere is reportable');
  assert.equal(extractJobs(null), null);
});

test('a reposting site listing itself as the employer is flagged', () => {
  const reposted = normalizeJob(
    { sourceId: '1', title: 'Email Marketing Specialist', company: 'remote click jobs', url: 'https://x.com/1', publisher: 'Remote Click Jobs', remoteFlag: true },
    { source: 'jsearch', sourceLabel: 'Google Jobs' }
  );
  assert.equal(reposted.employerUnknown, true);

  const named = normalizeJob(
    { sourceId: '2', title: 'Email Marketing Specialist', company: 'Sierra Solutions', url: 'https://x.com/2', publisher: 'LinkedIn', remoteFlag: true },
    { source: 'jsearch', sourceLabel: 'Google Jobs' }
  );
  assert.equal(named.employerUnknown, false);

  const noPublisher = normalizeJob(
    { sourceId: '3', title: 'Proofreader', company: 'Acme', url: 'https://x.com/3', remoteFlag: true },
    { source: 'remotive', sourceLabel: 'Remotive' }
  );
  assert.equal(noPublisher.employerUnknown, false);
});

test('JSearch field mapping accepts the prefixed and unprefixed spellings', () => {
  const v1 = mapJsearchJob({
    job_id: 'a',
    job_title: 'Email QA Specialist',
    employer_name: 'Acme',
    job_apply_link: 'https://example.com/a',
    job_publisher: 'LinkedIn',
    job_is_remote: true,
    job_city: 'Chicago',
    job_state: 'IL',
  });
  const v5 = mapJsearchJob({
    id: 'a',
    title: 'Email QA Specialist',
    company_name: 'Acme',
    apply_link: 'https://example.com/a',
    publisher: 'LinkedIn',
    is_remote: true,
    city: 'Chicago',
    state: 'IL',
  });

  for (const [name, m] of [['v1', v1], ['v5', v5]]) {
    assert.equal(m.title, 'Email QA Specialist', name);
    assert.equal(m.company, 'Acme', name);
    assert.equal(m.url, 'https://example.com/a', name);
    assert.equal(m.publisher, 'LinkedIn', name);
    assert.equal(m.location, 'Remote (Chicago, IL)', name);
    assert.equal(m.remoteFlag, true, name);
  }
});

/* --------------------------------------------------------------------- rss */

test('parseRssItems reads a We Work Remotely style feed', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Acme Corp: Email Marketing Specialist]]></title>
      <link>https://weworkremotely.com/remote-jobs/acme-email</link>
      <region>USA Only</region>
      <type>Full-Time</type>
      <pubDate>Sat, 26 Jul 2026 08:30:00 +0000</pubDate>
      <description><![CDATA[<p>Own our <b>HTML email</b> program.</p>]]></description>
      <category>Marketing</category>
    </item>
  </channel></rss>`;

  const [item] = parseRssItems(xml);
  assert.equal(item.title, 'Acme Corp: Email Marketing Specialist');
  assert.equal(item.link, 'https://weworkremotely.com/remote-jobs/acme-email');
  assert.equal(item.region, 'USA Only');
  assert.ok(item.description.includes('HTML email'));
});

/* --------------------------------------------------------- end-to-end-ish */

test('a realistic feed produces a sensible ranked list', () => {
  const raw = [
    { sourceId: '1', title: 'Email QA Specialist', company: 'Bright Retail', url: 'https://x.com/1', location: 'USA', description: 'Proofread and test HTML email in Litmus, verify links and brand consistency.', postedAt: NOW.toISOString(), remoteFlag: true },
    { sourceId: '2', title: 'Senior Software Engineer', company: 'Devshop', url: 'https://x.com/2', location: 'USA', description: 'Kubernetes, Go, microservices.', postedAt: NOW.toISOString(), remoteFlag: true },
    { sourceId: '3', title: 'Proofreader (Part-Time)', company: 'Word House', url: 'https://x.com/3', location: 'USA', description: 'Part-time proofreading of marketing copy, AP style, 20 hours per week.', postedAt: new Date(NOW.getTime() - 5 * 86400000).toISOString(), remoteFlag: true },
    { sourceId: '4', title: 'Marketing Specialist', company: 'Berlin GmbH', url: 'https://x.com/4', location: 'Germany', description: 'Email campaigns.', postedAt: NOW.toISOString(), remoteFlag: true },
    { sourceId: '5', title: 'Email QA Coordinator', company: 'Local Agency', url: 'https://x.com/5', location: 'Kalamazoo, MI', description: 'On-site QA of HTML email campaigns, proofreading and Litmus testing.', postedAt: NOW.toISOString(), remoteFlag: false },
  ].map((r) => normalizeJob(r, { source: 'demo', sourceLabel: 'Demo' }));

  const ranked = raw
    .filter((j) => evaluateLocation(j, profile).eligible)
    .map((j) => ({ job: j, ...scoreJob(j, profile, NOW) }))
    .filter((r) => !r.excluded && r.match >= profile.search.minMatchScore)
    .sort((a, b) => b.rank - a.rank);

  const titles = ranked.map((r) => r.job.title);
  assert.equal(titles[0], 'Email QA Specialist');
  assert.ok(titles.includes('Proofreader (Part-Time)'));
  assert.ok(!titles.includes('Marketing Specialist'), 'Germany-only posting is filtered out');
  assert.ok(!titles.includes('Senior Software Engineer'), 'engineering posting falls below the threshold');
  assert.ok(
    !titles.includes('Email QA Coordinator'),
    'a strong on-site match nearby is still filtered out — remote only'
  );
  assert.ok(ranked.every((r) => r.job.workType === 'remote'));
});
