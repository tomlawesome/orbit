# Extraction corpus: full-page documents

Builds the full-page fixtures in
`src/server/documents/extraction-corpus-fullpage.ts` (#981) and the hold-out
fixtures in `src/server/documents/extraction-holdout3-fullpage.ts` (#998) and
`src/server/documents/extraction-holdout4-fullpage.ts` (#1007).

Three corpora, three directories. Every script here takes `--dir <name>` (or
`CORPUS_DIR`) and defaults to `sources`, so a command without the flag still
means the tuning set:

| directory   | documents | what it is for |
| ----------- | --------- | -------------- |
| `sources/`  | the tuning set (48) | read it, tune against it, argue with it |
| `holdout3/` | an unseen set (12) | scored, never read, never tuned against |
| `holdout4/` | an unseen set (12) | scored, never read, never tuned against |

Hold-outs 1 and 2 are retired: both were spent (#996, and the shape of its
misses read during tuning, #998) and rolled into `sources/` on 2026-09-12,
which is why the tuning set is 48 rather than 24. `holdout3/` and `holdout4/`
are the two unseen sets left; a further one follows this file's shape and
`generate.mjs`'s directory-derived naming.

## Why these exist

The corpus these join was 36 documents averaging 294 characters, the longest
about a fifth of an A4 page, in which **76 of 77 dates were answers**. With
almost nothing to reject, "find the dates" and "find the right dates" were the
same task, and every accuracy number the project held was measured on that.

These six are full pages of realistic UK household paper — 45,700 characters,
**9 answers among 85 date-like strings**. Adding them moved measured heuristic
accuracy from 50.2% to 43.7%, and dropped provider from 100% to 69.7% and
reference from 100% to 77.1%. Nothing regressed; those fields were never that
accurate, they were measured on documents that printed `Provider: Acme Cover
Ltd` on a line of its own.

## Rebuilding

From the repository root, with the `orbit-tika` container running:

```sh
# 1. Typefaces. Not committed -- see "Fonts" below.
bash scripts/corpus/fetch-fonts.sh

# 2. Give each document its typeface. MUST come before rendering: a document
#    written against the placeholder stacks and measured there will spill once
#    its real face goes in. Libre Baskerville put the energy letter 49px over
#    A4 on a page that measured clean the moment before.
node scripts/corpus/apply-fonts.mjs

# 3. HTML -> PDF, A4, backgrounds on.
node scripts/corpus/render.mjs

# 4. No page may spill past A4.
for f in scripts/corpus/sources/*.html; do node scripts/corpus/measure.mjs "$(basename "$f")"; done

# 5. PDF -> text, through the REAL Tika. No host port is published, so this
#    runs on Orbit's document-processing network.
docker run --rm --network orbit_orbit-document-processing \
  -v "$PWD/scripts/corpus/sources:/data" \
  -v "$PWD/scripts/corpus/tika.mjs:/app/tika.mjs:ro" \
  node:26-alpine node /app/tika.mjs

# 6. Every declared value must be findable in what Tika produced.
node scripts/corpus/verify.mjs

# 7. Write the TypeScript module, and the evidence needles the
#    ideal-answer test needs.
node scripts/corpus/generate.mjs
node scripts/corpus/generate-evidence.mjs   # paste into ideal-answer-survives.test.ts
```

For the hold-out, the same seven steps with `--dir holdout3` (and the volume
mounted from `scripts/corpus/holdout3` at step 5). There is no evidence file:
the ideal-answer test reads the tuning set only. `generate.mjs` derives both
the output path and the export name from the directory's own basename, so
`--dir holdout3` writes `extraction-holdout3-fullpage.ts` and exports
`EXTRACTION_HOLDOUT3_FULLPAGE` -- any directory other than `sources` gets its
own module and export this way, which is what let a second and third
hold-out exist without overwriting the one before it.

`contact-sheet.mjs` and `make-index.mjs` build review pages: page 1 of all six
side by side, and the PDFs with their ground truth. Two rounds of near-identical
documents got through because they were reviewed one PDF at a time.

## Rules these documents follow

- **Never edit the `text` in the generated module.** Edit the HTML and
  regenerate, so the fixture and the document it came from cannot drift apart.
- **The text is Tika's real output**, flattened tables and repeated page
  headers included. That is the point — the fixture is what production sees.
- **A document must not explain its own trap.** An early draft of the gas
  safety record stated in its small print that it did not say when the next
  check fell due, and the vaccination card explained that its vial expiry
  dates needed no action. Real paper never does this, and it hands the answer
  to any extractor that reads it. Both were removed.
- **Every expected value is verified present**, not assumed. `verify.mjs`
  fails the build rather than letting a fixture claim something the page does
  not say. The one cost that may be unprinted is a fixed-term total the page
  leaves as price x months (owner, 2026-09-13): the truth then declares
  `costArithmetic` and `verify.mjs` checks each price and term is printed and
  the products add up.
- **The truth JSON is the source; the TypeScript is generated.** Edit
  `sources/<name>.truth.json`, then run `generate.mjs`. Edits made directly
  to `extraction-corpus-fullpage.ts` are lost on the next generation (that
  happened to eleven cost truths and two providers before 2026-09-13).
- **British, never American** (owner, 2026-09-11). Dates are `3 March 2026` or
  `03/03/2026`, day before month; money is in pounds; spelling is `licence`,
  `cheque`, `organisation`, `authorised`, `instalment`, `centre`; addresses
  carry a postcode, not a state and a ZIP. An Americanism makes the fixture
  measure something a real UK extractor will never meet. `verify.mjs` now fails
  on the unambiguous markers, and the American date form `March 3, 2026` was
  removed from the printed forms it accepts -- while it was there, a fixture
  could have declared a date printed that way and passed.
- **Each document is its own kind of object** — a government form, a carbon
  copy, a letter, a folded card, a marketing leaflet, a bulk-printed schedule.
  Varying colour and font alone produced six documents with one skeleton;
  what separates real paper is production method and page geometry.

## Fonts

`fetch-fonts.sh` downloads eleven files across eight families, all **SIL Open
Font License 1.1**, into `scripts/corpus/fonts/` — which is **not committed**.
Fetching rather than vendoring keeps the project from redistributing copies
and taking on the obligations that go with that. The corpus text is committed,
so this is only needed to regenerate the fixtures.

These are **build-time tooling**. Nothing here ships in the Orbit image, is
served to a user, or is redistributed.

Two traps, both of which have already cost a rebuild:

- **Only ten fonts are installed on this host** (see the root `AGENTS.md`).
  Anything else falls back silently. Six documents were once built to look
  deliberately unlike each other and rendered in a single face because every
  one asked for Helvetica or Times New Roman.
- **Google ships variable fonts as `Name[wght].ttf`.** Brackets do not resolve
  in a CSS `url()`, so the fetch script drops the axis tag from the filename.

The assignment of face to document is **fixed, not random**. The corpus text is
committed ground truth; a typeface that changed between renders would change
what Tika emits and silently invalidate it.

`holdout3/` uses its own further faces, none of them used by `sources/`, so
the two corpora share no character map. A fault that only appears in one
font's encoding would otherwise be tuned away on `sources/` and never met
again. The now-retired first and second hold-outs followed the same rule
against `sources/` and against each other before they were merged in, which
is why the 48 tuning documents between them use as many distinct typefaces
as they do.

## Hold-out history

The first hold-out was burned on 2026-09-12 (#996): an eval run with
`--misses` printed each page's expected answer during a tuning session, the
output was read, and the next change was designed knowing what those pages
contained. The second hold-out (#997) replaced it, written without reading
`sources/`, the first hold-out, or either of their generated modules -- and
was itself partly spent (#998) when a script run over it during tuning
reported the shape of its misses (word counts, capitals): counts, not text,
but enough to change stage 1 with.

Rather than write a fourth set immediately, both retired hold-outs were
rolled into `sources/` on 2026-09-12 (#998): their 24 documents joined the
original 24 to make the 48-document tuning set this file now describes, and
`holdout3/` took over as the only unseen set. Nothing about a document
changed in the move -- same HTML, same ground truth, same fonts -- only its
directory and, for the two generated modules it came from
(`extraction-holdout-fullpage.ts`, `extraction-holdout2-fullpage.ts`), which
no longer exist.

## Hold-out 3

`holdout3/` is twelve documents written after the extractor was tuned, by
someone who had not read `sources/` or either retired hold-out. It is the
only measurement the project has of whether the extractor generalises rather
than fits the 48 pages it was built against, and that is true only while
nobody working on the extractor has seen the pages.

Twelve documents, real Tika output: about 19,200 characters in total, 97
date-like strings, 26 of them answers. Measured baselines belong on the
experiment log (`docs/experiments/extraction.json`, rendered by
`node scripts/experiment-log.mjs render`), not here -- a number quoted in
this file would be exactly the kind of spoon-fed result the corpus exists
to avoid.

So, for anyone tuning:

- **Do not read `scripts/corpus/holdout3/`**, or
  `src/server/documents/extraction-holdout3-fullpage.ts`, or the PDFs, the
  truths, the contact sheet or the index built from them.
- **Do not run `npm run eval:holdout -- --holdout3 --misses`.** The default
  prints the score lines and nothing else. Per-document misses are how a
  hold-out quietly turns into a second tuning set, one fixed miss at a time;
  they are for the owner, who is not the one tuning.
- **Never change a hold-out document to make a score move.** A fix that needs
  the hold-out to change is a fix aimed at the answer, not at the extractor.

New documents belong in `sources/`. If `holdout3/` is ever burned -- read,
tuned against, or quoted back into a fix -- it is spent, and the replacement
is `holdout4/`, following this section's shape and `generate.mjs`'s
directory-derived naming -- not a scrub of any retired set.

`--holdout3` selects it on every eval CLI that takes a hold-out
(`holdout-score-cli`, `holdout-breakdown-cli`, `provider-bins-cli`,
`subtype-runs-cli`, `provider-stage1-cli`, `provider-stage2-cli`,
`shortlist-recall-cli`, `model-blind-probe`); none of these CLIs accept
`--holdout` or `--holdout2` any longer.

Building a hold-out from a fresh session needs `ORBIT_HOLDOUT_AUTHOR=1`
declared on every command that touches its path, because
`~/agent-hooks/holdout-gate.py` otherwise refuses to let a tuning session
read or write it; see that file for exactly what it exempts. Once a hold-out
is generated, it is scored like any other -- nothing about that gate changes
what `npm run eval:holdout -- --holdout3` prints.

## Hold-out 4

`holdout4/` is twelve more documents (#1007), written after hold-out 3 by
someone who had read neither it nor `sources/`. It answers a different
question: hold-out 3's pages are about 1,600 characters each and the tuning
set's median is 3,400, while the real household paper the owner ran the
rules over on 2026-09-13 is around 10,000. These twelve are built to that
shape -- long, mostly noise, several labelled numbers and several real
prices per page, and on five of the twelve the provider's trading name never
appears as a plain name, only inside a web address, an e-mail address, a
sub-brand or a registered company name that differs from the brand.

Twelve documents, real Tika output: about 120,100 characters in total, 215
date-like strings, 28 of them answers. Measured baselines belong on the
experiment log, not here, for the reason the hold-out 3 section gives.

Everything the hold-out 3 section says applies here word for word: do not
read `scripts/corpus/holdout4/` or
`src/server/documents/extraction-holdout4-fullpage.ts`, do not run
`npm run eval:holdout -- --holdout4 --misses`, and never change a hold-out
document to make a score move.

`--holdout4` selects it on `holdout-score-cli` and `holdout-breakdown-cli`;
`--holdout3` still means hold-out 3 everywhere it did before. `holdout4/`
takes twenty-three typefaces, none of them used by `holdout3/`, so the two
unseen sets share no character map. Full separation from `sources/` is no
longer possible: `fetch-fonts.sh` brings down 108 files and the earlier
corpora already use all but five of them, and a hold-out fetches nothing
new (see "Fonts").
