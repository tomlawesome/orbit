import { describe, expect, it } from "vitest";

import type { CorpusDocument } from "./extraction-corpus";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import {
  formatThreeWayScore,
  scoreCorpusRepeated,
  scoreCorpusThreeWay,
  type ThreeWayExtractor,
  type ThreeWayResult,
} from "./extraction-scoring";
import { proposalFromText, type DocumentProposal } from "./suggestions";

// ADR-0025 section 6 / issue #959: the three-way measurement built on top of
// the repeated-run harness `extraction-accuracy.test.ts` already exercises.
// These fixtures are hand-built rather than drawn from `EXTRACTION_CORPUS`,
// so the resolution-accuracy arithmetic can be checked by hand: each
// document declares no expected dates, so dates never contribute noise, and
// every scenario turns on exactly one provider or reference disagreement.

const MODEL_ENVIRONMENT = { OLLAMA_MODEL: "a-local-model:latest" } as NodeJS.ProcessEnv;
const NO_MODEL_ENVIRONMENT = {} as NodeJS.ProcessEnv;

function proposal(overrides: Partial<DocumentProposal>): DocumentProposal {
  return { title: "document", dates: [], ...overrides };
}

// Doc 1: heuristic and blind disagree on provider. The blind reading is the
// one ground truth supports, and adjudication sides with the heuristic (the
// wrong reading) anyway -- the laundering case the diagnostic exists to
// catch.
const LAUNDERED_DOC: CorpusDocument = {
  name: "laundered provider",
  filename: "laundered.txt",
  text: "irrelevant for these fakes",
  expected: { dates: [], provider: "Acme Energy Ltd" },
};

// Doc 2: heuristic and blind disagree on reference. The blind reading is
// again the correct one, but this time adjudication sides with it -- the
// diagnostic must not count this as laundering.
const RESOLVED_DOC: CorpusDocument = {
  name: "resolved reference",
  filename: "resolved.txt",
  text: "irrelevant for these fakes",
  expected: { dates: [], reference: "REF-9" },
};

function fixedThreeWay(byFilename: Record<string, ThreeWayResult>): ThreeWayExtractor {
  return async (_text, filename) => {
    const result = byFilename[filename];
    if (!result) throw new Error(`no fixture for ${filename}`);
    return result;
  };
}

