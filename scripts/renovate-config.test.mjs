import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1218: Renovate compiles customManagers' matchStrings with RE2, which has
 * no lookaround. One `(?!\$)` made the whole configuration invalid, and
 * Renovate stopped opening merge requests until it was fixed. JavaScript's
 * RegExp accepts lookaround, so compiling the strings here proves nothing:
 * refuse the syntax outright, then check the patterns still read a plain pin
 * and a pin named through the image cache (#1510).
 */
const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
const matchStrings = config.customManagers.flatMap((m) => m.matchStrings ?? []);
const ci = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

describe("renovate.json stays valid for Renovate's RE2 (#1218)", () => {
  it.each(matchStrings)("has no lookaround or backreference: %s", (pattern) => {
    expect(pattern).not.toMatch(/\(\?<?[=!]/);
    expect(pattern).not.toMatch(/\\[1-9]/);
  });

  const [plain] = config.customManagers[0].matchStrings.map((s) => new RegExp(s));
  const cached = new RegExp(config.customManagers[1].matchStrings[0]);
  const pins = ci.split("\n").filter((line) => /^\s+[A-Z_]+_IMAGE:\s.*@sha256:/.test(line));

  it("reads a cache-named pin with the cache pattern only (PLAYWRIGHT_IMAGE)", () => {
    const line = pins.find((l) => l.includes("PLAYWRIGHT_IMAGE"));
    expect(line?.match(cached)?.groups?.currentValue).toMatch(/^v[\d.]+-noble$/);
    expect(config.customManagers[1].depNameTemplate).toBe("mcr.microsoft.com/playwright");
    expect(line).not.toMatch(plain);
  });

  it("reads a plain Docker Hub pin with the plain pattern only (NODE_IMAGE)", () => {
    const line = pins.find((l) => l.includes("NODE_IMAGE"));
    expect(line?.match(plain)?.groups?.depName).toBe("node");
    expect(line).not.toMatch(cached);
  });
});
