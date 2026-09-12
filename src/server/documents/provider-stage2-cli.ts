#!/usr/bin/env node
// What provider's own stage 2 (#996) is worth: `providerCandidates` (stage 1)
// -> `readProviders` (stage 2's votes) -> `chooseProvider` (stage 3's sum),
// over the 24-document tuning corpus, or once over the second hold-out
// after the rules are finished (rules doc, "What 'trained to the set' would
// look like"). The first hold-out is spent for this field (#996) and is not
// offered.
//
//   npm run eval:provider-stage2               # the score line
//   npm run eval:provider-stage2 -- --holdout2 # the second 12 unseen pages
//   npm run eval:provider-stage2 -- --show     # plus, per document, the
//                                               # chosen name, the expected
//                                               # name, and the top three
//                                               # scores (owner only on the
//                                               # hold-out: the gate refuses it)
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT2_FULLPAGE } from "./extraction-holdout2-fullpage";
import { classifyProvider } from "./extraction-scoring";
import { providerCandidates } from "./provider-stage1-sieve";
import { chooseProvider, readProviders } from "./provider-stage2-sieves";

const show = process.argv.includes("--show");
const holdout2 = process.argv.includes("--holdout2");
const documents = holdout2 ? EXTRACTION_HOLDOUT2_FULLPAGE : EXTRACTION_CORPUS;
const prefix = holdout2 ? "hold-out 2: " : "";

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
