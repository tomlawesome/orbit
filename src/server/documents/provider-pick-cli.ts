#!/usr/bin/env node
// "Rules find, model picks" for provider (#994, owner 2026-09-12): the rules
// build a shortlist of at most eight names, and a model is asked which one
// the household deals with -- a few hundred characters, no page text beyond
// the block each name was printed in. Two shortlists, because two rule
// routes exist: the shipped word-run bins (`providerShortlistEntries`) and
// provider's own stage 2 (`readProviders`, #996). Scored with
// `classifyProvider`, so a short form of the name counts.
//
//   npm run eval:provider-pick                             # NuExtract, both lists
//   npm run eval:provider-pick -- --chooser-model qwen3:4b # another model
//   npm run eval:provider-pick -- --route bins|own         # one list only
//   npm run eval:provider-pick -- --limit 6                # first N documents
//
// Asks the model, so it must run in a container on
// `orbit_orbit-document-processing` (AGENTS.md, "stages-rerun" pattern).
import { assertChooserReachable, chooseProviderWithModel, chooserTransport, providerShortlistEntries } from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { classifyProvider } from "./extraction-scoring";
import type { ShortlistEntry } from "./extraction-shortlist";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { providerCandidates } from "./provider-stage1-sieve";
import { readProviders } from "./provider-stage2-sieves";

const LIST_LIMIT = 8;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const modelNamed = flag("--chooser-model");
const route = flag("--route") ?? "both";
const limit = Number(flag("--limit") ?? Number.MAX_SAFE_INTEGER);
const documents = EXTRACTION_CORPUS.slice(0, limit);

/** The first block the name is printed in, as the evidence the model sees. */
function blockPrinting(text: string, name: string): string {
  const wanted = name.toLowerCase();
  for (const line of text.split(/\n+/u)) {
    if (line.toLowerCase().includes(wanted)) return line.trim().slice(0, 160);
  }
  return "";
}

/** Own stage 2's top eight as shortlist entries: the name, where it was
 * printed, and what the rules said about it. */
function ownStage2Entries(text: string): ShortlistEntry[] {
  return readProviders(text, providerCandidates(text)).slice(0, LIST_LIMIT).map((reading) => ({
    value: reading.name,
    display: reading.name,
    line: blockPrinting(text, reading.name),
    why: [
      `printed ${reading.printings} times`,
      ...reading.votes.map((vote) => `${vote.weight > 0 ? "for" : "against"}: ${vote.trigger}`),
    ],
    support: reading.score,
  }));
}

interface Tally { hits: number; of: number; onList: number; blank: number }

async function main(): Promise<void> {
  await assertChooserReachable(modelNamed);
  const transport = chooserTransport(modelNamed);
  const model = modelNamed ?? "NuExtract";
  const routes: Array<{ name: string; entries: (text: string) => ShortlistEntry[]; tally: Tally }> = [];
  if (route !== "own") routes.push({ name: "bins", entries: (text) => providerShortlistEntries(tagCandidates(text, sieve(text))), tally: { hits: 0, of: 0, onList: 0, blank: 0 } });
  if (route !== "bins") routes.push({ name: "own stage 2", entries: ownStage2Entries, tally: { hits: 0, of: 0, onList: 0, blank: 0 } });

  const started = Date.now();
  for (const document of documents) {
    const wanted = document.expected.provider;
    if (wanted === undefined) continue;
    for (const { entries, tally } of routes) {
      const list = entries(document.text);
      tally.of += 1;
      if (list.some((entry) => classifyProvider(wanted, entry.value) === "correct")) tally.onList += 1;
      const chosen = await chooseProviderWithModel(list, transport);
      if (chosen === undefined) tally.blank += 1;
      else if (classifyProvider(wanted, chosen) === "correct") tally.hits += 1;
    }
    process.stderr.write(`${document.name.split(",")[0]}: ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  }

  for (const { name, tally } of routes) {
    const percent = tally.of === 0 ? "0" : ((tally.hits / tally.of) * 100).toFixed(0);
    console.log(`right answer on the ${name} list: ${tally.onList}/${tally.of}; model left blank: ${tally.blank}/${tally.of}`);
    console.log(`provider by model pick from ${name} (${model}): ${percent}% (${tally.hits}/${tally.of}) [provider ${tally.hits}/${tally.of}]`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
