import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeForMatch, containsPhrase, toIsoDate, stripHtml, excerpt, slugify } from '../scripts/lib/text.mjs';
import { evaluateLocation, detectWorkType } from '../scripts/lib/location.mjs';
import { scoreJob, matchTier, recencyScore } from '../scripts/lib/score.mjs';
import { normalizeJob, dedupeJobs, dedupeKey, isSameOrganisation, hostOf } from '../scripts/lib/normalize.mjs';
import { parseRssItems } from '../scripts/lib/xml.mjs';
import { explain as explainJsearch, extractJobs, mapJob as mapJsearchJob, selectQueries } from '../scripts/sources/jsearch.mjs';
import { scoreJob as scoreJobV2 } from '../scripts/lib/score-v2.mjs';
import {
  scoreJob as scoreJobV3,
  matchTier as matchTierV3,
  bandFor,
  countConcepts,
  requiredYears,
  freshnessBucket,
} from '../scripts/lib/score-v3.mjs';
import {
  scoreJob as scoreJobV4,
  classifyOccupation,
  checkEligibility,
  readAiPosture,
} from '../scripts/lib/score-v4.mjs';
import { buildV2Profile, buildV3Profile, buildV4Profile } from '../scripts/lib/profiles.mjs';
import { classifyResponse, verifyListings } from '../scripts/lib/verify.mjs';
import { buildBoard } from '../scripts/fetch-jobs.mjs';
import { planRunBudget, readQuotaHeaders, describeQuota } from '../scripts/lib/quota.mjs';

const profile = JSON.parse(await readFile(new URL('../config/profile.json', import.meta.url), 'utf8'));
const v2Overlay = JSON.parse(await readFile(new URL('../config/profile.v2.json', import.meta.url), 'utf8'));
const profileV2 = buildV2Profile(profile, v2Overlay);
const v3Overlay = JSON.parse(await readFile(new URL('../config/profile.v3.json', import.meta.url), 'utf8'));
const profileV3 = buildV3Profile(profile, v3Overlay);
const v4Overlay = JSON.parse(await readFile(new URL('../config/profile.v4.json', import.meta.url), 'utf8'));
const profileV4 = buildV4Profile(profile, v3Overlay, v4Overlay);
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

test('the profile supplies a priority, a specific and a broad query list', () => {
  // Whole-market and tag-filtered sources need broad terms; keyword-search
  // sources reward the specific ones; the metered source can only afford a
  // handful and must spend them on the best. Regressing any of the three
  // starves a source.
  assert.ok(profile.search.queries.length >= 10);
  assert.ok(profile.search.broadQueries.length >= 5);
  assert.ok(profile.search.priorityQueries.length >= 10);

  const all = new Set(profile.search.queries);
  for (const query of profile.search.priorityQueries) {
    assert.ok(all.has(query), `priority term "${query}" must also be in the full list`);
  }

  // The metered source takes from the front of the priority list, so the front
  // of it has to be the work she is actually looking for rather than whatever
  // was added most recently.
  const lead = profile.search.priorityQueries.slice(0, 6).join(' ');
  assert.match(lead, /content quality/);
  assert.match(lead, /editorial quality/);

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

test('the JSearch budget spreads what is left over the runs the period has left', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const plan = (remaining, resetDays) =>
    planRunBudget(
      { limit: 200, remaining, resetAt: new Date(now.getTime() + resetDays * 86400000).toISOString() },
      { maxPerRun: 3, reserve: 12, runsPerDay: 2, now }
    );

  // Early in a period there is room for the full per-run allowance. Checked as
  // an average, because the pacing carries fractions across runs — any single
  // run may be one under while the rate over the period is what matters.
  const fresh = [];
  for (let i = 0; i < 20; i += 1) {
    fresh.push(
      planRunBudget({ limit: 200, remaining: 190, resetAt: '2026-09-17T00:00:00Z' }, {
        maxPerRun: 3,
        reserve: 12,
        runsPerDay: 2,
        now: new Date(now.getTime() + i * 12 * 3600000),
      }).allowed
    );
  }
  const rate = fresh.reduce((a, b) => a + b, 0) / fresh.length;
  assert.ok(rate > 2.5, `a fresh period runs near full rate, got ${rate}/run`);
  assert.ok(Math.max(...fresh) <= 3, 'and never exceeds the configured ceiling');

  // The state that prompted this: 86% spent with nine days still to go. The old
  // fixed 3-per-run would have spent 54 more against 28 left.
  const squeezed = plan(28, 9);
  assert.ok(squeezed.allowed <= 1, 'a nearly-spent quota throttles rather than overrunning');
  assert.match(squeezed.reason, /\d+ spendable/);

  // The reserve is untouchable, so the last requests never become billed ones.
  assert.equal(plan(12, 5).allowed, 0, 'stops at the reserve');
  assert.equal(plan(3, 5).allowed, 0, 'never spends below the reserve');
  assert.match(plan(3, 5).reason, /reserve/);
});

test('the JSearch budget never plans more than the quota can pay for', () => {
  // Property check across a period: whatever the pacing decides, run by run,
  // total spend has to stay inside the quota. This is the guarantee that keeps
  // RapidAPI from billing for overage, so it is checked by simulation rather
  // than by trusting the arithmetic.
  const LIMIT = 200;
  const RESERVE = 12;
  const periodStart = Date.parse('2026-09-01T00:00:00Z');
  const resetAt = new Date(periodStart + 31 * 86400000).toISOString();

  let remaining = LIMIT;
  let spent = 0;

  for (let run = 0; run < 31 * 2; run += 1) {
    const now = new Date(periodStart + run * 12 * 3600000);
    const { allowed } = planRunBudget({ limit: LIMIT, remaining, resetAt }, {
      maxPerRun: 3,
      reserve: RESERVE,
      runsPerDay: 2,
      now,
    });
    spent += allowed;
    remaining -= allowed;
  }

  assert.ok(spent <= LIMIT - RESERVE, `spent ${spent}, which must stay within ${LIMIT - RESERVE}`);
  assert.ok(spent > 100, `spent ${spent} — pacing must not be so timid that the source stops being useful`);
});

test('a quota reading from a finished period is treated as rolled over', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const stale = { limit: 200, remaining: 4, resetAt: '2026-09-01T00:00:00Z' };

  const plan = planRunBudget(stale, { maxPerRun: 3, reserve: 12, runsPerDay: 2, now });
  assert.equal(plan.allowed, 3, 'a new period starts spending again rather than staying throttled forever');
});

test('with no reading yet, the run proceeds and lets the headers set the pace', () => {
  const plan = planRunBudget(null, { maxPerRun: 3, reserve: 12 });
  assert.equal(plan.allowed, 3);
  assert.match(plan.reason, /no quota reading/);
});

test('RapidAPI quota headers are read off a response', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const headers = new Headers({
    'x-ratelimit-requests-limit': '200',
    'x-ratelimit-requests-remaining': '28',
    'x-ratelimit-requests-reset': String(9 * 86400),
  });

  const quota = readQuotaHeaders(headers, now);
  assert.equal(quota.limit, 200);
  assert.equal(quota.remaining, 28);
  assert.equal(quota.resetAt, '2026-08-27T00:00:00.000Z', 'seconds-until-reset becomes an absolute time');
  assert.match(describeQuota(quota), /172\/200 used/);

  assert.equal(readQuotaHeaders(new Headers({})), null, 'an API that reports no meter is not a meter reading zero');
});

test('every hand-added search term is both searched and recognised', () => {
  // Terms added by hand are easy to half-wire: added to the search list but
  // invisible to the scorer, so the postings they find arrive and then score
  // near zero — which looks identical to the term not working at all.
  const searched = new Set(
    [...profile.search.queries, ...profile.search.broadQueries].map((q) => q.toLowerCase())
  );

  const terms = [
    'Content Quality Specialist', 'Content QA Specialist', 'Digital Content QA', 'Content Auditor',
    'E-commerce Content Specialist', 'Product Content Specialist', 'Catalog Specialist', 'Catalog Quality',
    'Content Integrity Specialist', 'Editorial QA', 'Production Editor', 'Web Content Specialist',
    'Digital Production Specialist', 'Campaign Operations Specialist',
    // Editorial and educational-editorial titles. "Assessment Editor" matched
    // nothing at all when it was requested — searching for a title the scorer
    // cannot recognise returns postings that then score near zero, which looks
    // exactly like the search not working.
    'Copy Editor', 'Proofreader', 'Editorial QA Specialist', 'Content Editor',
    'Digital Content QA Specialist', 'Product Content Quality Specialist',
    'Learning Content Editor', 'Assessment Editor',
  ];

  const body =
    'Review content for accuracy and consistency against brand and style guidelines. Verify links, ' +
    'assets and formatting. Work to deadlines across multiple concurrent projects and give clear ' +
    'written feedback to designers.';

  for (const title of terms) {
    assert.ok(searched.has(title.toLowerCase()), `"${title}" must actually be searched for`);
    const result = scoreJob(job({ title, description: body }), profile, NOW);
    assert.ok(
      result.match >= profile.search.minMatchScore,
      `"${title}" must clear the publish threshold, got ${result.match}`
    );
  }
});

test('contract, freelance and project-based work outranks the same role permanent', () => {
  const body =
    'Review web and email content for accuracy against brand and style guidelines, ' +
    'verify links and assets, and report findings.';

  const permanent = scoreJob(job({ title: 'Content QA Specialist', description: body }), profile, NOW);
  const freelance = scoreJob(
    job({
      title: 'Content QA Specialist',
      description: `${body} This is a freelance, project-based engagement with defined deliverables and a statement of work.`,
    }),
    profile,
    NOW
  );

  assert.ok(freelance.match > permanent.match, 'the contract framing is what is being looked for');
  assert.ok(freelance.projectBased, 'and is flagged for the board filter');
  assert.equal(permanent.projectBased, false);
});

