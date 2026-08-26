/**
 * Emily's Job Board — client.
 *
 * Reads the two JSON files produced by scripts/fetch-jobs.mjs and renders a
 * filterable, sortable list. Saved / applied / dismissed state and per-job
 * notes live in localStorage, so nothing leaves the browser.
 *
 * Everything from the feed is inserted with textContent, never innerHTML —
 * job descriptions are third-party text and must never be able to run.
 */

import {
  DOWN_REASONS,
  buildModel,
  adjustmentFor,
  recordFeedback,
  clearFeedback,
  ratingFor,
  normalisePreferences,
  emptyPreferences,
  summarise,
} from './preferences.mjs?v=9a202cf9c0';

const STORE_KEY = 'emily-job-board:v1';
const PREFS_KEY = 'emily-job-board:prefs:v1';
const RATINGS_KEY = 'emily-job-board:ratings:v1';

const state = {
  jobs: [],
  meta: null,
  view: 'all',
  // Set when the requested board does not exist yet and v1 is standing in.
  fellBackFrom: null,
  focusIndex: -1,
  visible: [],
  store: loadStore(),
  // The 👍 / 👎 / 🚫 ratings, and the weights derived from them. The model is
  // rebuilt whenever a rating changes rather than per card, because every card
  // in a render consults the same one.
  ratings: emptyPreferences(),
  model: null,
  // jobId → { points, notes }, recomputed with the model.
  adjustments: new Map(),
};

/* ---------------------------------------------------------------
   Persistence
   --------------------------------------------------------------- */

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      saved: parsed.saved || {},
      applied: parsed.applied || {},
      hidden: parsed.hidden || {},
      notes: parsed.notes || {},
    };
  } catch {
    return { saved: {}, applied: {}, hidden: {}, notes: {} };
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  } catch {
    /* storage full or blocked — the board still works, just without memory */
  }
}

function loadRatings() {
  try {
    return normalisePreferences(JSON.parse(localStorage.getItem(RATINGS_KEY) || '{}'));
  } catch {
    return emptyPreferences();
  }
}

function saveRatings() {
  try {
    localStorage.setItem(RATINGS_KEY, JSON.stringify(state.ratings));
  } catch {
    /* storage full or blocked — ranking still works, just without memory */
  }
}

/**
 * Rebuilds the preference model and every posting's adjustment.
 *
 * Called on load and after each rating. Doing it here rather than inside the
 * sort keeps the arithmetic to once per change instead of once per comparison,
 * and means the card and the sort order can never disagree about a number.
 */
function refreshRanking() {
  state.model = buildModel(state.ratings);
  const labels = state.meta?.model?.workSignalLabels || {};
  state.adjustments = new Map();
  for (const job of state.jobs) {
    const adjustment = adjustmentFor(job, state.model, labels);
    if (adjustment.points) state.adjustments.set(job.id, adjustment);
  }
}

function adjustmentOf(job) {
  return state.adjustments.get(job.id) || { points: 0, notes: [] };
}

/** Where a posting actually sorts: the board's rank, plus what she has taught it. */
function tunedRank(job) {
  return job.rank + adjustmentOf(job).points;
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* non-fatal */
  }
}

/* ---------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function relativeDay(ageDays, assumed) {
  if (ageDays === null || ageDays === undefined) return 'date unknown';
  if (assumed) return 'date unknown';
  if (ageDays < 1) return 'today';
  if (ageDays < 2) return 'yesterday';
  if (ageDays < 14) return `${Math.round(ageDays)} days ago`;
  if (ageDays < 60) return `${Math.round(ageDays / 7)} weeks ago`;
  return `${Math.round(ageDays / 30)} months ago`;
}

const FILTERABLE_SCOPES = ['remote-anywhere', 'remote-us'];

function workTypeLabel(job) {
  switch (job.locationScope) {
    case 'remote-anywhere':
      return 'Remote (anywhere)';
    case 'remote-us':
      return 'Remote (US)';
    case 'local':
      return job.workType === 'hybrid' ? 'Hybrid — local' : 'On-site — local';
    default:
      return 'Remote';
  }
}

// Chip labels. v1 and v2 grade on four tiers, v3 on the specification's five
// bands; the keys do not collide, so one map covers every board. The board's
// own wording for the band travels in meta and becomes the chip's tooltip.
const TIER_LABEL = {
  exceptional: 'Exceptional match',
  strong: 'Strong match',
  good: 'Good match',
  possible: 'Worth a look',
  stretch: 'Stretch',
  low: 'Low priority',
};

/**
 * v4's occupational classes, in the words the card uses. WRONG never appears —
 * those postings are suppressed by the pipeline and never reach the board — but
 * it is named here so a hand-edited or archived data file still renders.
 */
const OCCUPATION_LABEL = {
  core: 'CORE TARGET',
  adjacent: 'ADJACENT',
  unclear: 'OCCUPATION UNCLEAR',
  wrong: 'WRONG OCCUPATION',
};

/**
 * How the two leading header tiles are labelled and what they filter to.
 * v3's bands sit at different numbers from v1's tiers, so a tile that jumps to
 * "70+" would mean something different on each board.
 */
function tileConfig(meta) {
  const order = meta?.model?.tierOrder || [];
  if (order.includes('exceptional')) {
    return {
      top: { label: 'Apply now', tiers: ['exceptional', 'strong'], min: 88 },
      second: { label: 'Good match', tiers: ['good'], min: 80 },
    };
  }
  return {
    top: { label: 'Strong match', tiers: ['strong'], min: 70 },
    second: { label: 'Good match', tiers: ['good'], min: 50 },
  };
}

/* ---------------------------------------------------------------
   Filtering & sorting
   --------------------------------------------------------------- */

