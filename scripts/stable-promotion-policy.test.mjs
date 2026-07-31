import { describe, expect, it } from "vitest";

import { validateStablePromotionCandidate } from "./stable-promotion-policy.mjs";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function candidate(overrides = {}) {
  return {
    digest: DIGEST,
    version: "v1.2.3",
    releaseStage: "preview",
    revision: SHA,
    sourceBranch: "release/v1.2.3",
    ...overrides,
  };
}

const acceptedEvidence = {
  mergedIntoMain: true,
  mergedIntoDevelop: true,
  mainTreeMatchesRevision: true,
};

describe("stable promotion policy", () => {
  it("accepts one synthetic preview-to-stable mapping", () => {
    expect(validateStablePromotionCandidate(candidate(), acceptedEvidence)).toEqual({
      digest: DIGEST,
      version: "v1.2.3",
      revision: SHA,
      sourceBranch: "release/v1.2.3",
    });
  });

  it.each([
    [{ releaseStage: "release-candidate" }, acceptedEvidence, /preview/u],
    [{ sourceBranch: "develop" }, acceptedEvidence, /release\/v1\.2\.3/u],
    [{ sourceBranch: "release/v1.2.4" }, acceptedEvidence, /release\/v1\.2\.3/u],
    [{ digest: "sha256:not-a-digest" }, acceptedEvidence, /digest/u],
    [{ revision: "not-a-revision" }, acceptedEvidence, /revision/u],
    [{}, { ...acceptedEvidence, mergedIntoMain: false }, /main/u],
    [{}, { ...acceptedEvidence, mergedIntoDevelop: false }, /develop/u],
    [{}, { ...acceptedEvidence, mainTreeMatchesRevision: false }, /exact preview tree/u],
  ])("rejects an ineligible stable promotion", (candidateOverrides, evidence, expected) => {
    expect(() => validateStablePromotionCandidate(candidate(candidateOverrides), evidence)).toThrow(expected);
  });
});
