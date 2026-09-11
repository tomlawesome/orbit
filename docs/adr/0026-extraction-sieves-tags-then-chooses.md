# ADR-0026: Extraction finds every candidate, tags each with the label beside it, then chooses per field — no route takes one shot at the value

**Status:** Accepted (owner, 2026-09-11, on #989: "First, write this
approach, and experiment up somewhere durable. Then yes, adopt it.")
**Date:** 2026-09-11
**Relates to:** #989 (the design issue this records); #986 (the blind
baselines that motivated it); #977 (which method per field — now the
stage 3 policy table); #965 (`value-trim`), #979 (ConText), #980
(checksums) — the three techniques, each of which becomes a stage rather
than a bolt-on; #988 (input-budget truncation, largely dissolved by this);
#984 (adjudicator economics); #987 (provider database, deferred);
ADR-0025 (unchanged in its bounds, grounding, adjudication and gate; this
ADR changes what runs *inside* each of its two routes).

## Context

The 24-document full-page corpus (#986) is the first measurement on paper
shaped like real paper: 181,276 characters of Tika text, 437 date-like
strings of which 35 (8%) are answers, three to five organisations per
page, and every answer literal on the page by construction
(`scripts/corpus/verify.mjs`).

Both routes were run blind over it on 2026-09-11:

| route | overall | where it lands |
|---|---|---|
| heuristics (`proposalFromText`) | **15.0%** (29/193) | dates 82.9%, reference 33.3%, provider **−33.3%**, every other field 0 |
| model (NuExtract 3, Q4_K_M, CPU) | first six documents only; full run in flight | cost 6/6, provider 4/6 (both "hidden organisation" traps lost), subtype 0/6, five to eleven dates returned where one or two are wanted; the 12-page report ran past the 300 s mailbox deadline |

The same experiment, run on the sieve this ADR introduces
(`npm run eval:sieve`, 2026-09-11):

| field | expected value among the candidates | distinct candidates per document |
|---|---|---|
| dates | 35/35 | 11.5 |
| cost | 19/19 | 17.0 |
| reference | 24/24 | 16.1 |
| provider | 24/24 | 19.9 |
| subtype | 23/24 | 56.4 |

(The one miss is a subtype printed only inside a footer sentence — see
"Open for the owner".)

Read together: **finding values is solved; choosing between them is the
whole problem.** Heuristics find 83% of the dates and 0% of their roles.
They find the reference token on every page and pick the right one a third
of the time. Provider is negative because `extractProvider` tries three
regexes in order and the first that yields anything wins — there is no
place to hold "I found four organisations" — and since #939 a confident
wrong value costs a point. The model fails the same way one stage later:
asked for *the* answer from 12,000 characters, it returns every date it
sees and the most prominent organisation rather than the one the household
deals with.

The owner's diagnosis (#989): *"simply looking for the actual answer is
prone to failure. We should be looking for where we would find the
answer."*

## Decision

Extraction is three stages. Each is a separate module with its own
measurement, and no stage does the next stage's job.

### 1. Sieve — collect every candidate, judged on recall only

`src/server/documents/extraction-sieve.ts` reads the **whole** Tika text
(the 250,000-character cap, not the model's 12,000) and returns every
candidate of five kinds — `date`, `amount`, `identifier`, `organisation`,
`heading` — each with the Tika block it sits in. The block is the excerpt
the later stages read instead of the page.

The sieve chooses nothing and caps nothing. A pattern that loses a real
answer is a defect in this stage; a pattern that admits forty false
candidates is not. `npm run eval:sieve` prints recall per field and the
shortlist size, with every miss named. There is no floor (owner,
2026-09-11); a miss is a sieve to widen.

### 2. Tag — attach to each candidate the label beside it

Each candidate gets the words that say what it is: "Renewal date",
"Total amount due", "Policy number", "Administered by", "Underwritten by",
"on behalf of". This is ConText (#979, Harkema et al. 2009) generalised
from dates to every kind: nearest trigger within the block wins, a
termination term ends its reach, and a candidate with no trigger is tagged
`other` rather than guessed.

Tags are the only thing stage 3 is allowed to reason from besides the
candidate's own shape. Checksums (#980) live here as **shape tags**: an
identifier that passes the GB VAT or UTR check is tagged as the company's
number, which is a reason to *reject* it as the household's reference —
their real job, not a bonus.

### 3. Choose — one policy per field, over the tagged shortlist

Per field, a policy takes the tagged candidates and returns a value or
nothing. **Nothing is a first-class answer**: a policy that cannot
separate two candidates returns blank, and blank is free where a wrong
value is not.

Which policy each field gets is #977's table, decided by measurement, and
falls into two kinds:

- **Rule-shaped fields** — dates and their roles, reference, cost,
  currency, and everything derived from roles (`scheduleKind`,
  `recurrenceMonths`) — are chosen by rules over tags. `value-trim`
  (#965) is the clean-up on the chosen value.
- **Meaning-shaped fields** — provider and subtype — may go to the model,
  which is handed the **shortlist and its blocks**, a few hundred
  characters, and asked which one. It is never handed the page.

ADR-0025's bounds, grounding, blind-then-adjudicate flow and hold-out gate
all stand: a model call is still schema-bound, evidence-grounded, on the
fixed endpoint, under the same deadlines. What changes is its input — a
shortlist instead of a document — which is why a call that took 69–300
seconds on CPU becomes seconds, and why the 14-page policy booklet that
#988 could not answer becomes answerable: the sieve read all of it.

### Measurement stays separate per stage

- Stage 1: recall and shortlist size (`eval:sieve`).
- Stage 2: tag accuracy against the corpus' role labels, once written.
- Stage 3: the existing `scoreCorpus`, per field, with the #939 penalty —
  the number the owner rules on.

The three techniques the owner asked for as separate run-time switches are
still built separately and measured one at a time; this ADR says *where*
each plugs in, so that switching one on is a stage change and not a patch
to a regex chain.

## Consequences

- `extractProvider`, `extractReference` and the one-shot `extractDates`
  become stage 3 policies over the sieve, or are retired by them. Until
  then they remain the shipping heuristics and the baseline they scored.
- The heuristic and model routes stop being two different extractors and
  become two stage 3 choosers over one sieve. ADR-0025 §4's adjudication
  compares their choices, as before.
- A provider database (#987) is deferred: "administered by" outranking
  "underwritten by" outranking the letterhead is a tag rule, not a lookup.
  Revisit when tag rules stop improving provider.
- Tuning against the 24 is now legitimate for stage 1 (recall is a
  property of patterns, and every miss is a real page shape) and still
  illegitimate for stage 3, whose numbers the 12 fresh hold-out documents
  (#986 step 8) judge.
- The 36 short documents and hold-out corpus 2 stay retired (owner,
  2026-09-11): a page with six date-like strings has nothing to sieve.

## Alternatives rejected

- **Widen the regexes field by field until the 24 pass.** This is the
  spoon-feeding the owner retired, one level down: a fourth provider
  regex would win on the four traps it was written for and lose on the
  fifth.
- **Run the adjudicator (#984) on whole documents.** A second model
  reading the same 12,000 characters over-extracts the same way; two
  guesses are not a judgement. Adjudication over a shortlist is the same
  design with a tractable input.
- **A provider database first (#987).** Normalises a name; cannot choose
  between two real ones on the same page, which is the failure observed.

## Open for the owner

1. Subtype ground truth for `energy-tariff-end`: the phrase "Tariff end
   notice" is printed only inside a footer sentence, added earlier so the
   value would be literal. The page's printed title is "your fixed price
   is coming to an end". The convention says subtype is the printed title;
   either the truth changes or the sieve learns to read footer form names.
   Left as the one recorded miss until ruled on.
