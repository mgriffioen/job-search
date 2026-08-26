/**
 * Match scoring — MODEL V4 (occupational fit first).
 *
 * v3 answers one question well: how much of this posting's vocabulary is her
 * vocabulary? On the live board that produced a Commercial/Transactional Lawyer
 * at 73, a Child Psychologist at 68, a Senior Child Welfare Specialist and an AI
 * Systems Engineering Subject Matter Expert — every one of them scoring on
 * "review", "accuracy", "verification", "discrepancy", "attention to detail"
 * and "deadlines".
 *
 * Those are not false matches on the vocabulary. They are true matches on the
 * vocabulary, and that is the problem: careful reviewing against a standard is
 * something every profession does, so measuring it measures nothing about
 * whether she could hold the job. Meanwhile a Content Reviewer — an occupation
 * she plausibly belongs to — sat below them on a thinner description.
 *
 * v4 keeps every axis, signal, combination and band v3 defined and puts one
 * question in front of them:
 *
 *   IS THIS AN OCCUPATION SHE COULD PLAUSIBLY HOLD?
 *
 * Only after that is answered do the four axes get to speak.
 *
 *   CORE      The occupation itself is proofreading, copyediting, editorial or
 *             content quality, or digital / marketing / email / creative QA.
 *   ADJACENT  A title she would not have searched for, whose primary
 *             responsibilities are still reviewing, editing, validating or
 *             quality-checking customer-facing, marketing, e-commerce or
 *             editorial content. These stay discoverable — that is the whole
 *             point of the board.
 *   UNCLEAR   The posting has not said what the job is. Usually a two-line
 *             snippet. Held below the apply bands rather than suppressed.
 *   WRONG     A different profession. Suppressed.
 *
 * THE CLASS IS A PREREQUISITE AND A MULTIPLIER, NEVER ANOTHER SMALL SIGNAL.
 * That is the difference between this and adding a few more penalty phrases to
 * v3: no quantity of transferable vocabulary moves a posting out of the class
 * its occupation puts it in, so a Content Reviewer at 70% transferable overlap
 * outranks a Lawyer at 95% — which is the specification's own test.
 *
 * THREE GATES, NOT ONE. Occupation, eligibility and AI-work are separate
 * because they fail separately: a posting can read as exactly the right
 * occupation and still demand a licence, and a posting can name a credential in
 * a paragraph about some other team. The eligibility gate lists credentials she demonstrably does
 * not hold and cannot acquire between now and the application. Everything
 * softer — AP style, Chicago, a CMS, a PIM, an agency background, a markup tool
 * — stays a LEARNABLE GAP: it costs a few points on qualification fit and never
 * removes a posting.
 *
 * AND THE THIRD GATE: AI TRAINING IS NOT CONTENT WORK. The market changed under
 * this board. The occupations that pay careful readers of English to rate what
 * a model produced advertise in exactly her vocabulary — review, accuracy,
 * guidelines, quality, attention to detail — and increasingly under exactly her
 * titles, which is why `Content Reviewer` can no longer be trusted on sight.
 * The line the specification draws is about what the work produces: AI used as
 * a tool to do the job is fine and is nobody's business but hers, while
 * training, rating, evaluating or annotating the model AS the job is not
 * wanted. So the AI gate reads responsibilities rather than industry, and it is
 * the one classification a content title cannot overrule — everywhere else in
 * this file a title that names a content occupation wins the argument.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. The wrong-occupation lists are not a
 * keyword blocklist over industries. A posting is not rejected because the word
 * "health", "legal" or "financial" appears in a company blurb: a body-only
 * classification needs several distinct concepts from the profession itself,
 * and a title that names a content occupation is never overruled by the body at
 * all. The failure mode being avoided is a board that hides an e-commerce
 * content role at a health brand, which would be the same mistake in the other
 * direction.
 */

import { normalizeForMatch } from './text.mjs';
import {
  scoreJob as scoreJobV3,
  bandFor,
  freshnessBucket,
  countConcepts,
  matchCombinations,
  matchGroup,
  longestMatch,
} from './score-v3.mjs';

export { bandFor, freshnessBucket, matchTier, recencyScore, requiredYears, seniorityOf } from './score-v3.mjs';

const round1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------- occupation gate */