test('the engagement bonus does not dock permanent roles', () => {
  // Scoring engagement as a bonus rather than widening the denominator is what
  // keeps a settled match where it was. If this regresses, every permanent
  // posting silently loses a tier for no reason of its own.
  const permanent = scoreJob(
    job({
      title: 'Email QA Specialist',
      description: 'QA HTML email campaigns, check rendering, proofread copy, enforce brand standards. Litmus.',
    }),
    profile,
    NOW
  );
  assert.ok(permanent.match >= 70, `a bullseye permanent role must stay strong, got ${permanent.match}`);
});

test('project-shaped work is recognised as contract however it is worded', () => {
  // These reach the board's contract filter through employment type, so a
  // posting that says "statement of work" but never "contract" still qualifies.
  for (const wording of ['project-based', 'statement of work', '1099', 'per project', 'retainer']) {
    const normalized = normalizeJob(
      {
        title: 'Content Auditor',
        company: 'Example Co',
        url: 'https://example.com/1',
        description: `A ${wording} assignment reviewing site content.`,
        location: 'Remote',
      },
      { source: 'test', sourceLabel: 'Test' }
    );
    assert.ok(
      normalized.employmentTypes.includes('contract'),
      `"${wording}" should register as contract work, got ${JSON.stringify(normalized.employmentTypes)}`
    );
  }
});

test('lead-generation listings do not ride the contract signals to the top', () => {
  // Recruiting mills advertise flexible, no-experience work — exactly what the
  // engagement signals reward. Ten such listings sat on the board at 59 and the
  // bonus lifted one to 72 before this was added.
  const spam = scoreJob(
    job({
      title: 'Remote Email Marketing Specialist – Flexible Hours – Call Now (405) 801-9601',
      description: 'Flexible hours, no experience needed, weekly pay. Start immediately.',
    }),
    profile,
    NOW
  );
  assert.ok(spam.match <= 5, `should be excluded outright, got ${spam.match}`);
});

test('the engagement vocabulary avoids words every posting uses', () => {
  // "engagement", "as needed" and "ad hoc" appear in permanent postings and,
  // in law and marketing, constantly — they pulled an Immigration Attorney and
  // a professorship onto the board.
  const phrases = profile.engagement.flatMap((group) => group.phrases);
  for (const filler of ['engagement', 'as needed', 'ad hoc', 'on demand']) {
    assert.ok(!phrases.includes(filler), `"${filler}" is too generic to signal contract work`);
  }
});

test('v2 inherits everything from v1 except the matching model', () => {
  // The two boards must search identically. If they drifted, a difference
  // between them would say nothing about the models being compared.
  assert.deepEqual(profileV2.search.queries, profile.search.queries, 'same search terms');
  assert.deepEqual(profileV2.search.broadQueries, profile.search.broadQueries);
  assert.deepEqual(profileV2.engagement, profile.engagement, 'same contract targeting');
  assert.deepEqual(profileV2.penalties, profile.penalties, 'same penalties');
  assert.deepEqual(profileV2.excludeTitlePhrases, profile.excludeTitlePhrases, 'same exclusions');
  assert.deepEqual(profileV2.location, profile.location, 'same location gate');

  // …and differs where it is supposed to.
  assert.ok(profileV2.capabilities.length > 0, 'v2 adds the capability model');
  assert.ok(profileV2.roleFamilies.length > 0, 'v2 adds role families');
  assert.equal(profile.capabilities, undefined, 'v1 stays title-driven');
});

test('v2 title edits do not discard search terms added to v1', () => {
  // The overlay expresses title changes as edits, not a replacement list, so a
  // term added to v1 keeps working on v2. A wholesale copy would silently lose
  // every term added after the copy was taken.
  const v1QA = profile.titles.find((g) => g.label === 'QA specialist / analyst');
  const v2QA = profileV2.titles.find((g) => g.label === 'QA specialist / analyst');
  assert.deepEqual(v2QA.phrases, v1QA.phrases);
  assert.ok(!profileV2.titles.some((g) => g.label === 'Localization / bilingual'), 'moved to a role family in v2');
});

test('both models score the same posting, and only v2 flags new directions', () => {
  const posting = job({
    title: 'Instructional Designer',
    description:
      'Build curriculum aligned to learning objectives, develop training materials and job aids, ' +
      'collaborate with stakeholders. Strong writing and attention to detail.',
  });

  const a = scoreJob(posting, profile, NOW);
  const b = scoreJobV2(posting, profileV2, NOW);

  assert.equal(a.discovery, undefined, 'v1 has no concept of a new direction');
  assert.ok(b.discovery, 'v2 recognises the adjacent family');
  assert.ok(b.match > a.match, 'and scores the ability match higher');
});

test('both models treat contract framing identically', () => {
  // Engagement is a shared target, not a model difference. If only one board
  // scored it, a comparison would confound the two changes.
  const body = 'Review web content for accuracy against brand guidelines and report findings.';
  const permanent = job({ title: 'Content QA Specialist', description: body });
  const freelance = job({
    title: 'Content QA Specialist',
    description: `${body} A freelance, project-based engagement with defined deliverables and a statement of work.`,
  });

  for (const [name, scorer, prof] of [['v1', scoreJob, profile], ['v2', scoreJobV2, profileV2]]) {
    const p = scorer(permanent, prof, NOW);
    const f = scorer(freelance, prof, NOW);
    assert.ok(f.match > p.match, `${name}: contract framing must rank higher`);
    assert.ok(f.projectBased && !p.projectBased, `${name}: must flag project work`);
  }
});

