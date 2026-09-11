#!/usr/bin/env node
// The hold-out measurement (#986 step 8). The same pipeline and the same
// printing as `stages-score-cli.ts`, over the 12 documents in
// `extraction-holdout-fullpage.ts` — written after the extractor was tuned,
// by someone who had not read the 24 in `scripts/corpus/sources/`.
//
//   npm run eval:holdout
//   npm run eval:holdout -- --model
//   npm run eval:holdout -- --misses      # owner only; see below
//
// Scores on the 24 are tuning indicators; this is the number that says
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

import { chooseFields, chooseFieldsWithModel } from "./extraction-choose";
import { chooserTransport } from "./extraction-choose-meaning";
import { EXTRACTION_HOLDOUT_FULLPAGE } from "./extraction-holdout-fullpage";
import { formatRunScore, scoreCorpus, type RunScore } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { proposalFromText } from "./suggestions";

const showMisses = process.argv.includes("--misses");

/** `formatRunScore` prints whatever misses it is given, so the default run
 * hands it a score with none. */
const forPrinting = (score: RunScore): RunScore => (showMisses ? score : { ...score, misses: [] });

async function main(): Promise<void> {
  const withModel = process.argv.includes("--model");
  const staged = await scoreCorpus(EXTRACTION_HOLDOUT_FULLPAGE, async (text) => {
    const tagged = tagCandidates(text, sieve(text));
    return withModel ? chooseFieldsWithModel(tagged, chooserTransport()) : chooseFields(tagged);
  });
  console.log(formatRunScore(withModel ? "hold-out: sieve+tag+choose+model" : "hold-out: sieve+tag+choose", forPrinting(staged)));
  const heuristics = await scoreCorpus(EXTRACTION_HOLDOUT_FULLPAGE, (text, filename) => proposalFromText(text, filename));
  console.log(formatRunScore("hold-out: heuristics (one-shot)", forPrinting(heuristics)));
}

void main();