/**
 * STEP 2 — the credential / eligibility gate.
 *
 * Returns every stated requirement she cannot meet, with the occupation it
 * belongs to. Empty is the normal case, and an empty result is what lets the
 * learnable gaps in v3's qualification axis do their much gentler job.
 */
export function checkEligibility(profile, normAll) {
  const groups = profile.credentialGate?.phrases || [];
  const blocking = [];
  for (const group of groups) {
    const phrase = longestMatch(group.phrases, normAll);
    if (phrase) blocking.push({ id: group.id, label: group.label, phrase });
  }
  return { eligible: blocking.length === 0, blocking };
}

/**
 * STEP 1(D) — is AI the tool, or is AI the work?
 *
 * The specification's own words: "AI is a tool used to perform the relevant job
 * → potentially fine. Training/evaluating/improving the AI is the job → not
 * wanted." Those two look identical from a distance. Both advertise for careful
 * readers of English, both talk about guidelines, accuracy and quality, and the
 * second increasingly advertises under the first's titles — which is why
 * `Content Reviewer` can no longer be trusted on sight.
 *
 * So this reads what is being done, not who is doing it or where:
 *
 *   `titles`       conclusive. An AI Trainer trains AI.
 *   `weakTitles`   a title that goes both ways, settled by one work phrase.
 *   `workPhrases`  the act of teaching or grading a model. Two DISTINCT
 *                  concepts for a body-only verdict, because one sentence about
 *                  AI is a sentence and not a job.
 *   `mentionPhrases` AI is in the room and the posting has not said it is the
 *                  work. This NEVER suppresses. It exists so the card can
 *                  answer the question instead of going quiet.
 *
 * Deliberately absent from `workPhrases`: "artificial intelligence", "machine
 * learning", "AI-powered". A retailer that boasts about its recommendation
 * engine has not advertised an AI-training job, and a proofreader checking
 * AI-drafted campaign copy before it reaches a customer is doing her own job on
 * a new kind of first draft.
 */
export function readAiPosture(profile, { normTitle, normAll }) {
  const gate = profile.aiWorkGate || {};
  const work = countConcepts(gate.workPhrases, normAll);
  const mentions = countConcepts(gate.mentionPhrases, normAll);

  const found = (evidence) => ({ posture: 'work', evidence, work: work.size, mentions: mentions.size });

  const titleHit = longestMatch(gate.titles, normTitle);
  if (titleHit) return found(`Title names the work: “${titleHit}”`);

  const weakHit = longestMatch(gate.weakTitles, normTitle);
  if (weakHit && work.size >= 1) {
    return found(`Title “${weakHit}”, and the description is about training or grading a model`);
  }

  if (work.size >= (gate.bodyThreshold ?? 2)) {
    return found(`${work.size} responsibilities that are about the model itself rather than about content`);
  }

  if (work.size || mentions.size) {
    return { posture: 'tool', evidence: null, work: work.size, mentions: mentions.size };
  }
  return { posture: 'absent', evidence: null, work: 0, mentions: 0 };
}

/**
 * The sentence the card prints about AI, which the specification requires of
 * every surviving posting that mentions it at all. Silence would be the wrong
 * answer twice over: it would hide the reason a suppressed posting was
 * suppressed, and it would leave her guessing about the ones that survived.
 */
function aiSentence(posture) {
  if (posture.posture === 'absent') return null;
  if (posture.posture === 'work') {
    return (
      'AI is the WORK here, not a tool: the job is training, rating or evaluating a model, which is not the kind ' +
      'of reviewing you are looking for.'
    );
  }
  return posture.work
    ? 'AI is mentioned, and one responsibility points at model work — read that paragraph before applying. ' +
      'On balance this still reads as AI being a tool the team uses rather than the thing being built.'
    : 'AI is mentioned only as a tool the team uses, not as the thing being trained or evaluated. That is not a ' +
      'reason to skip this one.';
}

/**
 * STEP 1 — the occupational fit gate.
 *
 * `family` is v3's title match; `coreSignals` is how many of v3's CORE work
 * signals (proofreading, final review, accuracy, standards, audit) the
 * description carries; `combinations` is how many of its co-occurrence rules
 * fired. The classification is deliberately made from those three plus the
 * subject matter, and never from the total score — a score is exactly the thing
 * transferable vocabulary inflates.
 */
