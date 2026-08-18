# Emily's Job Board

A self-updating job board tuned to one résumé: 10 years of QA on HTML email and
web content for digital marketing campaigns, plus an editorial and teaching
background, based in Kalamazoo, Michigan.

**Remote roles only**, full-time or part-time. Twice a day a GitHub Action pulls
postings from every free job API that will talk to it, drops anything that isn't
remote or isn't open to a Michigan resident, scores what remains against the
résumé, and commits the result. The site is a static page — no server, no
database, no accounts, nothing to pay for.

**Live site:** <https://mgriffioen.github.io/job-search/>

---

## Setup — three steps, about five minutes

### 1. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment**

- Source: **Deploy from a branch**
- Branch: **your default branch**, folder: **`/docs`** → **Save**

The URL appears at the top of that page a minute later.

### 2. Make sure Actions is enabled

Repo **Settings → Actions → General**

- **Actions permissions**: *Allow all actions and reusable workflows*
- **Workflow permissions**: *Read and write permissions* → **Save**

The second one lets the workflow commit updated listings back to the repo. If
**Update job listings** is missing from the Actions tab, this setting is the
first thing to check — GitHub does not register workflow files at all while
Actions is disabled for the repository.

### 3. Run it once by hand

Repo **Actions → Update job listings → Run workflow**

It takes a minute or two. When it finishes, the site has jobs on it. From then
on it runs itself at roughly 2am and noon Eastern.

> **Note on branches.** GitHub registers scheduled and manually-run workflows
> only from the repository's **default branch**. This project was pushed to
> `claude/job-search-qa-specialist-ny8k3g`, which GitHub made the default
> because it was the first branch in an empty repo. Renaming it to `main`
> (**Settings → Branches → pencil icon**) is worth doing — the `push` trigger
> below already accepts both names.

---

## Getting LinkedIn, Indeed and ZipRecruiter listings

None of those three offer a public feed. Indeed closed its Publisher API to
non-partners and retired its RSS feeds; LinkedIn has no public jobs API at all
(theirs is partner-only, for *posting* jobs); ZipRecruiter's is partner-gated.
Scraping them breaches their terms and gets blocked quickly.

What does work is going through an aggregator that licenses their content.
Google for Jobs indexes all three, and **JSearch** serves Google for Jobs
results with the originating board named — so a LinkedIn posting arrives
labelled *LinkedIn*, both on the card and in the board filter.

1. Sign up at [JSearch on RapidAPI](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch)
2. Subscribe to the **Basic (free)** plan — roughly 200 requests/month
3. Add the key as the `RAPIDAPI_KEY` repository secret

Because the free tier is metered, this source runs a **moving window** of
`search.queries` rather than the whole list — up to `search.jsearchQueriesPerRun`
(3) per run, advancing each run, so the full keyword list is covered over a
couple of days. Every other source runs the full list every time.

### Staying inside the free quota

RapidAPI bills for every request past the monthly allowance, so
`jsearchQueriesPerRun` is a **ceiling, not a promise**. Before spending
anything, each run reads how much quota is left and how long the period still
has to run, and takes an even share of the remainder:

- **The count comes from RapidAPI, not from us.** Every response carries the
  meter in its headers; the reading is stored in `docs/data/meta.json` and
  carried into the next run. Nothing to drift out of sync with the real bill.
- **A reserve is never spent.** `jsearchQuota.reserve` (12) is the cushion that
  absorbs unplanned requests — a manual run, an endpoint probe — without any of
  them costing money. Runs stop dead when only the reserve is left.
- **Spend early and later runs get less.** Burn the quota in week one and the
  pacing thins out to one request every few runs rather than stopping outright,
  so listings keep arriving until the meter resets.
- **Pushes do not spend quota.** The workflow also runs on pushes that touch
  `scripts/` or `config/`, which used to cost requests every time a file was
  edited. JSearch now sits those out (`JSEARCH_ENABLED`); the free boards still
  refresh, and the next scheduled run picks it back up within twelve hours. Use
  **Run workflow** on the Actions tab if you need it immediately.

Every run prints where the quota stands in its Actions summary, so you can see
it without logging into RapidAPI. If you move to a paid plan, raise
`jsearchQueriesPerRun` and set `jsearchQuota.monthlyLimit` to the new
allowance.

### Adding a search term

Two places, and both matter:

1. **`search.queries`** — what gets searched.
2. **A `titles` group** — so the matcher recognises it. Skip this and the search
   finds the postings but they score near nothing, which looks identical to the
   term not working.

