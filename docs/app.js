/**
 * The board.
 *
 * One list, built from docs/data/jobs.json. The pipeline has already decided
 * what is on it — everything remote, recent, and carrying one of the search
 * terms in its title — so nothing here re-judges a posting. This file filters,
 * sorts, remembers what has been saved or applied to, and applies whatever the
 * 👍 / 👎 / 🚫 ratings have taught the order.
 *
 * Ratings live in this browser's localStorage, and can be exported to a file
 * and imported into another browser. Nothing is sent anywhere.
 */

import {
  DOWN_REASONS,
  adjustmentFor,
  buildModel,
  clearFeedback,
  emptyPreferences,
  normalisePreferences,
  ratingFor,
  reasonApplies,
  reasonUnavailableBecause,
  recordFeedback,
  setReason,
  summarise,
} from './preferences.mjs?v=bc9ed00b81';

const STORE_KEY = 'emily-job-board:v1';
const PREFS_KEY = 'emily-job-board:prefs:v1';
const RATINGS_KEY = 'emily-job-board:ratings:v1';

const state = {
  jobs: [],
  meta: null,
  view: 'all',
  focusIndex: 0,
  store: { saved: {}, applied: {}, hidden: {}, notes: {} },
  ratings: emptyPreferences(),
  model: null,
  adjustments: new Map(),
};

/* ---------------------------------------------------------------
   Storage
   --------------------------------------------------------------- */

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    state.store = {
      saved: raw.saved || {},
      applied: raw.applied || {},
      hidden: raw.hidden || {},
      notes: raw.notes || {},
    };
  } catch {
    /* corrupt storage is the same as none */
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  } catch {
    /* quota or private mode — the page still works, it just forgets */
  }
}

function loadRatings() {
  try {
    state.ratings = normalisePreferences(JSON.parse(localStorage.getItem(RATINGS_KEY) || 'null'));
  } catch {
    state.ratings = emptyPreferences();
  }
}

function saveRatings() {
  try {
    localStorage.setItem(RATINGS_KEY, JSON.stringify(state.ratings));
  } catch {
    /* as above */
  }
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
    /* as above */
  }
}

/**
 * Recomputes the learned model and every posting's adjustment. Called once
 * after a rating changes rather than per card, because the model is shared and
 * the arithmetic is otherwise repeated a few hundred times per render.
 */
function refreshRanking() {
  state.model = buildModel(state.ratings);
  state.adjustments = new Map();
  for (const job of state.jobs) {
    state.adjustments.set(job.id, adjustmentFor(job, state.model));
  }
}

const adjustmentOf = (job) => state.adjustments.get(job.id) || { points: 0, notes: [] };

/** Where a posting actually sorts: the board's rank, plus what she has taught it. */
const tunedRank = (job) => job.rank + adjustmentOf(job).points;

/* ---------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function relativeDay(ageDays, assumed) {
  if (ageDays === null || ageDays === undefined) return 'date unknown';
  const days = Math.round(ageDays);
  const prefix = assumed ? '~' : '';
  if (days <= 0) return 'today';
  if (days === 1) return `${prefix}yesterday`;
  if (days < 7) return `${prefix}${days} days ago`;
  if (days < 14) return `${prefix}last week`;
  if (days < 31) return `${prefix}${Math.round(days / 7)} weeks ago`;
  return `${prefix}${Math.round(days / 30)} months ago`;
}

function locationLabel(job) {
  if (job.location) return job.location;
  return job.locationScope === 'remote-anywhere' ? 'Remote — anywhere' : 'Remote — US';
}

/**
 * The colour band on a card. Purely a reading aid for how much of the title the
 * matched term covered — it is not a verdict on the job.
 */
function relevanceBand(relevance) {
  if (relevance >= 90) return 'exact';
  if (relevance >= 70) return 'close';
  return 'partial';
}

/* ---------------------------------------------------------------
   Filtering and sorting
   --------------------------------------------------------------- */

