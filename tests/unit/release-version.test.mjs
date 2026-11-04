import { describe, expect, it } from "vitest";
import { compareReleaseVersions, parseReleaseVersion } from "@/lib/release-version";

/* #1618: the one place a release version is read and compared. */
describe("parseReleaseVersion", () => {
  it("reads vX.Y.Z into three numbers", () => {
    expect(parseReleaseVersion("v0.3.7")).toEqual([0, 3, 7]);
    expect(parseReleaseVersion("v10.20.30")).toEqual([10, 20, 30]);
    expect(parseReleaseVersion("v0.0.0")).toEqual([0, 0, 0]);
  });

  it.each([
    "", "0.3.7", "V0.3.7", "v0.3", "v0.3.7.1", "v0.3.7-rc1", "v0.3.7+build", "v0.3.7 ",
    " v0.3.7", "v01.3.7", "v0.03.7", "v0.3.07", "v-1.3.7", "v1.2.x", "vA.B.C", "v1.2.3\n",
  ])("refuses %j", (text) => {
    expect(parseReleaseVersion(text)).toBeNull();
  });

  it.each([undefined, null, 7, {}, [], true])("refuses a non-string %j", (value) => {
    expect(parseReleaseVersion(value)).toBeNull();
  });
});

describe("compareReleaseVersions", () => {
  it("answers -1, 0 and 1", () => {
    expect(compareReleaseVersions("v0.3.6", "v0.3.7")).toBe(-1);
    expect(compareReleaseVersions("v0.3.7", "v0.3.7")).toBe(0);
    expect(compareReleaseVersions("v0.3.8", "v0.3.7")).toBe(1);
  });

  it("compares each part as a number, not as text", () => {
    expect(compareReleaseVersions("v0.3.10", "v0.3.9")).toBe(1);
    expect(compareReleaseVersions("v0.10.0", "v0.9.9")).toBe(1);
    expect(compareReleaseVersions("v1.0.0", "v0.99.99")).toBe(1);
    expect(compareReleaseVersions("v0.0.0", "v0.0.1")).toBe(-1);
  });

  it("throws on a malformed input, either side", () => {
    expect(() => compareReleaseVersions("v0.3", "v0.3.7")).toThrow();
    expect(() => compareReleaseVersions("v0.3.7", "latest")).toThrow();
    expect(() => compareReleaseVersions("", "")).toThrow();
  });
});