function readFilters() {
  const checked = (name) => $$(`input[name="${name}"]:checked`).map((el) => el.value);
  return {
    query: $('#q').value.trim().toLowerCase(),
    sort: $('#sort').value,
    scopes: checked('scope'),
    employment: checked('employment'),
    sources: $$('#source-filters input:checked').map((el) => el.value),
    minMatch: Number($('#min-match').value),
    maxAge: Number($('#max-age').value),
    onlyProject: $('#only-project').checked,
    onlyOpen: $('#only-open').checked,
    onlyNewDirections: $('#only-newdir').checked,
    onlySurprise: $('#only-surprise').checked,
    hideHidden: $('#hide-hidden').checked,
    hideApplied: $('#hide-applied').checked,
  };
}

function applyFilters(jobs, f) {
  const maxAgeActive = f.maxAge < 46;

  return jobs.filter((job) => {
    const isHidden = Boolean(state.store.hidden[job.id]);
    const isApplied = Boolean(state.store.applied[job.id]);
    const isSaved = Boolean(state.store.saved[job.id]);

    if (state.view === 'saved' && !isSaved) return false;
    if (state.view === 'applied' && !isApplied) return false;
    if (state.view === 'hidden' && !isHidden) return false;
    if (state.view === 'all') {
      if (isHidden && f.hideHidden) return false;
      if (isApplied && f.hideApplied) return false;
    }

    // Scopes outside the filter's own vocabulary (only reachable when
    // remoteOnly is turned off in the profile) are always let through.
    if (FILTERABLE_SCOPES.includes(job.locationScope) && !f.scopes.includes(job.locationScope)) return false;
    if (!job.employmentTypes.some((t) => f.employment.includes(t))) return false;
    if (f.sources.length && !job.sources.some((s) => f.sources.includes(s))) return false;
    if (f.onlyProject && !job.projectBased) return false;
    if (f.onlyOpen && job.availability !== 'open') return false;
    if (f.onlyNewDirections && !job.discovery) return false;
    if (f.onlySurprise && !job.surprise) return false;
    if (job.match < f.minMatch) return false;
    if (maxAgeActive && (job.ageDays === null || job.ageDays > f.maxAge)) return false;

    if (f.query) {
      const haystack = `${job.title} ${job.company} ${job.location} ${job.tags.join(' ')} ${job.excerpt}`.toLowerCase();
      if (!f.query.split(/\s+/).every((term) => haystack.includes(term))) return false;
    }

    return true;
  });
}

function sortJobs(jobs, mode) {
  const copy = [...jobs];
  switch (mode) {
    case 'match':
      return copy.sort((a, b) => b.match - a.match || b.recency - a.recency);
    case 'new':
      return copy.sort((a, b) => (a.ageDays ?? 999) - (b.ageDays ?? 999) || b.match - a.match);
    case 'company':
      return copy.sort((a, b) => a.company.localeCompare(b.company) || b.match - a.match);
    default:
      // "Best overall" is the only sort the ratings touch. Highest match and
      // Most recent are asked to sort on one stated axis, and quietly folding
      // a learned preference into either would make them lie.
      return copy.sort((a, b) => tunedRank(b) - tunedRank(a));
  }
}

/* ---------------------------------------------------------------
   Rendering
   --------------------------------------------------------------- */

function makeChip(text, modifier) {
  const li = document.createElement('li');
  li.className = modifier ? `chip chip--${modifier}` : 'chip';
  li.textContent = text;
  return li;
}

function renderCard(job) {
  const node = $('#job-template').content.firstElementChild.cloneNode(true);
  const isSaved = Boolean(state.store.saved[job.id]);
  const isApplied = Boolean(state.store.applied[job.id]);
  const isHidden = Boolean(state.store.hidden[job.id]);

  node.dataset.id = job.id;
  node.dataset.tier = job.matchTier;
  node.classList.toggle('is-applied', isApplied);
  node.classList.toggle('is-hidden-job', isHidden && state.view !== 'hidden');

  const ring = $('[data-ring]', node);
  ring.style.setProperty('--pct', String(job.match));
  $('[data-match]', node).textContent = String(job.match);

  const age = $('[data-age]', node);
  age.textContent = relativeDay(job.ageDays, job.ageAssumed);
  age.classList.toggle('is-new', job.ageDays !== null && !job.ageAssumed && job.ageDays <= 2);

  const link = $('[data-link]', node);
  link.textContent = job.title;
  link.href = job.url;

  $('[data-company]', node).textContent = job.company;
  $('[data-location]', node).textContent = job.location || workTypeLabel(job);

  const chips = $('[data-chips]', node);
  const tierChip = makeChip(TIER_LABEL[job.matchTier] || job.matchTier, 'tier');
  if (job.band?.label) tierChip.title = job.band.label;
  chips.append(tierChip);
  chips.append(makeChip(workTypeLabel(job)));
  for (const type of job.employmentTypes) {
    if (type !== 'unspecified') chips.append(makeChip(type));
  }
  if (job.discovery) {
    const chip = makeChip('New direction', 'newdir');
    chip.title = 'Outside the job titles you have been searching, but a match on what you can actually do.';
    chips.append(chip);
  }
  if (job.projectBased && !job.employmentTypes.includes('contract')) {
    // The employment-type chip already says "contract" when the source labelled
    // it; this covers postings that describe project work without saying so.
    chips.append(makeChip('project-based', 'project'));
  }
  if (job.salary) chips.append(makeChip(job.salary, 'salary'));
  if (job.availability === 'open') {
    const chip = makeChip('Confirmed open', 'open');
    chip.title = `The posting was re-fetched when this board was built and did not say it was closed (${job.availabilityDetail || 'checked'}).`;
    chips.append(chip);
  } else if (job.availability === 'unverified') {
    const chip = makeChip('Not confirmed', 'caution');
    chip.title = 'This board could not confirm the posting is still open — the site blocked the check, timed out, or was past the checking budget. Open it and see.';
    chips.append(chip);
  }
  if (job.freshness?.label && job.ageDays !== null && job.ageDays > 30) {
    chips.append(makeChip(job.freshness.label, 'caution'));
  }
  if (job.employerUnknown) {
    const chip = makeChip('Employer not named', 'caution');
    chip.title = 'This listing was reposted by a job site that lists itself as the employer, so who is actually hiring is not stated. It sorts lower for that reason.';
    chips.append(chip);
  }
  chips.append(makeChip(job.sources.join(' · '), 'source'));

  const newdir = $('[data-newdir]', node);
  if (job.discovery) {
    newdir.hidden = false;
    const lead = document.createElement('strong');
    lead.textContent = job.family?.label ? `${job.family.label} — why this fits: ` : 'Different title, your skills: ';
    newdir.append(lead, document.createTextNode(job.family?.why || 'this posting asks for several of your core abilities.'));
  }

  renderFitReport(node, job);

  $('[data-excerpt]', node).textContent = job.excerpt || '';

  const positives = job.reasons.filter((r) => r.points > 0).length;
  $('[data-why-summary]', node).textContent =
    `Why it matched — ${positives} signal${positives === 1 ? '' : 's'}` +
    (job.breakdown.penalty < 0 ? `, ${job.reasons.filter((r) => r.points < 0).length} concern(s)` : '');

  const reasonList = $('[data-reasons]', node);
  for (const reason of job.reasons) {
    const li = document.createElement('li');
    const pts = document.createElement('span');
    pts.className = reason.points < 0 ? 'why__pts is-neg' : 'why__pts';
    pts.textContent = `${reason.points > 0 ? '+' : ''}${reason.points}`;
    const label = document.createElement('span');
    label.className = 'why__label';
    label.textContent = reason.label;
    const detail = document.createElement('span');
    detail.className = 'why__detail';
    detail.textContent = reason.detail;
    li.append(pts, label, detail);
    reasonList.append(li);
  }
  const eligibility = document.createElement('li');
  const eligPts = document.createElement('span');
  eligPts.className = 'why__pts';
  eligPts.textContent = '📍';
  const eligLabel = document.createElement('span');
  eligLabel.className = 'why__label';
  eligLabel.textContent = 'Location';
  const eligDetail = document.createElement('span');
  eligDetail.className = 'why__detail';
  eligDetail.textContent = job.locationReason;
  eligibility.append(eligPts, eligLabel, eligDetail);
  reasonList.append(eligibility);

  const apply = $('[data-apply]', node);
  apply.href = job.applyUrl || job.url;

  const saveBtn = $('[data-action="save"]', node);
  saveBtn.classList.toggle('is-on', isSaved);
  saveBtn.textContent = isSaved ? '★ Saved' : '★ Save';

  const appliedBtn = $('[data-action="applied"]', node);
  appliedBtn.classList.toggle('is-on', isApplied);
  appliedBtn.textContent = isApplied ? '✓ Applied' : '✓ Applied?';

  const hideBtn = $('[data-action="hide"]', node);
  hideBtn.textContent = isHidden ? 'Restore' : 'Dismiss';

  renderFeedback(node, job);

  const note = $('.note', node);
  const textarea = $('[data-note]', node);
  note.classList.toggle('is-open', isSaved || isApplied);
  textarea.value = state.store.notes[job.id] || '';

  return node;
}

