#!/usr/bin/env node
// ADR-0026 stage 3's measurement: the whole sieve → tag → choose pipeline
// scored the same way as every other extractor, beside the one-shot
// heuristics it replaces. Scores on the 24 are tuning indicators (owner,
// 2026-09-11); the hold-out judges.
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/stages-score-cli.ts
//   node node_modules/tsx/dist/cli.mjs src/server/documents/stages-score-cli.ts --model
//   node node_modules/tsx/dist/cli.mjs src/server/documents/stages-score-cli.ts --dump <filename-part> <kind>
//
// Without `--model`, `provider` and `subtype` are whatever the rules over
// the tags decide, and a date no sieve could label is offered with no role.
// With it, the three questions the rules left open -- provider, subtype, and
// which unlabelled date the household must act on -- are put to NuExtract 3
// over the shortlist, which needs the Ollama container on
// `orbit_orbit-document-processing`.
//
// `--dump` prints every tagged candidate of one kind for one document, with
// its tags and block, and skips untagged ones: the view for deciding
// whether a miss is a tag or a choice.

import { chooseFields, chooseFieldsWithModel } from "./extraction-choose";
import { ollamaMeaningTransport } from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { formatRunScore, scoreCorpus } from "./extraction-scoring";
import { sieve, type CandidateKind } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { proposalFromText } from "./suggestions";

function dump(filePart: string, kind: CandidateKind): void {
  const doc = EXTRACTION_CORPUS.find((d) => d.filename.includes(filePart));
  if (!doc) throw new Error(`no corpus document matches ${filePart}`);
  console.log(JSON.stringify(doc.expected));
  for (const c of tagCandidates(doc.text, sieve(doc.text))) {
    if (c.kind !== kind) continue;
    const tags = c.tags.map((t) => `${t.value}${t.trigger ? `<${t.trigger}>` : ""}`).join(",");
    if (tags === "other") continue;
    console.log(`${c.value.padEnd(16)} ${(c.currency ?? "").padEnd(4)} ${tags.padEnd(30)} | ${c.line.slice(0, 100)}`);
  }
}

async function main(): Promise<void> {
  const dumpAt = process.argv.indexOf("--dump");
  if (dumpAt !== -1) {
    dump(process.argv[dumpAt + 1], process.argv[dumpAt + 2] as CandidateKind);
    return;
  }
  const withModel = process.argv.includes("--model");
  const staged = await scoreCorpus(EXTRACTION_CORPUS, async (text) => {
    const tagged = tagCandidates(text, sieve(text));
    return withModel ? chooseFieldsWithModel(tagged, ollamaMeaningTransport) : chooseFields(tagged);
  });
  console.log(formatRunScore(withModel ? "sieve+tag+choose+model" : "sieve+tag+choose", staged));
  const heuristics = await scoreCorpus(EXTRACTION_CORPUS, (text, filename) => proposalFromText(text, filename));
  console.log(formatRunScore("heuristics (one-shot)", heuristics));
}

void main();
