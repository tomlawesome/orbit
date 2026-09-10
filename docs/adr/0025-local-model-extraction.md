# ADR-0025: Model extraction is a schema-bound, evidence-grounded proposer on a fixed internal endpoint, gated by a hold-out corpus

**Status:** Accepted (owner, 2026-09-09), **amended 2026-09-10** by the
owner's ruling on #936: the model adjudicates over both readings rather than
competing with the heuristics. Section 4 carries the new shape, with the
superseded wording kept inside it. Section 1's request bound moved from one
pass to two as a direct consequence, and sections 3 and 6 were tightened to
match; section 2's boundary is untouched. The review-surface question the
amendment left open was ruled on by the owner the same day and is recorded
in section 4. With the constants held lightly:
the owner ratified "for now" and expects to revisit this one. Drafted under
the owner's decisions of 2026-08-13 on #319: the four fields stay and the
model path must produce them; no training or fine-tuning, ever; no cloud
extraction providers.

The parts most likely to move are the three fixed numbers -- the +0.05
margin, the ten-document hold-out minimum, and minimum-of-five scoring --
because none of them can be validated until the model path has run against
real paperwork. Changing one is a revision of this ADR, not a build-time
judgement.
**Date:** 2026-09-09
**Relates to:** #319 (the epic; outcome, non-goals and the four-field
requirement are decided there); #933 (this design slice); #929 (the
tuned-against-its-own-corpus caveat this ADR's measurement design answers);
ADR-0005 (review-first ingestion, unchanged here); ADR-0002 (the gate in
section 6 is evidence in its sense); `docs/document-threat-model.md` (which
already binds any model path: "a tool-free, secret-free, network-isolated
proposer" whose "schema-constrained output receives the same validation and
trust level as parser or OCR output")

## Context

Extraction today is `proposalFromText`
(`src/server/documents/suggestions.ts:231`): deterministic heuristics over
parser text, producing a `DocumentProposal` (:6) of `title`, `provider`,
`reference` and `dates`, always re-validated at the storage boundary by
`safeStoredDocumentProposal` (:241). Suggestions reach the person through
`buildSuggestions` (`src/server/item-document-inspection.ts:65`) and the
mail-in review flow (`src/server/mail-in/`, `src/server/reviewed-intake.ts`);
nothing is ever written without explicit review (ADR-0005).

Facts verified in the tree on 2026-09-09:

- The evaluation corpus (`src/server/documents/extraction-corpus.ts`) holds
  23 documents worth 78 points; `extraction-accuracy.test.ts` measures the
  heuristics at 1.00 with `ACCURACY_FLOOR = 0.95`. #929 records the trap:
  the heuristics were improved against the same documents that score them,
  twice now (after #316 and after #929), so 1.00 means "handles these
  documents", not "extraction is solved". A model path judged on this
  corpus would inherit the same illusion — and could never show a margin
  over a baseline already at 1.00.
- `orbit-ollama` (`docker-compose.yml:121`) exists under the optional `ai`
  profile: pinned image, `OLLAMA_NO_CLOUD: "1"`, port 11434 unpublished,
  CPU and memory bounded (`OLLAMA_CPUS`, `OLLAMA_MEMORY_LIMIT`). It has no
  `networks:` key, so it sits on the default Compose network — which has
  egress, unlike the internal-only `orbit-document-processing` network that
  Tika and ClamAV are confined to. No application code calls it.
- The item model carries four fields nothing extracts: `subtype`,
  `costMinor` and `recurrenceMonths` (`src/db/schema.ts:401` onwards) and
  `scheduleKind` (`src/lib/workspace.ts:39`), which is not a column but a
  validated value derived from which scheduled date an item has
  (`scheduleKinds = ["renewal", "service"]`, `src/lib/domain.ts:23`).
  The owner decided on #319 (2026-08-13, revised the same day) that these
  stay in the model, that no interim heuristic attempt is made, and that
  the model path must actually produce them — or the contract be revisited
  — before any main promotion.
- `document-health.ts` (`src/server/document-health.ts`) already reports
  scanner, encryption, storage and worker state to administrators, with the
  application staying healthy when an optional dependency is not.

## Decision

### 1. Bounded requests, one schema, one deadline

Per document the model is asked for exactly one *kind* of thing -- a single
JSON object naming candidate field values, each with a verbatim evidence
span copied from the document -- and the number of times it is asked is
bounded and enumerable: **at most two passes**, the blind pass and the
adjudicating pass of section 4, never more. Every pass carries the identical
bounds below; no pass relaxes them. (Until 2026-09-10 this section read
"asked exactly once"; the section 4 amendment superseded that, and the
bound moved from one request to two rather than being lifted.) The input
is the same parser text the heuristics read, after the evidence normalisation already applied to
anything untrusted (NFKC, controls and bidi formatting stripped), truncated
to a fixed character budget set in code. The system prompt is a fixed
string in the repository; the document rides in a delimited data block that
the prompt names as untrusted content to be read, never obeyed.

The reply is bounded on every axis, all constants in code, none
configurable: schema-constrained decoding (Ollama's structured-output
`format`, so the reply cannot be prose), temperature 0 and a fixed seed, a
generation-token cap, a response-size cap checked before parsing, and a
wall-clock deadline — short for the interactive Add-item inspection, longer
for the asynchronous mailbox path, never unbounded. That deadline bounds
**the whole flow, not each pass**: two sequential passes must not double
what the interactive path waits for, so the adjudicating pass runs only
inside what remains of the document's budget and is abandoned like any
other late reply once it is spent. A reply that is late,
oversized, malformed, schema-violating or absent is discarded whole: no
partial salvage, no repair prompt, no automatic retry. The upload proceeds
with the heuristic proposal alone, and the failure is recorded as a sample
for section 5. Where it is the *adjudicating* pass that fails, the
heuristic value stands for the disputed field -- not the blind model value
-- because the heuristics are this design's fallback everywhere else, and a
failed adjudication is evidence for neither reading. On hostile input this is the entire blast radius: an
attacker who controls the document controls, at most, which *candidate
suggestions* a reviewer sees — the same power a hostile document already
has over the heuristics — and can waste at most two bounded inferences. A
hostile document can always manufacture a disagreement and so force the
second pass, which is why the count is capped here rather than left to
section 4's agreement test: that test is a cost optimisation, not a
security control.

### 2. The endpoint is code, not configuration; the server loses egress

Document text goes only to the private local model. What prevents a cloud
path by configuration is that no configuration exists to express one:

- The client's endpoint is the compile-time constant
  `http://orbit-ollama:11434`. There is no base-URL, host, port, proxy or
  API-key setting anywhere in Orbit's configuration surface. The only knobs
  are the Compose `ai` profile (on/off) and the model name. Reaching any
  other destination requires a code change, and a code change to this
  boundary requires an ADR superseding this one.
- `orbit-ollama` moves onto `orbit-document-processing` (`internal: true`),
  the same egress-free network that confines Tika and ClamAV — a hostile
  document's text must not sit in a container that can reach the internet.
  `OLLAMA_NO_CLOUD: "1"` stays as defence in depth against Ollama's own
  cloud relay, but the network is the structural guarantee: even a
  malicious model server image has nowhere to send anything.
- Pulling a model needs egress the serving container no longer has, so the
  implementing slice adds a one-shot pull helper (same image, same
  `orbit-ollama-data` volume, default network, run explicitly by the
  operator, never at startup). Selecting and pulling a model remains a
  deliberate operator action, as the Compose comment already promises, and
  the documentation recommends digest-pinned model references.

An adapter interface fronts the client, per the house rule that externals
get a replaceable seam — but it ships exactly one production implementation
plus a test fake. The seam exists for testing, not for provider choice;
adding a second production implementation is a superseding decision, not a
plugin.

### 3. Validation: everything the heuristics get, plus grounding

Model output enters `safeStoredDocumentProposal` like any other proposal
source and keeps its trust level: bounded untrusted evidence that may
populate only allowlisted, type- and length-validated editable suggestions,
behind the unchanged review-first flow. Non-determinism adds two
requirements beyond that:

- **Grounding.** The heuristics can only quote the document; a model can
  invent. So every model value must arrive with its verbatim evidence span,
  and a field whose span does not occur in the normalised input text is
  dropped before validation. **"Input text" means the document data block
  and nothing else.** Section 4's adjudicating prompt carries the heuristic
  and blind readings inside it; a value present only in those supplied
  readings must not self-ground on them, or grounding becomes a check the
  prompt can satisfy by quoting itself. The adjudicated answer is grounded
  against the document exactly as the blind answer is. Numeric fields (`costMinor`,
  `recurrenceMonths`) additionally require their digits to appear in the
  span. Dates are canonicalised then checked by the existing
  `validCalendarDate`, deduplicated and capped as today. A grounded-but-
  wrong value survives — that is what review is for — but a fabricated one
  does not reach the reviewer.
- **Closed vocabularies and derived values.** The model never emits
  `scheduleKind`. It labels each date with a role from a closed set
  (renewal, expiry, due, service, issued, start, other); the application
  maps roles onto the item's date slots and derives `scheduleKind` exactly
  as `src/lib/workspace.ts` already derives it from which scheduled date is
  present. Unknown role strings are dropped. `subtype` passes
  `safeDocumentPlainText` at 80 characters; `costMinor` and
  `recurrenceMonths` are validated to the bounds `src/lib/workspace.ts`
  already enforces (0–100,000,000 minor units; 1–120 months). A cost is
  proposed only when its span carries an explicit currency symbol or code;
  the model never guesses a currency.

Everything else the heuristics get — `safeStoredDocumentProposal`'s
normalisation, length caps, markup stripping, the fresh-object rebuild that
discards unknown keys — applies unchanged. Raw model responses are
discarded after proposal derivation and never logged, exactly as raw parser
responses are.

### 4. The model adjudicates; it does not compete

**Amended 2026-09-10 by owner ruling (#936); the superseded position is
recorded at the end of this section.**

The heuristics run on every upload regardless — they are microseconds of
regex and they are the fallback, so they must stay exercised. Where the
model path is active (profile up, gate in section 6 passed at release
time), the model is used as an adjudicator over both readings rather than
as a rival whose value wins a contest:

1. **Blind pass.** The model reads the document under section 1's bounds
   with no knowledge of the heuristic proposal, and its result is recorded.
2. **Comparison.** The blind result is compared with the heuristic result,
   field by field.
3. **Adjudicating pass.** Only where the two disagree on a field, the model
   is asked once more — same bounds, same schema — this time with both
   readings supplied, and its answer is final for those fields.

**"Disagree" is a defined term here, not a judgement call for the slice.**
Comparison happens on values that have already passed section 3's
validation and normalisation, never on raw model output or raw regex
captures, so "EDF Energy" and "EDF ENERGY" are the same answer. A field
where one extractor found a value and the other found nothing **is** a
disagreement worth adjudicating: the whole hard case in this domain is a
value that only one reading sees, and the superseded shape's
"differing *non-empty* heuristic value" wording quietly excluded exactly
that. A field neither extractor filled is not a disagreement and buys
nothing.

**One adjudicating pass covers every disputed field**, not one pass per
field — the cap in section 1 is two passes per document, and a per-field
cap would not be enumerable. That pass uses the full section 1 schema, and
its output for fields that were already settled is discarded rather than
allowed to reopen them.

**What the adjudicating pass may return.** It uses the same schema as the
blind pass, so it emits a field value with its evidence span — it is *not* a
choice between two candidates. Four outcomes are available to it, and all
four are intended:

1. endorse the heuristic's reading;
2. endorse its own blind reading;
3. propose a value neither reading found;
4. return the field empty — "both readings are wrong and I have nothing
   better."

The fourth is deliberate and follows from #939: a wrong value costs more than
a blank, so a model able to reject both readings is worth more than one
forced to pick the least bad. The schema must therefore permit an absent
field, and an empty adjudicated field is a **result, not a failed pass** —
distinct from the late, malformed or absent reply of section 1, which leaves
the heuristic value standing.

Grounding is unchanged and constrains outcome 3: a value neither reading
proposed must still occur verbatim in the document data block, so
adjudication cannot invent one.

The case that earns the second inference is the partial one. Where the
heuristic has "Northfield Gas & Energy Ltd" and the blind pass has
"Northfield Gas", both are defensible and the question is which the document
actually supports — the judgement neither a regex nor a single unaided read
can make, and the same question #939's tight-name ruling answered by hand.

**The order is the point, not an implementation detail.** Shown the
heuristic's answer up front, the model anchors on it, and what looks like
two extractors agreeing is one extractor twice. The blind pass is what
keeps a genuinely independent second reading in the system, and recording
it is what makes that independence checkable afterwards.

It also turns disagreement from a tie-break into a judgement. A model told
"the heuristic says Direct Debit" can reason that a payment method is not a
sender, which no mechanical rule between two candidate strings can do.

Two bounds on the shape:

- **Agreement settles the field.** When the blind pass and the heuristic
  already agree, that is the confident case and no adjudicating pass is
  paid for. This is the same instinct as #939's "do not even run the
  partial once an exact match is found", applied to inference cost. It is a
  **cost decision, not a correctness claim**: two extractors reading the
  same text can fixate on the same salient wrong string, and agreement
  there is not independent evidence. That case is bounded by review-first
  (ADR-0005) and visible in section 6, where an agreed-but-wrong field
  depresses all three numbers alike.
- **Three numbers are kept, never two**: heuristic alone, model blind, and
  model adjudicated, per field and overall. Without the blind score there
  is no way to tell whether adjudication earns its keep or merely launders
  the heuristic's answer back out. Section 6 gates on these.

The adjudicated value is a suggestion like any other: it passes section 3's
grounding and validation unchanged, and nothing is written without review
(ADR-0005). Adjudication decides *which reading is proposed*; it never
decides whether to write.

**What the reviewer sees (owner ruling, 2026-09-10).** The adjudicated value
is the suggestion, and the reading it rejected stays available behind a quiet
secondary affordance beside the field — "also read as: X" — which fills the
field with that value when chosen. Where the two readings agreed, nothing
extra is shown at all: the reviewer sees an ordinary suggestion and is not
asked to think about extraction. This keeps the superseded position's still-
valid principle that disagreement is information, and lets a doubtful
reviewer pick the other reading instead of retyping it, without going back
to making them resolve every disagreement — which is what the ruling
removed. The alternative considered and rejected was showing the adjudicated
value alone, which discards a reading the system paid two inferences to
produce.

**What that requires keeping.** Only the losing *validated* value, and only
for the life of the pending review that offers it: it is discarded when the
item is saved or the review is abandoned, along with everything else the
review held. Nothing about the second reading is retained beyond that, and
raw model responses are still never logged (section 3). Section 5's
agreement counter is unaffected — it is a non-sensitive count and does not
carry values.

Dates are not adjudicated as a contest, because a date set has no single
value to disagree about: they remain the union of both extractors'
validated dates, deduplicated, carrying the model's role labels where
assigned, exactly as before. The consequence is worth stating plainly:
adjudication never *removes* a date. Date noise is corrected by the
reviewer and measured by section 6, not adjudicated away. The four fields of section 7 are model-only,
so no disagreement arises there and no adjudicating pass is triggered by
them. Per-field agreement is recorded as a non-sensitive counter, feeding
section 5.

**Superseded position (ratified 2026-09-09, replaced 2026-09-10).** Section
4 previously read "Both extractors always run; disagreement is shown, never
merged silently": the model's grounded value was the primary suggestion, a
differing non-empty heuristic value was presented alongside it as a
labelled alternative, and the reviewer chose. It is recorded rather than
deleted because the reasoning behind it — that disagreement is information
and must not be averaged away — still holds, and the amendment keeps it:
adjudication is a reasoned reading of both, not a blend or a confidence
score. What changed is who resolves the disagreement. The old shape asked
the reviewer to resolve every one; the new shape spends a second inference
to resolve it first, and only where the two readings actually differ.

### 5. Degradation: heuristics per upload, `document-health` for the administrator

Per upload, model failure is invisible beyond the suggestions simply being
the heuristic ones — no user-facing error, no blocked flow. The
administrator, not the upload stream, is where unavailability surfaces:
`document-health.ts` gains a `modelExtraction` entry beside `scanner`, with
three states — `not_configured` (no `ai` profile: a design state, not a
warning, and it never degrades overall health), `ready`, and `unavailable`
(configured but unreachable, or failing above a threshold over the recent
sample window recorded by sections 1 and 4). `unavailable` marks overall
health degraded with a non-sensitive diagnostic, following the scanner
precedent: the application stays up, the administrator learns that every
upload is silently getting heuristics only, and nothing in the diagnostic
names documents or content. The Compose profile is the only switch; there
is no second in-app toggle to drift out of agreement with it.

### 6. Measurement: pinned and repeated, gated on a hold-out the tuning never reads

Determinism is approached, then not trusted. The evaluation pins model
reference (digest), image, prompt, seed and temperature, then still scores
the full corpus five times and reports minimum, mean and maximum; every
gate below uses the **minimum**, so run-to-run variance counts against the
model, never for it.

The #929 trap — a 1.00 baseline manufactured by tuning against the
scoreboard — is answered by splitting the corpus. The existing 23 documents
become the *tuning set*: improvement work (prompts, pipeline, model choice)
may read and iterate against them freely. A new *hold-out set* lives in a
separate file whose header states the rule: sessions doing extraction
improvement never read it; a hold-out document that gets tuned against is
moved to the tuning set and replaced. Enforcement is the recorded rule plus
review, which is the honest limit of what a repository can promise, and it
is the same choice #929's comment sketched.

Section 4 makes this a three-way measurement rather than a two-way one.
Every evaluation reports the heuristics alone, the model's blind pass and
the model's adjudicated answer, separately. The margin below is judged on
the **adjudicated** number, because that is what a reviewer would see.

A blind score at or below the heuristic baseline is **not** a failure and
does not block the gate. The owner's ruling is that the model's value is as
a judge over both readings, not as a solo extractor, so an ensemble that
beats both of its components is this design working as intended rather than
a result to be suspicious of.

What the blind number is actually for is detecting laundering — adjudication
parroting the heuristic instead of judging it. That failure has the opposite
signature: it drives the adjudicated answer *towards* the heuristic, so it
shows up as a missing margin, which the gate below already fails on its own.
The sharper diagnostic, reported beside the three scores, is **per-disagreement
resolution accuracy**: among the fields where the blind pass and the heuristic
disagreed and the blind reading was the correct one, how often did adjudication
side with the heuristic anyway. That is diagnostic reporting only. Making it a
threshold would be a revision of this ADR needing ratification, not something a
build slice decides.

The gate for the model path becoming the default where available:

- on a hold-out of **at least 10 documents**, the model's minimum
  adjudicated accuracy over five runs exceeds the heuristics' hold-out
  accuracy by **at least 0.05** — that is the stated margin, measured where
  neither extractor was tuned;
- on the tuning corpus, the model's minimum stays at or above
  `ACCURACY_FLOOR`;
- corpus ground truth is extended to the four fields and role-labelled
  dates first, so the gate judges the whole contract, not the easy quarter
  of it.

The heuristic fixture test stays in the fast lane unchanged. Model
evaluation is a separate script run where the `ai` profile exists —
developer machine or opt-in CI job — never a required pipeline gate, since
CI runners do not carry the profile. Its numbers are recorded with the
ratification evidence of the enabling release (ADR-0002), naming model
digest, margin achieved and spread.

### 7. The model path owns the four fields

`cost`, `subtype`, `scheduleKind` and `recurrenceMonths` are extracted by
the model path, not dropped. The owner settled the direction on #319
(2026-08-13): the fields stay, the heuristics never attempt them, and the
model path must produce them before any main promotion. This ADR makes
that the contract: `DocumentProposal` grows `costMinor` (with explicit
currency), `subtype`, `recurrenceMonths` and role-labelled dates, validated
as section 3 specifies, with `scheduleKind` derived rather than emitted.
The suggestion surfaces — `buildSuggestions`, which today emits only four
of the eight fields `itemDocumentSuggestionFields` declares, and the
mail-in review flow's parallel surface — are wired to carry the new slots
consistently, and the UI presents the four as document-suggested only when
the model actually produced them, which is exactly the owner's "honest UI
now, real extraction later" state resolving itself. Where the model is
absent, those suggestion slots are simply empty, as they are today.

## Consequences

- Build slices can be filed against this ADR: the client and prompt with
  bounds (§1–2, including the two-pass cap, the Compose network move and
  the pull helper), the
  proposal-contract and validation extension with corpus ground truth for
  the four fields (§3, §7), the blind-then-adjudicate two-pass flow with
  its three recorded numbers (§4), health reporting (§5), and the hold-out
  set plus evaluation script (§6). None of them reopens a design question.
- `docs/document-threat-model.md` must be extended by the first
  implementing slice, as its deferred-features section requires; the
  extension records sections 1–3 as the model boundary.
- The default-on story is two-staged by construction: instances without the
  `ai` profile keep pure heuristics forever, and instances with it get the
  model path only in a release whose evaluation passed the section 6 gate.
- On small hosts the bounded deadline will sometimes lose the race and
  uploads will quietly get heuristics; section 5 is how an administrator
  distinguishes "occasionally slow" from "down".
- The four fields' accuracy is measured from the first corpus extension, so
  "must actually produce those fields" before main promotion becomes a
  number, not an assertion.
- Choosing which local model to recommend is an evaluation outcome, not a
  design call: candidates are scored by the section 6 harness and the
  winner is recorded with its numbers. **The owner fixed the budget that
  evaluation runs inside (2026-09-10): Orbit is self-hosted, typically on
  unremarkable hardware, so the model path must do a lot with little.**
  - **CPU is the baseline, not the fallback.** If the job can be done on
    CPU it is done on CPU, and a candidate that needs a GPU to be usable
    has failed rather than qualified. The Compose service is capped at 2
    CPUs and 6 GB today, which is the shape a candidate is judged in.
  - **A GPU option is offered, and it asks for very little.** Nobody
    hands a household document-filing system their whole graphics card,
    so the optional accelerated path targets a small slice of VRAM
    rather than a dedicated device, and degrades to the CPU path when it
    is not there. Delivery is CUDA in Docker; the container, its network
    and every bound in sections 1 to 3 are unchanged by it, so this is a
    deployment option and not a second extraction path.
  - The consequence for selection is that model *size* is a first-class
    score alongside accuracy. A candidate that wins on accuracy while
    only running acceptably on hardware a self-hoster does not have has
    not won.

## Alternatives rejected

- **Any cloud or hosted extraction API:** forbidden by #319's non-goals,
  and it would move household documents across the one boundary this
  design exists to keep them inside.
- **A configurable endpoint URL (e.g. an OpenAI-compatible base-URL
  setting):** that *is* the cloud path by configuration alone; the absence
  of the knob is the control.
- **Training or fine-tuning:** owner ban, 2026-08-13 — off-the-shelf model,
  corpus- and prompt-driven improvement only.
- **Free-text prompting parsed after the fact:** turns every malformed
  reply into a parsing surface and every hostile document into a prompt
  for one; grammar-constrained decoding removes the failure class.
- **Retry or self-repair loops on malformed output:** unbounded spend a
  hostile document can trigger. A failed pass is never re-attempted; the
  two passes of sections 1 and 4 are two different questions, not one
  question retried, and a failed adjudication falls back to the heuristic
  value rather than asking again.
- **Multimodal input (raw PDFs or images to the model):** v1's model reads
  only the text the existing parser boundary produced; scanned-input OCR
  is the separate deferred design the threat model already requires.
- **Silent merge or confidence-weighted blend of model and heuristic
  values:** hides exactly the signal a reviewer needs; disagreement is
  information, not noise. Section 4's adjudication is not this: a blend
  averages two strings mechanically, where adjudication asks a reader to
  judge both and say which the document supports.
- **The model and the heuristics as competitors with a mechanical
  tie-break** (the position section 4 held until 2026-09-10): it spends the
  model's only real advantage — that it can read — on being one candidate
  string among two. Owner ruling, #936.
- **Feeding the heuristic result into the single model pass:** cheaper than
  two passes, and it destroys the independence the second opinion exists
  for; the model anchors and agreement becomes unfalsifiable.
- **Adjudicating every field, including the ones both readings agree on:**
  pays for inference to confirm what is already settled, against #939's
  ruling that a confident answer stops the search.
- **Auto-applying high-confidence suggestions:** would breach ADR-0005's
  review-first invariant and #319's "never an automatic write".
- **Scoring by mean over runs:** lets variance hide regressions; the
  minimum gates.
- **Judging the model on the tuning corpus:** the #929 trap — a baseline
  of 1.00 there makes "beats by a margin" unfalsifiable and meaningless.
- **A heuristic attempt at the four fields:** closed by the owner on #319
  before this ADR ("no interim heuristic attempt"); recorded here so the
  ceiling that decision protects against is not rebuilt by accident.
- **An in-app enable toggle beside the Compose profile:** two switches that
  can disagree, reporting confusion for no capability.
- **Leaving `orbit-ollama` on the default network:** a container that
  handles hostile document text with internet egress, which the threat
  model denies to every comparable service.

## Open for the owner

1. Ratification of this ADR, including the constants it fixes: the 0.05
   hold-out margin, the 10-document hold-out minimum, and minimum-of-five
   scoring.
2. An invitation, not a blocker: hold-out documents modelled on real
   household paper (all values fictionalised, per the no-real-data rule)
   would make the hold-out far stronger than synthetic documents written
   by the same agents that tune the extractors. Absent owner-supplied
   documents, the hold-out is synthetic under the section 6 no-tuning
   rule.
