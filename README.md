# Emily's Job Board

A self-updating job board tuned to one résumé: 10 years of QA on HTML email and
web content for digital marketing campaigns, plus an editorial and teaching
background, based in Kalamazoo, Michigan.

Twice a day a GitHub Action pulls postings from every free job API that will
talk to it, filters out anything that isn't workable from Kalamazoo, scores what
remains against the résumé, and commits the result. The site is a static page —
no server, no database, no accounts, nothing to pay for.

**Live site:** `https://<your-github-username>.github.io/job-search/`
(after the one-time setup below)

---

## Setup — three steps, about five minutes

### 1. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment**

- Source: **Deploy from a branch**
- Branch: **`main`**, folder: **`/docs`** → **Save**

The URL appears at the top of that page a minute later.

### 2. Allow the Action to commit

Repo **Settings → Actions → General → Workflow permissions**

- Select **Read and write permissions** → **Save**

### 3. Run it once by hand

Repo **Actions → Update job listings → Run workflow**

It takes a minute or two. When it finishes, the site has jobs on it. From then
on it runs itself at roughly 2am and noon Eastern.

---

## Optional: add local Kalamazoo listings

Every free source above is remote-only. **Adzuna** is the one that also indexes
local postings, and it needs a free key.

1. Register at <https://developer.adzuna.com/> (free, instant).
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   - `ADZUNA_APP_ID` — your Application ID
   - `ADZUNA_APP_KEY` — your Application Key

The next run picks up jobs within 50 miles of Kalamazoo alongside the remote
ones. Without the key, Adzuna quietly skips itself and everything else still works.

## Optional: watch specific companies

The highest-signal postings come straight from a company's own careers page,
often days before they reach any aggregator. Add companies to
[`config/company-boards.json`](config/company-boards.json):

```json
{
  "boards": [
    { "ats": "greenhouse", "token": "acmecorp", "name": "Acme Corp" },
    { "ats": "lever",      "token": "exampleco", "name": "Example Co" },
    { "ats": "ashby",      "token": "thirdco",   "name": "Third Co" }
  ]
}
```

Find the token in the company's careers URL:

| Careers URL | `ats` | `token` |
| --- | --- | --- |
| `job-boards.greenhouse.io/acmecorp` | `greenhouse` | `acmecorp` |
| `jobs.lever.co/exampleco` | `lever` | `exampleco` |
| `jobs.ashbyhq.com/thirdco` | `ashby` | `thirdco` |

Worth adding: marketing agencies, email platforms (Klaviyo, Braze, Iterable,
Attentive), retail/e-commerce brands with in-house email teams, and large
Michigan employers (Stryker, Kellanova, Perrigo, Whirlpool, WMU).

---

## Using the board

- **Best overall** blends match quality with how recently a job was posted, so a
  very good match from three weeks ago still outranks a mediocre one from today —
  but not by much. Switch to **Highest match** or **Most recent** to sort on one
  axis alone.
- **Why it matched** on each card shows exactly which phrases earned or lost
  points. If a job is ranked wrong, that panel tells you which keyword to fix in
  `config/profile.json`.
- **★ Save**, **✓ Applied** and **Dismiss** track progress. A notes field opens on
  anything saved or applied — good for contact names and follow-up dates.
- **Export saved + applied to CSV** produces an application tracker you can open
  in Excel or Google Sheets.
- Everything you save stays in that browser's local storage. It is never uploaded,
  which also means it doesn't sync between her laptop and phone.
- Keyboard: <kbd>/</kbd> search, <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>s</kbd> save,
  <kbd>a</kbd> applied, <kbd>x</kbd> dismiss, <kbd>Enter</kbd> open.

---

## Where the listings come from

