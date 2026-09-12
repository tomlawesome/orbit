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

## Amendment, 2026-09-11: several sieves per field, and no rule discards

Owner, on the hold-out result (dates 50%, dateRoles 25%, against a stage 1
that finds 100% of the dates): "generalisation is the king", and stage 2 is
about being creative -- several independent sieves per field, each a
different way of looking at a candidate. A candidate several sieves keep
rises; one only a single sieve keeps sinks. **Rules never discard what the
model could still choose.**

Two things change from the decision above.

1. Stage 2 is no longer one trigger table per kind. For dates it is a set of
   named sieves (`extraction-date-sieves.ts`) -- the words before, the words
   after, the column heading above, the arithmetic between two dates and a
   printed term, repetition across the document, position relative to the
   document's own date -- each voting a role, the words that justified it,
   and how good a reason that is. Votes merge into tags by role, so a tag
   records which sieves agreed (`Tag.sieves`) and how strong the best of them
   was (`Tag.strength`). `npm run eval:date-sieves` judges them one at a
   time: answers kept, roles right, answers no other sieve kept, candidates
   kept, milliseconds.

2. Stage 3 keeps every date. Dates the rules can label are labelled as
   before; the rest are offered with no role and, where the model is
   available, put to it as one question over the shortlist -- which of these
   is the date the household must act on, and what for -- grounded the same
   way provider and subtype are.

Measured on the 24 the same day: overall 65.8% -> 67.9%, dates 88.6% ->
100%, dateRoles unchanged at 88.6%. All of that gain is (2): on the 24 no
new sieve keeps an answer the words before the date did not already keep, so
the sieves are redundancy there by construction. They are a bet on pages
nobody has seen, where the words-before sieve is exactly what fails, and the
hold-out is what will say whether the bet paid.

## Amendment, 2026-09-11: the same treatment for provider and cost

The hold-out said what one way of looking is worth: provider scored
-16.7% on rules alone and -41.7% with the model, and cost -27.3%. Both
would have scored higher blank. So the shape the dates got is now the
shape all three have.

1. **Several sieves per field.** `extraction-provider-sieves.ts` reads an
   organisation six ways -- the language fact beside it, an e-mail domain
   or web address sharing a distinctive word or its initials, a block
   inviting contact, the name printed throughout, a letter frame, a
   masthead -- plus one reading a name's own words as a reason against
   (ombudsman, compensation scheme, underwriting company).
   `extraction-amount-sieves.ts` reads a figure seven ways: the label, the
   clause after it, the column heading above it, which period's column it
   is in, the period word beside it, repetition, and whether it is what
   the printed instalments add up to. `npm run eval:provider-sieves` and
   `npm run eval:amount-sieves` judge them one at a time, as
   `eval:date-sieves` does.

2. **Agreement, not the first rule that fires.** The rules answer a
   provider only where two sieves agree, no other organisation is as well
   spoken for, and one of the agreeing sieves had the page's own words
   behind it; where the page states outright who the household deals with,
   only stated names are heard. Cost is the same with one exception: a
   single label that named the figure in so many words may answer alone.
   A figure a sieve reads as last year's, or as the rival beside the real
   one, is out of the running whatever else agrees.

3. **The model chooses only from what the sieves kept.** Its provider pick
   counts where at least one sieve read the same name, or where it picked
   the one name several sieves agreed about; otherwise blank. Cost joins
   provider, subtype and the unlabelled dates as a question put to it over
   a shortlist and its blocks.

Measured on the 24 the same day: overall 67.9% -> 75.1%, provider 45.8%
-> 75.0%, cost 63.2% -> 100%. Every remaining provider miss on the 24 is
a blank rather than a wrong value, which is the point of the change: the
hold-out is what will say whether the bet paid.

## Amendment, 2026-09-11: the model chooses every field; rules rank and fall back

Owner, on the hold-out: *"Everything is supposed to go to the model for
final choice."* Measured on the 12 unseen pages, every field the rules
answered alone got worse as more sieves were added -- provider -25%, cost
-36% -- while subtype, the one field decided by the model from a shortlist,
held at 66.7%. Sieves are shaped by the 24 pages however careful we are;
the model is not.

So stage 3 is now one shape for every field.