describe("scoreCorpusThreeWay (#959, ADR-0025 section 6)", () => {
  it("reports the three numbers separately, not blended into one score", async () => {
    const heuristic = (_text: string, filename: string): DocumentProposal =>
      filename === LAUNDERED_DOC.filename
        ? proposal({ provider: "Direct Debit" }) // wrong
        : proposal({ reference: "REF-1" }); // wrong

    const threeWay = fixedThreeWay({
      [LAUNDERED_DOC.filename]: {
        blind: proposal({ provider: "Acme Energy Ltd" }), // correct
        adjudicated: proposal({ provider: "Direct Debit" }), // endorsed the wrong heuristic reading
        comparisons: [{ field: "provider", comparison: "disagreed", outcome: "endorsed_heuristic" }],
      },
      [RESOLVED_DOC.filename]: {
        blind: proposal({ reference: "REF-9" }), // correct
        adjudicated: proposal({ reference: "REF-9" }), // endorsed the correct blind reading
        comparisons: [{ field: "reference", comparison: "disagreed", outcome: "endorsed_blind" }],
      },
    });

    const score = await scoreCorpusThreeWay([LAUNDERED_DOC, RESOLVED_DOC], {
      heuristic,
      threeWay,
      environment: MODEL_ENVIRONMENT,
      runs: 1,
    });

    expect(score.model).not.toBeNull();
    // Always print the measurement, as the neighbouring accuracy test does.
    console.info(formatThreeWayScore("three-way fixture", score));

    // Heuristic alone: both fields wrong (0/2).
    expect(score.heuristic.minimum).toBeCloseTo(0, 10);
    // Model blind: both fields correct (2/2) -- a different number from the
    // heuristic's, proving the two are not the same score in disguise.
    expect(score.model!.blind.minimum).toBeCloseTo(1, 10);
    // Adjudicated: one endorsed the wrong heuristic reading, one endorsed the
    // correct blind reading -- 1/2, distinct from both of the above.
    expect(score.model!.adjudicated.minimum).toBeCloseTo(0.5, 10);
  });

  it("does not fail anything when the blind score sits below the heuristic baseline", async () => {
    // Here the heuristic is right and the blind pass is wrong on both fields
    // -- the opposite relationship from the test above -- specifically to
    // prove nothing in the harness gates on, or throws over, that ordering.
    const heuristic = (_text: string, filename: string): DocumentProposal =>
      filename === LAUNDERED_DOC.filename
        ? proposal({ provider: "Acme Energy Ltd" }) // correct
        : proposal({ reference: "REF-9" }); // correct

    const threeWay = fixedThreeWay({
      [LAUNDERED_DOC.filename]: {
        blind: proposal({ provider: "Direct Debit" }), // wrong
        adjudicated: proposal({ provider: "Acme Energy Ltd" }), // adjudication rescued it
        comparisons: [{ field: "provider", comparison: "disagreed", outcome: "endorsed_heuristic" }],
      },
      [RESOLVED_DOC.filename]: {
        blind: proposal({ reference: "REF-1" }), // wrong
        adjudicated: proposal({ reference: "REF-9" }), // adjudication rescued it
        comparisons: [{ field: "reference", comparison: "disagreed", outcome: "endorsed_heuristic" }],
      },
    });

    const score = await scoreCorpusThreeWay([LAUNDERED_DOC, RESOLVED_DOC], {
      heuristic,
      threeWay,
      environment: MODEL_ENVIRONMENT,
      runs: 1,
    });

    expect(score.model).not.toBeNull();
    expect(score.model!.blind.minimum).toBeLessThan(score.heuristic.minimum);
    // Nothing above threw or produced a failure signal -- there is no
    // pass/fail field on `ThreeWayScore` at all, which is the point: a
    // blind score at or below the heuristic baseline is not a failure.
    expect(score).not.toHaveProperty("passed");
  });

  it("computes per-disagreement resolution accuracy on a small hand-built case", async () => {
    const heuristic = (_text: string, filename: string): DocumentProposal =>
      filename === LAUNDERED_DOC.filename
        ? proposal({ provider: "Direct Debit" })
        : proposal({ reference: "REF-1" });

    const threeWay = fixedThreeWay({
      [LAUNDERED_DOC.filename]: {
        blind: proposal({ provider: "Acme Energy Ltd" }),
        adjudicated: proposal({ provider: "Direct Debit" }),
        comparisons: [{ field: "provider", comparison: "disagreed", outcome: "endorsed_heuristic" }],
      },
      [RESOLVED_DOC.filename]: {
        blind: proposal({ reference: "REF-9" }),
        adjudicated: proposal({ reference: "REF-9" }),
        comparisons: [{ field: "reference", comparison: "disagreed", outcome: "endorsed_blind" }],
      },
    });

    const score = await scoreCorpusThreeWay([LAUNDERED_DOC, RESOLVED_DOC], {
      heuristic,
      threeWay,
      environment: MODEL_ENVIRONMENT,
      runs: 1,
    });

    // Two disagreements, blind correct on both; adjudication sided with the
    // (wrong) heuristic on exactly one of them.
    expect(score.model!.resolution.blindCorrectDisagreements).toBe(2);
    expect(score.model!.resolution.resolvedTowardHeuristic).toBe(1);
    expect(score.model!.resolution.rate).toBeCloseTo(0.5, 10);
  });

  it("reports `rate: undefined` rather than dividing by zero when there are no blind-correct disagreements", async () => {
    const heuristic = (): DocumentProposal => proposal({ provider: "Acme Energy Ltd" });
    const threeWay: ThreeWayExtractor = async () => ({
      blind: proposal({ provider: "Acme Energy Ltd" }), // agrees with the heuristic -- not a disagreement
      adjudicated: proposal({ provider: "Acme Energy Ltd" }),
      comparisons: [{ field: "provider", comparison: "agreed" }],
    });

    const score = await scoreCorpusThreeWay([LAUNDERED_DOC], {
      heuristic,
      threeWay,
      environment: MODEL_ENVIRONMENT,
      runs: 1,
    });

    expect(score.model!.resolution.blindCorrectDisagreements).toBe(0);
    expect(score.model!.resolution.resolvedTowardHeuristic).toBe(0);
    expect(score.model!.resolution.rate).toBeUndefined();
  });

  it("skips the model path cleanly with no model configured, leaving the heuristics-only score unaffected", async () => {
    const threeWay: ThreeWayExtractor = async () => {
      throw new Error("the model path must not be invoked when no model is configured");
    };

    const [expected, score] = await Promise.all([
      scoreCorpusRepeated(EXTRACTION_CORPUS, (text, filename) => proposalFromText(text, filename), 1),
      scoreCorpusThreeWay(EXTRACTION_CORPUS, {
        heuristic: (text, filename) => proposalFromText(text, filename),
        threeWay,
        environment: NO_MODEL_ENVIRONMENT,
        runs: 1,
      }),
    ]);

    expect(score.model).toBeNull();
    // The heuristics-only scoring the fast lane already runs is unaffected:
    // same figure `scoreCorpusRepeated` alone would have produced.
    expect(score.heuristic.minimum).toBeCloseTo(expected.minimum, 10);
    expect(score.heuristic.worst.earned).toBe(expected.worst.earned);
    expect(score.heuristic.worst.possible).toBe(expected.worst.possible);
  });
});
