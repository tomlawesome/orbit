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
// Without `--model`, every field is whatever the rules over the tags decide:
// the attended case, and the fall-back where there is no model to ask.
//
// With it, every field is the model's pick from that field's shortlist --
// dates and their roles in one call, then reference, cost, provider, subtype
// and, where the roles make a schedule, how long it runs. Five or six calls
// a document, each over a few hundred characters, which needs the Ollama
// container on `orbit_orbit-document-processing`. `--chooser-model <name>`
// sends the questions to another model instead of NuExtract.
//
// `--dump` prints every tagged candidate of one kind for one document, with
// its tags and block, and skips untagged ones: the view for deciding
// whether a miss is a tag or a choice.

import { chooseFields, chooseFieldsWithModel } from "./extraction-choose";
import { assertChooserReachable, chooserTransport } from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { formatRunScore, scoreCorpus } from "./extraction-scoring";
import { sieve, type CandidateKind } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { proposalFromText } from "./suggestions";

/** Which model answers the questions, named on the command line:
 * `--chooser-model <name>` sends them to that model over Ollama's generic
 * chat call, and naming nothing leaves them with NuExtract's native mode.
 * A flag rather than an environment variable, so the application's
 * configuration contract stays the application's. */
function chooserModelNamed(): string | undefined {
  const at = process.argv.indexOf("--chooser-model");
  return at === -1 ? undefined : process.argv[at + 1];
}

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
  if (withModel) await assertChooserReachable(chooserModelNamed());
  const staged = await scoreCorpus(EXTRACTION_CORPUS, async (text) => {
    const tagged = tagCandidates(text, sieve(text));
    return withModel
      ? chooseFieldsWithModel(tagged, chooserTransport(chooserModelNamed()))
      : chooseFields(tagged, text);
  });
  console.log(formatRunScore(withModel ? "sieve+tag+choose+model" : "sieve+tag+choose", staged));
  const heuristics = await scoreCorpus(EXTRACTION_CORPUS, (text, filename) => proposalFromText(text, filename));
  console.log(formatRunScore("heuristics (one-shot)", heuristics));
}

void main();
