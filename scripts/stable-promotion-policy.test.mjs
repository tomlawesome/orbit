import { describe, expect, it } from "vitest";

import {
  validatePreviewMergeCandidate,
  validateStablePromotionCandidate,
} from "./stable-promotion-policy.mjs";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function candidate(overrides = {}) {
  return {
    digest: DIGEST,
    version: "v1.2.3",
    releaseStage: "preview",
    revision: SHA,
    sourceBranch: "preview",
    ...overrides,
  };
}

const acceptedEvidence = {
  mergedIntoMain: true,
  presentInSource: true,
  mainTreeMatchesRevision: true,
};

describe("stable promotion policy", () => {
  it("accepts one synthetic preview-to-stable mapping", () => {
    expect(validateStablePromotionCandidate(candidate(), acceptedEvidence)).toEqual({
      digest: DIGEST,
      version: "v1.2.3",
      revision: SHA,
      sourceBranch: "preview",
    });
  });

  it.each([
    [{ releaseStage: "release-candidate" }, acceptedEvidence, /preview/u],
    [{ sourceBranch: "dev" }, acceptedEvidence, /protected preview lane/u],
    [{ sourceBranch: "hotfix/unsafe/path" }, acceptedEvidence, /protected preview lane/u],
    [{ digest: "sha256:not-a-digest" }, acceptedEvidence, /digest/u],
    [{ revision: "not-a-revision" }, acceptedEvidence, /revision/u],
    [{}, { ...acceptedEvidence, mergedIntoMain: false }, /main/u],
    [{}, { ...acceptedEvidence, presentInSource: false }, /source branch/u],
    [{}, { ...acceptedEvidence, mainTreeMatchesRevision: false }, /exact preview tree/u],
  ])("rejects an ineligible stable promotion", (candidateOverrides, evidence, expected) => {
    expect(() => validateStablePromotionCandidate(candidate(candidateOverrides), evidence)).toThrow(expected);
  });

  it("accepts a bounded hotfix preview", () => {
    expect(
      validateStablePromotionCandidate(candidate({ sourceBranch: "hotfix/correct-login" }), acceptedEvidence),
    ).toMatchObject({ sourceBranch: "hotfix/correct-login" });
  });
});

describe("stable pull request preview identity", () => {
  it("requires the tested preview revision to equal the pull request head", () => {
    expect(validatePreviewMergeCandidate(candidate(), SHA)).toMatchObject({
      digest: DIGEST,
      version: "v1.2.3",
      revision: SHA,
    });
    expect(() => validatePreviewMergeCandidate(candidate(), "c".repeat(40))).toThrow(/pull request head/u);
  });
});