test('recruiting-mill listings are kept off both boards', () => {
  // Ten identical listings from one employer reached the top of the board:
  // the engagement bonus rewards their "independent contractor / 1099 /
  // work anytime" wording. Data entry is also the opposite of the stated
  // target — high-judgment, detail-intensive work.
  const mill = job({
    title: 'Remote Data Entry & Email Marketing Specialist NYC, NY',
    description: 'Independent Contractor / 1099. 100% Remote. Flexible — work anytime, day or night. Computer-savvy.',
  });
  for (const [name, scorer, prof] of [['v1', scoreJob, profile], ['v2', scoreJobV2, profileV2]]) {
    assert.ok(scorer(mill, prof, NOW).match <= 5, `${name}: should be excluded, not promoted`);
  }
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

test('language-focused roles are kept off both boards', () => {
  // She is fluent in Spanish and holds a graduate degree in it, but does not
  // want work that is *about* the language. These used to be actively promoted:
  // a "Localization / bilingual" title group worth 34, a Spanish skill in v1,
  // and in v2 a graduate-Spanish capability plus a whole localisation family.
  const languageRoles = [
    'Spanish Linguistic QA Tester (Remote - US Based)',
    'Bilingual Copy Editor',
    'Localization Specialist',
    'Spanish Translator',
    'Translation Project Coordinator',
    'Multilingual Content Reviewer',
  ];

  for (const title of languageRoles) {
    const posting = job({ title, description: 'Review content for accuracy and consistency. Remote.' });
    for (const [name, scorer, prof] of [['v1', scoreJob, profile], ['v2', scoreJobV2, profileV2]]) {
      const result = scorer(posting, prof, NOW);
      assert.ok(result.match <= 5, `${name}: "${title}" should be excluded, got ${result.match}`);
    }
  }
});

test('a job that merely requires Spanish is pushed down, one where it is a bonus is not', () => {
  // The distinction that matters: a role built around the language is not for
  // her, but a role she would want that happens to list Spanish as a nice-to-have
  // should not be punished for a skill she actually has.
  const body = 'QA marketing content for accuracy against brand and style guidelines.';

  const requiresIt = scoreJob(
    job({ title: 'Content QA Specialist', description: `${body} Must be bilingual; fluent in Spanish required.` }),
    profile,
    NOW
  );
  const bonus = scoreJob(
    job({ title: 'Content QA Specialist', description: `${body} Spanish a plus.` }),
    profile,
    NOW
  );

  assert.ok(bonus.match > requiresIt.match, 'a requirement costs, a nice-to-have does not');
  assert.ok(bonus.match >= 50, `a good role mentioning Spanish in passing stays a good role, got ${bonus.match}`);
});

test('no model still rewards the language itself', () => {
  // Removing the promotion matters as much as adding the exclusion: while
  // Spanish earned points, every language-adjacent posting drifted upward.
  const v1Signals = JSON.stringify([profile.skills, profile.titles, profile.context]).toLowerCase();
  assert.ok(!v1Signals.includes('spanish'), 'v1 must not score Spanish as a positive');
  assert.ok(!v1Signals.includes('bilingual'), 'v1 must not score bilingual as a positive');

  const v2Signals = JSON.stringify([profileV2.capabilities, profileV2.roleFamilies]).toLowerCase();
  assert.ok(!v2Signals.includes('spanish'), 'v2 must not score Spanish as a positive');
  assert.ok(!profileV2.roleFamilies.some((f) => f.id === 'localization'), 'v2 must not suggest localisation as a direction');
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

test('a reposting site is recognised even when it mangles its own name', () => {
  // The real case: publisher "MySmartPros" arrived as company "vmysmartpros",
  // and an equality check let it through to the top of the board.
  assert.equal(isSameOrganisation('vmysmartpros', 'MySmartPros'), true);
  assert.equal(isSameOrganisation('remote click jobs', 'Remote Click Jobs'), true);
  assert.equal(isSameOrganisation('Lensa', 'Lensa.com'), true);

  // …without swallowing genuinely different employers.
  assert.equal(isSameOrganisation('Sierra Solutions', 'LinkedIn'), false);
  assert.equal(isSameOrganisation('Ziff Davis', 'Google Jobs'), false);
  assert.equal(isSameOrganisation('Indeed Technologies Ltd', 'Zip'), false, 'short names must not match by substring');
  assert.equal(isSameOrganisation('Acme', ''), false);
});

test('hostOf normalises hosts and survives junk', () => {
  assert.equal(hostOf('https://www.MySmartPros.com/tuition/job/x'), 'mysmartpros.com');
  assert.equal(hostOf('https://jobs.example.co.uk/a'), 'jobs.example.co.uk');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
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

/* ------------------------------------------------------------------ v3 */

/**
 * The v3 postings below are written the way real ones read, because the model
 * is deliberately hard to satisfy with keywords: it wants concepts appearing
 * together, and a two-word fixture cannot demonstrate that.
 */
const CONTENT_QA_BODY =
  'Review and proofread customer-facing content for accuracy and consistency against our brand ' +
  'guidelines and style guide. You will run the final review before publication for email and web ' +
  'campaigns, verify links, imagery and pricing, catch discrepancies and inconsistencies against the ' +
  'live site, and give clear actionable feedback to designers and developers. Attention to detail is ' +
  'essential. 3+ years of editorial or quality assurance experience. Bachelor degree preferred.';

const v3job = (overrides = {}) => ({
  title: 'Content Quality Specialist',
  company: 'Example Retail',
  location: 'USA',
  locationRestriction: 'USA',
  workType: 'remote',
  description: CONTENT_QA_BODY,
  tags: [],
  postedAt: '2026-07-26T12:00:00Z',
  ...overrides,
});

test('v3 inherits the search terms and gates, and replaces only the model', () => {
  // Every board must see the same postings. If the search terms or the location
  // gate drifted between them, a difference between the boards would say
  // nothing about the models being compared.
  assert.deepEqual(profileV3.search.queries, profile.search.queries);
  assert.deepEqual(profileV3.location, profile.location);
  assert.deepEqual(profileV3.penalties, profile.penalties);
  assert.deepEqual(profileV3.excludeTitlePhrases, profile.excludeTitlePhrases);

  // …but it publishes on its own terms.
  assert.notEqual(profileV3.search.minMatchScore, profile.search.minMatchScore);
  assert.ok(profileV3.workSignals.length > 0);
  assert.ok(profileV3.combinations.length > 0);
  assert.ok(profileV3.experience.length > 0);
});

test('v3 reports four axes and weights them 35/30/20/15', () => {
  const result = scoreJobV3(v3job(), profileV3, NOW);
  const { work, experience, qualification, lifestyle } = result.details.scores;

  for (const [axis, value] of Object.entries(result.details.scores)) {
    assert.ok(value >= 0 && value <= 100, `${axis} must be a percentage, got ${value}`);
  }

  // The overall is the weighted blend, plus a small industry nudge and any
  // shared penalties — so it can sit above the blend but never far from it.
  const blend = work * 0.35 + experience * 0.3 + qualification * 0.2 + lifestyle * 0.15;
  assert.ok(
    Math.abs(result.match - blend) <= 5,
    `overall ${result.match} should track the weighted blend ${blend.toFixed(1)}`
  );
});

test('a posting that describes her actual work lands in the apply bands', () => {
  const result = scoreJobV3(v3job(), profileV3, NOW);
  assert.ok(result.match >= 88, `expected a priority application, got ${result.match}`);
  assert.ok(
    ['APPLY', 'APPLY ASAP'].includes(result.details.recommendation),
    `expected an apply recommendation, got ${result.details.recommendation}`
  );
  assert.ok(result.details.evidence.length >= 3, 'and arrives with evidence to apply with');
  assert.match(result.details.whyMatched, /content & editorial quality/i);
});

test('the same work, offered as remote freelance, outranks it permanent', () => {
  const permanent = scoreJobV3(v3job(), profileV3, NOW);
  const freelance = scoreJobV3(
    v3job({
      description: `${CONTENT_QA_BODY} This is a freelance, project-based engagement with defined deliverables and flexible hours.`,
    }),
    profileV3,
    NOW
  );
  assert.ok(freelance.details.scores.lifestyle > permanent.details.scores.lifestyle);
  assert.ok(freelance.match > permanent.match);
  assert.ok(freelance.projectBased);
});

test('concepts are counted once however many synonyms a posting uses', () => {
  // Without this, a list of near-synonyms would outweigh a posting that
  // genuinely describes several different things.
  const text = normalizeForMatch('We review, reviewing and reviews all day, and proofread and proofreading too.');
  assert.equal(countConcepts(['review', 'reviewing', 'reviews'], text).size, 1);
  assert.equal(countConcepts(['review', 'proofread', 'proofreading'], text).size, 2);
});

test('a copywriting job is pushed down even when it mentions proofreading', () => {
  // The spec's central question: is she creating the content or reviewing
  // content created by others? Mentioning writing is not disqualifying — being
  // mostly writing is.
  const copywriting = scoreJobV3(
    v3job({
      title: 'Marketing Copywriter',
      description:
        'Write original copy for campaigns, blog posts and social media content. Content creation from ' +
        'scratch, ideation and creative concepting with the brand team. SEO writing and thought ' +
        'leadership. You will proofread your own work before it ships.',
    }),
    profileV3,
    NOW
  );

  assert.ok(copywriting.match < 70, `a copywriting role must not reach the apply bands, got ${copywriting.match}`);
  assert.ok(
    copywriting.details.watchOuts.some((w) => /writing job|copywriting/i.test(w)),
    'and must say why'
  );
  assert.equal(copywriting.details.recommendation, 'SKIP');
});

test('an editing role is not penalised merely for involving some writing', () => {
  const withWriting = scoreJobV3(
    v3job({
      description: `${CONTENT_QA_BODY} You will occasionally rewrite a headline or suggest alternative copy.`,
    }),
    profileV3,
    NOW
  );
  assert.ok(withWriting.match >= 88, `reviewing still dominates here, got ${withWriting.match}`);
  assert.equal(withWriting.details.scores.work >= 80, true);
});

test('automation engineering is penalised while technical literacy is not', () => {
  const automation = scoreJobV3(
    v3job({
      title: 'QA Analyst',
      description:
        'Build and maintain automated test frameworks in Selenium and Playwright, write Python and ' +
        'Java, own the CI/CD pipeline in Jenkins, and develop API automation and unit tests.',
    }),
    profileV3,
    NOW
  );
  assert.ok(automation.match < 70, `an automation role must not reach the apply bands, got ${automation.match}`);

  const literacy = scoreJobV3(
    v3job({
      description: `${CONTENT_QA_BODY} Comfort reading HTML and CSS in our CMS is a plus.`,
    }),
    profileV3,
    NOW
  );
  assert.ok(literacy.match >= 88, `reading HTML is her daily work, not a penalty — got ${literacy.match}`);
});

test('a learnable tool costs a little and is reported as learnable', () => {
  // The spec is explicit: "AP Style required" must not destroy an otherwise
  // excellent match.
  const plain = scoreJobV3(v3job(), profileV3, NOW);
  const withApStyle = scoreJobV3(
    v3job({ description: `${CONTENT_QA_BODY} AP style required. Salsify experience preferred.` }),
    profileV3,
    NOW
  );

  assert.ok(plain.match - withApStyle.match <= 3, 'a learnable tool costs a couple of points, not a tier');
  assert.ok(withApStyle.match >= 88, `still a priority application, got ${withApStyle.match}`);
  const learnable = withApStyle.details.gaps.learnable.map((g) => g.label).join(', ');
  assert.match(learnable, /AP Style/);
  assert.equal(withApStyle.details.gaps.experience.length, 0, 'and is not filed as a true gap');
});

test('work she has never done is a true gap and caps the recommendation', () => {
  const medical = scoreJobV3(
    v3job({
      title: 'Medical Copy Editor',
      description:
        'Copy edit clinical and pharmaceutical manuscripts to AMA style, support regulatory submission ' +
        'documents, and review content for accuracy and consistency against our style guide. Five years ' +
        'of pharmaceutical editing required.',
    }),
    profileV3,
    NOW
  );

  const trueGaps = medical.details.gaps.experience.map((g) => g.label).join(', ');
  assert.match(trueGaps, /Medical, scientific or pharmaceutical/);
  assert.notEqual(medical.details.recommendation, 'APPLY');
  assert.notEqual(medical.details.recommendation, 'APPLY ASAP');
});

test('a bare title on a snippet is floored, but never over a true gap', () => {
  // Jooble and the RSS feeds return two lines, and three of the four axes read
  // the description — so a bullseye title arrives with nothing to score.
  const snippet = scoreJobV3(
    v3job({ title: 'Content Quality Specialist', description: 'Remote content quality role.' }),
    profileV3,
    NOW
  );
  assert.ok(snippet.match >= 70, `a core title on a snippet should still be visible, got ${snippet.match}`);
  assert.equal(snippet.details.scoredFromSnippet, true);
  assert.ok(snippet.details.watchOuts.some((w) => /snippet/i.test(w)), 'and says the score was read off a snippet');

  const wrongJob = scoreJobV3(
    v3job({ title: 'Copy Editor', description: 'Copy editor for clinical and pharmaceutical manuscripts.' }),
    profileV3,
    NOW
  );
  assert.ok(wrongJob.match < 70, `the floor must not rescue work she has never done, got ${wrongJob.match}`);
});

test('v3 bands and recommendations follow the specification', () => {
  assert.equal(bandFor(97, profileV3).recommendation, 'APPLY ASAP');
  assert.equal(bandFor(90, profileV3).recommendation, 'APPLY');
  assert.equal(bandFor(83, profileV3).recommendation, 'APPLY');
  assert.equal(bandFor(72, profileV3).recommendation, 'CONSIDER');
  assert.equal(bandFor(40, profileV3).recommendation, 'SKIP');

  assert.equal(matchTierV3(96, profileV3), 'exceptional');
  assert.equal(matchTierV3(89, profileV3), 'strong');
  assert.equal(matchTierV3(81, profileV3), 'good');
  assert.equal(matchTierV3(71, profileV3), 'possible');
  assert.equal(matchTierV3(50, profileV3), 'low');
});

test('the years asked for are read off the posting', () => {
  assert.equal(requiredYears('3+ years of editorial experience'), 3);
  assert.equal(requiredYears('3-5 years in a similar role'), 5);
  assert.equal(requiredYears('Minimum 12 years of pharmaceutical editing'), 12);
  assert.equal(requiredYears('No experience necessary'), null);
});

test('an unreasonable experience bar costs qualification fit, a reachable one does not', () => {
  const reachable = scoreJobV3(v3job(), profileV3, NOW);
  const unreasonable = scoreJobV3(
    v3job({ description: CONTENT_QA_BODY.replace('3+ years', '15+ years') }),
    profileV3,
    NOW
  );
  assert.ok(unreasonable.details.scores.qualification < reachable.details.scores.qualification);
});

test('freshness buckets follow the spec ladder and only move the sort order', () => {
  assert.equal(freshnessBucket(1, profileV3).rankBonus, 6);
  assert.equal(freshnessBucket(5, profileV3).rankBonus, 3);
  assert.equal(freshnessBucket(12, profileV3).rankBonus, 0);
  assert.ok(freshnessBucket(20, profileV3).rankBonus < 0);
  assert.ok(freshnessBucket(90, profileV3).rankBonus < 0);

  // Two identical postings, different ages: the score is the same, the rank is not.
  const fresh = scoreJobV3(v3job({ postedAt: new Date(NOW.getTime() - 86400000).toISOString() }), profileV3, NOW);
  const older = scoreJobV3(v3job({ postedAt: new Date(NOW.getTime() - 20 * 86400000).toISOString() }), profileV3, NOW);
  assert.equal(fresh.match, older.match, 'age must not change what the bands claim about fit');
  assert.ok(fresh.rank > older.rank);
});

test('postings over a month old are dropped unless they are unusually strong', () => {
  // The spec hides them by default; the board does it by not publishing them,
  // because a stale listing that is only a decent match is a wasted click.
  const old = (title, description) =>
    normalizeJob(
      {
        sourceId: title,
        title,
        company: 'Example Retail',
        url: `https://example.com/${encodeURIComponent(title)}`,
        description,
        location: 'Remote, USA',
        remoteFlag: true,
        postedAt: new Date(NOW.getTime() - 40 * 86400000).toISOString(),
      },
      { source: 'test', sourceLabel: 'Test' }
    );

  const built = buildBoard(
    [
      old('Content Quality Specialist', CONTENT_QA_BODY),
      old('Marketing Coordinator', 'Support the marketing team with scheduling, reporting and campaign execution.'),
    ],
    profileV3,
    scoreJobV3,
    NOW,
    { tier: (m) => matchTierV3(m, profileV3), tierOrder: profileV3.bands.map((b) => b.tier) }
  );

  assert.equal(built.jobs.length, 1, 'only the unusually strong one survives being over a month old');
  assert.equal(built.jobs[0].title, 'Content Quality Specialist');
  assert.ok(built.jobs[0].scores, 'and it carries the four axes into the board file');
  assert.ok(built.jobs[0].recommendation);
});

/* --------------------------------------------------- liveness verification */

test('only a definite answer marks a posting closed', () => {
  // A false positive here silently deletes a real job, which is the failure
  // this whole pass exists to prevent.
  assert.equal(classifyResponse({ status: 404 }).state, 'closed');
  assert.equal(classifyResponse({ status: 410 }).state, 'closed');
  assert.equal(
    classifyResponse({ status: 200, body: `${'x'.repeat(600)} We are no longer accepting applications for this role.` }).state,
    'closed'
  );

  assert.equal(classifyResponse({ status: 403 }).state, 'unverified', 'a bot wall proves nothing');
  assert.equal(classifyResponse({ status: 500 }).state, 'unverified');
  assert.equal(classifyResponse({ error: 'timed out' }).state, 'unverified');
  assert.equal(classifyResponse({ status: 200, body: '' }).state, 'unverified', 'an empty 200 proves nothing either');

  assert.equal(
    classifyResponse({ status: 200, body: `${'x'.repeat(600)} Apply now for this open position.` }).state,
    'open'
  );
});

test('“closed” wording is specific enough not to catch live postings', () => {
  const live = `${'x'.repeat(600)} You will run closed-loop reporting on expired promotions and closed campaigns.`;
  assert.equal(classifyResponse({ status: 200, body: live }).state, 'open');
});

test('verification labels every posting and spends a bounded budget', async () => {
  const pages = {
    'https://example.com/open': { status: 200, body: `${'x'.repeat(600)} Apply today.` },
    'https://example.com/gone': { status: 404, body: '' },
    'https://example.com/walled': { status: 403, body: '' },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = pages[url];
    return { status: page.status, text: async () => page.body };
  };

  const jobs = [
    { id: '1', url: 'https://example.com/open' },
    { id: '2', url: 'https://example.com/gone' },
    { id: '3', url: 'https://example.com/walled' },
    { id: '4', url: 'https://example.com/open' },
  ];

  const { report, closed } = await verifyListings(jobs, { fetchImpl, maxChecks: 3, concurrency: 1 });

  assert.equal(calls.length, 3, 'the budget is a hard cap on requests');
  assert.equal(jobs[0].availability, 'open');
  assert.equal(jobs[1].availability, 'closed');
  assert.equal(jobs[2].availability, 'unverified', 'blocked is not the same as closed');
  assert.equal(jobs[3].availability, 'unverified', 'and what the budget did not reach is not claimed either');
  assert.equal(closed, 1);
  assert.equal(report.checked, 3);
  assert.equal(report.live, 1);
});

test('a verification pass that cannot reach the network still produces a board', async () => {
  const jobs = [{ id: '1', url: 'https://example.com/1' }];
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const { report, closed } = await verifyListings(jobs, { fetchImpl, maxChecks: 5 });

  assert.equal(closed, 0, 'an unreachable network must never delete a posting');
  assert.equal(jobs[0].availability, 'unverified');
  assert.equal(report.unknown, 1);
});

test('every hand-added search term is recognised by the v3 model too', () => {
  // Same trap as the v1 version of this test: a term added to the search list
  // but invisible to the scorer returns postings that then score near zero.
  const terms = [
    'Content Quality Specialist', 'Editorial Quality Specialist', 'Content Reviewer', 'Quality Editor',
    'Marketing Copy Editor', 'Digital Content Editor', 'Web Content Editor', 'Brand Editor',
    'Copy Editor', 'Proofreader', 'Production Editor', 'Editorial Operations Specialist',
    'Product Content Specialist', 'Catalog Quality Specialist', 'E-commerce Content Specialist',
    'Email QA Specialist', 'Campaign Quality Specialist', 'Assessment Editor', 'Curriculum Editor',
  ];
  const searched = new Set(
    [...profile.search.queries, ...profile.search.broadQueries].map((q) => q.toLowerCase())
  );

  for (const title of terms) {
    const result = scoreJobV3(v3job({ title, description: CONTENT_QA_BODY }), profileV3, NOW);
    assert.ok(
      result.family,
      `"${title}" must be recognised as a role family, or the board cannot explain why it appeared`
    );
    assert.ok(
      result.match >= profileV3.search.minMatchScore,
      `"${title}" must clear the publish threshold, got ${result.match}`
    );
    // Not every family title is worth an API call of its own, but the ones that
    // name a whole family should be searched for by name.
    if (!/specialist$/i.test(title)) continue;
    assert.ok(
      [...searched].some((q) => q.includes(title.toLowerCase().split(' ')[0])),
      `nothing in the search list would ever find a "${title}"`
    );
  }
});

/* ------------------------------------------- v3: what must NOT reach the top */

/**
 * These fixtures are written from the postings that actually led the live board
 * on 22 August 2026 — a UX/UI design contract at 85, a Creative Designer at 89,
 * a payroll specialist at 82, a marine sales role at 72.
 *
 * Every one of them was a scoring fault rather than a near miss, and they had
 * two causes worth keeping tests on:
 *
 *   1. Nothing gated the score on work fit. Experience, qualification and
 *      lifestyle are 65% of the weight and all three have high floors — every
 *      posting here is remote, she clears most stated requirements, and she has
 *      done a great deal of adjacent work — so a job she had no wish to do
 *      reached the apply bands purely on her being qualified for it.
 *
 *   2. The combination rules, which the specification weights above any title
 *      match, contained bare words: "review", "quality", "audit", "compare".
 *      That turned "concepts appearing together" into "common words appearing
 *      together", and a payroll posting fired both "Email + content review +
 *      quality assurance" and "Content audit + discrepancies + source of truth".
 */
const FALSE_POSITIVES = [
  ['Creative Designer',
    'We are looking for a Creative Designer to produce beautiful, on-brand work across digital and print. ' +
    'You will design campaign assets, social graphics, landing pages and presentation decks, working from creative ' +
    'briefs and maintaining consistency with our brand guidelines. Partner with marketing stakeholders and developers, ' +
    'present concepts, and iterate on feedback. Strong attention to detail, excellent layout and typography skills, ' +
    'fluency in Figma and Adobe Creative Suite. You will manage multiple projects to tight deadlines and take part in ' +
    'the assessment of new creative tools. 4+ years of design experience and a strong portfolio required.'],
  ['Senior UX/UI Designer: Contractor Job Ad',
    'A full-service creative and design agency hiring a senior UX/UI designer on contract: user research, wireframes, ' +
    'prototypes, design systems and accessible, responsive interfaces. You will collaborate with developers and content ' +
    'strategists, present work to stakeholders, run design reviews, and ensure visual consistency and quality across ' +
    'deliverables. Strong Figma skills, attention to detail, and the ability to manage multiple projects to deadline. ' +
    'WCAG accessibility knowledge required. Remote, contract.'],
  ['Sr. Global Payroll Specialist',
    'Process multi-country payroll accurately and on time. You will verify payroll inputs for accuracy, reconcile ' +
    'discrepancies, maintain documentation and audit trails, support internal and external audits, and ensure compliance ' +
    'with local regulations and company policy. Partner with HR and Finance stakeholders, respond to employee queries by ' +
    'email, and maintain process consistency across regions. High attention to detail and the ability to meet strict ' +
    'deadlines are essential. 5+ years of payroll experience required.'],
  ['Content Marketing Strategist',
    'Own our content marketing strategy end to end. You will develop the editorial calendar, write original blog posts ' +
    'and thought leadership, create content for social media and email campaigns, and drive SEO content production. ' +
    'Brief and manage freelance writers, collaborate with designers on creative assets, and report on campaign ' +
    'performance. Strong storytelling and ideation skills, attention to detail, and experience running content programs ' +
    'at pace. 5+ years in content marketing.'],
  ['Sales Executive - Marine',
    'Sell marine equipment to dealers and distributors across the region. Build the pipeline, run product ' +
    'demonstrations, prepare accurate quotations, and follow up by email and phone. Maintain accurate CRM records, ' +
    'prepare pricing proposals, and work with the marketing team on campaign collateral. Attention to detail, ' +
    'self-motivation and the ability to juggle multiple accounts to deadline.'],
];

const TRUE_POSITIVES = [
  ['Marketing Copy Editor',
    'Copy edit and proofread marketing campaign copy written by our creative team — email, landing pages and product ' +
    'descriptions — against our house style guide and brand voice. You are the last set of eyes before publication: ' +
    'check grammar, punctuation, spelling and formatting, verify product information and pricing against source data, ' +
    'and flag inconsistencies between the campaign and the live website. Partner with designers and developers to get ' +
    'corrections made. Two to four years in an editorial or content review role. Remote, part-time considered.'],
  ['Product Content Editor',
    'Own product content quality across our e-commerce catalog. Review product descriptions and product information for ' +
    'accuracy, verify pricing and offers against source data, audit the catalog for discrepancies, and maintain ' +
    'consistency with brand standards and our editorial style guide. You will proofread new copy before it publishes ' +
    'and work with merchandising and designers on corrections. Salsify experience preferred. 2+ years. Remote.'],
];

test('being qualified for a job is not the same as wanting it', () => {
  // The work-fit gate. Without it these five led the live board.
  for (const [title, description] of FALSE_POSITIVES) {
    const result = scoreJobV3(v3job({ title, description }), profileV3, NOW);
    assert.ok(
      result.match < 70,
      `"${title}" must not reach the adjacent-opportunity band, got ${result.match} ` +
        `(work ${result.details.scores.work}, experience ${result.details.scores.experience})`
    );
    assert.equal(result.details.recommendation, 'SKIP');
  }
});

test('and the work she wants still reaches the apply bands', () => {
  // The other half of the same change: a gate that also caught the true
  // positives would have been a worse model, not a better one.
  for (const [title, description] of [...TRUE_POSITIVES, ['Content Quality Specialist', CONTENT_QA_BODY]]) {
    const result = scoreJobV3(v3job({ title, description }), profileV3, NOW);
    assert.ok(result.match >= 88, `"${title}" should still be a priority application, got ${result.match}`);
    assert.equal(result.details.scores.work >= 80, true, `and its work fit should be high, got ${result.details.scores.work}`);
  }
});

test('the vocabulary every posting shares cannot carry work fit on its own', () => {
  // Layout, deadlines, designers, stakeholders, campaigns and "attention to
  // detail" are in every digital posting written. They are context, not
  // evidence that she would be reviewing anything.
  const supportingOnly = scoreJobV3(
    v3job({
      title: 'Digital Producer',
      description:
        'Work with designers and developers on campaign assets and landing pages. Manage multiple projects against ' +
        'tight deadlines in a fast-paced production workflow, partner with stakeholders, and keep the CMS up to date. ' +
        'Attention to detail and strong layout and formatting sense essential.',
    }),
    profileV3,
    NOW
  );
  assert.ok(
    supportingOnly.details.scores.work <= 45,
    `supporting signals alone must not build a work fit, got ${supportingOnly.details.scores.work}`
  );
});

test('no combination rule may be satisfied by common words alone', () => {
  // The rule that broke the board: a bare "review", "quality", "audit" or
  // "compare" in a combination set turns "concepts appearing together" into
  // "common words appearing together".
  // Process filler, not domain nouns. "retail" and "e-commerce" tell you what
  // kind of work a posting is about; "review", "quality" and "accuracy" are in
  // every job advertisement ever written and tell you nothing.
  const tooCommon = new Set([
    'review', 'reviews', 'quality', 'audit', 'auditing', 'compare', 'accuracy', 'accurate',
    'errors', 'issues', 'gaps', 'documentation', 'against the', 'consistency', 'marketing',
    'editing', 'edits', 'assessment', 'assessments', 'digital', 'web', 'email', 'campaign',
    'campaigns', 'design', 'layout', 'formatting', 'visual', 'testing', 'compliance',
  ]);

  /**
   * The invariant is not "no set may contain a common word" — "proofreading +
   * layout review" is a fine rule, because the proofreading half is specific
   * enough to carry it. It is that no combination may have MORE THAN ONE set
   * satisfiable by filler, because then the whole rule fires on filler.
   *
   * That is exactly what went wrong: "content audit + discrepancies + source of
   * truth" had all three sets satisfiable by "audit", "errors" and
   * "documentation", so a payroll posting fired it.
   */
  for (const combination of profileV3.combinations) {
    const weak = combination.all
      .map((set, index) => ({ index, filler: set.filter((phrase) => tooCommon.has(phrase)) }))
      .filter((set) => set.filler.length > 0);

    assert.ok(
      weak.length <= 1,
      `"${combination.label}" has ${weak.length} sets satisfiable by common words ` +
        `(${weak.map((w) => `set ${w.index + 1}: ${w.filler.map((f) => `"${f}"`).join(', ')}`).join('; ')}) — ` +
        'the whole rule can fire on filler'
    );
  }
});

test('every work signal declares whether it is evidence or context', () => {
  for (const group of profileV3.workSignals) {
    assert.ok(group.id, 'a work signal needs an id — the ranking model learns over them');
    assert.ok(
      ['core', 'supporting'].includes(group.tier),
      `"${group.label}" must be tiered core or supporting, got ${group.tier}`
    );
  }
  assert.ok(profileV3.workSignals.some((g) => g.tier === 'core'));
  assert.ok(profileV3.workSignals.some((g) => g.tier === 'supporting'));
});

test('the work-fit gate can only ever lower a score', () => {
  const { base, slope } = profileV3.workGate;
  assert.ok(base + slope * 100 >= 100, 'a perfect work fit must not be capped below 100');
  assert.ok(slope > 0 && base < 100, 'and the gate has to actually bind at the bottom');
});

test('the board speaks to the person reading it', () => {
  /**
   * She is the one reading her own job board, so every word it renders is
   * addressed to her — "work you have done daily for ten years", not "work she
   * has done". This scans the two places that copy comes from: the strings the
   * scorer composes, and the strings the config supplies to the card.
   *
   * Comments and `_`-prefixed config notes are exempt: those are addressed to
   * whoever maintains this, who is not necessarily her.
   */
  const thirdPerson = /\b(she|her|hers)\b/i;

  const result = scoreJobV3(
    v3job({
      title: 'Medical Copy Editor',
      description:
        `${CONTENT_QA_BODY} Copy edit clinical and pharmaceutical manuscripts to AMA style. ` +
        'A law degree is preferred. Salsify experience a plus. 1 years of experience minimum.',
    }),
    profileV3,
    NOW
  );

  const rendered = [
    result.details.whyMatched,
    ...result.details.evidence.flatMap((e) => [e.label, e.evidence]),
    ...result.details.gaps.learnable.flatMap((g) => [g.label, g.note]),
    ...result.details.gaps.experience.flatMap((g) => [g.label, g.note]),
    ...result.details.watchOuts,
    ...result.reasons.flatMap((r) => [r.label, r.detail]),
    result.family?.why,
  ].filter(Boolean);

  for (const line of rendered) {
    assert.ok(!thirdPerson.test(line), `card copy must address the reader directly: "${line}"`);
  }

  // …and a proofreader's board does not print "1 years".
  assert.ok(
    !rendered.some((line) => /\b1 years\b/.test(line)),
    'a singular year must not be pluralised'
  );

  // The config side: everything the card can show, minus the maintainer notes.
  const visibleStrings = (value, key = '') => {
    if (typeof key === 'string' && key.startsWith('_')) return [];
    if (Array.isArray(value)) return value.flatMap((v) => visibleStrings(v));
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) =>
        ['phrases', 'titles', 'queries', 'all'].includes(k) ? [] : visibleStrings(v, k)
      );
    }
    return typeof value === 'string' ? [value] : [];
  };

  for (const [name, config] of [
    ['profile.json', profile],
    ['profile.v2.json', profileV2],
    ['profile.v3.json', profileV3],
    ['profile.v4.json', profileV4],
  ]) {
    for (const line of visibleStrings(config)) {
      assert.ok(!thirdPerson.test(line), `${name} shows the reader: "${line}"`);
    }
  }
});

/* ------------------------------------------------------------------ v4 */

/**
 * MODEL V4 — occupational fit before transferable-skill fit.
 *
 * The postings below are written from the ones that actually led, or wrongly
 * survived on, the live v3 board: a Commercial/Transactional Lawyer at 73, a
 * Prevention Program Assistant at 78, a Child Psychologist at 68, an AI Systems
 * Engineering Subject Matter Expert at 66 — all of them above a Content
 * Reviewer at 74 and two more at 68.
 *
 * None of those were keyword accidents. Every one of them genuinely asks for
 * review, accuracy, verification, discrepancy detection, proofreading and
 * deadlines, because careful checking against a standard is something every
 * profession does. That is the whole finding: measuring transferable skill
 * measures nothing about whether somebody could hold the job, so v4 asks
 * whether the occupation is plausible FIRST and only then scores the axes.
 */

const v4job = (overrides = {}) => ({
  title: 'Content Quality Specialist',
  company: 'Example Retail',
  location: 'USA',
  locationRestriction: 'USA',
  workType: 'remote',
  description: CONTENT_QA_BODY,
  tags: [],
  postedAt: '2026-07-26T12:00:00Z',
  ...overrides,
});

const v4 = (title, description, extra = {}) =>
  scoreJobV4(v4job({ title, description, ...extra }), profileV4, NOW);

/**
 * The five postings the specification names, written the way they actually
 * read — which is to say, stuffed with her vocabulary. If these fixtures did
 * not contain "review", "accuracy", "discrepancy" and "attention to detail",
 * they would not be testing anything.
 */
const WRONG_OCCUPATIONS = [
  ['legal', 'Commercial/Transactional Lawyer',
    'Draft, review and negotiate commercial agreements for a fast-growing platform. You will review contracts for ' +
    'accuracy and consistency, identify discrepancies between drafts and the executed version, proofread final ' +
    'documents before signature, maintain a clause library with meticulous attention to detail, manage deadlines ' +
    'across concurrent deals and provide legal advice to the business. Excellent written communication and quality ' +
    'control essential. 5+ years of commercial contract negotiation experience.'],
  ['clinical', 'Child Psychologist',
    'Serve as part of a team of clinical and other subject matter experts. You will conduct psychological assessment ' +
    'of children, review case documentation for accuracy and completeness, verify that reports meet our standards ' +
    'before submission, identify discrepancies in records, and provide clear written feedback to providers. Strong ' +
    'attention to detail and the ability to meet reporting deadlines required. Doctoral degree in psychology and ' +
    'clinical licensure required.'],
  ['social-services', 'Senior Child Welfare Specialist',
    'Support a prevention-oriented, compliance-focused culture across a care provider network. You will conduct ' +
    'compliance audits, review provider documentation for accuracy and consistency against policy, proofread ' +
    'monitoring reports before they are issued, track corrections to completion, identify discrepancies across ' +
    'sites, and meet strict reporting deadlines. Child welfare or social services background required.'],
  ['engineering', 'AI Systems Engineering Subject Matter Expert',
    'Help us build an international platform of digital re-skilling products. You will review learner-facing ' +
    'technical content for accuracy, verify code samples against the curriculum, identify discrepancies between ' +
    'lessons and the production system, and give detailed feedback. Deep expertise in system architecture, ' +
    'machine learning models, data pipelines and production code required. Attention to detail essential.'],
  ['social-services', 'Prevention Program Assistant',
    'Support our Prevention of Sexual Abuse project, which conducts compliance audits and technical assistance for ' +
    'the Office of Refugee Resettlement provider community. You will maintain accurate records, review and proofread ' +
    'programme documentation, verify data for accuracy, track corrections, and support monitoring and continuous ' +
    'quality improvement across the care provider network. Excellent attention to detail and deadline management.'],
];

test('v4 places every wrong occupation the specification names', () => {
  for (const [expected, title, description] of WRONG_OCCUPATIONS) {
    const result = v4(title, description);
    assert.equal(
      result.occupationClass,
      'wrong',
      `"${title}" is not an occupation to be in, got ${result.occupationClass} at ${result.match}`
    );
    assert.equal(result.details.occupation.id, expected, `and the profession should be named as ${expected}`);
    assert.equal(result.suppressed, true, 'and it should be suppressed rather than published quietly');
  }
});

test('a wrong occupation can never be a Strong or a Good match', () => {
  // The specification's floor requirement. Even if every other axis were
  // perfect, transferable vocabulary must not buy a place in the apply bands.
  for (const [, title, description] of WRONG_OCCUPATIONS) {
    const result = v4(title, description);
    assert.ok(result.match < 70, `"${title}" reached ${result.match}`);
    assert.ok(!['exceptional', 'strong', 'good'].includes(matchTierV3(result.match, profileV4)));
    assert.equal(result.details.recommendation, 'SKIP');
  }
});

test('the pipeline drops suppressed postings rather than listing them low', () => {
  const board = buildBoard(
    WRONG_OCCUPATIONS.map(([, title, description], index) => ({
      id: `wrong-${index}`,
      title,
      company: 'Somewhere',
      location: 'USA',
      locationRestriction: 'USA',
      workType: 'remote',
      description,
      tags: [],
      employmentTypes: ['full-time'],
      sources: ['test'],
      postedAt: '2026-07-26T12:00:00Z',
      url: 'https://example.com/1',
    })),
    profileV4,
    scoreJobV4,
    NOW,
    { tier: (m) => matchTierV3(m, profileV4), tierOrder: profileV4.bands.map((b) => b.tier) }
  );

  assert.equal(board.jobs.length, 0, 'a board that lists these at 20 is still asking her to read them');
  assert.equal(board.dropped.wrongOccupation, WRONG_OCCUPATIONS.length, 'and the suppression is counted, not silent');
});

test('a content reviewer outranks a lawyer with more transferable overlap', () => {
  // The specification's own test: overlap in a plausible occupation beats
  // greater overlap in an impossible one. The reviewer here is the vague
  // posting the board actually sees — "online content", "our guidelines", no
  // customer in sight — so it is not claimed as a good match. It does not have
  // to be. It only has to beat the lawyer, and no amount of contract-review
  // vocabulary can lift the lawyer past it.
  const reviewer = v4(
    'Content Reviewer - US',
    'Evaluate and review online content for accuracy, quality and adherence to our guidelines. You will compare ' +
      'content against reference material, flag inconsistencies, and provide feedback. Flexible, remote, freelance ' +
      'project work. Strong attention to detail and excellent English essential.'
  );
  const lawyer = v4(WRONG_OCCUPATIONS[0][1], WRONG_OCCUPATIONS[0][2]);

  assert.ok(
    reviewer.match > lawyer.match,
    `the reviewer scored ${reviewer.match} and the lawyer ${lawyer.match}`
  );
  assert.equal(reviewer.suppressed, false, 'and it survives, where the lawyer does not');
  assert.ok(reviewer.rank > lawyer.rank, 'and it must sort above it, not merely score above it');
});

/**
 * "Content Reviewer" — the title the specification singles out, and the reason
 * the AI gate exists.
 *
 * It used to mean somebody checking marketing copy. It increasingly means
 * somebody grading what a language model produced, advertised in her exact
 * vocabulary: review, accuracy, guidelines, quality, excellent English,
 * attention to detail. So the board may no longer take the title's word for it
 * — "DO NOT automatically treat as good anymore. First determine what 'content
 * review' actually means."
 *
 * The three postings below share a title and nothing else, and each has its own
 * correct answer.
 */
test('“Content Reviewer” is judged on what is being reviewed, not on the title', () => {
  const marketing = v4(
    'Content Reviewer',
    'Own the final quality check on our retail marketing content. Review email campaigns, landing pages and ' +
      'product descriptions before they go live: proofread copy for grammar, spelling and punctuation, verify ' +
      'pricing, links and imagery against source data, check everything against our brand style guide, log ' +
      'discrepancies and track corrections with designers and developers.'
  );
  assert.equal(marketing.occupationClass, 'adjacent', 'reviewing customer-facing marketing content is her job');
  assert.equal(marketing.suppressed, false);
  assert.ok(marketing.match >= 80, `and it should still be a good match, got ${marketing.match}`);

  const aiRating = v4(
    'Content Reviewer - English US',
    'Join our community of freelance contributors. You will review and rate model responses for accuracy, fluency ' +
      'and adherence to our annotation guidelines, compare two candidate responses and choose the better one, ' +
      'write prompts on assigned topics, and flag factual errors. Excellent written English and attention to ' +
      'detail essential. Flexible remote project work paid per task.'
  );
  assert.equal(aiRating.occupationClass, 'wrong', 'rating model output is not content review');
  assert.equal(aiRating.details.occupation.id, 'ai-training');
  assert.equal(aiRating.suppressed, true);

  // Same title, same freelance framing, same vocabulary. Only the object of the
  // reviewing differs, and that is the whole judgement.
  assert.ok(
    marketing.match - aiRating.match > 40,
    `the two must not land near each other: ${marketing.match} against ${aiRating.match}`
  );

  const vague = v4(
    'Content Reviewer - US',
    'Evaluate and review online content for accuracy, quality and adherence to our guidelines. Strong attention ' +
      'to detail and excellent English essential.'
  );
  assert.equal(vague.occupationClass, 'unclear', 'a posting that has not said what it reviews has not said');
  assert.ok(vague.match < 70, `and it cannot claim the apply bands on a title alone, got ${vague.match}`);
});

test('the occupations she is actually looking for still reach the apply bands', () => {
  // The other half of every gate: one that also caught the true positives would
  // be a worse model, not a better one.
  for (const [title, description] of [...TRUE_POSITIVES, ['Content Quality Specialist', CONTENT_QA_BODY]]) {
    const result = v4(title, description);
    assert.equal(result.occupationClass, 'core', `"${title}" is a core target`);
    assert.ok(result.match >= 88, `"${title}" should still be a priority application, got ${result.match}`);
    assert.equal(result.suppressed, false);
  }
});

test('an unfamiliar title whose work is hers is discovered, not suppressed', () => {
  // The whole reason the board exists: an employer using a different name for
  // work she has done for ten years.
  const result = v4(
    'Digital Content Integrity Coordinator',
    'You will be the final check on everything the brand publishes. Review web and email content before it goes ' +
      'live for accuracy, brand consistency and adherence to our style guide, verify pricing, links and imagery ' +
      'against source-of-truth product data, log discrepancies, track corrections with designers and developers, ' +
      'and audit live landing pages for errors after launch. Two years in a content review, proofreading or ' +
      'digital production role.'
  );

  assert.notEqual(result.occupationClass, 'wrong');
  assert.ok(result.match >= 80, `an unfamiliar title should not cost it the band, got ${result.match}`);
  assert.equal(result.suppressed, false);
});

test('the Surprise Me shelf takes adjacent occupations and not core ones', () => {
  // A core-family title is not a surprise; it is the search working.
  const familiar = v4('Content Quality Specialist', CONTENT_QA_BODY);
  assert.equal(familiar.surprise, false, 'a title she searched for is not a discovery');

  const unfamiliar = v4(
    'Merchandising Accuracy Coordinator',
    'Own the accuracy of everything on our product pages. You will proofread product descriptions and marketing ' +
      'copy before publication, verify pricing, imagery and product information against source data, run a weekly ' +
      'content audit of the catalog for discrepancies, check that everything matches our brand style guide, and ' +
      'work with designers and the e-commerce team to get corrections made ahead of each campaign launch.'
  );
  assert.equal(unfamiliar.occupationClass, 'adjacent', 'the title is not one of the families');
  assert.equal(unfamiliar.surprise, true, 'and its work is unusually well aligned anyway');
  assert.equal(unfamiliar.discovery, true);
});

test('a credential she cannot hold rejects the posting; a learnable tool does not', () => {
  // The specification's sharpest distinction, and the one most matchers get
  // wrong in both directions.
  const credentialed = v4(
    'Editorial Quality Specialist',
    `${CONTENT_QA_BODY} An active bar license is required for this role.`
  );
  assert.equal(credentialed.suppressed, true, 'a bar licence is not something to pick up before applying');
  assert.ok(credentialed.details.occupation.eligibility.length > 0);
  assert.ok(
    credentialed.details.gaps.experience.some((gap) => /bar/i.test(gap.note)),
    'and it is reported beside the true gaps, never among the learnable ones'
  );

  const learnable = v4(
    'Editorial Quality Specialist',
    `${CONTENT_QA_BODY} AP Style required. Salsify and Chicago Manual of Style experience preferred.`
  );
  assert.equal(learnable.suppressed, false, 'AP style is a weekend, not a career');
  assert.ok(learnable.match >= 85, `and it must not sink the score, got ${learnable.match}`);
  assert.ok(learnable.details.gaps.learnable.length > 0, 'it is reported, as a learnable gap');
});

test('a specialist word in a company blurb does not condemn the job', () => {
  // STEP 5. The failure mode being avoided is a board that hides an e-commerce
  // content role at a health brand — the same mistake in the other direction.
  const result = v4(
    'Digital Content Editor',
    'We are a direct-to-consumer health and wellness brand. Our legal and finance teams sit alongside marketing in ' +
      'a flat structure. In this role you will copy edit and proofread web and email content against our brand ' +
      'style guide, run the final review before campaigns deploy, verify product claims, pricing and links against ' +
      'approved source copy, and flag discrepancies between the campaign and the live site.'
  );

  assert.notEqual(result.occupationClass, 'wrong');
  assert.ok(result.match >= 80, `an editorial job at a health brand is an editorial job, got ${result.match}`);
});

test('strategy and content ownership are down-ranked, not called the wrong occupation', () => {
  // The specification's reading of this one: adjacent industry, poor functional
  // fit. It is not somebody else's profession; it is the opposite half of hers.
  const strategist = v4(
    'Senior Integrated Marketing Strategist',
    'Lead integrated campaign strategy across paid, owned and earned channels for a consumer brand. You will own ' +
      'the marketing strategy and the editorial calendar, develop messaging frameworks and brand positioning, brief ' +
      'creative teams, drive demand generation, and report on campaign performance. Review creative for brand ' +
      'consistency and accuracy before launch. 7+ years in integrated marketing.'
  );

  assert.ok(strategist.match < 70, `strategy ownership is not the work, got ${strategist.match}`);
  assert.equal(strategist.details.occupation.contentMode, 'creating');
  assert.ok(
    /originates and owns content/.test(strategist.details.whyMatched),
    'and the card says which half of the work it is, rather than shrugging'
  );
});

test('every surviving posting answers the six questions the specification asks', () => {
  const result = v4(
    'Product Content Editor',
    `${TRUE_POSITIVES[1][1]} Our merchandising team drafts with AI tools before it reaches you.`
  );
  const report = result.details.occupation;

  assert.ok(report.why, '1. why this occupation belongs in the target or adjacent family');
  assert.ok(report.responsibilities.length, '2. which responsibilities match her professional experience');
  assert.ok(Array.isArray(result.details.gaps.learnable), '3. learnable gaps');
  assert.ok(Array.isArray(report.eligibility), '4. eligibility concerns');
  assert.ok(/REVIEWING|CREATING|Mixed/.test(report.contentModeNote), '5. reviewing or creating');
  // 6. and, when AI comes up at all, whether it is the tool or the work.
  assert.ok(report.aiNote, '6. AI is mentioned, so the card must say which kind of AI job this is');
  assert.equal(report.ai, 'tool');

  // And the ban that goes with them: the paragraph must lead with the
  // occupation, not with a list of transferable phrases.
  assert.ok(
    result.details.whyMatched.startsWith(report.why),
    `the explanation must open on the occupation: "${result.details.whyMatched.slice(0, 80)}…"`
  );
});

test('the occupational class is a multiplier, not another small signal', () => {
  // Same description, three occupations. If the class were merely one more
  // weighted signal, the transferable content would dominate it.
  const gate = profileV4.occupationGate;
  assert.ok(gate.multipliers.core > gate.multipliers.adjacent);
  assert.ok(gate.multipliers.adjacent > gate.multipliers.unclear);
  assert.ok(gate.multipliers.unclear > gate.multipliers.wrong);

  // And the caps below the bands they must never reach.
  assert.ok(gate.caps.wrong < 70, 'a wrong occupation cannot be a possible opportunity');
  assert.ok(gate.caps.unclear < 80, 'an unplaceable one cannot be a good match');
  assert.equal(gate.caps.core, 100);
});

test('no wrong-occupation rule fires on a word every posting contains', () => {
  /**
   * The invariant that keeps this from becoming an industry blocklist. A body
   * phrase has to name the profession — "bar admission", "clinical supervision",
   * "general ledger" — and never a word that turns up in ordinary marketing
   * copy, or the gate would start deleting the jobs it exists to find.
   */
  const everywhere = new Set([
    'review', 'reviews', 'quality', 'accuracy', 'audit', 'compliance', 'documentation', 'content',
    'deadlines', 'detail', 'communication', 'stakeholders', 'process', 'reporting', 'standards',
    'health', 'legal', 'financial', 'marketing', 'digital', 'remote', 'team', 'project',
  ]);

  for (const occupation of profileV4.occupationGate.wrongOccupations) {
    for (const phrase of occupation.body || []) {
      assert.ok(
        !everywhere.has(phrase),
        `${occupation.id} would classify on the word "${phrase}", which is in every posting written`
      );
    }
    assert.ok((occupation.bodyThreshold ?? 3) >= 2, `${occupation.id} must need more than one concept`);
    assert.ok(occupation.why, `${occupation.id} must be able to explain itself on the card`);
  }
});

test('a content title containing another profession is classified on its description', () => {
  // "Content Engineer" is a content job with an engineer's word in it, and
  // reading that word as the occupation is how a board loses the roles it
  // exists to find.
  const result = v4(
    'Content Engineer',
    'Own the quality of our published content. You will proofread and copy edit web and email content against our ' +
      'style guide, run the final review before publication, verify links, pricing and imagery, and audit the live ' +
      'site for discrepancies. Comfortable reading HTML. No coding required.'
  );
  assert.equal(result.occupationClass, 'adjacent', `got ${result.occupationClass}`);
  assert.ok(
    result.match >= profileV4.search.minMatchScore,
    `and it must survive the publish threshold, got ${result.match}`
  );
});

/* ------------------------------------------------ v4: AI training and evaluation */

/**
 * STEP 1(D) — the gate the market made necessary.
 *
 * The specification is precise about the line: "AI is a tool used to perform
 * the relevant job → potentially fine. Training/evaluating/improving the AI is
 * the job → not wanted." Both sides of that line advertise for a careful reader
 * of English who works to guidelines and notices errors, so a gate that read
 * skills would put them in the same place. These tests exist to keep it reading
 * the object of the work instead.
 */

const AI_WORK = [
  ['AI Trainer',
    'Use your writing ability to help improve our assistant. You will review responses for accuracy and tone, ' +
    'correct errors, and follow detailed guidelines. Excellent English and attention to detail required. Flexible ' +
    'remote work paid per task.'],
  ['AI Writing Evaluator',
    'Use your editorial eye to review written responses for accuracy, tone and clarity against our style ' +
    'guidelines. You will provide detailed written feedback, identify errors and inconsistencies, and meet daily ' +
    'deadlines. Excellent grammar and attention to detail required. Remote, flexible, paid per task.'],
  ['LLM Evaluator',
    'Review and score outputs for factual accuracy, coherence and adherence to our quality guidelines. Strong ' +
    'proofreading skills and meticulous attention to detail essential.'],
  ['Search Quality Rater',
    'Evaluate search results for relevance and quality against detailed rating guidelines. You will review web ' +
    'pages for accuracy, apply consistent standards, and meet weekly deadlines. Part-time, remote, flexible hours.'],
  ['Data Annotation Specialist',
    'Review and label content according to our annotation guidelines. You will verify accuracy, resolve ' +
    'discrepancies between annotators, and maintain consistency across the dataset. Attention to detail essential.'],
  ['Editorial Specialist',
    // The one with a title she would absolutely have searched for. Only the
    // responsibilities give it away, which is exactly the case the body
    // threshold is there for.
    'Bring your editorial judgement to a frontier lab. You will write prompts on specialist topics, rate model ' +
    'responses for accuracy and style, compare candidate outputs and pick the stronger one, and help build the ' +
    'training data that teaches the model to write well. Excellent grammar and proofreading skills essential.'],
];

test('AI training and evaluation work is suppressed however editorial it sounds', () => {
  for (const [title, description] of AI_WORK) {
    const result = v4(title, description);
    assert.equal(
      result.details.occupation.id,
      'ai-training',
      `"${title}" is AI work, got ${result.details.occupation.id} at ${result.match}`
    );
    assert.equal(result.occupationClass, 'wrong');
    assert.equal(result.suppressed, true, 'the specification excludes or strongly suppresses these');
    assert.ok(result.match < 70, `"${title}" reached ${result.match}`);
    assert.equal(result.details.recommendation, 'SKIP');
  }
});

test('a job is not AI work merely because the employer uses AI', () => {
  /**
   * The other half, and the more dangerous one to get wrong: the specification
   * says plainly not to exclude a normal editorial, QA, marketing or e-commerce
   * position because employees use AI tools. Proofreading an AI first draft
   * before it reaches a customer is her job done on a new kind of draft — the
   * output goes to the customer, not back to the model.
   */
  const editor = v4(
    'Marketing Copy Editor',
    'Copy edit and proofread marketing campaign copy — email, landing pages and product descriptions — against ' +
      'our house style guide and brand voice. Increasingly our first drafts are AI-generated, so you will review ' +
      'AI-generated copy alongside writer-drafted copy: check grammar, punctuation and spelling, verify product ' +
      'information and pricing against source data, and flag inconsistencies with the live website. We use AI ' +
      'tools across the team. Partner with designers and developers on corrections. Remote.'
  );

  assert.equal(editor.suppressed, false, 'AI as a tool is not a reason to hide an editing job');
  assert.notEqual(editor.details.occupation.id, 'ai-training');
  assert.ok(editor.match >= 80, `and it must keep its band, got ${editor.match}`);
  assert.equal(editor.details.occupation.ai, 'tool');

  // A retailer boasting about its recommendation engine is not an AI employer
  // for these purposes either.
  const retail = v4(
    'Product Content Editor',
    TRUE_POSITIVES[1][1] +
      ' We are an AI-powered retail platform using machine learning to personalise every storefront.'
  );
  assert.equal(retail.suppressed, false, 'a company blurb is not a job description');
  assert.equal(retail.occupationClass, 'core');
});

test('the card says whether AI is the tool or the work', () => {
  // The specification's sixth question about every surviving posting, and the
  // one it calls "especially important".
  const editor = v4(
    'Content Editor',
    'Review and edit web and email content against our brand style guide before publication, verify product ' +
      'information and pricing, and flag inconsistencies. The team uses AI tools to draft first versions.'
  );
  assert.match(editor.details.occupation.aiNote || '', /tool/i);
  assert.match(editor.details.whyMatched, /AI/, 'and the answer belongs in the paragraph she actually reads');

  const trainer = v4(...AI_WORK[0]);
  assert.match(trainer.details.occupation.aiNote || '', /the WORK/);
  assert.ok(
    trainer.details.watchOuts.some((w) => /AI training or evaluation/.test(w)),
    'a suppressed posting must say why it was suppressed'
  );

  // Silence is the honest answer when the posting never raises it. A card that
  // announced "no AI here" on every listing would train her to stop reading.
  const quiet = v4('Product Content Editor', TRUE_POSITIVES[1][1]);
  assert.equal(quiet.details.occupation.ai, 'absent');
  assert.equal(quiet.details.occupation.aiNote, null);
});

test('no AI rule fires on a word an ordinary content posting contains', () => {
  /**
   * The same invariant the wrong-occupation lists carry, and it matters more
   * here: this gate is allowed to overrule a title she searched for, so a loose
   * phrase in it would delete real jobs rather than merely demote them. Every
   * work phrase must name something done TO a model.
   */
  const everywhere = new Set([
    'review', 'reviews', 'content', 'quality', 'accuracy', 'guidelines', 'feedback', 'evaluate',
    'rate', 'rating', 'annotate', 'label', 'prompt', 'model', 'data', 'training', 'ai',
    'artificial intelligence', 'machine learning', 'automation', 'english', 'writing',
  ]);
  const gate = profileV4.aiWorkGate;

  for (const phrase of gate.workPhrases) {
    assert.ok(
      !everywhere.has(phrase),
      `"${phrase}" would classify an ordinary editing job as AI work`
    );
    assert.ok(phrase.includes(' ') || phrase === 'rlhf' || phrase === 'utterances',
      `"${phrase}" is a single common word and needs its context to mean anything`);
  }
  assert.ok(gate.bodyThreshold >= 2, 'one sentence about AI is a sentence, not a job');

  // And the mention list, which must never be able to suppress anything, is
  // where the ambiguous vocabulary is allowed to live.
  for (const phrase of ['artificial intelligence', 'machine learning', 'ai generated', 'ai tools']) {
    assert.ok(gate.mentionPhrases.includes(phrase), `"${phrase}" must be a mention, never a verdict`);
    assert.ok(!gate.workPhrases.includes(phrase), `"${phrase}" must not be able to suppress a posting`);
  }
});

test('the AI gate can overrule a title the occupation gate would have trusted', () => {
  /**
   * The ordering that makes this work. Everywhere else in the gate a title
   * naming a content occupation wins the argument with its own description —
   * that rule is what keeps a content role at a health brand on the board. Here
   * it has to lose, because a content title in front of model-evaluation work
   * is the entire failure being fixed.
   */
  const posture = readAiPosture(profileV4, {
    normTitle: normalizeForMatch('Editorial Specialist'),
    normAll: normalizeForMatch(AI_WORK[5][1]),
  });
  assert.equal(posture.posture, 'work');

  const asContent = classifyOccupation(profileV4, {
    normTitle: normalizeForMatch('Editorial Specialist'),
    normAll: normalizeForMatch(AI_WORK[5][1]),
    family: { id: 'content-editorial-quality', tier: 'core', label: 'Content & editorial quality' },
    coreSignals: 4,
    combinations: 2,
  });
  assert.equal(asContent.class, 'wrong', 'a core-family title does not rescue model evaluation');
  assert.equal(asContent.id, 'ai-training');
});

test('the AI postings that were actually on the board are caught', () => {
  /**
   * Written from the live v4 board on the day this gate was built, in the
   * employers' own words. Three of the eight postings it was publishing were
   * AI-rating work — one of them the Content Reviewer the specification names —
   * and all three had cleared a threshold of 70.
   *
   * Imagined fixtures are written by somebody who already knows the answer.
   * These are the sentences real employers actually use, which is a different
   * and harder test: none of them says "train a model" anywhere.
   */
  const live = [
    ['Content Reviewer - US',
      'We are looking for an independent, flexible, remote opportunity where you can help improve AI-powered ' +
      'search technology from the comfort of your home. If you are curious, internet-savvy, and enjoy evaluating ' +
      'online content, this freelance project could be a great fit.'],
    ['AI Consulting Domain Expert',
      'micro1 is engaging AI Consulting Domain Experts to partner on a customer-facing project focused on the ' +
      'evaluation and optimization of AI-driven outputs. In this role, you will apply your expertise to help ' +
      'train next-generation AI systems. Your work will shape how models learn, reason, and perform through ' +
      'high-quality, real-world input.'],
    ['Media Search Analyst - English (AU)',
      'This position offers you the flexibility to set your own schedule and complete exciting tasks using an ' +
      'innovative web-based evaluation tool. You will be doing a comprehensive assessment of diverse task ' +
      'categories, encompassing music, video and search relevance.'],
  ];

  for (const [title, description] of live) {
    const result = v4(title, description);
    assert.equal(
      result.details.occupation.id,
      'ai-training',
      `"${title}" was published at 70+ before this gate; got ${result.details.occupation.id} at ${result.match}`
    );
    assert.equal(result.suppressed, true);
  }
});

test('the pipeline drops AI-training postings and counts them with the rest', () => {
  const board = buildBoard(
    AI_WORK.map(([title, description], index) => ({
      id: `ai-${index}`,
      title,
      company: 'Somewhere',
      location: 'USA',
      locationRestriction: 'USA',
      workType: 'remote',
      description,
      tags: [],
      employmentTypes: ['contract'],
      sources: ['test'],
      postedAt: '2026-07-26T12:00:00Z',
      url: 'https://example.com/1',
    })),
    profileV4,
    scoreJobV4,
    NOW,
    { tier: (m) => matchTierV3(m, profileV4), tierOrder: profileV4.bands.map((b) => b.tier) }
  );

  assert.equal(board.jobs.length, 0, 'none of these belong on the board at any score');
  assert.equal(board.dropped.wrongOccupation, AI_WORK.length);
});

test('the occupational facts reach the card so the ratings can learn from them', () => {
  const result = v4('Product Content Editor', TRUE_POSITIVES[1][1]);
  assert.ok(result.details.signals.occupation, 'which occupation this is');
  assert.ok(result.details.signals.function, 'and whether the job makes content or checks it');
  assert.equal(result.details.signals.occupationClass, 'core');
  // The transferable skills still travel — 👍 learns from them. It is 🚫 that
  // must not, and that rule lives in docs/preferences.mjs.
  assert.ok(result.details.signals.work.length > 0);
});

test('classification and eligibility can be asked separately', () => {
  // They fail separately — a posting can read as exactly the right occupation
  // and still demand a licence — so they are two functions, not one verdict.
  const eligible = checkEligibility(profileV4, normalizeForMatch(CONTENT_QA_BODY));
  assert.equal(eligible.eligible, true);

  const blocked = checkEligibility(profileV4, normalizeForMatch('Editorial role. Juris doctor required.'));
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.blocking[0].id, 'jd');

  const classified = classifyOccupation(profileV4, {
    normTitle: normalizeForMatch('Copy Editor'),
    normAll: normalizeForMatch(CONTENT_QA_BODY),
    family: { id: 'copyediting-proofreading', label: 'Copy editing & proofreading', tier: 'core' },
    coreSignals: 4,
    combinations: 2,
  });
  assert.equal(classified.class, 'core');
});
