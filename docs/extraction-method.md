# Extraction method

How document-extraction work is done and measured, and the rulings behind it.
`AGENTS.md` carries each rule as one line; the reasoning is here. It covers the
code in `src/server/documents/extraction-*`, the corpus in
[`scripts/corpus/`](../scripts/corpus/README.md) and the score register in
`docs/experiments/extraction.json`.

## Before you start

Read #992 (extraction lessons, running record) before touching
`src/server/documents/extraction-*`, and add an entry there when a session
learns something the next would otherwise relearn.

`tmp/` is the gitignored scratch directory for prototypes and for the rendered
experiment log. The gates skip it on purpose: a prototype there is expected to
rot, and following the instructions must not break the fast suite for the next
session (#995; `scripts/scratch-dir-ignored.test.mjs` guards it).

## How extraction work is tested

Owner, 2026-09-12. This is how the work is measured, not a ruling on what the
pipeline ends up doing: heuristics only, no model, one field at a time. What the
full pipeline does is decided later, once the fields have been measured this
way. The experiment page's front table is the blind whole-page model against the
heuristics on the twelve unseen pages; a run joins it with `"headline": true` in
the register.

## Every scored run is logged

Every scored run (`eval:stages`, `eval:holdout`, `eval:extraction`) is an
experiment and goes in `docs/experiments/extraction.json` the same session, with
a plain-English "what we did" (owner, 2026-09-12: "we can only improve if we
keep track"). `node scripts/experiment-log.mjs record …` parses the score line
and renders the page. The owner reads the log at port 8090 on the design host
(container `orbit-experiments`, nginx over `tmp/experiment-log/`); re-render
after recording.

## Runs that ask the model

A run that asks the model must run inside a container on
`orbit_orbit-document-processing`. From the host `orbit-ollama` does not
resolve, every answer is blank, and the run scores 0% in seconds.

    scripts/corpus/stages-rerun.sh '<command>'

runs one shell command in a throwaway `node:22` container on that network with
the checkout mounted at `/app` (`--dry-run` prints the `docker run` line it
would use; `ORBIT_STAGES_NETWORK` and `ORBIT_STAGES_IMAGE` override the network
and image). It is the old "stages-rerun" recipe,
`docker run --network … -v $PWD:/app -w /app --entrypoint sh node:22 -c '…'`,
as a script.

## Every field gets its own copy of every stage

Owner, 2026-09-12: its own sieve, its own tagging, its own chooser, in its own
files. Not one shared stage 1 with per-field choosers on top: provider's sieve is
provider's, and making it greedier must not change a single candidate subtype
sees. Copy rather than import: a shared helper cannot be tuned for one field
without moving the other, which is the whole point of separating them.
Duplication is expected and is not a defect to clean up.

Whether anything can be merged back is decided at the end, from the numbers,
once every field has been tuned on its own. Until then, a change that helps one
field and is not measured on the others does not go into anything the others
read. #996 is the first of these.

## Scanning rules are generic, not tunes

Owner, 2026-09-13: "what I wanted were generic rule improvements, not tunes".
This is about the extraction rules in `src/server/documents/extraction-*` (the
sieves, tagging and choosers that read a scanned household document), not about
project rules in general. A scanning rule states a fact about household paper in
general ("a total the page dates is history"; "the number carried on every sheet
is the item's own"), and the commit and experiment note say that fact. A rule
that names a heading word, a phrase or a layout seen on one page is a tune: it
needs a class of paper it is true of, or it stays out.

Hold-outs are a check, not the judge. Keeping a rule by its hold-out score alone
is selecting on the hold-out, and twelve pages make one page eight points of a
field. The judge is the owner's own documents through `scripts/extract-bundle/`:
rebuild after a batch of rules and compare right / in top three / wrong counts
with the previous run (#1007).

## The unseen documents are locked

Owner, 2026-09-12: "You need to be locked out from the unseen documents."
`~/agent-hooks/holdout-gate.py` refuses to read a hold-out document, its ground
truth or its generated module, and refuses to RUN an eval carrying `--misses` or
`--answers`, the flags that print each page's expected value beside what was
extracted. Staging, counting, moving, building and writing about those files is
still allowed; reading them out is not. Score them and read the score line.

Asking permission cannot help: the hook screens the command, not the intent.
Authoring a hold-out is the one exempt role, and it is declared rather than
inferred. Write `ORBIT_HOLDOUT_AUTHOR=1` into the command itself, which says "I
am writing these and will never tune against them". A session that writes it has
spent its right to tune on that set.

It must be in the command text. The hook runs as its own process, so a variable
exported around the command is not set when the hook reads its environment; the
first version checked only the environment and so locked the author out along
with everyone else. Declaring it in the command is better anyway: the exemption
shows up in the transcript on the line that used it. Only Bash can carry it, so
a hold-out author reads with `cat` and writes with a heredoc; Read, Write and
Edit stay shut on those paths.

The first hold-out was lost on 2026-09-12 without a single file being opened: an
eval printed the answers, they were read, and the next change was designed
knowing them (#996, #997). That is why the flags are gated and not only the
files. `~/agent-hooks/holdout-gate_test.py` proves both halves fire, and that
neither blocks ordinary work. Hold-out history is in the corpus README.

## Collected documents stay out of the repository

Owner, 2026-09-15: "None of our treatments from any source need to be committed,
any that carry license terms saying they do shouldn't be used." Specimen and
real documents gathered for measuring the extractor live outside git
(`~/projects/.scratch/uk-specimens/` for the collected British specimens, the
owner's own machine for their paperwork) and are used locally only. A source
whose licence would oblige us to publish or redistribute anything is not used at
all, whatever else it offers. Counts, score lines and licence records are what
travel.

## An internal test harness is not product UX

Owner, 2026-09-15: "This is a basic functional ui so it goes to you. We don't
need fable for test harnesses." The global rule routing UI and architecture
calls to the top model covers what a household sees, not tooling the owner and
the agents use: a labelling harness, an evaluation page, a debug view. Build
those in the ordinary way; #1025 was filed to the top model in error.