export function classifyOccupation(
  profile,
  { normTitle, normAll, family, coreSignals, combinations, creationDominant = false, aiPosture = null }
) {
  const gate = profile.occupationGate || {};
  const coreTiers = gate.coreFamilyTiers || ['core', 'priority'];

  /**
   * A title in a core family states the occupation — except for the handful the
   * market has taken back. `Content Reviewer` is a real editorial title and is
   * also what the AI-data marketplaces call the person grading model output, so
   * the specification's instruction is to work out what is being reviewed
   * rather than to take the title's word for it. Excluded titles are not
   * penalised; they are simply made to earn their class from the description
   * like any unfamiliar one, which is the path a genuine content-review job
   * walks through comfortably.
   */
  const titleTakenBack = Boolean(longestMatch(gate.coreFamilyTitleExclusions, normTitle));
  const inCoreFamily = Boolean(family && coreTiers.includes(family.tier)) && !titleTakenBack;

  /**
   * The AI test runs FIRST, ahead of the wrong-occupation lists and ahead of
   * the core-family shortcut, because it is the one classification a content
   * title must not be able to overrule. Everywhere else in this gate a title
   * that names a content occupation wins the argument; here the whole failure
   * mode is a content title in front of model-evaluation work.
   */
  const ai = aiPosture || readAiPosture(profile, { normTitle, normAll });
  if (ai.posture === 'work') {
    return {
      class: 'wrong',
      id: 'ai-training',
      label: 'AI training and evaluation',
      why:
        'The reviewing in this job is reviewing what a model produced, so that the model gets better. Your ' +
        'language and judgement would be the training material rather than the point of the work, and you have ' +
        'said that is not the direction you want.',
      evidence: ai.evidence,
      contentDomain: countConcepts(gate.contentDomain, normAll).size,
      coreSignals,
      combinations,
      ai,
    };
  }

  // A title that names a content occupation is not overruled by its own
  // description. "Content Engineer" and "Editorial Program Coordinator" are
  // content jobs with another profession's word inside them, and reading that
  // word as the occupation is how a board loses the roles it exists to find.
  const exemption = longestMatch(gate.titleExemptions, normTitle);

  const wrong = detectWrongOccupation(gate.wrongOccupations, { normTitle, normAll, exemption, inCoreFamily });
  const contentDomain = countConcepts(gate.contentDomain, normAll).size;

  if (wrong) {
    return {
      class: 'wrong',
      id: wrong.id,
      label: wrong.label,
      why: wrong.why,
      evidence: wrong.evidence,
      contentDomain,
      coreSignals,
      combinations,
      ai,
    };
  }

  if (inCoreFamily) {
    const phrase = familyPhrase(profile, normTitle, family);
    return {
      class: 'core',
      id: family.id,
      label: family.label,
      why: `${family.label} is one of the occupations this search is for — the title matches on “${phrase}”.`,
      evidence: `Title: “${phrase}”`,
      contentDomain,
      coreSignals,
      combinations,
      ai,
    };
  }

  /**
   * ADJACENT — the discovery path, and the reason this gate is not simply a
   * title whitelist. Two things must both be true: the description says the job
   * is reviewing somebody else's work against a standard (core signals), and it
   * says the thing being reviewed is content (contentDomain). Either alone is
   * what produced the false positives — a payroll specialist reviews against a
   * standard, a copywriter works on content — and it is the pair that describes
   * her job.
   */
  const rules = gate.adjacentEvidence || {};
  const needed = combinations >= 1
    ? rules.minCoreSignalsWithCombination ?? 1
    : rules.minCoreSignals ?? 2;
  const domainNeeded = rules.minContentDomainConcepts ?? 1;

  if (coreSignals >= needed && contentDomain >= domainNeeded) {
    return {
      class: 'adjacent',
      id: family?.id || 'adjacent-content-review',
      label: family?.label || 'Content review under another name',
      why:
        'The title is not one you would have searched for, but the responsibilities are: this posting is about ' +
        'reviewing and checking content somebody else produced, which is the work you have done for ten years.',
      evidence: `${coreSignals} review responsibilities on content subject matter`,
      contentDomain,
      coreSignals,
      combinations,
      ai,
    };
  }

  /**
   * The near miss worth naming rather than shrugging at: a posting that is
   * plainly about content and plainly about making it. Marketing strategists,
   * content marketers and campaign owners land here. The occupation is adjacent
   * to hers and the function is not, which is a different thing from "this
   * posting did not say", and the card should say which it is.
   */
  if (creationDominant && contentDomain >= domainNeeded) {
    return {
      class: 'unclear',
      id: 'content-creation',
      label: 'Content creation and marketing strategy',
      why:
        'The industry is yours and the occupation is next door to it, but the function is the opposite one: this ' +
        'job originates and owns content rather than reviewing and correcting what others produce.',
      evidence: `${contentDomain} content subject-matter concepts, and creation dominates the responsibilities`,
      contentDomain,
      coreSignals,
      combinations,
      ai,
    };
  }

  return {
    class: 'unclear',
    id: family?.id || null,
    label: family?.label || 'Occupation not stated',
    why:
      'This posting does not say enough about what the job actually involves to tell whether the occupation is ' +
      'yours. It is held below the apply bands until it does.',
    evidence: `${coreSignals} review responsibilities, ${contentDomain} content subject-matter concepts`,
    contentDomain,
    coreSignals,
    combinations,
    ai,
  };
}

