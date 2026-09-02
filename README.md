# Emily's Job Board

A self-updating job board for one person: 10 years of QA on HTML email and web
content for digital marketing campaigns, plus an editorial and teaching
background, based in Kalamazoo, Michigan.

**Live site:** <https://mgriffioen.github.io/job-search/>

---

## How it works

One rule:

> **A posting is published if one of the search terms in
> [`config/profile.json`](config/profile.json) appears in it.**

That is the whole matching model. Twice a day a GitHub Action asks every free
job API it can reach for those terms, drops anything that isn't remote or isn't
open to a Michigan resident, drops anything older than 60 days, keeps everything
a term appears in, and commits the result. The site is a static page — no
server, no database, no accounts, nothing to pay for.

There is no minimum score, no penalty list, no exclusion phrases and no
occupational gate.

### The number on a card

It is **not** a verdict on the job. It says **where** the term was found, which
is the only thing a keyword match can honestly tell you:

| Where | Number | Means |
| --- | --- | --- |
| In the **title** | 40–100 | the job *is* that role |
| In the **tags** | 45 | the board filed it under that |
| In the **description** | 30 | the work is mentioned |

A title match is scored by how much of the title the term accounted for —
`Proofreader` is 100, `Senior Copy Editor, Trust & Safety` is 64. A long title
is not a worse job; it is a less certain match, and it sorts lower for that
reason alone. **Best overall** blends that number with how recently the posting
went up, so every title match sits above every description match.

**A word may be slipped into the middle of a term.** "Digital Content Project
Specialist" is a `digital content specialist`; titles insert Project, Quality or
Marketing as a matter of routine. The term's words must still appear *in order*
and within two words of their natural span, so this is a near-miss on the
phrase and not a bag of words — a title with "content" and "specialist" at
opposite ends is still not that role. A loosened match is capped at 85.

**One-word terms only count in the title or the tags.** `proofreader` as a title
is the job; any posting on earth can mention an editor in passing. Multi-word
terms like `content quality specialist` may match anywhere — nothing says that
phrase by accident. Only the first 1,800 characters of a description are read,
which is the part that says what the job is rather than what the company
believes in.

This matters because most sources are searched *by keyword* and return whatever
matched their full text. A title-only rule threw away almost everything the
search had just found — 17 postings out of 1,026 on a real run, most of them
"Video Editor" caught by the generic term `editor`. If the description matches
start to feel like noise, the **Title matches** tile at the top of the page (and
the matching checkbox in Filters) collapses the list back to title matches
only.

### Teaching it what you actually want

The list is wide on purpose, which means some of it will be wrong. That is what
the buttons under each card are for:

- **👍 More like this** — right kind of work. Learns from everything about it.
- **👎 Not for me** — this posting is not wanted, but the category may be fine.
  Learns cautiously, and asks **why**.
- **🚫 Wrong kind of work** — the term that found this should not have. Hides it,
  and learns hard about that term and that employer.

### Saying why

A 👎 opens a row of optional reasons. "Not for me" says a posting was wrong;
the reason says *which part* was wrong, and that is what lets one rating
generalise correctly instead of quietly marking down the employer and the
search term for a fault that belonged to neither.

| Reason | Generalises through |
| --- | --- |
| Too much writing | roles that **make** content rather than check it |
| Too technical | postings that treat writing code as the job |
| Wrong industry | the line of business, charged to that industry alone |
| Too senior / Too junior | the seniority read from the job title |
| Poor pay | the best pay you have turned down becomes a floor |
| Not flexible | postings offering neither contract nor part-time |
| Other | nothing — it affects only this posting |

**Every reason is selectable on every card.** The board's reading of a posting
is a guess — seniority comes from the title, industry from a phrase list — and
you are the one who read the job. "Too senior" on a title this code called
mid-level is you correcting it, and it still teaches every posting the board
*did* read as senior.

What that cannot do is cost you anything. A reason *redirects* blame away from
the search term and the employer and onto the fact it names, and the redirect
only fires when that fact is actually on the posting. Give a reason with nothing
here to carry it and the rating costs exactly what a plain 👎 costs — never
less.

Two things make the chips safe to use. **Naming the fault never costs a posting
more than staying silent**: a reason *redirects* blame rather than adding to it,
so the search term and the employer absorb less of it, not more. And a reason is
applied **in full from the first time you give it** — the rest of the model
whispers until there is evidence behind it, because it is inferring; "too
senior" is something you said.

