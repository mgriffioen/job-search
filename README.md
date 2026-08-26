# Emily's Job Board

A self-updating job board tuned to one résumé: 10 years of QA on HTML email and
web content for digital marketing campaigns, plus an editorial and teaching
background, based in Kalamazoo, Michigan.

The work being looked for is **content and editorial quality**: somebody else
made it, and her job is to investigate it, find what is wrong, verify it against
a source of truth, and make sure it is right before it is published.

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

> **Rename the default branch to `main`.** This project was pushed to
> `claude/job-search-qa-specialist-ny8k3g`, which GitHub made the default
> because it was the first branch in an empty repo. Everything lives on it: the
> site, the twice-daily data commits, and the schedule (GitHub only registers
> scheduled and manually-run workflows from the **default branch**).
>
> **Settings → Branches → pencil icon → `main` → Rename branch.** GitHub does
> the rest in one move: it repoints the default, carries the Pages source
> across so the site keeps building, retargets any open pull requests, and
> leaves a redirect so existing clones keep working. The `push` trigger below
> already accepts `main`, so nothing stops.
>
> Do **not** do this by creating a `main` branch by hand instead. A new branch
> would not be the default, so Pages, the schedule and every data commit would
> carry on landing on the old branch while `main` quietly went stale — two
> trunks, one of them a decoy. The rename is the whole job.

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
2. **A `titles` group** (and, for v3 and v4, a `roleFamilies` entry in
   `config/profile.v3.json`) — so the matcher recognises it. Skip this and the
   search finds the postings but they score near nothing, which looks identical
   to the term not working. A test enforces it: every term the two lists name
   has to clear the publish threshold on a realistic posting.

`search.priorityQueries` is a third, shorter list — the twenty terms worth
spending a metered request on. JSearch is billed per call and can afford about
three per run, so it takes them from here rather than from anywhere in the
seventy-odd specific terms. Put a new term in `queries`; promote it to
`priorityQueries` only if it is worth displacing something already there.

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
- **👍 / 👎 / 🚫** under each v3 card tune the order — see *Teaching it what you
  actually want* below. **Dismiss** just removes one listing and teaches nothing.
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

## Four boards: v4, v3, v2 and v1

The board runs **four matching models over the same postings**, switchable in
the header. **v4 is what the site opens on**; `?board=v3`, `?board=v2` or
`?board=v1` in the URL selects another, so any board can be linked or
bookmarked.

| | **v4 — occupational fit** (default) | v3 — fit profile | v2 — ability-based | v1 — title-driven |
| --- | --- | --- | --- | --- |
| What carries the score | Whether the occupation is plausible at all, *then* v3's four axes | What the day involves, and which concepts appear together | What she can do (max 46 of 100) | The job title (max 50 of 95) |
| Title weight | Places the occupation; 22 of 90 towards work fit | 22 of 90, corroboration only | 22 | 50 |
| Reports | The occupational verdict, four axis scores, a recommendation, evidence, gaps and cautions | Four axis scores and the same report | One score | One score |
| Finds | Work she could plausibly be hired for and wants to do | Work she wants, under any title, that she is qualified for | Roles that want her abilities under any name | Roles named like hers |
| Volume | Fewest — precision over volume | Deliberately few | Many | Many |
| Data | `docs/data/v4/` | `docs/data/v3/` | `docs/data/v2/` | `docs/data/` |

**One fetch feeds all four.** Scoring is pure CPU, so the extra models cost
nothing at the APIs — which matters, because JSearch is billed per request and
running the pipeline once per model would multiply every call.

If a board has not been generated yet — v4 first appears after the run that
follows its release — the page falls back to v1 and says so in the subtitle
rather than showing an empty list.

**The overlays are not copies.** `config/profile.v2.json` and
`config/profile.v3.json` hold only what defines their matching models, and
`config/profile.v4.json` is an overlay **on the v3 overlay**: it keeps every
axis, signal, combination and band v3 defined and adds the occupational gate in
front of them. Search terms, engagement signals, penalties, the hard title
exclusions and the location gate are all inherited from `config/profile.json`.
That is deliberate — if the boards differed in what they searched for as well as
how they scored, a difference between them would not be attributable to the
model. **Put shared changes in `profile.json`; put only model-defining changes in
the overlays.**