1. **Stage 2 shrinks and ranks; it never answers.** Per field the sieves
   hand over at most eight candidates, best-spoken-for first, each with the
   Tika block it was printed in and the names of the sieves and tags that
   kept it (`extraction-shortlist.ts`, and the builders in
   `extraction-choose.ts` and `extraction-choose-meaning.ts`). Nothing is
   discarded before the cap: a figure read as last year's, or a name no
   sieve spoke for, goes to the bottom of its list rather than off it.

2. **The model picks, and `none` is an answer.** One question per field:
   the dates and their jobs in one call, then reference, cost, provider,
   subtype, and -- where the roles make a schedule -- how long it runs.
   Five or six calls a document, each a few hundred characters, within the
   five-minute unattended budget. Only grounded answers count: a value on
   the list, a role in the vocabulary. `scheduleKind` still derives from
   the roles; subtype's shortlist is the taxonomy groups the page's own
   words support -- two qualifiers and two kinds, composed afterwards
   (below) -- so the model chooses between four names rather than 51
   kinds and 63 qualifiers.

3. **The rules rank and fall back, and never both.** `chooseFields` is
   unchanged and is what runs where there is no model to ask -- the
   attended case, no Ollama. `npm run eval:stages` without `--model` scores
   75.1% before and after this change, which is the point: that path did
   not move.

