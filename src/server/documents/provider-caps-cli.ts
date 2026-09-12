#!/usr/bin/env node
// Provider by capitalisation (owner, 2026-09-12): names read straight off
// the page by how they are capitalised (`capsMentions`), then the word-run
// bins over them, answer = the top run. No sieve, no tags, no model.
//
//   npm run eval:provider-caps                 # the score line, seen corpus
//   npm run eval:provider-caps -- --holdout3   # the 12 unseen pages
//   npm run eval:provider-caps -- --show       # per document: top 3 runs and
//                                              # the expected name (seen only)
//   npm run eval:provider-caps -- --then deals # the shipped route: bins make
//                                              # the shortlist, who-acts cues
//                                              # (`provider-dealing-cues.ts`)
//                                              # pick from it
//   npm run eval:provider-caps -- --boost 3    # a web/e-mail domain binned 3x
//   npm run eval:provider-caps -- --dict single # ordinary English words
//                                              # dropped (host word list)
//   npm run eval:provider-caps -- --then votes # own stage 2's votes pick
//   npm run eval:provider-caps -- --tagged     # the mentions go through the
//                                              # shipped tags and provider
//                                              # sieve first (owner: "what if
//                                              # the sieve only looked for
//                                              # those in the first place")
import { providerTaggedOrganisations, providerWordRuns, type ProviderMention } from "./extraction-provider-runs";
import type { Candidate } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { classifyProvider } from "./extraction-scoring";
import { capsMentions } from "./provider-caps-mentions";
import { readFileSync } from "node:fs";
import { readProviders } from "./provider-stage2-sieves";
import { providerPicks } from "./provider-route";

const show = process.argv.includes("--show");
const tagged = process.argv.includes("--tagged");
const holdout3 = process.argv.includes("--holdout3");
// `--boost N`: a brand-shaped word or a web/email domain counts N times
// (owner, 2026-09-12: "words joined together without spaces ... or joined by
// a number or symbol" -- structure nobody prints by accident).
// `--dict single|all`: drop a mention that is an ordinary English word
// (Customer, Agent, Testing), or one made only of them (owner, 2026-09-12).
// The host's word list, read at run time -- a probe, not a shipped dataset.
// Lower-case entries only: the list's proper nouns are not "ordinary".
const dictAt = process.argv.indexOf("--dict");
const dictMode = dictAt === -1 ? "off" : process.argv[dictAt + 1] ?? "single";
const ORDINARY: ReadonlySet<string> = dictMode === "off" ? new Set() : new Set(
  readFileSync("/usr/share/dict/american-english", "utf8").split("\n").filter((word) => /^[a-z]+$/u.test(word)));
function ordinary(value: string): boolean {
  const words = value.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word !== "");
  if (dictMode === "single") return words.length === 1 && ORDINARY.has(words[0] as string);
  return words.length > 0 && words.every((word) => ORDINARY.has(word));
}
// `--then votes`: the bins only make the shortlist (top 8 runs); own stage
// 2's votes (`readProviders`, R1-R5) then pick from it, bin rank breaking a
// tie (owner, 2026-09-12: "a second approach that runs after the sieve ...
// two real company names but the one we want appears less times").
const thenAt = process.argv.indexOf("--then");
const then = thenAt === -1 ? "off" : process.argv[thenAt + 1] ?? "votes";
const thenVotes = then === "votes";
const thenDeals = then === "deals";
const boostAt = process.argv.indexOf("--boost");
const boost = boostAt === -1 ? 1 : Number(process.argv[boostAt + 1]);
const documents = holdout3 ? EXTRACTION_HOLDOUT3_FULLPAGE : EXTRACTION_CORPUS;
const prefix = holdout3 ? "hold-out 3: " : "";

function main(): void {
  let of = 0;
  let top1 = 0;
  let top2 = 0;
  let onList = 0;
  let mentioned = 0;
  let mentions = 0;

  for (const document of documents) {
    const wanted = document.expected.provider;
    if (wanted === undefined) continue;
    of += 1;
    const caps = capsMentions(document.text).filter((mention) => !ordinary(mention.value)).flatMap((mention) =>
      mention.rule === "domain" ? Array.from({ length: boost }, () => mention) : [mention]);
    const found: Array<ProviderMention & { index: number }> = tagged
      ? providerTaggedOrganisations(tagCandidates(document.text, caps.map((mention): Candidate =>
          ({ kind: "organisation", value: mention.value, index: mention.index, line: mention.line }))))
      : caps;
    mentions += found.length;
    const ok = (value: string): boolean => classifyProvider(wanted, value) === "correct";
    if (found.some((mention) => ok(mention.value))) mentioned += 1;
    let runs = providerWordRuns(found).slice(0, 8);
    if (thenVotes) {
      const readings = readProviders(document.text, found.map((mention): Candidate =>
        ({ kind: "organisation", value: mention.value, index: mention.index, line: mention.line })));
      const scoreOf = (display: string): number =>
        readings.find((reading) => classifyProvider(reading.name, display) === "correct")?.score ?? Number.NEGATIVE_INFINITY;
      runs = runs.map((run, rank) => ({ run, rank, score: scoreOf(run.display) }))
        .sort((a, b) => b.score - a.score || a.rank - b.rank)
        .map((entry) => entry.run);
    }
    // The shipped route (`provider-route.ts`): its own bins with the domain
    // weight, so `--boost` and `--dict` do not apply here.
    if (thenDeals) runs = providerPicks(document.text).map((pick) => pick.run);
    const at = runs.findIndex((run) => ok(run.display));
    if (at === 0) top1 += 1;
    if (at >= 0 && at < 2) top2 += 1;
    if (at >= 0) onList += 1;
    if (show) {
      console.log(`${document.name.split(",")[0]}${at === 0 ? "" : "  <-- miss"}`);
      console.log(`  expected: ${wanted}`);
      console.log(`  top 3:    ${runs.slice(0, 3).map((run) => `${run.display} (${run.count})`).join(", ")}`);
    }
  }

  console.log(`mentions per page ${(mentions / of).toFixed(1)}; provider among them ${mentioned}/${of}; top-2 ${top2}/${of}; on list ${onList}/${of}`);
  const percent = of === 0 ? "0" : ((top1 / of) * 100).toFixed(0);
  console.log(`${prefix}provider by capitalisation${tagged ? ", tagged" : ""}${boost > 1 ? `, odd shapes x${boost}` : ""}${dictMode === "off" ? "" : `, ordinary words (${dictMode}) dropped`}${thenVotes ? ", then own stage 2 votes" : ""}${thenDeals ? ", then who-acts cues" : ""}: ${percent}% (${top1}/${of}) [provider ${percent}% (${top1}/${of})]`);
}

main();