`scripts/lib/score.mjs`, `score-v2.mjs` and `score-v3.mjs` are separate files and
duplicate some helpers. That is also deliberate: those three models differ in
their axes, their caps and the shape of the title signal, so sharing would mean
parameterising all of them into one — and a change meant for one board would
silently move the others. `score-v4.mjs` is the exception and **calls** v3
rather than copying it, because it is not a different set of axes; it is the
same axes with a question in front of them.

---

## How v4 scores a job

v3 answers one question well: *how much of this posting's vocabulary is her
vocabulary?* On the live board that produced

| Posting | v3 |
| --- | --- |
| Commercial/Transactional Lawyer | 73 |
| Prevention Program Assistant | 78 |
| Child Psychologist | 68 |
| AI Systems Engineering Subject Matter Expert | 66 |
| **Content Reviewer – US** | **74** |
| **Content Reviewer – English US** | **68** |

Every one of those scores was earned honestly. Lawyers review for accuracy and
catch discrepancies; child-welfare specialists audit documentation against
policy; systems engineers verify and validate. **Careful checking against a
standard is something every profession does**, so measuring it measures nothing
about whether somebody could be hired into the job — and the two Content
Reviewer postings, which she plausibly *could* be hired into, sat among them and
below some of them.

**v4 asks the prior question first** ([`scripts/lib/score-v4.mjs`](scripts/lib/score-v4.mjs),
vocabulary in [`config/profile.v4.json`](config/profile.v4.json)):

> Is this an occupation she could plausibly hold?

Only after that is answered do v3's four axes get to speak. Everything below
happens **before** work fit, experience fit, qualification fit and lifestyle fit
are weighted.

### Step 1 — the occupational fit gate

Every posting is classified into one of four classes.

| Class | What it means | What happens |
| --- | --- | --- |
| **CORE TARGET** | The occupation itself is proofreading, copyediting, editorial or content quality, or digital / marketing / email / creative QA. The title says so. | Scored normally |
| **ADJACENT** | A title she would not have searched for, whose primary responsibilities are still reviewing, editing, validating or quality-checking customer-facing, marketing, e-commerce or editorial content. | Scored normally, ×0.97, flagged as a discovery |
| **OCCUPATION UNCLEAR** | The posting has not said what the job is. Usually a two-line snippet. | ×0.85 and capped at 69, so it can never claim to be a good match |
| **WRONG OCCUPATION** | A different profession whose description happens to contain her vocabulary. | **Suppressed** — dropped by the pipeline and counted, not listed quietly at 20 |

Nine professions are named in `occupationGate.wrongOccupations`: legal,
clinical/medical, social work and child welfare, engineering, software QA and
test automation, accounting and audit, scientific and regulatory, sales and
recruiting, and the physical trades. Each is recognised three ways, in the order
the evidence deserves:

- **`titles`** — conclusive. The employer named the profession in the job title,
  and no description argues with that.
- **`weakTitles`** — Program Coordinator, Case Manager, Technician. These point
  at the occupation without settling it, because content people hold them too,
  so they classify only when the description corroborates them.
- **`body`** — needs several *distinct* concepts from the profession itself
  ("bar admission", "clinical supervision", "general ledger"), and is not
  consulted at all against a core-family title.

