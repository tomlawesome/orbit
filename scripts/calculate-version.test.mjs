import { describe, expect, it } from "vitest";

import { calculateReleaseTrainVersion } from "./calculate-version.mjs";

describe("release-train version calculation", () => {
  it("uses the package version only to bootstrap a repository without stable tags", () => {
    expect(
      calculateReleaseTrainVersion({
        tags: [],
        fallbackVersion: "1.0.0",
        channel: "preview",
      }),
    ).toBe("v1.1.0");
  });

  it("advances an ordinary release train once from the highest stable tag", () => {
    const input = {
      tags: ["v1.8.4", "v1.10.2", "v1.9.9"],
      fallbackVersion: "1.0.0",
      channel: "preview",
    };

    expect(calculateReleaseTrainVersion(input)).toBe("v1.11.0");
    expect(calculateReleaseTrainVersion(input)).toBe("v1.11.0");
  });

  it("treats stable Git tags as authoritative after bootstrap", () => {
    expect(
      calculateReleaseTrainVersion({
        tags: ["v3.2.1"],
        fallbackVersion: "99.0.0",
        channel: "preview",
      }),
    ).toBe("v3.3.0");
  });

  it("advances a hotfix train by one patch", () => {
    expect(
      calculateReleaseTrainVersion({
        tags: ["v2.4.7"],
        fallbackVersion: "1.0.0",
        channel: "hotfix",
      }),
    ).toBe("v2.4.8");
  });

  it("ignores prerelease, archive and malformed tags", () => {
    expect(
      calculateReleaseTrainVersion({
        tags: [
          "archive/version-active-plan-2026-07-26",
          "v2.0.0-rc.1",
          "v02.0.0",
          "v2.0",
          "not-a-version",
        ],
        fallbackVersion: "1.3.2",
        channel: "preview",
      }),
    ).toBe("v1.4.0");
  });

  it("fails closed for unsupported channels and malformed bootstrap versions", () => {
    expect(() =>
      calculateReleaseTrainVersion({
        tags: [],
        fallbackVersion: "1.0.0",
        channel: "major",
      }),
    ).toThrow(/preview or hotfix/u);
    expect(() =>
      calculateReleaseTrainVersion({
        tags: [],
        fallbackVersion: "next",
        channel: "preview",
      }),
    ).toThrow(/package version/u);
  });
});
