#!/usr/bin/env node
// Blind-pass-only probe over a small random sample (#965).
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/model-blind-probe.ts [sample] [seed]
//   node node_modules/tsx/dist/cli.mjs src/server/documents/model-blind-probe.ts --holdout3
//   node node_modules/tsx/dist/cli.mjs src/server/documents/model-blind-probe.ts --all --head 0.33
//
// `--all` reads every tuning document rather than a sample; `--head <fraction>`
// sends the model only the top of each page (owner, 2026-09-12: the top
// third, where the letterhead is).
//
// `--holdout3` reads all twelve unseen pages instead of a sample of the
// tuning corpus, and is how the experiment log's front table gets its model
// row: the blind model against the heuristics on pages nobody tuned on. It
// prints the score line and nothing per document, so the hold-out stays
// unread (the rule at the top of `holdout-score-cli.ts`). The first two
// hold-outs are retired, rolled into the tuning set on 2026-09-12 (#998).
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
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
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

/** `--head <fraction>`: only the top of the page goes to the model (owner,
 * 2026-09-12: "give the model the top third of the first page"). The
 * provider and the document's kind are usually printed in the letterhead,
 * and a shorter read is a faster one. Cut at a line end, never mid-word. */
function headFraction(): number {
  const at = process.argv.indexOf("--head");
  const fraction = at === -1 ? 1 : Number(process.argv[at + 1]);
  if (!(fraction > 0 && fraction <= 1)) throw new Error("--head wants a fraction between 0 and 1");
  return fraction;
}

function topOf(text: string, fraction: number): string {
  if (fraction >= 1) return text;
  const cutAt = Math.floor(text.length * fraction);
  const lineEnd = text.indexOf("\n", cutAt);
  return lineEnd === -1 ? text : text.slice(0, lineEnd);
}

const head = headFraction();

const blindExtractor: CorpusExtractor = async (text, filename) => {
  const result = await modelProposalFromText(topOf(text, head), filename, { deadlineMs: MODEL_MAILBOX_DEADLINE_MS });
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
  const onHoldout3 = process.argv.includes("--holdout3");
  const size = Number.parseInt(process.argv[2] ?? "", 10) || 6;
  const seed = Number.parseInt(process.argv[3] ?? "", 10) || 20_260_910;
  const all = process.argv.includes("--all");
  const documents = onHoldout3
    ? [...EXTRACTION_HOLDOUT3_FULLPAGE]
    : all ? [...EXTRACTION_CORPUS] : sample(EXTRACTION_CORPUS, size, seed);
  const read = head < 1 ? `top ${Math.round(head * 100)}% of the page` : "whole page";

  console.log(`model: ${selectedExtractionModel(process.env)}; reads the ${read}`);
  console.log(onHoldout3
    ? `hold-out 3: all ${documents.length} unseen pages`
    : all ? `all ${documents.length} tuning documents`
      : `sample: ${documents.length} of ${EXTRACTION_CORPUS.length} documents, seed ${seed}`);
  console.log("blind pass only -- no adjudication, so this is the model reading unaided\n");

  const started = Date.now();
  const score = await scoreCorpus(documents, blindExtractor);
  const elapsed = (Date.now() - started) / 1000;

  // The hold-out's misses are never printed: a hold-out turns into a second
  // tuning set one read miss at a time.
  console.log(formatRunScore(`${onHoldout3 ? "hold-out 3: " : ""}model blind (${read})`,
    onHoldout3 ? { ...score, misses: [] } : score));
  console.log(`\n${elapsed.toFixed(0)}s for ${documents.length} documents (${(elapsed / documents.length).toFixed(0)}s each)`);
  console.log("A screen, not a gate: the section 6 gate is five repeats of the whole corpus, plus the hold-out.");
}

main();
