import { describe, expect, it } from "vitest";

import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { proposalFromText } from "./suggestions";

// The measured number behind #319: extraction accuracy against the corpus.
// Scoring is deliberately simple and stable — each expected field is one
// point (every expected date individually; provider; reference), plus one
// point per document for emitting no false dates on date-free documents.
// The floor is a ratchet: raise it when extraction durably improves; never
// lower it to make a change pass.

// Measured 1.00 (78/78) on 2026-09-09, after the extractor learned the
// harder corpus: hyphenated, year-first and two-digit-year numeric dates,
// "the 1st of October", references carrying spaces and slashes, providers
// named in prose or on the letterhead, and firmware versions refused as
// dates. The floor sits below the measurement so that ADDING harder corpus
// documents is always welcome: a hard new document may land red-margin
// against perfection but must never take the whole measure below this
// floor without an accompanying, recorded floor decision. Raised 0.9 -> 0.95
// with that measurement; 0.95 still leaves about four points of the current
// 78 free for the next batch of hard documents.
const ACCURACY_FLOOR = 0.95;

interface Score {
  earned: number;
  possible: number;
  misses: string[];
}

function scoreDocument(name: string, text: string, filename: string, expected: {
  dates: string[]; provider?: string; reference?: string;
}): Score {
  const proposal = proposalFromText(text, filename);
  const misses: string[] = [];
  let earned = 0;
  let possible = 0;

  for (const date of expected.dates) {
    possible += 1;
    if (proposal.dates.includes(date)) earned += 1;
    else misses.push(`${name}: date ${date} not extracted (got ${proposal.dates.join(", ") || "none"})`);
  }
  if (expected.dates.length === 0) {
    possible += 1;
    if (proposal.dates.length === 0) earned += 1;
    else misses.push(`${name}: false dates ${proposal.dates.join(", ")}`);
  }
  if (expected.provider !== undefined) {
    possible += 1;
    if (proposal.provider === expected.provider) earned += 1;
    else misses.push(`${name}: provider expected "${expected.provider}", got "${proposal.provider ?? "none"}"`);
  }
  if (expected.reference !== undefined) {
    possible += 1;
    if (proposal.reference === expected.reference) earned += 1;
    else misses.push(`${name}: reference expected "${expected.reference}", got "${proposal.reference ?? "none"}"`);
  }
  return { earned, possible, misses };
}

describe("extraction accuracy against the corpus (#319)", () => {
  it(`heuristic extraction stays at or above the ${ACCURACY_FLOOR} floor`, () => {
    let earned = 0;
    let possible = 0;
    const misses: string[] = [];
    for (const doc of EXTRACTION_CORPUS) {
      const score = scoreDocument(doc.name, doc.text, doc.filename, doc.expected);
      earned += score.earned;
      possible += score.possible;
      misses.push(...score.misses);
    }
    const accuracy = earned / possible;
    // Always print the measurement — the number is the point.
    console.info(
      `extraction accuracy: ${(accuracy * 100).toFixed(1)}% (${earned}/${possible})` +
      (misses.length ? `\n  misses:\n  - ${misses.join("\n  - ")}` : ""),
    );
    expect(accuracy).toBeGreaterThanOrEqual(ACCURACY_FLOOR);
  });
});