4. **The chooser is not tied to one model** (owner, same day: *"let a model
   choose the most likely -- that does NOT have to be the NuExtract one"*).
   Each question is plain English over a numbered list, answered with a
   number or `none`, and the reply is parsed leniently and grounded against
   the list. Two transports ship: NuExtract 3's native structured mode on
   `/api/generate`, and a generic Ollama chat call on `/api/chat`. Which
   model answers is the evaluation's own `--chooser-model <name>` flag;
   naming one also selects the chat transport. Only NuExtract is pulled on
   `orbit-ollama` today, so swapping the chooser is that flag plus a model
   pull, never a code change. The flag is read by the evaluation CLIs
   alone: the library takes the name as an argument and reads no
   environment variable, so the application's configuration contract (#292)
   stays a list of what the application itself reads.

5. **Stage 2's number is now shortlist recall** (`npm run eval:shortlist`):
   how often the expected answer is among the entries handed to the model,
   and how many entries there were. On the 24, 2026-09-11:

   | field | answer on the shortlist | mean entries |
   |---|---|---|
   | dates | 35/35 (100%) | 7.0 |
   | reference | 24/24 (100%) | 7.3 |
   | cost | 19/19 (100%) | 5.2 |
   | provider | 23/24 (95.8%) | 7.1 |
   | subtype | 24/24 (100%) | 7.8 |
   | recurrence | 11/14 (78.6%) | 1.3 |

   The provider miss is a name stage 1 cut with the words after it
   ("Kelbridge Home Loans Standard Variable Rate"). The recurrence misses
   are periods the page writes in words ("monthly"), which stage 3's cycle
   reader refuses by design; the rules-only path could not reach them
   either. Both are stage 1 and 2 work, and this is the number that says
   so.

## Amendment, 2026-09-11: word-run bins rank the provider shortlist

The owner's prototype (`tmp/provider-word-bins.ts --stage2 --phrases`) put
the correct provider in the top two bins on all six unseen hold-out pages
(#989 note 16839). That method is now the provider shortlist's ranking
(`extraction-provider-runs.ts`), copied as the owner wrote it:

1. Stage 1's organisation candidates, kept where at least one stage 2 sieve
   read them as the provider (any `provider` tag).
2. **Describer words** are every word of every name and synonym in
   `subtype-taxonomy.json` -- kinds and qualifiers -- plus a generic
   company-form list (ltd, limited, plc, llp, co, company, group, the, of,
   and, &, uk, for, a). Every other word is a **name word**.
3. Every run of consecutive words across those mentions, case folded, is
   counted where the run carries at least one name word. Ranked by count,
   then the longer run first.
4. A run printed exactly as often as a longer run containing it is folded
   into it: "colworth &", "& drake" and "colworth" at ten are "colworth &
   drake" at ten. Without that fold, eight places on a shortlist go to
   eight cuts of one name.

The runs are the shortlist: the top eight, each shown with its count, the
form the page printed most often, the blocks its mentions came from, and the
sieves and labels that kept them as evidence. What rises is not a name a
rule reconstructed but the words a page repeats -- the sieves cut one name a
dozen ways, and every cut adds to the words they share.

The describer list is the taxonomy and the company forms and nothing else.
No word is added because a tuning document needed it (owner, 2026-09-11: the
24 are samples of what a page could be, not a definition of one).

Measured on the 24 the same day (`eval:shortlist`, which now reports where
the provider answer sits among the runs):

| | before | after |
|---|---|---|
| answer on the provider shortlist | 23/24 (95.8%) | 23/24 (95.8%) |
| answer the top run | -- | 17/24 (70.8%) |
| answer in the top two runs | -- | 22/24 (91.7%) |
| mean entries | 7.1 | 5.7 |

The one miss is the one the ranking before it missed: a name stage 1 cut
with the words after it ("Kelbridge Home Loans Standard Variable Rate"),
which is stage 1 work.

The rules fallback -- the attended case, no model to ask -- takes the top
run where the page printed it more often than anything else it printed, and
answers blank where two runs are level (owner, 2026-09-11). On the 24,
`eval:stages` without `--model` scores 75.1% -> 71.5% overall and provider
75.0% -> 45.8%: 17 right, 6 wrong, 1 blank against the claim rules' 18
right and 6 blank. Three of the six wrong answers are the right
organisation under a shorter name -- "Colworth & Drake" for "Colworth &
Drake Insurance Services Ltd" -- which is what ranking runs rather than
names costs a route that has to answer with one. The model route does not
pay it: the fuller name is on the same shortlist.

### Subtype: taxonomy bins over the page's own words

The same idea turned round is the subtype shortlist
(`extraction-subtype-bins.ts`, the owner's second method of 2026-09-11,
#989 note 16840). The sources are what a document calls itself and who it
is from: stage 1's headings and the organisations at least one sieve read
as the provider. Every synonym of every taxonomy kind and qualifier, with
the joining words dropped, is looked for as a run of consecutive words in
those sources, and each hit scores one for its group. The two qualifier
groups and the two kind groups with the most hits are the shortlist -- two
of each, not more, because ranks three and four were stray single matches
("Bike Service", "Home Bank account"). The model is shown the four as one
numbered list and answers two numbers, one from each half, and the answer
is composed by the taxonomy's own rules (`composeSubtype`): a kind alone, a
qualifier in front of a kind, or a qualifier alone where the taxonomy lets
it stand ("MOT", "Council tax"). It never writes a phrase.

Measured on the 24 (`eval:shortlist`): the true qualifier and the true kind
are both on the list on 24/24, at 3.9 entries a page against 7.8 for the
phrase list before it. The rules fallback answers each half where its top
group stands clear of the second and blank where two are level, the same
test as provider: 20/24 right, 2 wrong ("Broadband Bill" for a contract,
"Gas Permit" for a safety record), 2 blank, from a field the rules could
not answer at all before. `eval:stages` without `--model` is 81.9%.

**Tried and set aside** (owner, 2026-09-11): the provider method itself --
repeated runs of describer words -- as the subtype signal. Multi-word runs
only appear where a page prints the phrase the same way each time ("life
assurance", "council tax", "workplace pensions"); most pages top out at a
single word, so "dental plan" loses to "dental" and the kind is lost. A
name is printed whole; a document's kind is not.

## Amendment, 2026-09-12: provider is read off the page, then judged by who acts

The bins cannot separate two real firms on one page where the one the
household deals with is printed less (owner, 2026-09-12: "two real company
names but the one we want appears less times"). Provider now has its own
three steps in `provider-route.ts`, outside the shared sieve and tags:

1. **Names by shape** (`provider-caps-mentions.ts`): capitalised runs, a
   capital mid-sentence, a name before Ltd/plc, after "trading as", a
   brand-shaped word (Pass2Drive, ClearBourne), and the label of the page's
   own web or e-mail address (homeguard365 in claims@homeguard365.co.uk).
2. **The bins** over those mentions, a domain label counted three times;
   the top eight runs are the shortlist.
3. **Who acts** (`provider-dealing-cues.ts`): one vote per cue kind for the
   name that signs, is paid, is written to, owns the address or the
   copyright line, or is the trading name; against the company behind a
   trading name, the underwriter or regulator, a person, a street, a
   postcode's town, a registration mark. Votes rank; the bins break ties;
   level on both is blank.

Stage 3 therefore takes the page text as well as the candidates, for
provider alone. The cues are ConText-shaped triggers read around each name,
which is stage 2's job in this ADR; they live in their own module rather
than the shared tags because the bins count mentions the shared sieve never
made. Folding them into the tags is open.

| provider, top answer | tuning 48 | hold-out 3 (12) |
|---|---|---|
| word-run bins (before) | 31 | 7 |
| names by shape, bins alone | 35 | 9 |
| names by shape, bins, then who acts | **38** | **12** |

Whole pipeline (`eval:stages` / `eval:holdout`, no model): 76.7% -> 78.2%
on the 48, 65.2% -> 70.5% on hold-out 3. The ten tuning misses left: a
broker whose web domain is on the page beats the lender or contractor
(three), the company behind a trading name where the truth wants it (two),
and names the shortlist never holds (four). Tried and dropped the same day
(`docs/experiments/extraction.json`): binning only the top and bottom
thirds of the page, weighting them, dropping ordinary English words, and
own stage 2's votes as the second step.

Ruling (owner, 2026-09-12): the provider is the party the contract, product
or service is with -- the broker the household bought from (Hedgerow), not
the insurer behind it (Thornfield Assurance).

## Amendment, 2026-09-12: cost -- the owner's words, and what is not a price

Owner, 2026-09-12: "Select numbers preceded by a currency symbol" (already
the rule -- `PRINTED_AMOUNT` and stage 3 both refuse a figure without one)
and "check words before and/or after, for things like Balance, Invoice
amount, due, Total, total due, Remaining ... Grand, final, Outstanding,
Charge, Fee". The eleven tuning misses were not gaps in those words but
figures the page prints *beside* the price, which the words then found:

- **Not a price**: a cover limit ("£300 per claim", "per condition per
  year", a row between two cover limits -- the `table-neighbours` sieve --
  or under a "Benefit"/"Limit" heading), a penalty charge, a call-out
  charge, a balloon payment. An `other` a sieve read in words now counts
  against the figure in stage 3, as `rival` and `previous` do; the blank
  `other` on a figure nobody read still counts for nothing.
- **A comparison**: "equivalent to £119.88 a year", "(for comparison
  only)", "would otherwise cost £148 if booked separately", the second
  permit's price, and the sum of every payment over a term longer than a
  year ("total payable over the 24 month minimum term") -- all `rival`.
  The truth prices a monthly contract by the month.
- **The owner's words**: contract price, amount charged, balance due,
  invoice total, final total, annual permit fee, payment of. A bare
  "outstanding balance" is a loan's debt and stays out.
- **Two reach rules**: a heading printed straight over a block that is
  nothing but the figure is the form's own label for it (full strength);
  and a backward trigger reaches into the block above only where it
  starts its own block, so "This schedule confirms your cover from 4
  October 2026" no longer makes the premium above it a future price.

| cost | tuning 42 | hold-out 3 (12) |
|---|---|---|
| before | 31 | 4 |
| after | **40** | **6** |

Whole pipeline: 78.2% -> 80.4% on the 48, 70.5% -> 72.3% on hold-out 3.
Left on the tuning set: the PCP agreement (truth wants the monthly payment;
the page's "Total amount payable" is a regulated whole-term disclosure) and
the domain renewal (truth wants the line before VAT; open for the owner).

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

1. Resolved 2026-09-11 (owner): `subtype` means "what type of thing is
   this" — insurance, service, plan — matching the app's own field
   (`src/lib/demo-data.ts`), not the document's printed title. The
   printed-title convention the corpus truths were written to is
   withdrawn; the truths are being rewritten to a short vocabulary of
   kinds (#989), and stage 3 chooses subtype by classification from that
   vocabulary rather than by copying a heading. The `energy-tariff-end`
   footer question falls away with it.

2. The 24 documents are samples of what real pages could look like, not a
   definition of them (owner, 2026-09-11, quoted on #989). Sieves and bins
   key on language and value shape; never on where something sits on
   these pages or how many of the 24 behave a certain way.