/**
 * The v3 card: four axis scores, the recommendation, and the written report.
 *
 * Every block is hidden unless the posting actually carries the field, so the
 * same template renders a v1 card unchanged — there is one card, not three.
 */
function renderFitReport(node, job) {
  /**
   * v4's occupational verdict, printed above the axis scores because it is the
   * question that comes first: whether she plausibly belongs in this occupation
   * at all. The four axes only mean something once it is answered — a lawyer
   * scoring 100 on experience fit is a fact about her carefulness, not about
   * her being able to take the job.
   */
  if (job.occupation) {
    const line = $('[data-occupation]', node);
    line.hidden = false;
    line.dataset.class = job.occupation.class;

    const badge = document.createElement('strong');
    badge.className = 'occupation__badge';
    badge.textContent = OCCUPATION_LABEL[job.occupation.class] || job.occupation.class;
    line.append(badge, document.createTextNode(` ${job.occupation.label} — ${job.occupation.why}`));
    line.title = job.occupation.evidence || '';
  }

  if (job.recommendation) {
    const rec = $('[data-rec]', node);
    rec.hidden = false;
    rec.textContent = job.recommendation;
    rec.dataset.rec = job.recommendation.toLowerCase().replace(/\s+/g, '-');
    if (job.recommendationCapped) {
      rec.title = 'Held back from a stronger recommendation by a gap or by how much original writing the role involves — see the cautions below.';
    }
  }

  if (job.scores) {
    const bars = $('[data-fitbars]', node);
    bars.hidden = false;
    const axes = [
      ['Work', job.scores.work, 'What the day actually involves'],
      ['Experience', job.scores.experience, 'How much of it you have already done'],
      ['Qualification', job.scores.qualification, 'How closely you meet the stated requirements'],
      ['Lifestyle', job.scores.lifestyle, 'Remote, contract, flexibility'],
    ];
    for (const [label, value, title] of axes) {
      const row = document.createElement('div');
      row.className = 'fitbar';
      row.title = title;

      const name = document.createElement('span');
      name.className = 'fitbar__label';
      name.textContent = label;

      const track = document.createElement('span');
      track.className = 'fitbar__track';
      const fill = document.createElement('span');
      fill.className = 'fitbar__fill';
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      track.append(fill);

      const num = document.createElement('span');
      num.className = 'fitbar__num';
      num.textContent = String(value);

      row.append(name, track, num);
      bars.append(row);
    }
  }

  if (job.whyMatched) {
    const why = $('[data-whymatched]', node);
    why.hidden = false;
    why.textContent = job.whyMatched;
  }

  const evidence = job.evidence || [];
  const learnable = job.gaps?.learnable || [];
  const trueGaps = job.gaps?.experience || [];
  const watchOuts = job.watchOuts || [];
  const modeNote = job.occupation?.contentModeNote || '';
  const aiNote = job.occupation?.aiNote || '';
  if (!evidence.length && !learnable.length && !trueGaps.length && !watchOuts.length && !modeNote && !aiNote) return;

  const report = $('[data-report]', node);
  report.hidden = false;
  $('[data-report-summary]', node).textContent =
    [
      evidence.length ? `${evidence.length} piece${evidence.length === 1 ? '' : 's'} of evidence` : '',
      learnable.length ? `${learnable.length} learnable gap${learnable.length === 1 ? '' : 's'}` : '',
      trueGaps.length ? `${trueGaps.length} true gap${trueGaps.length === 1 ? '' : 's'}` : '',
      watchOuts.length ? `${watchOuts.length} caution${watchOuts.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · ');

  fillBlock(node, '[data-evidence-block]', '[data-evidence]', evidence.map((e) => [e.label, e.evidence]));
  // The specification's fifth question about every surviving posting: is the
  // job reviewing what already exists, or making what does not?
  if (job.occupation?.contentModeNote) {
    fillBlock(node, '[data-mode-block]', '[data-mode]', [[null, job.occupation.contentModeNote]]);
  }
  /**
   * And its sixth, asked only when the posting raises it: if AI is mentioned,
   * is it a tool the team uses or is training it the actual job? A card that
   * printed "no AI here" on every listing would teach her to stop reading this
   * block, so silence is the answer when the posting never brought it up.
   */
  if (aiNote) {
    fillBlock(node, '[data-ai-block]', '[data-ai]', [[null, aiNote]]);
  }
  fillBlock(node, '[data-learnable-block]', '[data-learnable]', learnable.map((g) => [g.label, g.note]));
  fillBlock(node, '[data-truegap-block]', '[data-truegaps]', trueGaps.map((g) => [g.label, g.note]));
  fillBlock(node, '[data-watch-block]', '[data-watchouts]', watchOuts.map((w) => [null, w]));
}

/**
 * The 👍 / 👎 / 🚫 row, the reason chips, and — when the ratings have moved this
 * posting — a line saying by how much and why.
 *
 * Only on boards that emit the signals the model learns over, which today means
 * v3. On v1 and v2 the buttons would take a rating the ranking cannot use.
 */
function renderFeedback(node, job) {
  if (!job.signals) return;

  const rating = ratingFor(state.ratings, job.id);
  const row = $('[data-feedback]', node);
  row.hidden = false;

  for (const button of $$('.vote', row)) {
    const active = rating?.verdict === button.dataset.verdict;
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-pressed', String(active));
  }

  // The reason row stays open while a 👎 has no reason yet, and after one is
  // chosen it keeps showing the choice rather than vanishing — otherwise there
  // is no way to see or change what was said.
  const picker = $('[data-reason-picker]', node);
  if (rating?.verdict === 'down') {
    picker.hidden = false;
    const chips = $('[data-reason-chips]', node);
    for (const reason of DOWN_REASONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reasonchip';
      chip.dataset.reason = reason.id;
      chip.textContent = reason.label;
      const chosen = rating.reason === reason.id;
      chip.classList.toggle('is-on', chosen);
      chip.setAttribute('aria-pressed', String(chosen));
      chips.append(chip);
    }
  }

  const adjustment = adjustmentOf(job);
  if (!adjustment.points) return;

  const line = document.createElement('p');
  line.className = adjustment.points > 0 ? 'tuned tuned--up' : 'tuned tuned--down';
  const delta = document.createElement('strong');
  delta.textContent = `${adjustment.points > 0 ? '+' : ''}${adjustment.points} from your ratings`;
  line.append(delta);
  if (adjustment.notes.length) {
    line.append(document.createTextNode(` — ${adjustment.notes.join('; ')}.`));
  }
  line.title = 'Your ratings move where a posting sits in the list. They never change the match score or the band, which mean what the matching specification says they mean.';
  row.before(line);
}

/** One report section: hidden when empty, never rendered with innerHTML. */
function fillBlock(node, blockSelector, listSelector, rows) {
  if (!rows.length) return;
  $(blockSelector, node).hidden = false;
  const list = $(listSelector, node);
  for (const [label, text] of rows) {
    const li = document.createElement('li');
    if (label) {
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      li.append(strong);
    }
    li.append(document.createTextNode(text || ''));
    list.append(li);
  }
}

function render() {
  const filters = readFilters();
  const visible = sortJobs(applyFilters(state.jobs, filters), filters.sort);
  state.visible = visible;

  const results = $('#results');
  results.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (const job of visible) fragment.append(renderCard(job));
  results.append(fragment);

  renderSurprise(visible);

  const empty = $('#empty');
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    empty.textContent = !state.jobs.length
      ? 'No job data yet. Run the “Update job listings” workflow from the Actions tab (or `npm run fetch` locally) to populate the board.'
      : state.view === 'saved'
        ? 'Nothing saved yet — hit ★ Save on anything worth a second look.'
        : state.view === 'applied'
          ? 'No applications logged yet. Mark a job “Applied” after you send it in.'
          : state.view === 'hidden'
            ? 'Nothing dismissed.'
            : 'No jobs match these filters. Try lowering the minimum match or widening the date range.';
  }

  const topTiers = tileConfig(state.meta).top.tiers;
  const strong = visible.filter((j) => topTiers.includes(j.matchTier)).length;
  const fresh = visible.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length;
  $('#resultline').innerHTML = '';
  $('#resultline').append(
    document.createTextNode('Showing '),
    boldText(String(visible.length)),
    document.createTextNode(` of ${state.jobs.length} matches`),
    document.createTextNode(strong ? ` · ${strong} ${tileConfig(state.meta).top.label.toLowerCase()}` : ''),
    document.createTextNode(fresh ? ` · ${fresh} new in 48h` : '')
  );

  updateFilterBadge(filters);
  updateStats();
  state.focusIndex = -1;
}

/**
 * The Surprise Me shelf — v4 only.
 *
 * One to three postings whose title she would never have typed into a search
 * box and whose work turns out to be hers anyway. They are shown here IN
 * ADDITION to their place in the list rather than being pulled out of it,
 * because the shelf is a reading suggestion, not a category.
 *
 * It is drawn from the filtered, sorted list, so it respects every filter on
 * screen — a shelf that ignored them would recommend jobs the rest of the page
 * had just been told to hide. When nothing qualifies the shelf disappears
 * entirely: an empty "Surprise me" heading is worse than no heading, and the
 * specification is explicit that categories are not to be filled to keep the
 * volume up.
 */
function renderSurprise(visible) {
  const section = $('#surprise');
  const list = $('#surprise-list');
  list.replaceChildren();

  const max = state.meta?.model?.surpriseMax ?? 3;
  const picks = visible.filter((job) => job.surprise && !state.store.hidden[job.id]).slice(0, max);
  section.hidden = picks.length === 0 || state.view !== 'all';
  if (section.hidden) return;

  for (const job of picks) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'surprisecard';
    item.dataset.jump = job.id;

    const match = document.createElement('span');
    match.className = 'surprisecard__match';
    match.textContent = String(job.match);

    const text = document.createElement('span');
    text.className = 'surprisecard__text';
    const title = document.createElement('strong');
    title.textContent = job.title;
    const company = document.createElement('span');
    company.className = 'surprisecard__company';
    company.textContent = job.company;
    const why = document.createElement('span');
    why.className = 'surprisecard__why';
    why.textContent = job.occupation?.why || 'The title is unfamiliar; the responsibilities are not.';
    text.append(title, company, why);

    item.append(match, text);
    list.append(item);
  }
}

function boldText(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function updateFilterBadge(f) {
  const active = [];
  if (f.onlyProject) active.push('contract / freelance only');
  if (f.onlyNewDirections) active.push('new directions only');
  if (f.onlySurprise) active.push('surprise me only');
  if (f.minMatch > 0) active.push(`match ≥ ${f.minMatch}`);
  if (f.maxAge < 46) active.push(`≤ ${f.maxAge}d old`);
  if (f.scopes.length < FILTERABLE_SCOPES.length) active.push('remote scope');
  if (f.employment.length < 4) active.push('schedule');
  const allSources = $$('#source-filters input').length;
  if (f.sources.length && f.sources.length < allSources) active.push('boards');
  $('#filters-count').textContent = active.length ? `· ${active.join(', ')}` : '';
}

function updateStats() {
  const savedCount = Object.keys(state.store.saved).length;
  const appliedCount = Object.keys(state.store.applied).length;
  $('#stat-saved').textContent = String(savedCount);
  $('#stat-applied').textContent = String(appliedCount);
}

/* ---------------------------------------------------------------
   Actions
   --------------------------------------------------------------- */

function toggle(bucket, id) {
  if (state.store[bucket][id]) delete state.store[bucket][id];
  else state.store[bucket][id] = new Date().toISOString();
  saveStore();
}

/**
 * Records a verdict, or clears it when the same one is pressed again.
 *
 * 🚫 also hides the posting, because "wrong kind of work" is a judgement about
 * this one as well as about its kind; un-rating it brings it back. The two are
 * kept distinct on purpose: Dismiss removes one listing and teaches nothing.
 */
function handleVerdict(verdict, id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  const existing = ratingFor(state.ratings, id);
  if (existing?.verdict === verdict) {
    state.ratings = clearFeedback(state.ratings, id);
    if (verdict === 'wrong') delete state.store.hidden[id];
  } else {
    state.ratings = recordFeedback(state.ratings, job, verdict);
    if (verdict === 'wrong') state.store.hidden[id] = state.store.hidden[id] || new Date().toISOString();
    else if (existing?.verdict === 'wrong') delete state.store.hidden[id];
  }

  saveRatings();
  saveStore();
  refreshRanking();
  renderTuning();
  render();
}

function handleReason(reasonId, id) {
  const job = state.jobs.find((j) => j.id === id);
  const existing = ratingFor(state.ratings, id);
  if (!job || existing?.verdict !== 'down') return;

  // Pressing the chosen reason again clears it, leaving the plain 👎.
  const next = existing.reason === reasonId ? null : reasonId;
  state.ratings = recordFeedback(state.ratings, job, 'down', next);
  saveRatings();
  refreshRanking();
  renderTuning();
  render();
}

function renderTuning() {
  const panel = $('#tuning');
  panel.hidden = !state.jobs.some((job) => job.signals);
  if (panel.hidden) return;
  $('#tuning-summary').textContent = summarise(state.model || buildModel(state.ratings));
}

function exportRatings() {
  if (!state.model?.counts.total) {
    window.alert('No ratings yet — 👍 or 👎 a few cards first.');
    return;
  }
  download(
    new Blob([`${JSON.stringify(state.ratings, null, 2)}\n`], { type: 'application/json' }),
    `job-board-ratings-${new Date().toISOString().slice(0, 10)}.json`
  );
}

/**
 * Ratings are per-browser, like everything else the board remembers. Import is
 * how they move to another machine — and the only way back after clearing site
 * data, so it merges rather than replaces.
 */
async function importRatings(file) {
  if (!file) return;
  try {
    const incoming = normalisePreferences(JSON.parse(await file.text()));
    const merged = normalisePreferences(state.ratings);
    let added = 0;
    for (const [id, rating] of Object.entries(incoming.ratings)) {
      if (!merged.ratings[id]) added += 1;
      merged.ratings[id] = rating;
    }
    state.ratings = merged;
    saveRatings();
    refreshRanking();
    renderTuning();
    render();
    window.alert(`Imported ${Object.keys(incoming.ratings).length} rating(s); ${added} were new.`);
  } catch (err) {
    window.alert(`That file could not be read as ratings (${err.message}).`);
  }
}

function resetRatings() {
  if (!window.confirm('Clear every 👍 / 👎 / 🚫 rating and go back to the board\u2019s own order?')) return;
  state.ratings = emptyPreferences();
  saveRatings();
  refreshRanking();
  renderTuning();
  render();
}

function handleAction(action, id) {
  if (action === 'save') {
    toggle('saved', id);
  } else if (action === 'applied') {
    toggle('applied', id);
    if (state.store.applied[id]) state.store.saved[id] = state.store.saved[id] || new Date().toISOString();
    saveStore();
  } else if (action === 'hide') {
    toggle('hidden', id);
  }
  render();
}

function exportCsv() {
  const tracked = state.jobs.filter((j) => state.store.saved[j.id] || state.store.applied[j.id]);
  if (!tracked.length) {
    window.alert('Nothing saved or applied to yet.');
    return;
  }

  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    // The v3 columns are blank on the other boards rather than absent, so one
    // tracker spreadsheet works whichever board a job was saved from.
    ['Status', 'Saved on', 'Applied on', 'Match', 'Recommendation', 'Occupational fit', 'Reviewing or creating', 'AI: tool or work', 'Work fit', 'Experience fit', 'Qualification fit', 'Lifestyle fit', 'Title', 'Company', 'Location', 'Schedule', 'Salary', 'Posted', 'Source', 'URL', 'Notes'],
    ...tracked.map((j) => [
      state.store.applied[j.id] ? 'Applied' : 'Saved',
      (state.store.saved[j.id] || '').slice(0, 10),
      (state.store.applied[j.id] || '').slice(0, 10),
      j.match,
      j.recommendation || '',
      j.occupation ? `${j.occupation.class} — ${j.occupation.label}` : '',
      j.occupation?.contentMode || '',
      j.occupation?.ai || '',
      j.scores?.work ?? '',
      j.scores?.experience ?? '',
      j.scores?.qualification ?? '',
      j.scores?.lifestyle ?? '',
      j.title,
      j.company,
      j.location || j.locationScope,
      j.employmentTypes.join('/'),
      j.salary || '',
      j.postedAt ? j.postedAt.slice(0, 10) : '',
      j.sources.join('/'),
      j.url,
      state.store.notes[j.id] || '',
    ]),
  ];

  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  download(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), `job-applications-${new Date().toISOString().slice(0, 10)}.csv`);
}

/** Hands a generated file to the browser. */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------
   External saved searches (boards with no public feed)
   --------------------------------------------------------------- */

const EXTERNAL_SEARCHES = [
  {
    name: 'LinkedIn — remote QA/email',
    desc: 'Remote US, posted this week',
    url: 'https://www.linkedin.com/jobs/search/?keywords=%22email%20marketing%22%20OR%20%22quality%20assurance%22%20OR%20proofreader&location=United%20States&f_WT=2&f_TPR=r604800&sortBy=DD',
  },
  {
    name: 'LinkedIn — part-time & contract',
    desc: 'Remote US, part-time or contract',
    url: 'https://www.linkedin.com/jobs/search/?keywords=%22email%20marketing%22%20OR%20proofreader%20OR%20%22quality%20assurance%22&location=United%20States&f_WT=2&f_JT=P%2CC&f_TPR=r604800&sortBy=DD',
  },
  {
    name: 'Indeed — remote email marketing',
    desc: 'Remote, last 7 days',
    url: 'https://www.indeed.com/jobs?q=%22email+marketing%22+or+%22quality+assurance%22+or+proofreader&l=Remote&fromage=7&sort=date',
  },
  {
    name: 'Indeed — remote proofreading',
    desc: 'Editorial & copy roles, last 7 days',
    url: 'https://www.indeed.com/jobs?q=proofreader+or+%22copy+editor%22+or+%22content+editor%22&l=Remote&fromage=7&sort=date',
  },
  {
    name: 'ZipRecruiter — remote QA',
    desc: 'Remote US postings',
    url: 'https://www.ziprecruiter.com/jobs-search?search=email+marketing+quality+assurance&location=Remote+%28USA%29&days=7',
  },
  {
    name: 'Google Jobs',
    desc: 'Aggregated across the web',
    url: 'https://www.google.com/search?q=%22email+marketing%22+OR+%22QA+specialist%22+remote+jobs&ibp=htl;jobs&htichips=date_posted:week',
  },
  {
    name: 'FlexJobs',
    desc: 'Curated remote & part-time (paid)',
    url: 'https://www.flexjobs.com/search?search=email+marketing+quality+assurance&location=',
  },
  {
    name: 'Built In — remote marketing',
    desc: 'Tech-company marketing roles',
    url: 'https://builtin.com/jobs/remote/marketing',
  },
  {
    name: 'Remote.co — marketing',
    desc: 'Hand-screened remote roles',
    url: 'https://remote.co/remote-jobs/marketing/',
  },
  {
    name: 'Idealist',
    desc: 'Nonprofit comms & marketing roles',
    url: 'https://www.idealist.org/en/jobs?q=marketing%20communications&remoteOptions=Remote',
  },
];

function renderExternal() {
  const grid = $('#elsewhere');
  for (const item of EXTERNAL_SEARCHES) {
    const a = document.createElement('a');
    a.className = 'sitecard';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const name = document.createElement('div');
    name.className = 'sitecard__name';
    name.textContent = item.name;

    const desc = document.createElement('div');
    desc.className = 'sitecard__desc';
    desc.textContent = item.desc;

    a.append(name, desc);
    grid.append(a);
  }
}

/* ---------------------------------------------------------------
   Source filters & health
   --------------------------------------------------------------- */

function renderSourceControls() {
  const labels = [...new Set(state.jobs.flatMap((j) => j.sources))].sort();
  const box = $('#source-filters');
  for (const label of labels) {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = label;
    input.checked = true;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    box.append(wrap);
  }

  const grid = $('#source-health');
  for (const source of state.meta?.sources || []) {
    const row = document.createElement('div');
    row.className = 'srcrow';
    row.dataset.status = source.status;

    const dot = document.createElement('span');
    dot.className = 'srcrow__dot';

    const name = document.createElement('span');
    name.className = 'srcrow__name';
    name.textContent = source.label;

    const count = document.createElement('span');
    count.className = 'srcrow__count';
    count.textContent =
      source.status === 'ok'
        ? `${source.fetched}`
        : source.status === 'error'
          ? 'failed'
          : source.status === 'skipped'
            ? 'not set up'
            : 'off';

    row.append(dot, name, count);

    const tooltip = [source.detail, ...(source.warnings || [])].filter(Boolean);
    if (tooltip.length) row.title = tooltip.join('\n');
    if (!source.detail && source.warnings?.length) {
      count.textContent = `${source.fetched} ⚠`;
    }
    grid.append(row);
  }
}

/* ---------------------------------------------------------------
   Keyboard navigation
   --------------------------------------------------------------- */

function focusCard(index) {
  const cards = $$('.card');
  if (!cards.length) return;
  const next = Math.max(0, Math.min(cards.length - 1, index));
  cards.forEach((c) => c.classList.remove('is-focused'));
  cards[next].classList.add('is-focused');
  cards[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  state.focusIndex = next;
}

function currentJobId() {
  const cards = $$('.card');
  const card = cards[state.focusIndex];
  return card ? card.dataset.id : null;
}

function onKeydown(event) {
  const tag = event.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (event.key === '/' && !typing) {
    event.preventDefault();
    $('#q').focus();
    return;
  }
  if (event.key === 'Escape' && typing) {
    event.target.blur();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  const id = currentJobId();

  switch (event.key) {
    case 'j':
      event.preventDefault();
      focusCard(state.focusIndex + 1);
      break;
    case 'k':
      event.preventDefault();
      focusCard(state.focusIndex - 1);
      break;
    case 's':
      if (id) { event.preventDefault(); const i = state.focusIndex; handleAction('save', id); focusCard(i); }
      break;
    case 'a':
      if (id) { event.preventDefault(); const i = state.focusIndex; handleAction('applied', id); focusCard(i); }
      break;
    case 'x':
      if (id) { event.preventDefault(); const i = state.focusIndex; handleAction('hide', id); focusCard(Math.min(i, $$('.card').length - 1)); }
      break;
    case '1':
    case '2':
    case '3': {
      if (!id) break;
      const verdict = { 1: 'up', 2: 'down', 3: 'wrong' }[event.key];
      event.preventDefault();
      const index = state.focusIndex;
      handleVerdict(verdict, id);
      focusCard(Math.min(index, $$('.card').length - 1));
      break;
    }
    case 'Enter': {
      const job = state.visible.find((j) => j.id === id);
      if (job) { event.preventDefault(); window.open(job.applyUrl || job.url, '_blank', 'noopener'); }
      break;
    }
    default:
      break;
  }
}

/* ---------------------------------------------------------------
   Theme
   --------------------------------------------------------------- */

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = mode;
  const prefs = loadPrefs();
  savePrefs({ ...prefs, theme: mode });
}

function cycleTheme() {
  const current = loadPrefs().theme || 'auto';
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  applyTheme(next);
  $('#theme-toggle').title = `Theme: ${next}`;
}

/* ---------------------------------------------------------------
   Wiring
   --------------------------------------------------------------- */

function wireEvents() {
  let debounce;
  $('#q').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(render, 140);
  });

  $('#sort').addEventListener('change', () => {
    savePrefs({ ...loadPrefs(), sort: $('#sort').value });
    render();
  });

  $('#controls').addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"], input[type="range"]')) render();
  });

  $('#min-match').addEventListener('input', (e) => {
    $('#min-match-out').textContent = e.target.value;
  });

  $('#max-age').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#max-age-out').textContent = v >= 46 ? 'any time' : v === 1 ? '24 hours' : `${v} days`;
  });

  $('#reset-filters').addEventListener('click', () => {
    $$('#controls input[type="checkbox"]').forEach((el) => {
      el.checked = !['hide-applied', 'only-project', 'only-newdir', 'only-open', 'only-surprise'].includes(el.id);
    });
    $('#min-match').value = 0;
    $('#min-match-out').textContent = '0';
    $('#max-age').value = 46;
    $('#max-age-out').textContent = 'any time';
    $('#q').value = '';
    render();
  });

  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-ratings').addEventListener('click', exportRatings);
  $('#reset-ratings').addEventListener('click', resetRatings);
  $('#import-ratings').addEventListener('change', (event) => {
    importRatings(event.target.files?.[0]);
    event.target.value = '';
  });
  $('#theme-toggle').addEventListener('click', cycleTheme);

  // A full navigation rather than a live swap: saved/applied/hidden state and
  // filters are all keyed off the loaded board, and reloading keeps that honest.
  for (const btn of $$('.boardswitch__btn')) {
    btn.addEventListener('click', () => {
      const board = btn.dataset.board;
      if (board === currentBoard()) return;
      const url = new URL(location.href);
      if (board === DEFAULT_BOARD) url.searchParams.delete('board');
      else url.searchParams.set('board', board);
      location.assign(url.toString());
    });
  }

  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    setView(tab.dataset.view);
  });

  $('#statbar').addEventListener('click', (event) => {
    const stat = event.target.closest('.stat');
    if (!stat) return;
    if (stat.dataset.view) {
      setView(stat.dataset.view);
      return;
    }
    if (stat.dataset.tierFilter) {
      // Written onto the tile when the header rendered, because the band
      // boundaries differ between the matching models.
      const min = Number(stat.dataset.tierMin) || (stat.dataset.tierFilter === 'strong' ? 70 : 50);
      $('#min-match').value = String(min);
      $('#min-match-out').textContent = String(min);
      $('#filters').open = true;
    }
    if (stat.dataset.projectFilter) {
      $('#only-project').checked = true;
      $('#filters').open = true;
    }
    if (stat.dataset.surpriseFilter) {
      $('#only-surprise').checked = true;
      $('#filters').open = true;
    }
    if (stat.dataset.ageFilter) {
      $('#max-age').value = stat.dataset.ageFilter;
      $('#max-age-out').textContent = '2 days';
      $('#filters').open = true;
    }
    setView('all');
  });

  $('#surprise-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-jump]');
    if (!item) return;
    const card = $(`.card[data-id="${CSS.escape(item.dataset.jump)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
  });

  $('#results').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;

    const vote = event.target.closest('[data-verdict]');
    if (vote) {
      handleVerdict(vote.dataset.verdict, card.dataset.id);
      return;
    }

    const reason = event.target.closest('[data-reason]');
    if (reason) {
      handleReason(reason.dataset.reason, card.dataset.id);
      return;
    }

    const button = event.target.closest('[data-action]');
    if (button) handleAction(button.dataset.action, card.dataset.id);
  });

  $('#results').addEventListener('focusin', (event) => {
    const card = event.target.closest('.card');
    if (card) state.focusIndex = $$('.card').indexOf(card);
  });

  $('#results').addEventListener('input', (event) => {
    const textarea = event.target.closest('[data-note]');
    if (!textarea) return;
    const id = textarea.closest('.card').dataset.id;
    if (textarea.value.trim()) state.store.notes[id] = textarea.value;
    else delete state.store.notes[id];
    saveStore();
  });

  document.addEventListener('keydown', onKeydown);
}

