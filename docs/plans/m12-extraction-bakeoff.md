# M12 — Extraction bake-off: which method for which field

Status: proposed 2026-09-16 for owner ratification. Issue: #977 (which
method per field). Milestone: M12 — Document extraction. Governs ADR-0026
stage 3's policy table; changes nothing in ADR-0025's bounds or gate.

Owner, 2026-09-11: *"We test which methods work best for which fields.
Then I decide."* This plan decides nothing about the winner.

## 1. Fields and how a cell is scored

The eight fields the scorer already reports: `provider`, `reference`,
`dates`, `dateRoles`, `subtype`, `cost`, `scheduleKind`, `recurrence`.
Scoring is `scoreCorpus` (`src/server/documents/extraction-scoring.ts`)
unchanged:

- One point per expected value. Right earns 1; blank and wrong both earn 0
  (`WRONG_VALUE_PENALTY = 0`, owner 2026-09-12). Cells show blank and wrong
  counts, because a cautious 8/12 and a careless 8/12 need different fixes.
- **Exact match**: `reference`, `dates`, `dateRoles`, `scheduleKind`,
  `recurrence`, and `cost` (amount and currency together).
- **Normalised match**: `provider` — case, company suffix and a short form
  of the name are all the same answer (`classifyProvider`); `subtype` —
  any phrase the truth's taxonomy groups accept (`subtypeAnswers`).
- **Cost is the annual or full-contract figure** (#985, owner ruling
  2026-09-16): never the instalment or monthly price. The truth's
  `costMinor` may carry a short list of near-identical amounts the page
  supports for that same figure; a match against any is right. #985's
  corpus corrections land before the run. Provider truths carry no legal
  suffix.

## 2. Methods: one row each

Rows are choosers, named as the eval CLIs already label them:

| row | what runs | code |
|---|---|---|
| `heuristics (one-shot)` | the pre-sieve regexes, still the shipping fallback | `proposalFromText`, `suggestions.ts` |
| `sieve+tag+choose` | rules over the tagged shortlist, no model | `chooseFields`, `extraction-choose.ts` |
| `sieve+tag+choose+model` | NuExtract picks each field from its shortlist | `chooseFieldsWithModel`, native transport |
| `sieve+tag+choose+model <name>` | a second model over the same shortlists | `--chooser-model`, Ollama chat transport |
| `model, whole page` | ADR-0025's blind pass over the page text | `model-extraction.ts`, `model-eval-cli.ts` |
| `adjudicated` | ADR-0025 §4: model judges rules against its blind pass | `adjudication.ts`, `scoreCorpusThreeWay` |

A technique that changes a stage — checksums (#980), a new sieve, a
different provider or subtype ranker — is not a row of its own. It is
measured as the rules row with that change, given a new row label, on the
same documents. ConText (#979) is already stage 2 in every row. A ranker
that moves what is on the shortlist without changing the answer is judged
by shortlist recall and top-three (#1008), not here.

## 3. The corpus

**Twelve unseen documents**: hold-out 4 (`scripts/corpus/holdout4/`, 12
pages at real-paper length). The owner declined a second hold-out (#977,
2026-09-16: "33. No."), so the bake-off runs on the corpus that exists.
No third-party data; no real documents.

On twelve points one page is 8% of a column, so the margins in section 6
are set at **two pages** and a one-page gap is called noise. The 60 tuning
pages appear in a second table for orientation only. Hold-out 3 is not
used: its cost column is tainted (#1006) and its pages are short.

The owner's own paper reaches the table only through the labelling harness
(#1025), scored on the owner's machine and recorded as a separate corpus
row in the experiment log; it never enters the repository.

## 4. The harness

`src/server/documents/bakeoff-cli.ts`, run as `npm run eval:bakeoff --
--holdout4 [--chooser-model <name>]`, beside the other eval
CLIs. It runs every row of section 2 over the named sets with the scorer
unchanged, model rows **five times reporting the minimum** (ADR-0025 §6,
`SCORING_RUNS`), rules rows once, and prints:

- one parseable score line per row, so `scripts/experiment-log.mjs` records
  each as an experiment in `docs/experiments/extraction.json`;
- the table below in Markdown, with no page named and no `--misses`.

## 5. The output table

Methods down the side, fields across, plus overall and seconds per page:

| method | provider | reference | dates | dateRoles | subtype | cost | scheduleKind | recurrence | overall | s/page |
|---|---|---|---|---|---|---|---|---|---|---|
| sieve+tag+choose | 10/12 (1b 1w) | … | | | | | | | 74.1% | 0.2 |
| sieve+tag+choose+model | 7/12 (1b 4w) min of 5 | … | | | | | | | | 41 |
| … | | | | | | | | | | |
| **owner's pick** | | | | | | | | | | |

A cell is `right/points (blanks wrongs)`. The last row is empty until the
owner fills it on #977.

## 6. What would change ADR-0026

ADR-0026's current ordering (amendment of 2026-09-11) is: the model chooses
every field; rules rank and fall back. The rule for reading the table:

- Rules beat the model chooser on a field by **two or more points** on
  the 12: that field becomes rules-first, the model not asked. The
  amendment is revised field by field.
- The model beats rules by two or more: the ordering stands for that
  field.
- Within two points (a one-page gap): no change — the difference is noise, and the ADR is
  not re-cut on noise.
- `model, whole page` beats `sieve+tag+choose+model` on any field: the
  shortlist premise itself is in question. That is flagged to the owner,
  not amended.

E111–E113 already show the chooser at 35% against rules at 72% on
hold-out 4, from one run. This bake-off turns that into a ruling.

## Superseded / rejected

- **Deciding per-class routing as a design argument.** Closed by the owner
  on #977: measure first.
- **Judging on the tuning pages**, or on hold-out 3's cost column.
- **A second hold-out (24 pages).** Proposed so a three-page margin could
  separate methods; owner declined (2026-09-16). Margins set for twelve
  instead.
- **Real household documents in the corpus.** Private data; #1025 is the
  route.
- **Restoring the wrong-value penalty for this table.** Owner ruled it
  out; blank and wrong counts in the cell carry the same information.
- **One overall number per method.** The overall column is shown, but the
  choice is per field, which is the point.
- **A script under `scripts/`.** Every eval CLI lives in
  `src/server/documents/*-cli.ts` with an `npm run eval:` alias; the
  harness follows that.
