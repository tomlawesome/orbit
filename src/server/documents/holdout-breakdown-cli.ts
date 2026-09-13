#!/usr/bin/env node
// What the net score hides: how many of each field's points on the hold-out
// were right, lost to a wrong answer, or left blank.
//
//   npm run eval:breakdown -- --holdout3
//
// A field can score the same net from being cautious (right and blank) or
// careless (right and wrong), and they are not the same thing to fix. Counts
// only -- no document is ever named, so the hold-out stays unread. The
// first two hold-outs are retired, rolled into the tuning set 2026-09-12
// (#998); `--holdout3` is the only unseen set left.
import { chooseFields } from "./extraction-choose";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { FIELD_NAMES, scoreCorpus } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { repairLetterSpacing } from "./extraction-text-repair";

const corpus = EXTRACTION_HOLDOUT3_FULLPAGE;

const KEY: Record<string, string> = {
  provider: "provider expected", reference: "reference expected", subtype: "subtype expected",
  cost: "cost expected", recurrence: "recurrence expected", scheduleKind: "schedule kind expected",
  dateRoles: "expected role", dates: "date ",
};

async function main(): Promise<void> {
  const score = await scoreCorpus(corpus, (text) => {
    const page = repairLetterSpacing(text);
    return chooseFields(tagCandidates(page, sieve(page)), page);
  });
  console.log("field         right  wrong  blank   of");
  for (const field of FIELD_NAMES) {
    const { possible } = score.fields[field];
    const key = KEY[field] as string;
    const misses = score.misses.filter((miss) =>
      field === "dates" ? miss.includes("date ") && !miss.includes("expected role") : miss.includes(key));
    // The score no longer separates a wrong answer from a blank, so the
    // count comes from how each miss was classified when it was recorded.
    const wrong = misses.filter((miss) => miss.trimEnd().endsWith("(wrong)")).length;
    const blank = misses.filter((miss) => miss.trimEnd().endsWith("(blank)")).length;
    const right = possible - wrong - blank;
    console.log(`${field.padEnd(13)} ${String(right).padStart(4)}  ${String(wrong).padStart(5)}  ${String(blank).padStart(5)} ${String(possible).padStart(4)}`);
  }
}
void main();