function setView(view) {
  state.view = view;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  render();
}

function restorePrefs() {
  const prefs = loadPrefs();
  applyTheme(prefs.theme || 'auto');
  if (prefs.sort) $('#sort').value = prefs.sort;
}

/**
 * Which matching model is being viewed. Kept in the URL so a board can be
 * linked, bookmarked and shared, and so a reload does not silently switch it.
 */
const BOARDS = ['v1', 'v2', 'v3', 'v4'];
const DEFAULT_BOARD = 'v4';

function currentBoard() {
  const asked = new URLSearchParams(location.search).get('board');
  return BOARDS.includes(asked) ? asked : DEFAULT_BOARD;
}

function boardDataPath() {
  const board = currentBoard();
  return board === 'v1' ? 'data' : `data/${board}`;
}

async function loadBoard(base) {
  const bust = `?t=${Date.now()}`;
  const [jobs, meta] = await Promise.all([
    fetch(`${base}/jobs.json${bust}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
    fetch(`${base}/meta.json${bust}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  ]);
  return { jobs: Array.isArray(jobs) ? jobs : [], meta };
}

async function loadData() {
  const board = await loadBoard(boardDataPath());
  state.jobs = board.jobs;
  state.meta = board.meta;
  state.fellBackFrom = null;

  // A board exists only once a run has produced it. Rather than showing an
  // empty page that looks broken, fall back to v1 — which has been generated
  // since the first run — and say so.
  if (!state.meta && currentBoard() !== 'v1') {
    const fallback = await loadBoard('data');
    if (fallback.meta) {
      state.fellBackFrom = currentBoard();
      state.jobs = fallback.jobs;
      state.meta = fallback.meta;
    }
  }
}

function renderHeader() {
  const meta = state.meta;
  if (!meta) {
    $('#updated').textContent = 'No data yet — run `npm run fetch`.';
    return;
  }

  const when = new Date(meta.generatedAt);
  const hours = (Date.now() - when.getTime()) / 3600000;
  const freshness = hours < 1 ? 'just now' : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
  $('#updated').textContent = `Updated ${freshness} · ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;

  $('#statbar').hidden = false;

  // The new-directions tile and filter belong to v2 only; on v1 they would be
  // controls that silently do nothing.
  const hasDiscovery = Boolean(meta.discoveries !== undefined && state.jobs.some((j) => j.discovery !== undefined));
  $('#stat-newdir-tile').hidden = !hasDiscovery;
  $('#only-newdir-row').hidden = !hasDiscovery;
  $('#stat-newdir').textContent = String(meta.discoveries ?? 0);

  // The Surprise Me tile and filter belong to v4. On the other boards they
  // would be controls that silently do nothing.
  const hasSurprise = state.jobs.some((j) => j.surprise !== undefined);
  $('#stat-surprise-tile').hidden = !hasSurprise;
  $('#only-surprise-row').hidden = !hasSurprise;
  $('#stat-surprise').textContent = String(meta.surprises ?? 0);

  for (const btn of $$('.boardswitch__btn')) {
    // What is actually on screen, which is not the requested board when that
    // board has not been generated yet.
    btn.setAttribute('aria-pressed', String(btn.dataset.board === (meta.model?.id || currentBoard())));
  }
  if (meta.model?.label) {
    $('#tagline').textContent = state.fellBackFrom
      ? `The ${state.fellBackFrom} board has not been generated yet — showing ${meta.model.label.toLowerCase()} (${meta.model.id}) until the next scheduled run.`
      : `${meta.model.label} matching (${meta.model.id}) · ${meta.counts?.published ?? 0} matches — remote, open to Michigan`;
  }

  // Liveness checking is v3's; on the other boards the control would filter on
  // a field no posting carries.
  const hasAvailability = state.jobs.some((j) => j.availability !== undefined);
  $('#only-open-row').hidden = !hasAvailability;

  const tiles = tileConfig(meta);
  const countTiers = (list) => list.reduce((sum, tier) => sum + (meta.tiers?.[tier] ?? 0), 0);

  $('#stat-top-label').textContent = tiles.top.label;
  $('#stat-second-label').textContent = tiles.second.label;
  $('#stat-top-tile').dataset.tierMin = String(tiles.top.min);
  $('#stat-second-tile').dataset.tierMin = String(tiles.second.min);

  $('#stat-project').textContent = String(meta.projectBased ?? 0);
  $('#stat-strong').textContent = String(countTiers(tiles.top.tiers));
  $('#stat-good').textContent = String(countTiers(tiles.second.tiers));
  $('#stat-fresh').textContent = String(meta.freshLast48h ?? 0);
}

async function init() {
  restorePrefs();
  wireEvents();
  renderExternal();

  try {
    await loadData();
  } catch (err) {
    $('#updated').textContent = 'Could not load job data.';
    $('#empty').hidden = false;
    $('#empty').textContent = `Could not load ${boardDataPath()}/jobs.json (${err.message}). If you are opening this file directly, run "npm run serve" instead — browsers block fetch on file:// URLs.`;
    return;
  }

  // The v2 board only exists once a run has produced it; until then say so
  // plainly rather than showing an empty board that looks broken.
  if (!state.meta) {
    $('#updated').textContent = 'No board data yet.';
    $('#empty').hidden = false;
    $('#empty').textContent =
      'No board has been generated yet — run the “Update job listings” workflow from the Actions tab, ' +
      'or `npm run fetch` locally.';
    return;
  }

  state.ratings = loadRatings();
  refreshRanking();

  renderHeader();
  renderSourceControls();
  renderTuning();
  render();
}

init();
