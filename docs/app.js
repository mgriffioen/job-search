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

const STORE_KEY = 'emily-job-board:v1';
const PREFS_KEY = 'emily-job-board:prefs:v1';

const state = {
  jobs: [],
  meta: null,
  view: 'all',
  focusIndex: -1,
  visible: [],
  store: loadStore(),
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

function workTypeLabel(job) {
  switch (job.workType) {
    case 'remote':
      return job.locationScope === 'remote-anywhere' ? 'Remote (anywhere)' : 'Remote (US)';
    case 'hybrid':
      return 'Hybrid — local';
    case 'onsite':
      return 'On-site — local';
    default:
      return 'Setup unspecified';
  }
}

const TIER_LABEL = {
  strong: 'Strong match',
  good: 'Good match',
  possible: 'Worth a look',
  stretch: 'Stretch',
};

/* ---------------------------------------------------------------
   Filtering & sorting
   --------------------------------------------------------------- */

function readFilters() {
  const checked = (name) => $$(`input[name="${name}"]:checked`).map((el) => el.value);
  return {
    query: $('#q').value.trim().toLowerCase(),
    sort: $('#sort').value,
    workTypes: checked('workType'),
    employment: checked('employment'),
    sources: $$('#source-filters input:checked').map((el) => el.value),
    minMatch: Number($('#min-match').value),
    maxAge: Number($('#max-age').value),
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

    if (!f.workTypes.includes(job.workType)) return false;
    if (!job.employmentTypes.some((t) => f.employment.includes(t))) return false;
    if (f.sources.length && !job.sources.some((s) => f.sources.includes(s))) return false;
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
      return copy.sort((a, b) => b.rank - a.rank);
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
  chips.append(makeChip(TIER_LABEL[job.matchTier], 'tier'));
  chips.append(makeChip(workTypeLabel(job)));
  for (const type of job.employmentTypes) {
    if (type !== 'unspecified') chips.append(makeChip(type));
  }
  if (job.salary) chips.append(makeChip(job.salary, 'salary'));
  chips.append(makeChip(job.sources.join(' · '), 'source'));

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

  const note = $('.note', node);
  const textarea = $('[data-note]', node);
  note.classList.toggle('is-open', isSaved || isApplied);
  textarea.value = state.store.notes[job.id] || '';

  return node;
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

  const strong = visible.filter((j) => j.matchTier === 'strong').length;
  const fresh = visible.filter((j) => j.ageDays !== null && !j.ageAssumed && j.ageDays <= 2).length;
  $('#resultline').innerHTML = '';
  $('#resultline').append(
    document.createTextNode('Showing '),
    boldText(String(visible.length)),
    document.createTextNode(` of ${state.jobs.length} matches`),
    document.createTextNode(strong ? ` · ${strong} strong` : ''),
    document.createTextNode(fresh ? ` · ${fresh} new in 48h` : '')
  );

  updateFilterBadge(filters);
  updateStats();
  state.focusIndex = -1;
}

function boldText(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function updateFilterBadge(f) {
  const active = [];
  if (f.minMatch > 0) active.push(`match ≥ ${f.minMatch}`);
  if (f.maxAge < 46) active.push(`≤ ${f.maxAge}d old`);
  if (f.workTypes.length < 4) active.push('work setup');
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
    ['Status', 'Saved on', 'Applied on', 'Match', 'Title', 'Company', 'Location', 'Schedule', 'Salary', 'Posted', 'Source', 'URL', 'Notes'],
    ...tracked.map((j) => [
      state.store.applied[j.id] ? 'Applied' : 'Saved',
      (state.store.saved[j.id] || '').slice(0, 10),
      (state.store.applied[j.id] || '').slice(0, 10),
      j.match,
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
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `job-applications-${new Date().toISOString().slice(0, 10)}.csv`;
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
    name: 'LinkedIn — Kalamazoo area',
    desc: 'Within 40 miles of home',
    url: 'https://www.linkedin.com/jobs/search/?keywords=marketing%20OR%20%22quality%20assurance%22%20OR%20editor&location=Kalamazoo%2C%20Michigan&distance=40&f_TPR=r604800&sortBy=DD',
  },
  {
    name: 'Indeed — remote email marketing',
    desc: 'Remote, last 7 days',
    url: 'https://www.indeed.com/jobs?q=%22email+marketing%22+or+%22quality+assurance%22+or+proofreader&l=Remote&fromage=7&sort=date',
  },
  {
    name: 'Indeed — Kalamazoo, MI',
    desc: 'Within 35 miles, last 7 days',
    url: 'https://www.indeed.com/jobs?q=marketing+or+%22quality+assurance%22+or+editor&l=Kalamazoo%2C+MI&radius=35&fromage=7&sort=date',
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
    name: 'Michigan Works!',
    desc: 'State job bank, Kalamazoo region',
    url: 'https://www.michiganworks.org/',
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
    if (source.detail) row.title = source.detail;
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
    $$('#controls input[type="checkbox"]').forEach((el) => { el.checked = el.id !== 'hide-applied'; });
    $('#min-match').value = 0;
    $('#min-match-out').textContent = '0';
    $('#max-age').value = 46;
    $('#max-age-out').textContent = 'any time';
    $('#q').value = '';
    render();
  });

  $('#export-csv').addEventListener('click', exportCsv);
  $('#theme-toggle').addEventListener('click', cycleTheme);

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
      const min = stat.dataset.tierFilter === 'strong' ? 70 : 50;
      $('#min-match').value = String(min);
      $('#min-match-out').textContent = String(min);
      $('#filters').open = true;
    }
    if (stat.dataset.ageFilter) {
      $('#max-age').value = stat.dataset.ageFilter;
      $('#max-age-out').textContent = '2 days';
      $('#filters').open = true;
    }
    setView('all');
  });

  $('#results').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const card = button.closest('.card');
    handleAction(button.dataset.action, card.dataset.id);
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

async function loadData() {
  const bust = `?t=${Date.now()}`;
  const [jobs, meta] = await Promise.all([
    fetch(`data/jobs.json${bust}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
    fetch(`data/meta.json${bust}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  ]);
  state.jobs = Array.isArray(jobs) ? jobs : [];
  state.meta = meta;
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
  $('#stat-strong').textContent = String(meta.tiers?.strong ?? 0);
  $('#stat-good').textContent = String(meta.tiers?.good ?? 0);
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
    $('#empty').textContent = `Could not load data/jobs.json (${err.message}). If you are opening this file directly, run "npm run serve" instead — browsers block fetch on file:// URLs.`;
    return;
  }

  renderHeader();
  renderSourceControls();
  render();
}

init();
