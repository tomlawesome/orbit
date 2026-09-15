#!/usr/bin/env node
// Blind-pass-only probe over a small random sample (#965).
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/model-blind-probe.ts [sample] [seed]
//
// Why this exists alongside model-eval-cli.ts: the full three-way run over
// the 36-document corpus costs roughly 17 minutes against a local model, and
// while the blind score sits near zero there is nothing for adjudication to
// choose between -- so paying for the adjudicating pass tells you nothing.
// This asks the one question that gates the rest: can the model read a
// document at all?
//
// The sample is seeded so a candidate can be compared against another
// candidate on the same documents. It is a screen, never a gate: ADR-0025
// section 6's gate is five repeats of the whole corpus, and the hold-out.

import { EXTRACTION_CORPUS, type CorpusDocument } from "./extraction-corpus";
import { formatRunScore, scoreCorpus, type CorpusExtractor } from "./extraction-scoring";
import { modelProposalFromText, MODEL_MAILBOX_DEADLINE_MS, selectedExtractionModel } from "./model-extraction";

/** Deterministic shuffle, so two candidates are screened on the same documents. */
function sample(corpus: readonly CorpusDocument[], size: number, seed: number): CorpusDocument[] {
  const picked = [...corpus];
  let state = seed;
  for (let i = picked.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    const j = state % (i + 1);
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.slice(0, Math.min(size, picked.length));
}

const blindExtractor: CorpusExtractor = async (text, filename) => {
  const result = await modelProposalFromText(text, filename, { deadlineMs: MODEL_MAILBOX_DEADLINE_MS });
  // A skipped or failed pass scores as "the extractor offered nothing",
  // exactly as a blank does -- never as an error that hides the number.
  return result.status === "ready" ? result.proposal : { dates: [] };
};

async function main(): Promise<void> {
  if (!selectedExtractionModel(process.env)) {
    console.error("No model configured. Set OLLAMA_MODEL and bring up the `ai` Compose profile.");
    process.exitCode = 1;
    return;
  }
  const size = Number.parseInt(process.argv[2] ?? "", 10) || 6;
  const seed = Number.parseInt(process.argv[3] ?? "", 10) || 20_260_910;
  const documents = sample(EXTRACTION_CORPUS, size, seed);

  console.log(`model: ${selectedExtractionModel(process.env)}`);
  console.log(`sample: ${documents.length} of ${EXTRACTION_CORPUS.length} documents, seed ${seed}`);
  console.log("blind pass only -- no adjudication, so this is the model reading unaided\n");

  const started = Date.now();
  const score = await scoreCorpus(documents, blindExtractor);
  const elapsed = (Date.now() - started) / 1000;

  console.log(formatRunScore("model blind", score));
  console.log(`\n${elapsed.toFixed(0)}s for ${documents.length} documents (${(elapsed / documents.length).toFixed(0)}s each)`);
  console.log("A screen, not a gate: the section 6 gate is five repeats of the whole corpus, plus the hold-out.");
}

main();