Every reason is decided from a field the board actually publishes, so a chip can
never be a promise the data cannot keep. Three of them need vocabulary, all of
it in `config/profile.json` and none of it used for filtering:

- **`writingTerms`** — which search terms describe making content rather than
  checking it. A term not listed is treated as review work, because
  mislabelling a proofreading job as writing would teach the wrong lesson while
  missing one merely teaches less.
- **`technicalPhrases`** — writing code *as the job*. Technical literacy is
  never counted: HTML, CSS, templates, spreadsheets, Jira and CMSs are daily
  tools and appear nowhere in the list. That absence is what makes **one** hit
  enough — every phrase left is decisive on its own (`sdet`, `test automation`,
  `write code`). Add a daily tool to this list and the chip starts greying out
  the wrong half of the page.
- **`industries`** — 15 lines of business, deliberately neutral rather than a
  list of favourites, because "Wrong industry" is only useful if it can name the
  industry you actually meant. A posting matching none carries no industry, and
  that chip is greyed out on it.

Each rating stores the *categories* the posting belonged to, not the posting —
the search term its title matched, the employer, the shape of the engagement,
the seniority. Those carry forward, so twenty ratings become a preference over
categories rather than a list of dead links.

The matched term is the important one. "Video Editor" is on the page because it
matched `editor`; "Marketing Copy Editor" is there because it matched
`marketing copy editor`. A 👎 on the first teaches `editor` and leaves the second
alone — the term list learns its own shape without anybody editing it.

Deliberately cautious, for one reason: the point of a wide list is to surface
work you would not have searched for, and an over-eager learner closes exactly
those doors. So every category saturates after three consistent ratings, and the
total is capped at ±20 rank points — enough to reorder the list, never enough to
hide a category you have not actually rejected. Ratings move **where a posting
sits**, never the number on its card.

Ratings live in that browser's local storage. **Export ratings** / **Import
ratings** in the filter panel move them to another browser; nothing is uploaded.

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

> **The default branch is `main`, and it matters which branch that is.** GitHub
> only registers scheduled and manually-run workflows from the **default
> branch**, and GitHub Pages serves `/docs` from it — so the twice-daily update
> and the site both follow it. If it ever needs changing again, use
> **Settings → Branches → pencil icon → Rename branch**, which repoints the
> default, carries the Pages source across, retargets open pull requests and
> leaves a redirect so existing clones keep working. Creating a branch by hand
> and hoping it takes over leaves two trunks, one of them a decoy.

---

## Changing what it looks for

Everything is one list: `searchTerms` in
[`config/profile.json`](config/profile.json).

Add a term and it is used for both halves of the job — it is sent to the job
boards as a query, *and* it is what a title is checked against. There is nothing
else to keep in sync, and no weight to pick.

```json
"searchTerms": [
  "content quality specialist",
  "proofreader",
  "copy editor",
  ...
]
```

Two things worth knowing:

- **Order matters only for JSearch**, which is metered and spends its few calls
  per run starting from the top of the list. Everything else rotates over the
  whole thing.
- **`broadTerms` is fetch-only.** Adzuna, Jobicy and Jooble search a broad index
  and return nothing for a phrase like `product content quality specialist`, so
  they get short terms instead. Those widen what comes *back*; they do not decide
  what gets *published*. Everything fetched still has to match a `searchTerm` by
  title.

If a term is pulling in junk, you have two options and both are fine: delete it,
or leave it and press 🚫 on what it drags in. The **Matched search term** filter
in the panel shows how many postings each term actually produced, and
`docs/data/meta.json` records the same counts every run — that is the honest
measure of whether a term is earning its place.

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

### Staying inside the free quota

RapidAPI bills for every request past the monthly allowance, so
`search.jsearchTermsPerRun` is a **ceiling, not a promise**. Before spending
anything, each run reads how much quota is left and how long the period still
has to run, and takes an even share of the remainder:

- **The count comes from RapidAPI, not from us.** Every response carries the
  meter in its headers; the reading is stored in `docs/data/meta.json` and
  carried into the next run.
- **A reserve is never spent.** `jsearchQuota.reserve` (12) absorbs unplanned
  requests — a manual run, an endpoint probe — without any of them costing
  money. Runs stop dead when only the reserve is left.
- **Spend early and later runs get less.** Burn the quota in week one and the
  pacing thins to one request every few runs rather than stopping outright.
- **Pushes do not spend quota.** The workflow also runs on pushes that touch
  `scripts/` or `config/`. JSearch sits those out (`JSEARCH_ENABLED`); the free
  boards still refresh, and the next scheduled run picks it back up within
  twelve hours. Use **Run workflow** if you need it immediately.