/** The phrase in the title that put this posting in its family, for the card. */
function familyPhrase(profile, normTitle, family) {
  const entry = (profile.roleFamilies || []).find((candidate) => candidate.id === family.id);
  return longestMatch(entry?.titles, normTitle) || family.label.toLowerCase();
}

/**
 * The wrong-occupation test, in the order the evidence deserves.
 *
 * A `titles` hit is conclusive — the employer named the profession in the job
 * title. A `weakTitles` hit points at it without settling it (Program
 * Coordinator, Case Manager, Technician are held by content people too) and
 * needs one corroborating concept from the body. A body-only classification
 * needs `bodyThreshold` DISTINCT concepts, and is not made at all against a
 * core-family title: that is the specification's rule that "health", "legal" or
 * "financial" appearing somewhere in a company description is not a profession.
 */
function detectWrongOccupation(occupations, { normTitle, normAll, exemption, inCoreFamily }) {
  for (const entry of occupations || []) {
    const bodyConcepts = countConcepts(entry.body, normAll);

    if (!exemption) {
      const titleHit = longestMatch(entry.titles, normTitle);
      if (titleHit) return { ...entry, evidence: `Title names the occupation: “${titleHit}”` };

      const weakHit = longestMatch(entry.weakTitles, normTitle);
      if (weakHit && bodyConcepts.size >= 1) {
        return { ...entry, evidence: `Title “${weakHit}”, and the description is ${entry.label.toLowerCase()}` };
      }
    }

    if (!inCoreFamily && bodyConcepts.size >= (entry.bodyThreshold ?? 3)) {
      return {
        ...entry,
        evidence: `${bodyConcepts.size} concepts from ${entry.label.toLowerCase()} in the description`,
      };
    }
  }
  return null;
}

/* -------------------------------------------------------- review vs create */

/**
 * STEP 4 — is the job reviewing what exists, or making what does not?
 *
 * Recomputed here rather than read off v3's score because the card has to be
 * able to SAY which it is, in the words of the specification, and because the
 * answer is one of the five things every surviving posting must explain.
 */
function readOrientation(profile, normTitle, normAll) {
  const config = profile.orientation || {};
  const review = countConcepts(config.reviewPhrases, normAll).size;
  const creation = countConcepts(config.creationPhrases, normAll).size;
  const creationTitle = longestMatch(config.creationTitles, normTitle);

  const mode = creationTitle || creation > review ? 'creating' : review > creation ? 'reviewing' : 'mixed';
  return { review, creation, creationTitle, mode };
}

function orientationSentence({ review, creation, creationTitle, mode }) {
  // A snippet that mentions neither has not answered the question, and saying
  // "0 against 0" pretends it has.
  if (!review && !creation && !creationTitle) {
    return 'The posting does not say whether the job reviews existing content or creates new content. Open it and see.';
  }
  if (creationTitle) {
    return `Primarily CREATING: the title says “${creationTitle}”, so the job is producing content, not checking it.`;
  }
  if (mode === 'creating') {
    return `Primarily CREATING: ${creation} signals point at originating content against ${review} at reviewing it.`;
  }
  if (mode === 'reviewing') {
    return `Primarily REVIEWING existing content: ${review} review responsibilities against ${creation} for creating it.`;
  }
  return `Mixed: ${review} review responsibilities against ${creation} for creating content — read the split before applying.`;
}

/* ------------------------------------------------------------------ score */