**This is not an industry blocklist.** A posting is never rejected because the
word "health", "legal" or "financial" appears in a company blurb — that is
exactly the failure mode in the other direction, and there is a test for it. A
title that names a content occupation (`titleExemptions`: Content Engineer,
Editorial Program Coordinator, Content Reviewer, Documentation Specialist…) is
never overruled by its own body text — with one deliberate exception, [the AI
gate below](#step-2b--ai-training-and-evaluation), where a content title in
front of model-evaluation work is the whole problem being solved.

**The class is a prerequisite and a multiplier, never another small signal.**
That is the difference between v4 and adding a few more penalty phrases to v3:
no quantity of transferable vocabulary moves a posting out of the class its
occupation puts it in. A Content Reviewer at 70% transferable overlap outranks a
Lawyer at 95%, which is the specification's own test and is asserted in
`tests/matching.test.mjs` — though *which* Content Reviewer now depends on what
it turns out to be reviewing.

Two titles no longer confer a core class on sight — `coreFamilyTitleExclusions`:
**Content Reviewer**, Content Rater, Content Analyst. They are still perfectly
good occupations; they simply have to earn the class from their description,
because the same words now advertise two completely different jobs. See Step 2b.

### Step 2 — the credential / eligibility gate

Kept separate from the classes, because the two fail separately: a posting can
read as exactly the right occupation and still demand a licence.

**Rejected:** JD or bar admission · clinical, medical or nursing licence · MSW
or social-work licensure · a required computer-science degree or years of
software engineering · CPA or CFA · a scientific doctorate or years in
pharmaceutical regulatory work.

**Not rejected, and never more than a few points:** AP Style · Chicago Manual of
Style · a CMS · a PIM such as Salsify · a project-management platform · agency
experience · an e-commerce platform · a proofreading or markup tool. These are
**learnable gaps** — the underlying competency is already there, and the card
labels them as such. *"AP Style required" must not sink an otherwise excellent
editorial job*, and there is a test for that too.

### Step 2b — AI training and evaluation

A third gate, added because the market changed underneath this board. The jobs
that pay careful readers of English to rate what a language model produced
advertise in exactly her vocabulary — *review, accuracy, guidelines, quality,
excellent English, attention to detail* — and increasingly under exactly her
titles. A gate that read skills would file them next to a copyediting job.

The line the specification draws is about what the work produces:

| | |
|---|---|
| **AI is a tool used to do the job** | Fine. Not this gate's business. |
| **Training, rating, evaluating or annotating the model *is* the job** | Suppressed. |

So this gate reads responsibilities rather than industry. *AI Trainer*, *AI
Writing Evaluator*, *LLM Evaluator*, *Search Quality Rater*, *Data Annotation
Specialist* and RLHF-style work are suppressed on the title alone. Everything
else needs **two distinct phrases naming something done to a model** — rating
its responses, writing its training data, correcting its behaviour. Phrases that
merely mean AI is nearby — "artificial intelligence", "machine learning",
"AI-powered", "AI-generated" — can never suppress anything; they only let the
card answer the question.

This is the one classification a content title cannot overrule. Everywhere else
in the gate a title naming a content occupation wins the argument with its own
description, because that rule is what keeps an e-commerce content role at a
health brand on the board. Here it has to lose — a content title in front of
model-evaluation work is the entire failure being fixed.

**`Content Reviewer` is the specification's own example**, and it no longer
confers a core class on the strength of the title. It is judged on what is
actually being reviewed:

| The same title, three postings | Verdict |
|---|---|
| Reviews email campaigns, landing pages and product descriptions before they go live | **adjacent · 91 · APPLY** |
| Rates model responses against annotation guidelines and writes prompts | **suppressed** |
| "Evaluate online content against our guidelines" and nothing more | **unclear · 66** — held below the apply bands until it says |

Nothing about this excludes a normal editorial job whose team uses AI. A copy
editor who proofreads AI-drafted campaign copy before it reaches a customer is
doing her own job on a new kind of first draft — that posting scores **89, core,
APPLY**, and the card says AI is a tool here.

### Step 3 — then the existing fit scoring

Work / Experience / Qualification / Lifestyle, weighted 35 / 30 / 20 / 15,
exactly as [v3 describes below](#how-v3-scores-a-job). Occupational relevance
multiplies and caps the result; it is not another weighted term added to it.

### Step 4 — reviewing versus creating

Unchanged in principle from v3, with strategy added to the creation side: owning
a marketing programme, a content roadmap, demand generation or a messaging
framework is the opposite half of her work, not the same half. "Strategist"
joins the creation titles. A Senior Integrated Marketing Strategist is therefore
**down-ranked, not suppressed** — adjacent industry, wrong function — and the
card says which: *"the industry is yours and the occupation is next door to it,
but the function is the opposite one."*

Writing being present is still not disqualifying. An editing role that mentions
rewriting sentences is untouched.

### The Surprise Me shelf

One to three postings, above the list, whose title she would never have typed
into a search box and whose work turns out to be hers anyway. Candidates must be
**adjacent** — a core-family title is not a surprise, it is the search working —
and must clear a high work-fit bar, because a surprise that turns out to be
mediocre teaches her to stop reading the shelf. When nothing qualifies the shelf
disappears entirely.

This is how an obscure title like *Digital Content Integrity Coordinator* gets
found.

### Precision over volume

v4's publish threshold is **70**, the specification's own "possible adjacent
opportunity" line, up from v3's 65 — and wrong-occupation postings are dropped
before the threshold is consulted. **Bands are never filled to keep the count
up.** If few good jobs exist today, the board shows few good jobs. The standard
it is aiming at is:

> *"I can understand why Emily might realistically apply for each of these
> jobs"* — not *"I can find several sentences in each description that resemble
> things Emily has done."*

### What each card explains

For every surviving posting the card answers the six questions the
specification asks: why this occupation belongs in the target or adjacent
family, which responsibilities match her actual experience, any learnable gaps,
any genuine eligibility concerns, whether the job primarily **reviews** existing
content or **creates** new content, and — when the posting raises AI at all —
whether AI is a **tool** the team uses or whether training it is **the work**.
The paragraph leads with the occupation; justifying a match with generic
transferable phrases is the thing v4 exists to stop.

The AI line appears only when the posting brings it up. A card that announced
"no AI here" on every listing would teach her to stop reading that block.

---

## How v3 scores a job

v1 and v2 each answer with one number, which is the wrong shape for the decision
being made. A posting can be exactly the right work and still demand a
credential she does not have; another can meet every stated requirement and be a
copywriting job wearing an editor's title. One number cannot tell those apart.

**v3 scores four axes and shows all of them** ([`scripts/lib/score-v3.mjs`](scripts/lib/score-v3.mjs),
vocabulary in [`config/profile.v3.json`](config/profile.v3.json)):

| Axis | Weight | What it asks |
| --- | --- | --- |
| **Work fit** | 35% | What would she actually spend the day doing? |
| **Experience fit** | 30% | How much of that has she already done, whatever it was called? |
| **Qualification fit** | 20% | How closely does she meet what this employer explicitly asks for? |
| **Lifestyle fit** | 15% | Remote, contract, part-time, flexible, pay stated? |

The overall score puts each posting in one of five bands, and each band carries a
recommendation the card prints as a call to action:

| Score | Band | Recommendation |
| --- | --- | --- |
| 95–100 | Exceptional match | **APPLY ASAP** |
| 88–94 | Strong match — priority application | **APPLY** |
| 80–87 | Good match — review carefully | **APPLY** |
| 70–79 | Possible adjacent opportunity | **CONSIDER** |
| below 70 | Low priority | **SKIP** |

Six rules do most of the work:

- **Work fit is the gate.** The other three axes have high floors by their
  nature: everything here is remote, she clears most stated requirements, and
  she has done a great deal of adjacent work. Together they are 65% of the
  score, so without a gate a job she has no wish to do reaches the apply bands
  purely on her being qualified for it — on the first live board a UX/UI design
  contract led at 85 and a payroll role scored 82. `workGate` caps the overall
  at `base + slope × work fit`, which says the obvious thing: **a job she does
  not want to do cannot be a strong match however well she would meet its
  requirements.** It only ever lowers a score, and never touches a posting whose
  work she wants.
- **Titles corroborate; they do not decide.** A recognised title is worth at most
  22 of the 90 raw work-fit points. What carries the axis is what the posting
  says the job involves — and, more than any single concept, which concepts
  appear **together**. "Proofreading" is a word; *proofreading against brand
  standards for digital content* is her job. Fourteen such combinations are
  scored in `combinations`, and they outweigh any exact title match. **Every
  member of every combination set must name its own concept**: a set containing
  a bare "review", "quality" or "audit" turns *concepts appearing together* into
  *common words appearing together*, which is how a payroll posting came to fire
  both "Email + content review + quality assurance" and "Content audit +
  discrepancies + source of truth". A test enforces it.
- **Work signals are evidence or context, and the two are not equal.** `core`
  signals say the job is reviewing work somebody else produced against a
  standard; `supporting` signals — layout, deadlines, designers, campaigns —
  say where and with whom. Every digital and creative posting carries the
  supporting vocabulary, so it is capped, and a posting with no core signal at
  all is capped harder: nothing in it says she would be reviewing anything.
- **Writing is not disqualifying; writing as the job is.** Editing roles rewrite
  sentences all the time, so the copywriting test is a balance rather than a
  keyword: count the distinct concepts on each side, and only penalise when
  creating outweighs reviewing. A title that says *Copywriter* is charged
  separately, because a title is the strongest statement a posting makes about
  what the job primarily is.
- **Technical literacy is a positive; software engineering is not.** Reading HTML
  and working in a CMS score points. Selenium, CI/CD and test frameworks cost
  them.
- **Experience fit is a coverage ratio, not a tally.** Of everything this posting
  asks for, how much has she done? A tally rewards long postings; a ratio rewards
  postings whose demands she actually meets. Demands she has *not* performed —
  medical editing, newsroom reporting, engineering — sit in `experienceGaps` and
  are the other half of the denominator. That is what separates "she has not held
  this title" (fine) from "she has not done this work" (not fine).
- **One learnable tool must not sink a good job.** "AP Style required" costs three
  points and is reported as a **learnable gap** with a note explaining why it is
  learnable. A law degree costs twenty-six and is reported as a **true gap**. Any
  true gap also caps the recommendation at CONSIDER, however well the posting
  scores elsewhere.
- **Freshness moves the sort order, never the score.** 0–3 days old, this week,
  the last fortnight, over a fortnight, over a month: each bucket carries a rank
  bonus. Anything over 30 days is dropped unless it scores 88 or better, and
  what survives is labelled *confirm it is still open*.

Every card carries the reasoning in plain English: **why it matched**, **your
strongest evidence** (concrete sentences from her background, ready to lift into
an application), **learnable gaps** versus **true experience gaps**, and **watch
out for** — a misleading title, copywriting buried in the description, real
automation requirements, or a score read off a two-line snippet.

**Quality over quantity is the point.** v4 publishes far fewer postings than v1
— fewer even than v3, since it also suppresses whole occupations.
`search.minMatchScore` (70 in `config/profile.v4.json`, 65 in the v3 overlay) is
the single knob for the threshold. Six jobs worth applying to beat a hundred
vaguely related ones — and v1 is still one click away in the header when you
want the wide view.

### Teaching it what you actually want — 👍 / 👎 / 🚫

The four axes score a posting against a written specification. The rating
buttons on each v3 and v4 card score it against what she has actually said:

| Button | What it means | What it learns from |
| --- | --- | --- |
| 👍 **More like this** | The occupation, the responsibilities, the content type, the industry and the shape were all right | Everything |
| 👎 **Not for me** | The occupation may be perfectly valid; *this* opportunity is not wanted | Everything except the protected preferences, and cautiously |
| 🚫 **Wrong kind of work** | An occupational mismatch | **Only** the occupation, professional domain, job family and dominant function |

**The three buttons deliberately do not mean the same thing**, and v4 makes them
learn differently. Marking a Commercial Lawyer 🚫 has to teach *"legal work is
wrong"* and nothing whatsoever about review, proofreading, accuracy or
discrepancy detection — those are her strongest skills, and a model that learned
to mark them down from a 🚫 would be actively working against her. Likewise
rejecting one full-time posting must never produce a negative weight on
full-time work.

After 👎 a row of reasons appears — *too much writing, too technical, wrong
industry, too senior, too junior, poor pay, not flexible, other*. It is
optional, and it is worth using: "not for me" says a posting was wrong, while
"too technical" says **which part** was wrong, and that is what lets one rating
generalise correctly instead of quietly marking down the industry and the
employer for a fault that belonged to neither. A stated reason redirects the
blame rather than adding to it.

Seven rules keep it from doing more harm than good
([`docs/preferences.mjs`](docs/preferences.mjs)):

- **The verdict decides what may be learned.** 🚫 learns only occupational
  facts; 👎 learns from everything except the protected preferences; 👍 learns
  from everything. Ratings already in storage are re-read under these rules
  rather than keeping an older model's conclusions.
- **Explicit preferences are protected from inference.** Remote, United States,
  full-time, part-time and contract are all *stated*, not guessed, so nothing in
  the ratings may produce a negative weight on them. Several rejected postings
  happening to be full-time is a fact about what was advertised. (👍 still
  learns positively from the shape of an engagement — protection runs one way.)
- **Ratings move the rank, never the match.** Where a posting sits in the list
  changes; what the board claims about the fit does not. The bands mean what the
  specification says they mean, and a card whose position moved says so and says
  why — *"−6.4 from your ratings — you passed on other e-commerce & product
  content postings"*. Only **Best overall** is affected; *Highest match* and
  *Most recent* are asked to sort on one stated axis and are left alone.
- **It learns categories, not listings.** Each rating stores a snapshot of the
  posting's features — role family, kinds of work in the description, industry,
  employer, engagement shape — so the lesson outlives the posting, which will be
  gone in a fortnight.
- **It whispers before it speaks.** The inferred half of the model reaches full
  volume at four ratings. One 👎 is a data point, not a preference.
- **Nothing gets buried.** A category saturates after three consistent ratings,
  and the whole model is capped at ±15 rank points — enough to reorder
  neighbours, never enough to close off a family she has not actually rejected.
  That cap matters: the point of this board is surfacing work she would not have
  searched for, and an over-eager learner shuts exactly those doors.
- **It stays in the browser.** Ratings live in localStorage with the saved and
  applied lists. **Export ratings** writes a JSON file; **Import ratings** merges
  one back, which is how they move to another machine — or come back after
  clearing site data. **Start ratings again** wipes them.

Keyboard: <kbd>1</kbd> 👍, <kbd>2</kbd> 👎, <kbd>3</kbd> 🚫 on the focused card.
Pressing the same one twice clears the rating.

### Confirming a posting is still open

Aggregators keep serving listings for weeks after the employer has closed them,
so before publishing, v3 and v4 re-fetch their top postings and file each one:

- **Confirmed open** — the link resolved and the page does not say the role is
  closed.
- **Closed** — the link is gone (404/410) or the page says so in words. These are
  dropped from the board entirely.
- **Not confirmed** — the site blocked the check, timed out, or fell outside the
  budget. Labelled honestly rather than assumed either way.

Anything short of a definite answer is *not confirmed*, never *closed*: a false
positive silently deletes a real job, which is the failure this is meant to
prevent. The pass spends a fixed budget (`VERIFY_MAX_CHECKS`, 60 requests by
default, capped on concurrency and wall-clock time) and can be turned off
entirely with `VERIFY_LISTINGS=false`. It can never fail a run — an unreachable
network produces a board where nothing is confirmed, which is what the labels
are for.

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

## How the ranking works (v1 and v2)

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

Everything lives in the config files — no code changes needed. Edit, commit, and
the next run uses it (or run `npm run fetch` locally to see the effect
immediately). Search terms, penalties and the location gate are shared by every
board and live in [`config/profile.json`](config/profile.json); the v3 model's
own vocabulary lives in [`config/profile.v3.json`](config/profile.v3.json), and
the occupational gate that v4 puts in front of it lives in
[`config/profile.v4.json`](config/profile.v4.json).

Shared, affects every board:

- **Roles keep appearing that she doesn't want** → add a phrase to `penalties`
  (soft, reduces score) or `excludeTitlePhrases` (hard, removes entirely).
- **A whole family of jobs is missing** → add the terms to `search.queries` and
  a matching `titles` group.

v1 and v2 only:

- **A good role ranks too low** → add its title to the right `titles` group, or
  raise that group's `weight`.
- **Too few results** → lower `search.minMatchScore` or raise `search.maxAgeDays`.
- **Too much noise** → raise `search.minMatchScore` to 30–35.
- **New skill to emphasise** → add it to `skills` with a weight of 4–10.

v3 ([`config/profile.v3.json`](config/profile.v3.json)):

- **Too few results** → lower `search.minMatchScore` (65). This is the volume
  knob; nothing else needs touching.
- **A job family is being missed** → add it to `roleFamilies` with a `tier`
  (`core`, `priority` or `adjacent`) and a `why` the card can show.
- **A responsibility should count for more** → add or reweight a group in
  `workSignals`, or — better — add the pair of concepts to `combinations`,
  which is what actually separates a real match from a keyword.
- **Something she has done is not being credited** → add it to `experience`
  with the sentence you would want to see in the application.
- **Something she has never done keeps sneaking in** → add it to
  `experienceGaps` (work) or `qualification.disqualifying` (a stated
  requirement).
- **A tool requirement is being treated as fatal** → move it into
  `qualification.learnableGaps` with a note saying why it is learnable.
- **Stale postings hang around** → lower `search.staleAfterDays` (30) or raise
  `search.staleKeepMinMatch` (88).
- **Jobs she does not want keep reaching the top** → this is nearly always a
  `workSignals` group or a `combinations` set that a generic posting can
  satisfy. Open the card's *Why it matched* panel, find the signal that should
  not have fired, and either tier it `supporting` or make its phrases name the
  thing being reviewed. Tightening the `workGate` slope is the blunt version.
- **A whole level of role is wrong** → the 👍 / 👎 / 🚫 buttons handle this
  without a config change; `seniority` in the v3 profile is only the vocabulary
  that lets "too senior" and "too junior" recognise a level.

v4 only, in [`config/profile.v4.json`](config/profile.v4.json):

- **A whole profession keeps turning up** → add it to
  `occupationGate.wrongOccupations`. Put the job titles that settle it in
  `titles`, titles that only hint at it in `weakTitles`, and phrases from the
  profession itself in `body` — never a word that appears in ordinary marketing
  copy, which a test enforces.
- **A good job is being suppressed** → check the card on `?board=v3` to see what
  it scored before the gate. If the title is the problem, add it to
  `occupationGate.titleExemptions`; if a company blurb is, raise that
  occupation's `bodyThreshold`.
- **A required credential is being treated as learnable, or vice versa** →
  `credentialGate.phrases` rejects; `qualification.learnableGaps` in the v3
  profile costs a few points and explains itself. Nothing belongs in both.
- **The Surprise Me shelf is empty or noisy** → `surprise.minWorkFit` and
  `surprise.minMatch`. An empty shelf on a quiet day is correct behaviour.

The rating model's own constants — how fast it gains confidence, how far one
category may move a posting — are at the top of
[`docs/preferences.mjs`](docs/preferences.mjs), with the reasoning for each.

Phrases are matched on whole words, case-insensitively. Hyphens and slashes are
treated as spaces, so `copy editing` also matches "copy-editing" and
"QA/copy-editing".

## Working on it locally

```bash
npm test          # unit tests — matching, location gate, all three scorers, dedupe, liveness, ratings
npm run stamp     # refresh the cache-busting stamps after editing docs/
npm run fetch     # pull live postings → docs/data/
npm run serve     # preview at http://localhost:4173
npm start         # fetch then serve
```

No dependencies to install — everything uses the Node standard library, so
`npm test` and `npm run fetch` work on a clean checkout with Node 20+.

**After editing anything in `docs/`, run `npm run stamp`.** The board fetches
its data with a cache-buster, but referenced its own code by bare name — so a
browser that had the site open across a deploy ran the *old* script against the
*new* data. That is how the ratings first shipped invisibly: current postings,
current scores, no rating buttons. Every asset URL now carries a hash of its own
contents, `npm run serve` refreshes them, and `npm test` fails if they are
stale.

Open `docs/index.html` directly and the page will load but stay empty; browsers
block `fetch` on `file://` URLs. Use `npm run serve`.

## Layout

```
config/
  profile.json          shared: search terms, weights, penalties, location rules
  profile.v2.json       v2 overlay: capabilities and role families
  profile.v3.json       v3 overlay: the four-axis fit model, bands and gap lists
  company-boards.json   specific company career pages to watch
scripts/
  fetch-jobs.mjs        orchestrator: fetch → normalize → dedupe → filter → score → verify → write
  stamp-assets.mjs      content hashes on the page's own asset URLs, so a deploy is never cached over
  serve.mjs             local preview server
  lib/                  http, text, xml, location gate, three scorers, normalizer, liveness check
  sources/              one adapter per job board
docs/                   the site itself (GitHub Pages serves this folder)
  preferences.mjs       the 👍/👎/🚫 ranking model, shared by the page and the tests
  data/                 v1 jobs.json + meta.json, rewritten by the Action
  data/v2/, data/v3/    the other two boards, from the same fetch
tests/                  unit tests, no network required
```

A failing source can never fail the run: each adapter is isolated, and its error
is recorded in `docs/data/meta.json` and shown on the page.
