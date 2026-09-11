# Extraction corpus: full-page documents

Builds the full-page fixtures in
`src/server/documents/extraction-corpus-fullpage.ts` (#981) and the hold-out
fixtures in `src/server/documents/extraction-holdout-fullpage.ts` (#986).

Two corpora, two directories. Every script here takes `--dir <name>` (or
`CORPUS_DIR`) and defaults to `sources`, so a command without the flag still
means the tuning set:

| directory  | documents | what it is for |
| ---------- | --------- | -------------- |
| `sources/` | the tuning set | read it, tune against it, argue with it |
| `holdout/` | the hold-out set | scored, never read, never tuned against |

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

For the hold-out, the same seven steps with `--dir holdout` (and the volume
mounted from `scripts/corpus/holdout` at step 5). There is no evidence file:
the ideal-answer test reads the tuning set only. `generate.mjs` writes
`extraction-holdout-fullpage.ts` and exports `EXTRACTION_HOLDOUT_FULLPAGE`
when it is pointed at any directory other than `sources`.

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
  not say.
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

The hold-out documents use twenty further faces, none of them used by the
tuning set, so the two corpora share no character map. A fault that only
appears in one font's encoding would otherwise be tuned away on `sources/`
and never met again.

## The hold-out set

`holdout/` is twelve documents written after the extractor was tuned, by
someone who had not read `sources/`. It is the only measurement the project
has of whether the extractor generalises rather than fits the 24 pages it was
built against, and that is true only while nobody working on the extractor
has seen the pages.

So, for anyone tuning:

- **Do not read `scripts/corpus/holdout/`**, or
  `src/server/documents/extraction-holdout-fullpage.ts`, or the PDFs, the
  truths, the contact sheet or the index built from them.
- **Do not run `npm run eval:holdout -- --misses`.** The default prints the
  score lines and nothing else. Per-document misses are how a hold-out
  quietly turns into a second tuning set, one fixed miss at a time; they are
  for the owner, who is not the one tuning.
- **Never change a hold-out document to make a score move.** A fix that needs
  the hold-out to change is a fix aimed at the answer, not at the extractor.

New documents belong in `sources/`. If the hold-out is ever burned — read,
tuned against, or quoted back into a fix — it is spent, and the replacement is
a fresh set, not a scrub of this one.