export function scoreJob(job, profile, now = new Date(), options = {}) {
  const normTitle = normalizeForMatch(job.title || '');
  const body = job.description || job.excerpt || '';
  const normAll = normalizeForMatch(
    `${job.title || ''} ${job.company || ''} ${(job.tags || []).join(' ')} ${body}`
  );

  // The four axes, the written report and the freshness handling are v3's,
  // unchanged. v4 adds a gate in front of them and a report on top; duplicating
  // the axis code to add one step would guarantee the two drift apart.
  const base = scoreJobV3(job, profile, now, options);

  const family = base.family;
  const coreSignals = matchGroup(profile.workSignals, normAll).filter((hit) => hit.tier !== 'supporting').length;
  const combinations = matchCombinations(profile.combinations, normAll).length;

  const orientation = readOrientation(profile, normTitle, normAll);
  const aiPosture = readAiPosture(profile, { normTitle, normAll });
  const occupation = classifyOccupation(profile, {
    normTitle,
    normAll,
    family,
    coreSignals,
    combinations,
    creationDominant: orientation.mode === 'creating',
    aiPosture,
  });
  const eligibility = checkEligibility(profile, normAll);

  const gate = profile.occupationGate || {};
  const multiplier = gate.multipliers?.[occupation.class] ?? 1;
  const cap = gate.caps?.[occupation.class] ?? 100;

  let match = Math.min(Math.round(base.match * multiplier), cap);

  // An eligibility failure is charged like a wrong occupation, because it has
  // the same consequence: she cannot hold the job.
  if (!eligibility.eligible) match = Math.min(match, gate.caps?.wrong ?? 34);

  const suppressed = occupation.class === 'wrong' || !eligibility.eligible;

  // Everything downstream of the number has to be recomputed from the new
  // number, or the card would print v3's band beside v4's score.
  const band = bandFor(match, profile);
  const bucket = freshnessBucket(base.ageDays, profile);
  const { matchWeight, recencyWeight } = profile.ranking;
  const rank = round1(match * matchWeight + base.recency * recencyWeight + (bucket.rankBonus ?? 0));

  let recommendation = band.recommendation;
  if (suppressed) recommendation = 'SKIP';
  else if (base.details.recommendationCapped && band.recommendation !== 'SKIP') {
    // v3's own ceilings (a demand she has never met, a creation-dominant
    // posting) still apply on top of the band.
    recommendation = base.details.recommendation === 'SKIP' ? band.recommendation : base.details.recommendation;
  }
  if (!suppressed && occupation.class === 'unclear' && recommendation === 'APPLY') recommendation = 'CONSIDER';

  const report = buildOccupationReport({
    profile,
    base,
    occupation,
    eligibility,
    orientation,
    aiPosture,
    normAll,
  });

  /**
   * The Surprise Me shelf. A core-family title is not a surprise — it is the
   * search working. A surprise is an occupation she would never have typed into
   * a search box whose work turns out to be hers, and it has to clear a high
   * bar on both counts or the shelf stops being worth reading.
   */
  const surpriseConfig = profile.surprise || {};
  const surprise = Boolean(
    !suppressed &&
      occupation.class === 'adjacent' &&
      base.details.scores.work >= (surpriseConfig.minWorkFit ?? 62) &&
      match >= (surpriseConfig.minMatch ?? 74)
  );

  return {
    ...base,
    match,
    rank,
    // Suppressed postings carry the flag rather than being dropped here: the
    // pipeline decides what to publish, and it reports how many were suppressed
    // and why, which a silent drop inside the scorer could not.
    suppressed,
    occupationClass: occupation.class,
    discovery: !suppressed && (occupation.class === 'adjacent' || base.discovery),
    surprise,
    details: {
      ...base.details,
      band: { tier: band.tier, label: band.label },
      recommendation,
      recommendationCapped: recommendation !== band.recommendation,
      occupation: report.occupation,
      whyMatched: report.whyMatched,
      watchOuts: report.watchOuts,
      gaps: report.gaps,
      suppressed,
      signals: {
        ...base.details.signals,
        /**
         * What the 👍 / 👎 / 🚫 model learns over in v4. `occupation` and
         * `function` are the facts a 🚫 is actually about; the work-signal ids
         * it inherits from v3 are transferable skills and must never take a
         * negative weight from one. See docs/preferences.mjs.
         */
        occupation: occupation.id,
        occupationClass: occupation.class,
        function: orientation.mode,
        review: orientation.review,
        // Whether AI is the tool or the work. A fact about the occupation
        // rather than about her skills, so a 🚫 is allowed to learn from it.
        ai: aiPosture.posture,
      },
    },
  };
}