function readFilters() {
  const maxAgeRaw = Number($('#max-age').value);
  return {
    q: $('#q').value.trim().toLowerCase(),
    employment: $$('input[name="employment"]:checked').map((i) => i.value),
    terms: $$('#term-filters input:checked').map((i) => i.value),
    sources: $$('#source-filters input:checked').map((i) => i.value),
    // The top of the slider means "any time" rather than 61 days.
    maxAge: maxAgeRaw >= 61 ? Infinity : maxAgeRaw,
    onlyTitles: $('#only-titles').checked,
    onlyContract: $('#only-contract').checked,
    hideHidden: $('#hide-hidden').checked,
    hideApplied: $('#hide-applied').checked,
    sort: $('#sort').value,
  };
}

function applyFilters(jobs, f) {
  const termFilterActive = f.terms.length > 0 && f.terms.length < termsInResults().length;
  const sourceFilterActive = f.sources.length > 0 && f.sources.length < sourcesInResults().length;

  return jobs.filter((job) => {
    if (state.view === 'saved' && !state.store.saved[job.id]) return false;
    if (state.view === 'applied' && !state.store.applied[job.id]) return false;
    if (state.view === 'rated' && !ratingFor(state.ratings, job.id)) return false;
    if (state.view === 'hidden' && !state.store.hidden[job.id]) return false;

    if (state.view === 'all') {
      if (f.hideHidden && state.store.hidden[job.id]) return false;
      if (f.hideApplied && state.store.applied[job.id]) return false;
      // 🚫 means "the term that found this should not have". Acting on the one
      // posting as well as teaching the order is what makes the button feel
      // like it did something.
      if (ratingFor(state.ratings, job.id)?.verdict === 'wrong') return false;
    }

    if (f.q) {
      const hay = `${job.title} ${job.company} ${job.excerpt} ${(job.tags || []).join(' ')} ${job.matchedTerm}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }

    if (!job.employmentTypes.some((t) => f.employment.includes(t))) return false;
    if (f.onlyTitles && job.matchedIn !== 'title') return false;
    if (f.onlyContract && !job.employmentTypes.includes('contract')) return false;
    if (termFilterActive && !f.terms.includes(job.matchedTerm)) return false;
    if (sourceFilterActive && !job.sources.some((s) => f.sources.includes(s))) return false;

    if (f.maxAge !== Infinity) {
      if (job.ageDays === null || job.ageDays === undefined) return false;
      if (job.ageDays > f.maxAge) return false;
    }

    return true;
  });
}

function sortJobs(jobs, mode) {
  const copy = [...jobs];
  switch (mode) {
    case 'relevance':
      return copy.sort((a, b) => b.relevance - a.relevance || tunedRank(b) - tunedRank(a));
    case 'new':
      return copy.sort((a, b) => {
        const aAge = a.ageDays ?? 999;
        const bAge = b.ageDays ?? 999;
        return aAge - bAge || tunedRank(b) - tunedRank(a);
      });
    case 'company':
      return copy.sort((a, b) => a.company.localeCompare(b.company) || tunedRank(b) - tunedRank(a));
    default:
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
  node.dataset.id = job.id;

  const rating = ratingFor(state.ratings, job.id);
  const adjustment = adjustmentOf(job);

  // The band colours the card; --pct fills the ring's conic gradient.
  node.dataset.band = relevanceBand(job.relevance);
  $('[data-ring]', node).style.setProperty('--pct', job.relevance);
  $('[data-relevance]', node).textContent = job.relevance;

  const age = $('[data-age]', node);
  age.textContent = relativeDay(job.ageDays, job.ageAssumed);
  if (job.ageDays !== null && !job.ageAssumed && job.ageDays <= 2) age.classList.add('is-new');

  // The rank note only appears once the ratings have actually moved something,
  // and it says which category taught the move.
  const rec = $('[data-rec]', node);
  if (adjustment.points) {
    rec.hidden = false;
    rec.dataset.dir = adjustment.points > 0 ? 'up' : 'down';
    rec.textContent = `${adjustment.points > 0 ? '↑' : '↓'} ${Math.abs(adjustment.points)}`;
    if (adjustment.notes.length) rec.title = adjustment.notes.join('\n');
  }

  const link = $('[data-link]', node);
  link.textContent = job.title;
  link.href = job.url;

  $('[data-company]', node).textContent = job.employerUnknown ? `${job.company} (reposting site)` : job.company;
  $('[data-location]', node).textContent = locationLabel(job);

  const chips = $('[data-chips]', node);
  for (const type of job.employmentTypes) {
    if (type !== 'unspecified') chips.append(makeChip(type, type === 'contract' ? 'contract' : null));
  }
  if (job.salary) chips.append(makeChip(job.salary, 'pay'));
  if (job.seniority && job.seniority !== 'mid') chips.append(makeChip(job.seniority));
  for (const source of job.sources) chips.append(makeChip(source, 'source'));

  // Say where the term was found as well as what it was: a posting whose
  // description mentions proofreading is not a posting titled Proofreader, and
  // a card that blurred the two would be lying about the match.
  const WHERE = { title: 'in the title', tags: 'in the board’s tags', description: 'in the description' };
  const matched = $('[data-matched]', node);
  const terms = job.matchedTerms && job.matchedTerms.length > 1
    ? `${job.matchedTerms.map((t) => `“${t}”`).join(', ')}`
    : `“${job.matchedTerm}”`;
  matched.textContent = `Matched ${terms} ${WHERE[job.matchedIn] || ''}`.trim();
  matched.dataset.where = job.matchedIn;

  $('[data-excerpt]', node).textContent = job.excerpt || '';
  $('[data-apply]', node).href = job.applyUrl || job.url;

  if (state.store.saved[job.id]) {
    const btn = $('[data-action="save"]', node);
    btn.classList.add('is-on');
    btn.textContent = '★ Saved';
  }
  if (state.store.applied[job.id]) {
    const btn = $('[data-action="applied"]', node);
    btn.classList.add('is-on');
    btn.textContent = '✓ Applied';
    node.classList.add('is-applied');
  }
  if (state.store.hidden[job.id]) {
    node.classList.add('is-hidden-job');
    $('[data-action="hide"]', node).textContent = 'Restore';
  }

  for (const button of $$('.vote', node)) {
    button.classList.toggle('is-on', rating?.verdict === button.dataset.verdict);
  }

  renderReasons(node, job, rating);

  const note = $('[data-note]', node);
  note.value = state.store.notes[job.id] || '';

  return node;
}

/**
 * The reason chips. Only shown on a card carrying a 👎 — a 👍 has nothing to
 * explain, and a 🚫 has already said what was wrong.
 */
function renderReasons(node, job, rating) {
  const picker = $('[data-reason-picker]', node);
  if (!rating || rating.verdict !== 'down') {
    picker.hidden = true;
    return;
  }

  picker.hidden = false;
  const chips = $('[data-reason-chips]', picker);
  chips.replaceChildren();

  for (const reason of DOWN_REASONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reasonchip';
    chip.dataset.reason = reason.id;
    chip.textContent = reason.label;

    /**
     * A reason that names nothing about this posting is offered but not
     * selectable, and says why. Choosing one would redirect blame onto a fact
     * that is not there, which teaches less than a bare 👎 — so the chip is
     * shown (the set stays the same on every card, which is easier to learn)
     * and disabled.
     */
    if (!reasonApplies(reason.id, job)) {
      chip.disabled = true;
      chip.title = reasonUnavailableBecause(reason.id, job);
    } else {
      chip.classList.toggle('is-on', rating.reason === reason.id);
      chip.setAttribute('aria-pressed', String(rating.reason === reason.id));
    }

    chips.append(chip);
  }
}

function render() {
  const f = readFilters();
  const filtered = applyFilters(state.jobs, f);
  const sorted = sortJobs(filtered, f.sort);

  const results = $('#results');
  results.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (const job of sorted) fragment.append(renderCard(job));
  results.append(fragment);

  const line = $('#resultline');
  line.textContent = sorted.length
    ? `${sorted.length} posting${sorted.length === 1 ? '' : 's'}${state.view === 'all' ? '' : ` in ${state.view}`}`
    : '';

  const empty = $('#empty');
  empty.hidden = sorted.length > 0;
  if (!sorted.length) {
    empty.textContent =
      state.view === 'all'
        ? 'Nothing matches those filters. Try widening “Posted within”, or clearing the search box.'
        : `Nothing in ${state.view} yet.`;
  }

  updateFilterBadge(f);
  updateStats();
  renderTuning();
  state.focusIndex = Math.min(state.focusIndex, Math.max(0, sorted.length - 1));
}

function updateFilterBadge(f) {
  let active = 0;
  if (f.q) active += 1;
  if (f.employment.length < 4) active += 1;
  if (f.terms.length && f.terms.length < termsInResults().length) active += 1;
  if (f.sources.length && f.sources.length < sourcesInResults().length) active += 1;
  if (f.maxAge !== Infinity) active += 1;
  if (f.onlyTitles) active += 1;
  if (f.onlyContract) active += 1;
  if (!f.hideHidden) active += 1;
  if (f.hideApplied) active += 1;
  $('#filters-count').textContent = active ? `(${active} active)` : '';

  const out = $('#max-age-out');
  out.textContent = f.maxAge === Infinity ? 'any time' : `${f.maxAge} day${f.maxAge === 1 ? '' : 's'}`;
}

function updateStats() {
  const visible = state.jobs.filter((j) => ratingFor(state.ratings, j.id)?.verdict !== 'wrong');
  $('#stat-all').textContent = visible.length;
  $('#stat-fresh').textContent = visible.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length;
  $('#stat-contract').textContent = visible.filter((j) => j.employmentTypes.includes('contract')).length;
  $('#stat-titles').textContent = visible.filter((j) => j.matchedIn === 'title').length;
  $('#stat-rated').textContent = Object.keys(state.ratings.ratings).length;
  $('#stat-saved').textContent = Object.keys(state.store.saved).length;
  $('#stat-applied').textContent = Object.keys(state.store.applied).length;
  $('#statbar').hidden = false;
}

function renderTuning() {
  $('#tuning-summary').textContent = summarise(state.model);
}

/* ---------------------------------------------------------------
   Actions
   --------------------------------------------------------------- */

function toggle(bucket, id) {
  if (state.store[bucket][id]) delete state.store[bucket][id];
  else state.store[bucket][id] = new Date().toISOString();
  saveStore();
}

function handleAction(action, id) {
  if (action === 'save') toggle('saved', id);
  else if (action === 'applied') toggle('applied', id);
  else if (action === 'hide') toggle('hidden', id);
  render();
}

/**
 * A verdict, or the removal of one when the same button is pressed twice.
 * Re-ranks immediately so the effect is visible rather than theoretical.
 */
function handleVerdict(verdict, id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  const existing = ratingFor(state.ratings, id);
  state.ratings = existing?.verdict === verdict
    ? clearFeedback(state.ratings, id)
    : recordFeedback(state.ratings, job, verdict);

  saveRatings();
  refreshRanking();
  render();
}

/**
 * Sets or clears the reason, leaving the 👎 alone. Pressing the chip that is
 * already on takes it back off, so a mis-tap is one click to undo.
 */
function handleReason(reasonId, id) {
  const existing = ratingFor(state.ratings, id);
  if (!existing || existing.verdict !== 'down') return;

  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  state.ratings = setReason(state.ratings, job, existing.reason === reasonId ? null : reasonId);
  saveRatings();
  refreshRanking();
  render();
}

function exportRatings() {
  const blob = new Blob([JSON.stringify(state.ratings, null, 2)], { type: 'application/json' });
  download(blob, `job-board-ratings-${new Date().toISOString().slice(0, 10)}.json`);
}

/**
 * Merges an exported file into what is already here rather than replacing it,
 * so importing on a second browser does not throw away that browser's ratings.
 */
async function importRatings(file) {
  if (!file) return;
  try {
    const incoming = normalisePreferences(JSON.parse(await file.text()));
    const merged = normalisePreferences(state.ratings);
    for (const [id, rating] of Object.entries(incoming.ratings)) {
      const existing = merged.ratings[id];
      // Last one wins, by the timestamp on the rating itself.
      if (!existing || rating.at > existing.at) merged.ratings[id] = rating;
    }
    state.ratings = merged;
    saveRatings();
    refreshRanking();
    render();
  } catch {
    window.alert('That file could not be read as a ratings export.');
  }
}

function resetRatings() {
  if (!Object.keys(state.ratings.ratings).length) return;
  if (!window.confirm('Delete every rating and start the training again?')) return;
  state.ratings = emptyPreferences();
  saveRatings();
  refreshRanking();
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
    ['Status', 'Saved on', 'Applied on', 'Title match', 'Matched term', 'Title', 'Company', 'Location', 'Schedule', 'Salary', 'Posted', 'Source', 'URL', 'Notes'],
    ...tracked.map((j) => [
      state.store.applied[j.id] ? 'Applied' : 'Saved',
      (state.store.saved[j.id] || '').slice(0, 10),
      (state.store.applied[j.id] || '').slice(0, 10),
      j.relevance,
      j.matchedTerm,
      j.title,
      j.company,
      locationLabel(j),
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
    name: 'LinkedIn — editorial & content QA',
    desc: 'Remote US, posted this week',
    url: 'https://www.linkedin.com/jobs/search/?keywords=proofreader%20OR%20%22copy%20editor%22%20OR%20%22content%20quality%22&location=United%20States&f_WT=2&f_TPR=r604800&sortBy=DD',
  },
  {
    name: 'LinkedIn — part-time & contract',
    desc: 'Remote US, part-time or contract',
    url: 'https://www.linkedin.com/jobs/search/?keywords=proofreader%20OR%20%22copy%20editor%22%20OR%20%22content%20editor%22&location=United%20States&f_WT=2&f_JT=P%2CC&f_TPR=r604800&sortBy=DD',
  },
  {
    name: 'Indeed — remote proofreading',
    desc: 'Editorial & copy roles, last 7 days',
    url: 'https://www.indeed.com/jobs?q=proofreader+or+%22copy+editor%22+or+%22content+editor%22&l=Remote&fromage=7&sort=date',
  },
  {
    name: 'Indeed — remote content QA',
    desc: 'Quality & review roles, last 7 days',
    url: 'https://www.indeed.com/jobs?q=%22content+quality%22+or+%22quality+assurance%22+or+%22content+reviewer%22&l=Remote&fromage=7&sort=date',
  },
  {
    name: 'ZipRecruiter — remote editorial',
    desc: 'Remote US postings',
    url: 'https://www.ziprecruiter.com/jobs-search?search=proofreader+copy+editor&location=Remote+%28USA%29&days=7',
  },
  {
    name: 'Google Jobs',
    desc: 'Aggregated across the web',
    url: 'https://www.google.com/search?q=proofreader+OR+%22content+editor%22+OR+%22QA+specialist%22+remote+jobs&ibp=htl;jobs&htichips=date_posted:week',
  },
  {
    name: 'FlexJobs',
    desc: 'Curated remote & part-time (paid)',
    url: 'https://www.flexjobs.com/search?search=proofreading+editing&location=',
  },
  {
    name: 'Remote.co — writing & editing',
    desc: 'Hand-screened remote roles',
    url: 'https://remote.co/remote-jobs/writing/',
  },
  {
    name: 'MediaBistro',
    desc: 'Editorial and publishing roles',
    url: 'https://www.mediabistro.com/jobs/search/?keywords=editor',
  },
  {
    name: 'Idealist',
    desc: 'Nonprofit comms & editorial roles',
    url: 'https://www.idealist.org/en/jobs?q=editor&remoteOptions=Remote',
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
   Filter controls built from the results
   --------------------------------------------------------------- */

let termsCache = null;
let sourcesCache = null;

function termsInResults() {
  if (!termsCache) {
    const counts = new Map();
    for (const job of state.jobs) counts.set(job.matchedTerm, (counts.get(job.matchedTerm) || 0) + 1);
    termsCache = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  return termsCache;
}

function sourcesInResults() {
  if (!sourcesCache) sourcesCache = [...new Set(state.jobs.flatMap((j) => j.sources))].sort();
  return sourcesCache;
}

function renderFilterControls() {
  const termBox = $('#term-filters');
  termBox.replaceChildren();
  for (const [term, count] of termsInResults()) {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = term;
    input.checked = true;
    const span = document.createElement('span');
    span.textContent = `${term} (${count})`;
    wrap.append(input, span);
    termBox.append(wrap);
  }

  const sourceBox = $('#source-filters');
  sourceBox.replaceChildren();
  for (const label of sourcesInResults()) {
    const wrap = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = label;
    input.checked = true;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    sourceBox.append(wrap);
  }

  const grid = $('#source-health');
  grid.replaceChildren();
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
    if (!source.detail && source.warnings?.length) count.textContent = `${source.fetched} ⚠`;
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
  const card = $$('.card')[state.focusIndex];
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
  if (typing) return;

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
      if (id) handleAction('save', id);
      break;
    case 'a':
      if (id) handleAction('applied', id);
      break;
    case 'x':
      if (id) handleAction('hide', id);
      break;
    case '1':
      if (id) handleVerdict('up', id);
      break;
    case '2':
      if (id) handleVerdict('down', id);
      break;
    case '3':
      if (id) handleVerdict('wrong', id);
      break;
    case 'Enter': {
      const card = $$('.card')[state.focusIndex];
      if (card) $('[data-link]', card).click();
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
  document.documentElement.dataset.theme = mode === 'system' ? '' : mode;
  if (mode === 'system') delete document.documentElement.dataset.theme;
}

function cycleTheme() {
  const prefs = loadPrefs();
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(prefs.theme || 'system') + 1) % order.length];
  prefs.theme = next;
  savePrefs(prefs);
  applyTheme(next);
}

/* ---------------------------------------------------------------
   Wiring
   --------------------------------------------------------------- */

function setView(view) {
  state.view = view;
  for (const tab of $$('.tab')) tab.classList.toggle('is-active', tab.dataset.view === view);
  render();
}

let searchTimer = null;

function wireEvents() {
  $('#controls').addEventListener('input', (event) => {
    if (event.target.id === 'q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 120);
      return;
    }
    render();
    persistFilters();
  });

  $('#controls').addEventListener('change', () => {
    render();
    persistFilters();
  });

  $('#controls').addEventListener('submit', (event) => event.preventDefault());

  $('#reset-filters').addEventListener('click', () => {
    $('#q').value = '';
    for (const input of $$('input[name="employment"]')) input.checked = true;
    for (const input of $$('#term-filters input, #source-filters input')) input.checked = true;
    $('#max-age').value = 61;
    $('#only-titles').checked = false;
    $('#only-contract').checked = false;
    $('#hide-hidden').checked = true;
    $('#hide-applied').checked = false;
    $('#sort').value = 'rank';
    persistFilters();
    render();
  });

  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-ratings').addEventListener('click', exportRatings);
  $('#reset-ratings').addEventListener('click', resetRatings);
  $('#import-ratings').addEventListener('change', (event) => {
    importRatings(event.target.files?.[0]);
    event.target.value = '';
  });

  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) setView(tab.dataset.view);
  });

  $('#statbar').addEventListener('click', (event) => {
    const stat = event.target.closest('.stat');
    if (!stat) return;
    if (stat.dataset.view) {
      setView(stat.dataset.view);
      return;
    }
    if (stat.dataset.ageFilter) {
      $('#max-age').value = stat.dataset.ageFilter;
      setView('all');
    }
    if (stat.dataset.contractFilter) {
      $('#only-contract').checked = true;
      setView('all');
    }
    if (stat.dataset.titleFilter) {
      $('#only-titles').checked = true;
      setView('all');
    }
    persistFilters();
    render();
  });

  $('#results').addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;

    const vote = event.target.closest('.vote');
    if (vote) {
      handleVerdict(vote.dataset.verdict, card.dataset.id);
      return;
    }

    const reason = event.target.closest('.reasonchip');
    if (reason) {
      handleReason(reason.dataset.reason, card.dataset.id);
      return;
    }

    const button = event.target.closest('[data-action]');
    if (button) handleAction(button.dataset.action, card.dataset.id);
  });

  $('#results').addEventListener('input', (event) => {
    if (!event.target.matches('[data-note]')) return;
    const card = event.target.closest('.card');
    const value = event.target.value.trim();
    if (value) state.store.notes[card.dataset.id] = value;
    else delete state.store.notes[card.dataset.id];
    saveStore();
  });

  $('#theme-toggle').addEventListener('click', cycleTheme);
  document.addEventListener('keydown', onKeydown);
}

function persistFilters() {
  const prefs = loadPrefs();
  prefs.filters = {
    employment: $$('input[name="employment"]:checked').map((i) => i.value),
    maxAge: $('#max-age').value,
    onlyTitles: $('#only-titles').checked,
    onlyContract: $('#only-contract').checked,
    hideHidden: $('#hide-hidden').checked,
    hideApplied: $('#hide-applied').checked,
    sort: $('#sort').value,
  };
  savePrefs(prefs);
}

function restorePrefs() {
  const prefs = loadPrefs();
  applyTheme(prefs.theme || 'system');

  const f = prefs.filters;
  if (!f) return;
  if (Array.isArray(f.employment)) {
    for (const input of $$('input[name="employment"]')) input.checked = f.employment.includes(input.value);
  }
  if (f.maxAge) $('#max-age').value = f.maxAge;
  if (typeof f.onlyTitles === 'boolean') $('#only-titles').checked = f.onlyTitles;
  if (typeof f.onlyContract === 'boolean') $('#only-contract').checked = f.onlyContract;
  if (typeof f.hideHidden === 'boolean') $('#hide-hidden').checked = f.hideHidden;
  if (typeof f.hideApplied === 'boolean') $('#hide-applied').checked = f.hideApplied;
  if (f.sort) $('#sort').value = f.sort;
}

/* ---------------------------------------------------------------
   Load
   --------------------------------------------------------------- */

async function loadData() {
  const [jobs, meta] = await Promise.all([
    fetch(`data/jobs.json?t=${Date.now()}`).then((r) => r.json()),
    fetch(`data/meta.json?t=${Date.now()}`).then((r) => r.json()),
  ]);
  state.jobs = jobs;
  state.meta = meta;
  termsCache = null;
  sourcesCache = null;
}

function renderHeader() {
  const meta = state.meta;
  if (!meta) return;

  const when = new Date(meta.generatedAt);
  const hours = (Date.now() - when.getTime()) / 3600000;
  const ago = hours < 1 ? 'just now' : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
  $('#updated').textContent = `Updated ${ago} · ${meta.counts.published} of ${meta.counts.unique} postings matched`;

  const termCount = meta.searchTerms?.length ?? 0;
  const titles = meta.matchedIn?.title ?? 0;
  $('#tagline').textContent =
    `Every remote posting open to Michigan carrying one of your ${termCount} search terms` +
    (titles ? ` — ${titles} of them in the job title` : '') +
    '. Nothing else is filtered out; rate the cards to teach the order.';
}

async function init() {
  loadStore();
  loadRatings();
  restorePrefs();
  wireEvents();
  renderExternal();

  try {
    await loadData();
  } catch {
    $('#updated').textContent = 'Could not load listings.';
    $('#empty').hidden = false;
    $('#empty').textContent = 'The listings file could not be loaded. If this is a fresh checkout, run `npm run fetch` first.';
    return;
  }

  refreshRanking();
  renderHeader();
  renderFilterControls();
  render();
}

init();
