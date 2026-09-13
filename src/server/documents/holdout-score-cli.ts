#!/usr/bin/env node
// The hold-out measurement (#986 step 8). The same pipeline and the same
// printing as `stages-score-cli.ts`, over the 12 documents in
// `extraction-holdout3-fullpage.ts` -- written after the extractor was
// tuned, by someone who had not read the 48 in `scripts/corpus/sources/` or
// either retired hold-out (#998).
//
//   npm run eval:holdout -- --holdout3
//   npm run eval:holdout -- --holdout3 --model
//   npm run eval:holdout -- --holdout3 --misses      # owner only; see below
//
// Scores on the 48 are tuning indicators; this is the number that says
// whether the extractor generalises, and it only says that while nobody has
// looked at the pages. So the default prints the score lines and nothing
// else: per-document misses are how a hold-out turns into a second tuning
// set, one fixed miss at a time. `--misses` prints them for the owner, who
// is not the one tuning.
//
// `--model` behaves exactly as it does in `stages-score-cli.ts`: every field
// is the model's pick from that field's shortlist, five or six calls a
// document, which needs the Ollama container on
// `orbit_orbit-document-processing`.
//
// The first two hold-outs are retired: the first was spent when an eval run
// with `--misses` printed each page's answer during a tuning session
// (#996), and both were rolled into the tuning set on 2026-09-12 (#998).
// `--holdout3` is the only unseen set left.

import { chooseFields, chooseFieldsWithModel } from "./extraction-choose";
import { assertChooserReachable, chooserTransport } from "./extraction-choose-meaning";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { formatRunScore, scoreCorpus, type RunScore } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { repairLetterSpacing } from "./extraction-text-repair";
import { proposalFromText } from "./suggestions";

const corpus = EXTRACTION_HOLDOUT3_FULLPAGE;
const label = "hold-out 3";

/** Which model answers the questions, named on the command line:
 * `--chooser-model <name>` sends them to that model over Ollama's generic
 * chat call, and naming nothing leaves them with NuExtract's native mode.
 * A flag rather than an environment variable, so the application's
 * configuration contract stays the application's. */
function chooserModelNamed(): string | undefined {
  const at = process.argv.indexOf("--chooser-model");
  return at === -1 ? undefined : process.argv[at + 1];
}

const showMisses = process.argv.includes("--misses");

/** `formatRunScore` prints whatever misses it is given, so the default run
 * hands it a score with none. */
const forPrinting = (score: RunScore): RunScore => (showMisses ? score : { ...score, misses: [] });

async function main(): Promise<void> {
  const withModel = process.argv.includes("--model");
  if (withModel) await assertChooserReachable(chooserModelNamed());
  const staged = await scoreCorpus(corpus, async (text) => {
    const page = repairLetterSpacing(text);
    const tagged = tagCandidates(page, sieve(page));
    return withModel
      ? chooseFieldsWithModel(tagged, chooserTransport(chooserModelNamed()))
      : chooseFields(tagged, page);
  });
  console.log(formatRunScore(withModel ? `${label}: sieve+tag+choose+model` : `${label}: sieve+tag+choose`, forPrinting(staged)));
  const heuristics = await scoreCorpus(corpus, (text, filename) => proposalFromText(text, filename));
  console.log(formatRunScore(`${label}: heuristics (one-shot)`, forPrinting(heuristics)));
}

void main();