/**
 * STEP 9 — the match explanation.
 *
 * The specification names five things every surviving posting must answer, and
 * bans justifying a match with generic transferable phrases. So the paragraph
 * leads with the occupation, then names the responsibilities that are actually
 * hers, then says plainly whether the job is reviewing or creating. The
 * transferable vocabulary that used to open this paragraph now appears only as
 * supporting detail, which is what it is.
 */
function buildOccupationReport({ profile, base, occupation, eligibility, orientation, aiPosture, normAll }) {
  const coreHits = matchGroup(profile.workSignals, normAll).filter((hit) => hit.tier !== 'supporting');
  const responsibilities = coreHits.slice(0, 4).map((hit) => ({ label: hit.label, phrase: hit.phrase }));

  const why = [];
  if (occupation.class === 'wrong') {
    why.push(`WRONG OCCUPATION — ${occupation.label}. ${occupation.why}`);
  } else if (occupation.class === 'unclear') {
    why.push(occupation.why);
  } else {
    why.push(occupation.why);
    if (responsibilities.length) {
      why.push(
        `What it asks for: ${listPhrase(responsibilities.map((r) => r.label.toLowerCase()))} — the responsibilities you have held for ten years.`
      );
    }
    if (occupation.combinations) {
      why.push(
        `${occupation.combinations} of the board's co-occurrence rules fired, which is stronger evidence than any single phrase.`
      );
    }
  }
  why.push(orientationSentence(orientation));

  // The specification's sixth question, asked only when there is something to
  // answer: if AI is mentioned, is it the tool or is it the work?
  const aiNote = aiSentence(aiPosture);
  if (aiNote) why.push(aiNote);

  const watchOuts = [...(base.details.watchOuts || [])];
  if (occupation.class === 'wrong') {
    watchOuts.unshift(
      `This is ${occupation.label.toLowerCase()}, not content or editorial work. ${occupation.evidence}. ` +
        'It reads as a match only because reviewing carefully against a standard is something every profession does.'
    );
  }
  if (occupation.class === 'unclear') {
    watchOuts.unshift(
      'The posting does not say enough about the day-to-day work to place the occupation. Open it before judging it.'
    );
  }
  if (occupation.id === 'ai-training') {
    watchOuts.unshift(
      'This is AI training or evaluation work, not content or editorial work. ' +
        `${occupation.evidence}. The specification excludes it: your editorial judgement would be the raw material ` +
        'for a model rather than the point of the job.'
    );
  } else if (aiPosture.posture === 'tool' && aiPosture.work) {
    // Below the threshold, so it survived — but one model-work phrase in an
    // otherwise ordinary content posting is worth a second look before applying.
    watchOuts.push(
      'AI is mentioned and one responsibility reads as model work rather than content work. Read that paragraph ' +
        'before applying: the difference between using AI and training it is the difference between this job and one ' +
        'you have said you do not want.'
    );
  }

  for (const blocked of eligibility.blocking) {
    watchOuts.unshift(`Eligibility: this posting requires ${blocked.label.toLowerCase()} — “${blocked.phrase}”.`);
  }

  // The specification's separation, carried through to the card: a credential
  // she cannot hold is an eligibility concern and belongs beside the true gaps,
  // never among the learnable ones.
  const gaps = {
    learnable: base.details.gaps?.learnable || [],
    experience: [
      ...(base.details.gaps?.experience || []),
      ...eligibility.blocking.map((blocked) => ({
        label: blocked.label,
        note: `Eligibility requirement you do not meet: “${blocked.phrase}”.`,
      })),
    ],
  };

  return {
    whyMatched: why.join(' '),
    watchOuts,
    gaps,
    occupation: {
      class: occupation.class,
      id: occupation.id,
      label: occupation.label,
      why: occupation.why,
      evidence: occupation.evidence,
      responsibilities,
      contentMode: orientation.mode,
      contentModeNote: orientationSentence(orientation),
      ai: aiPosture.posture,
      aiNote,
      eligibility: eligibility.blocking.map((blocked) => ({ label: blocked.label, phrase: blocked.phrase })),
    },
  };
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