Every run prints where the quota stands in its Actions summary. On a paid plan,
raise `jsearchTermsPerRun` and set `jsearchQuota.monthlyLimit` to the new
allowance.

## Optional: wider remote coverage with Adzuna

The other sources are remote-job boards, so they only see companies that post
there. **Adzuna** indexes a much broader slice of the market. It needs a free key.

1. Register at <https://developer.adzuna.com/> (free, instant).
2. Repo **Settings → Secrets and variables → Actions → New repository secret**:
   - `ADZUNA_APP_ID` — your Application ID
   - `ADZUNA_APP_KEY` — your Application Key

Without the key, Adzuna quietly skips itself and everything else still works.
`JOOBLE_API_KEY` works the same way.

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

- Everything on the page is remote and open to a Michigan resident — that gate
  runs before matching, so nothing needs a location sanity-check.
- **Matched search term** on each card says which of your terms put it there,
  and whether it was found in the title, the tags or the description.
- **Title matches** at the top, or the checkbox in Filters, collapses the list
  to postings that are actually *titled* one of your roles.
- **★ Save**, **✓ Applied** and **Dismiss** track progress. **Dismiss** removes
  one listing and teaches nothing; 🚫 removes it *and* teaches. 👍 and 👎 never
  remove anything — a rated card stays exactly where it is, so you can add a
  reason to it, and the board settles into its new order the next time you
  change a filter, a sort or a tab.
- A notes field opens on every card — contact names, follow-up dates.
- **Export saved + applied to CSV** produces an application tracker.
- Everything you save stays in that browser's local storage. It is never
  uploaded, which also means it doesn't sync between laptop and phone.
- Keyboard: <kbd>/</kbd> search, <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>s</kbd> save,
  <kbd>a</kbd> applied, <kbd>x</kbd> dismiss, <kbd>Enter</kbd> open,
  <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> for 👍/👎/🚫.

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
| [Adzuna](https://www.adzuna.com/) | **yes** (free) | Broad US remote |
| [JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch) | **yes** (free tier) | **Google for Jobs — LinkedIn, Indeed, ZipRecruiter, Glassdoor** |
| [Jooble](https://jooble.org/api/about) | **yes** (free) | Broad aggregation, names the origin board |
| Company career pages | no | Greenhouse / Lever / Ashby boards you list |

Postings that arrive via an aggregator carry the board they came from, so a card
shows *Google Jobs · LinkedIn* and both names appear in the board filter. A job
found on several boards collapses to one card listing all of them.

The **"Where these came from"** strip at the bottom of the page shows which
sources answered on the last run. A red dot means that board was down or
rate-limited that time; it does not affect the others.

---

## Working on it locally

```bash
npm test          # unit tests — matching, location gate, dedupe, ratings
npm run stamp     # refresh the cache-busting stamps after editing docs/
npm run fetch     # pull live postings → docs/data/
npm run serve     # preview at http://localhost:4173
npm start         # fetch then serve
```

No dependencies to install — everything uses the Node standard library, so
`npm test` and `npm run fetch` work on a clean checkout with Node 20+.

**After editing anything in `docs/`, run `npm run stamp`.** The board fetches its
data with a cache-buster but references its own code by bare name, so a browser
that had the site open across a deploy would run the *old* script against the
*new* data. Every asset URL carries a hash of its own contents, `npm run serve`
refreshes them, and `npm test` fails if they are stale.

Open `docs/index.html` directly and the page will load but stay empty; browsers
block `fetch` on `file://` URLs. Use `npm run serve`.

## Layout

```
config/
  profile.json          search terms, broad terms, location rules — the whole configuration
  company-boards.json   specific company career pages to watch
scripts/
  fetch-jobs.mjs        orchestrator: fetch → normalize → dedupe → filter → match → write
  stamp-assets.mjs      content hashes on the page's asset URLs, so a deploy is never cached over
  serve.mjs             local preview server
  lib/match.mjs         the whole matching model
  lib/                  http, text, xml, location gate, normalizer, query rotation
  sources/              one adapter per job board
docs/                   the site itself (GitHub Pages serves this folder)
  preferences.mjs       the 👍/👎/🚫 training model, shared by the page and the tests
  data/                 jobs.json + meta.json, rewritten by the Action
tests/                  unit tests, no network required
```

A failing source can never fail the run: each adapter is isolated, and its error
is recorded in `docs/data/meta.json` and shown on the page.
