import { describe, expect, it } from "vitest";

import { calculateReleaseTrainVersion } from "./calculate-version.mjs";

describe("release-train version calculation", () => {
  describe("preview trains advance the patch by default", () => {
    it("moves v0.3.0 to v0.3.1 when the release line is v0.3", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.3",
        }),
      ).toBe("v0.3.1");
    });

    it("advances once from the highest stable tag, comparing numerically", () => {
      const input = {
        tags: ["v1.8.4", "v1.10.2", "v1.9.9"],
        fallbackVersion: "1.0.0",
        channel: "preview",
        releaseLine: "v1.10",
      };

      expect(calculateReleaseTrainVersion(input)).toBe("v1.10.3");
      expect(calculateReleaseTrainVersion(input)).toBe("v1.10.3");
    });

    it("treats stable Git tags as authoritative after bootstrap", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v3.2.1"],
          fallbackVersion: "99.0.0",
          channel: "preview",
          releaseLine: "v3.2",
        }),
      ).toBe("v3.2.2");
    });

    it("uses the package version only to bootstrap a repository without stable tags", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: [],
          fallbackVersion: "1.0.0",
          channel: "preview",
          releaseLine: "v1.0",
        }),
      ).toBe("v1.0.1");
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
          releaseLine: "v1.3",
        }),
      ).toBe("v1.3.3");
    });
  });

  describe("a higher release line starts a new minor or major", () => {
    it("moves to vX.Y.0 of the line when the line is above the baseline", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.5"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.4",
        }),
      ).toBe("v0.4.0");
    });

    it("goes back to patch bumps once the line has been tagged", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.5", "v0.4.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.4",
        }),
      ).toBe("v0.4.1");
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.5", "v0.4.0", "v0.4.1"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.4",
        }),
      ).toBe("v0.4.2");
    });

    it("starts a new major from the line", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.9.2"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v1.0",
        }),
      ).toBe("v1.0.0");
    });

    it("compares the line numerically, not as text", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.2.0"],
          fallbackVersion: "0.1.0",
          channel: "preview",
          releaseLine: "v0.10",
        }),
      ).toBe("v0.10.0");
    });

    it("lets a line above the package version start the line on bootstrap", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: [],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.5",
        }),
      ).toBe("v0.5.0");
    });

    it("skips straight to the line when it is more than one minor ahead", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.5"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.6",
        }),
      ).toBe("v0.6.0");
    });

    it("changes nothing when the line is lower than the baseline", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.4.2"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.3",
        }),
      ).toBe("v0.4.3");
      expect(
        calculateReleaseTrainVersion({
          tags: ["v1.2.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          releaseLine: "v0.9",
        }),
      ).toBe("v1.2.1");
    });
  });

  describe("hotfix trains", () => {
    it("advance the patch by one", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v2.4.7"],
          fallbackVersion: "1.0.0",
          channel: "hotfix",
          releaseLine: "v2.4",
        }),
      ).toBe("v2.4.8");
    });

    it("ignore a higher release line", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.5"],
          fallbackVersion: "0.2.0",
          channel: "hotfix",
          releaseLine: "v0.4",
        }),
      ).toBe("v0.3.6");
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.9.2"],
          fallbackVersion: "0.2.0",
          channel: "hotfix",
          releaseLine: "v1.0",
        }),
      ).toBe("v0.9.3");
    });
  });

  describe("release line validation", () => {
    const base = { tags: ["v0.3.0"], fallbackVersion: "0.2.0", channel: "preview" };

    it.each([
      ["leading zero in the minor", "v0.03"],
      ["leading zero in the major", "v00.3"],
      ["no leading v", "0.3"],
      ["a third part", "v0.3.1"],
      ["a major only", "v0"],
      ["a trailing dot", "v0."],
      ["a missing major", "v.3"],
      ["an empty string", ""],
      ["a prerelease suffix", "v0.3-rc.1"],
      ["leading whitespace", " v0.3"],
      ["trailing whitespace", "v0.3 "],
      ["an uppercase V", "V0.3"],
      ["a negative number", "v0.-1"],
      ["non-numeric parts", "vx.y"],
      ["a number instead of a string", 0.3],
      ["null", null],
    ])("throws on a release line with %s", (_label, releaseLine) => {
      expect(() => calculateReleaseTrainVersion({ ...base, releaseLine })).toThrow();
    });

    it("throws when the release line is missing for a preview train", () => {
      expect(() => calculateReleaseTrainVersion(base)).toThrow();
    });

    it("accepts a zero minor and multi-digit parts", () => {
      expect(
        calculateReleaseTrainVersion({ ...base, tags: ["v9.9.9"], releaseLine: "v10.0" }),
      ).toBe("v10.0.0");
      expect(
        calculateReleaseTrainVersion({ ...base, tags: ["v9.9.9"], releaseLine: "v9.10" }),
      ).toBe("v9.10.0");
    });
  });

  it("fails closed for unsupported channels and malformed bootstrap versions", () => {
    expect(() =>
      calculateReleaseTrainVersion({
        tags: [],
        fallbackVersion: "1.0.0",
        channel: "major",
        releaseLine: "v1.0",
      }),
    ).toThrow(/preview or hotfix/u);
    expect(() =>
      calculateReleaseTrainVersion({
        tags: [],
        fallbackVersion: "next",
        channel: "preview",
        releaseLine: "v1.0",
      }),
    ).toThrow(/package version/u);
  });

  describe("retracted tags", () => {
    const retractedTags = ["v1.0.0", "v1.1.0", "v1.2.0"];

    it("restarts the release line from the package version when only retracted tags exist", () => {
      const input = {
        tags: ["v1.1.0", "v1.2.0"],
        fallbackVersion: "0.2.0",
        retractedTags,
        releaseLine: "v0.2",
      };

      expect(calculateReleaseTrainVersion({ ...input, channel: "preview" })).toBe("v0.2.1");
      expect(calculateReleaseTrainVersion({ ...input, channel: "hotfix" })).toBe("v0.2.1");
    });

    it("starts the declared line from the package version when only retracted tags exist", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v1.1.0", "v1.2.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          retractedTags,
          releaseLine: "v0.5",
        }),
      ).toBe("v0.5.0");
    });

    it("ignores retracted tags beside real ones", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v1.1.0", "v0.3.0", "v1.2.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          retractedTags,
          releaseLine: "v0.3",
        }),
      ).toBe("v0.3.1");
    });

    it("never lets a retracted tag higher than a real tag win", () => {
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.2", "v1.2.0"],
          fallbackVersion: "0.2.0",
          channel: "hotfix",
          retractedTags,
          releaseLine: "v0.3",
        }),
      ).toBe("v0.3.3");
      expect(
        calculateReleaseTrainVersion({
          tags: ["v0.3.2", "v1.2.0"],
          fallbackVersion: "0.2.0",
          channel: "preview",
          retractedTags,
          releaseLine: "v0.3",
        }),
      ).toBe("v0.3.3");
    });
  });
});