| Source | Key needed | Covers |
| --- | --- | --- |
| [Remotive](https://remotive.com/) | no | Remote, keyword-searched |
| [We Work Remotely](https://weworkremotely.com/) | no | Remote, marketing/support/design feeds |
| [Himalayas](https://himalayas.app/) | no | Remote, all categories |
| [Jobicy](https://jobicy.com/) | no | Remote, US-filtered by industry |
| [RemoteOK](https://remoteok.com/) | no | Remote, all categories |
| [Working Nomads](https://www.workingnomads.com/) | no | Remote, curated |
| [Arbeitnow](https://www.arbeitnow.com/) | no | Mostly EU; occasional US remote |
| [Adzuna](https://www.adzuna.com/) | **yes** (free) | **Local Kalamazoo** + US remote |
| Company career pages | no | Greenhouse / Lever / Ashby boards you list |

**LinkedIn, Indeed and ZipRecruiter are deliberately absent.** None of them offer
a free public feed, and scraping them violates their terms and gets blocked
quickly. Instead the site's *"Search the boards that can't be aggregated"* section
holds pre-built searches for those sites with the same criteria — one click each,
worth doing a couple of times a week.

The **"Where these came from"** strip at the bottom of the page shows which
sources answered on the last run. A red dot means that board was down or
rate-limited that time; it does not affect the others.

---

## How the ranking works

Each posting gets two independent scores.

**Match (0–100)** — four components, in
[`scripts/lib/score.mjs`](scripts/lib/score.mjs):

| Component | Max | What it measures |
| --- | --- | --- |
| Title | 45 | The strongest job-title family that matches, plus partial credit for a second |
| Skills | 35 | Résumé skills found anywhere in the posting, with diminishing returns per additional hit |
| Context | 10 | Domain and seniority fit — marketing, mid-level, part-time-friendly, fully remote |
| Penalties | −38 | Signals this is the wrong kind of role, doubled when they appear in the title |

Diminishing returns matter: a posting that lists thirty tools cannot out-score a
posting that genuinely describes her job. Penalties are what keep "QA Automation
Engineer" from ranking alongside "QA Specialist" — they share a title prefix but
almost nothing else.

**Recency (0–100)** — halves every 14 days. A posting with no date is treated as
three weeks old rather than brand new, so undated listings don't crowd out real
ones.

**Best overall** = 72% match + 28% recency.

Before any of that, two hard gates run:

1. **Location.** Remote jobs must be open to US candidates — remote-but-EU-only is
   dropped. On-site and hybrid jobs must be within commuting range of Kalamazoo
   (the city list is in `config/profile.json`).
2. **Relevance floor.** Anything scoring under 20, older than 45 days, or matching
   the hard-exclude title list never reaches the site.

## Tuning the match score

Everything lives in [`config/profile.json`](config/profile.json) — no code
changes needed. Edit, commit, and the next run uses it (or run `npm run fetch`
locally to see the effect immediately).

- **Roles keep appearing that she doesn't want** → add a phrase to `penalties`
  (soft, reduces score) or `excludeTitlePhrases` (hard, removes entirely).
- **A good role ranks too low** → add its title to the right `titles` group, or
  raise that group's `weight`.
- **Too few results** → lower `search.minMatchScore` or raise `search.maxAgeDays`.
- **Too much noise** → raise `search.minMatchScore` to 30–35.
- **New skill to emphasise** → add it to `skills` with a weight of 4–10.

Phrases are matched on whole words, case-insensitively. Hyphens and slashes are
treated as spaces, so `copy editing` also matches "copy-editing" and
"QA/copy-editing".

## Working on it locally

```bash
npm test          # 28 unit tests — matching, location gate, scoring, dedupe
npm run fetch     # pull live postings → docs/data/
npm run serve     # preview at http://localhost:4173
npm start         # fetch then serve
```

No dependencies to install — everything uses the Node standard library, so
`npm test` and `npm run fetch` work on a clean checkout with Node 20+.

Open `docs/index.html` directly and the page will load but stay empty; browsers
block `fetch` on `file://` URLs. Use `npm run serve`.

## Layout

```
config/
  profile.json          résumé keywords, weights, location rules — the tuning knobs
  company-boards.json   specific company career pages to watch
scripts/
  fetch-jobs.mjs        orchestrator: fetch → normalize → dedupe → filter → score → write
  serve.mjs             local preview server
  lib/                  http, text, xml, location gate, scorer, normalizer
  sources/              one adapter per job board
docs/                   the site itself (GitHub Pages serves this folder)
  data/                 jobs.json + meta.json, rewritten by the Action
tests/                  unit tests, no network required
```

A failing source can never fail the run: each adapter is isolated, and its error
is recorded in `docs/data/meta.json` and shown on the page.