`broadQueries` is a separate, shorter list for Adzuna and Jobicy, which index the
whole market and return nothing for a long phrase — keep those terms to two
words. It rotates `broadQueriesPerRun` (12) terms per run, so the list can grow
without the per-run API cost growing with it.

**[Jooble](https://jooble.org/api/about)** is worth adding alongside it — free
key on request, broader but patchier, and it also reports which board each
posting came from. Add it as `JOOBLE_API_KEY`. Running both and letting
de-duplication merge them beats either alone; a job found in three places shows
all three names on one card rather than appearing three times.

Coverage is partial either way, which is why the site keeps a panel of
pre-built searches for those boards. Two things close the rest of the gap:

- **Job alert emails.** Alerts you subscribe to on LinkedIn, Indeed and
  ZipRecruiter are sent to you legitimately. Point them at a dedicated address
  and they become a feed nobody can cut off. Not wired up here — ask if you
  want it built.
- **Company career pages.** For employers she actually wants, the ATS adapters
  below beat every aggregator: same-day, complete, and free.

## Optional: wider remote coverage with Adzuna

The other sources are remote-job boards, so they only see companies that post
there. **Adzuna** indexes a much broader slice of the market — including remote
roles at companies that only advertise on their own site or on general job
boards. It needs a free key.

1. Register at <https://developer.adzuna.com/> (free, instant).
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   - `ADZUNA_APP_ID` — your Application ID
   - `ADZUNA_APP_KEY` — your Application Key

Without the key, Adzuna quietly skips itself and everything else still works.

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

- Everything on the board is remote and open to a Michigan resident — that gate
  runs before scoring, so nothing on the page needs a location sanity-check.
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
| [Adzuna](https://www.adzuna.com/) | **yes** (free) | Broad US remote, beyond the remote-only boards |
| [JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) | **yes** (free tier) | **Google for Jobs — LinkedIn, Indeed, ZipRecruiter, Glassdoor** |
| [Jooble](https://jooble.org/api/about) | **yes** (free) | Broad aggregation, names the origin board |
| Company career pages | no | Greenhouse / Lever / Ashby boards you list |

Postings that arrive via an aggregator carry the board they came from, so the
card shows *Google Jobs · LinkedIn* and both names appear in the board filter.
A job found on several boards collapses to one card listing all of them.

The **"Where these came from"** strip at the bottom of the page shows which
sources answered on the last run. A red dot means that board was down or
rate-limited that time; it does not affect the others.

---

## Two boards: v1 and v2

The board runs **two matching models over the same postings**, switchable in the
header (`?board=v2` in the URL, so a board can be linked or bookmarked).

| | v1 — title-driven | v2 — ability-based |
| --- | --- | --- |
| What carries the score | The job title (max 50 of 95) | What she can do (max 46 of 100) |
| Title weight | 50 | 22 |
| Finds | Roles named like hers | Roles that want her abilities under any name |
| Extras | — | **New direction** badges, role families, the reason each fits |
| Data | `docs/data/` | `docs/data/v2/` |

**One fetch feeds both.** Scoring is pure CPU, so the second model costs nothing
at the APIs — which matters, because JSearch is billed per request and running
the pipeline twice would double every call.

**v2 is an overlay, not a copy.** `config/profile.v2.json` holds only what
defines its matching model: capabilities, role families, its ranking knobs, and
the title groups it moves into families. Search terms, engagement signals,
skills, penalties and the location gate are all inherited from
`config/profile.json`. That is deliberate — if the two boards differed in what
they searched for as well as how they scored, a difference between them would
not be attributable to the model. **Put shared changes in `profile.json`; put
only model-defining changes in `profile.v2.json`.**

The two scorers are separate files (`scripts/lib/score.mjs`,
`scripts/lib/score-v2.mjs`) and duplicate some helpers. That is also deliberate:
the models differ in their caps and in the shape of the title signal, so sharing
would mean parameterising v1 — and v1 is the live board, which should not move
because an experiment beside it changed.

### Work she can do but does not want

She is fluent in Spanish and holds a graduate degree in it. She does not want a
job that is *about* the language, so bilingual, translation and localisation
work is kept off both boards:

- Titles naming a language are on `excludeTitlePhrases` — a hard exclusion, not
  a low score.
- Nothing scores the language as a positive any more. That half matters as much
  as the exclusion: while Spanish earned points, every language-adjacent posting
  drifted upward. v1 had a *Localization / bilingual* title group worth 34 and a
  Spanish skill; v2 had a graduate-Spanish capability and a whole localisation
  role family. All removed.
- A posting that *requires* Spanish is penalised even when its title is silent,
  but one where Spanish is "a plus" is left alone — she has the skill, and a role
  she would otherwise want should not be punished for mentioning it.

## How the ranking works

Each posting gets two independent scores.

**Match (0–100)** — four components, in
[`scripts/lib/score.mjs`](scripts/lib/score.mjs):

| Component | Max | What it measures |
| --- | --- | --- |
| Title | 50 | The strongest job-title family that matches, plus partial credit for a second |
| Skills | 35 | Résumé skills found anywhere in the posting, with diminishing returns per additional hit |
| Context | 10 | Domain and seniority fit — marketing, mid-level, part-time-friendly, fully remote |
| Engagement | +12 | Contract, freelance, project- and deliverable-based framing. A bonus, not part of the denominator |
| Penalties | −38 | Signals this is the wrong kind of role, doubled when they appear in the title |

Diminishing returns matter: a posting that lists thirty tools cannot out-score a
posting that genuinely describes her job. Penalties are what keep "QA Automation
Engineer" from ranking alongside "QA Specialist" — they share a title prefix but
almost nothing else.

Two rules sit on top of the title component:

- **Combination titles.** Phrase matching is contiguous, so `lifecycle marketing qa`
  would catch *"Lifecycle Marketing QA Analyst"* and miss *"QA Analyst, Lifecycle
  Marketing"* — the same job, titled the other way round. `titleCombinations` in
  `config/profile.json` instead requires one QA word **and** one marketing-discipline
  word anywhere in the title, in any order. That covers Marketing QA, Email QA, CRM QA,
  Lifecycle Marketing QA, Digital Production QA, Campaign QA and Marketing Operations QA
  however they are worded, and scores above every single-phrase group.
- **Bullseye title floor.** Jooble and the RSS feeds return a snippet rather than a
  full description, so those postings cannot earn the skill points they deserve. A title
  naming one of her exact roles floors the match at `ranking.bullseyeTitleFloor` (72),
  but only when nothing in the posting counts against it — so *"Marketing QA Automation
  Engineer"* is still held down by the automation penalties.

### Contract, freelance and project work

The target is not only a permanent remote job: it is **high-judgment,
detail-intensive, project- or deliverable-based content/brand/e-commerce QA and
auditing work, remote**. Contract framing is therefore scored in its own right —
`engagement` in `config/profile.json`, worth up to 12 points for contract,
freelance, project- and deliverable-based language, plus flexible capacity.

Those points are a **bonus on top of** the fit score rather than part of its
denominator. That distinction matters: widening the denominator would have
docked every permanent posting about 11% for no reason of its own, dropping
settled matches a whole tier. As a bonus, permanent roles stay exactly where they
were and only the work being sought moves up.

Postings are flagged `projectBased`, get their own **contract / freelance**
counter and filter on the board, and a *project-based* chip where the source did
not already label them contract. Employment-type detection also treats
"statement of work", "per project", "1099" and "retainer" as contract work, so
those listings reach the contract filter even when they never use the word.

Two cautions learned by measuring:

- The engagement vocabulary deliberately excludes *engagement*, *as needed*,
  *ad hoc* and *on demand*. Permanent postings use them constantly — and in law
  and marketing especially — and they pulled an immigration attorney and a
  professorship onto the board.
- Recruiting mills advertise flexible, no-experience work, which is exactly what
  these signals reward. Ten such listings sat on the board and the bonus lifted
  one into the strong band, so lead-generation markers are now penalised and
  "call now" is an outright exclusion.

Remote is still a hard gate (`location.remoteOnly`). Contract work is an
addition to the target, not a replacement for it.

**Recency (0–100)** — halves every 14 days. A posting with no date is treated as
three weeks old rather than brand new, so undated listings don't crowd out real
ones.

**Best overall** = 72% match + 28% recency.

Before any of that, two hard gates run:

1. **Remote and Michigan-eligible.** A posting has to clear all three:
   - it must be *stated* remote — on-site and hybrid are dropped, and so is
     anything with no positive sign of being remote, rather than being given the
     benefit of the doubt;
   - it must not be fenced to another country ("Remote — Europe");
   - it must not be fenced to a state list that excludes Michigan
     ("Remote (California, New York)"). A posting that says USA, nationwide or
     anywhere passes even if it also names a city.
2. **Relevance floor.** Anything scoring under 20, older than 45 days, or matching
   the hard-exclude title list never reaches the site.

**If she ever wants local Kalamazoo jobs back**, set `location.remoteOnly` to
`false` in `config/profile.json`. On-site and hybrid roles within commuting range
of the cities listed there start qualifying again, and Adzuna adds a 50-mile
local search.

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
