#!/usr/bin/env node
// What provider's own stage 2 (#996) is worth: `providerCandidates` (stage 1)
// -> `readProviders` (stage 2's votes) -> `chooseProvider` (stage 3's sum),
// over the tuning corpus, or once over hold-out 3 after the rules are
// finished (rules doc, "What 'trained to the set' would look like"). The
// first two hold-outs are retired, rolled into the tuning set on
// 2026-09-12 (#998).
//
//   npm run eval:provider-stage2               # the score line
//   npm run eval:provider-stage2 -- --holdout3 # the 12 unseen pages
//   npm run eval:provider-stage2 -- --show     # plus, per document, the
//                                               # chosen name, the expected
//                                               # name, and the top three
//                                               # scores (owner only on the
//                                               # hold-out: the gate refuses it)
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { classifyProvider } from "./extraction-scoring";
import { providerCandidates } from "./provider-stage1-sieve";
import { chooseProvider, readProviders } from "./provider-stage2-sieves";

const show = process.argv.includes("--show");
const holdout3 = process.argv.includes("--holdout3");
const documents = holdout3 ? EXTRACTION_HOLDOUT3_FULLPAGE : EXTRACTION_CORPUS;
const prefix = holdout3 ? "hold-out 3: " : "";

function main(): void {
  let hits = 0;
  let of = 0;

  for (const document of documents) {
    const wanted = document.expected.provider;
    if (wanted === undefined) continue;
    of += 1;

    const candidates = providerCandidates(document.text);
    const chosen = chooseProvider(document.text, candidates);
    const hit = chosen !== undefined && classifyProvider(wanted, chosen) === "correct";
    if (hit) hits += 1;

    if (show) {
      const top3 = readProviders(document.text, candidates)
        .slice(0, 3)
        .map((reading) => `${reading.name} (${reading.score.toFixed(1)})`)
        .join(", ");
      console.log(`${document.name}`);
      console.log(`  chosen:   ${chosen ?? "none"}`);
      console.log(`  expected: ${wanted}${hit ? "" : "  <-- miss"}`);
      console.log(`  top 3:    ${top3 || "none"}`);
    }
  }

  const percent = of === 0 ? "0.0" : ((hits / of) * 100).toFixed(0);
  console.log(`${prefix}provider by own stage 2: ${percent}% (${hits}/${of}) [provider ${hits}/${of}]`);
}

main();
