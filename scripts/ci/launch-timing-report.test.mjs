import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/*
 * #1048. The promotion gate reads this script's output and nothing else, so
 * what is pinned here is the output: that a run with no previous candidate
 * says so rather than inventing a comparison, that a run with one prints the
 * drift and the range to bisect over, and that an empty measurement
 * directory fails instead of carrying an empty report forward.
 *
 * Driven as a subprocess, because that is how the job calls it and because
 * importing the module would run it.
 */
const script = new URL("./launch-timing-report.mjs", import.meta.url).pathname;

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "orbit-launch-timing-"));
  directories.push(directory);
  return directory;
}

function pack(name, { mean, max, over32, over50 }) {
  return {
    pack: name,
    create: { count: 30, mean, max, over32, over50, raw: [mean] },
    home: { count: 90, mean, max, over32, over50, raw: [mean] },
  };
}

function measure(directory, packs) {
  for (const measured of packs) {
    writeFileSync(join(directory, `${measured.pack}.json`), JSON.stringify(measured), "utf8");
  }
}

function run(directory, environment = {}) {
  return execFileSync(process.execPath, [script, directory], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CI_COMMIT_SHA: "c".repeat(40), ...environment },
  });
}

describe("the promotion gate's launch-timing report", () => {
  it("records every pack the spec measured", () => {
    const directory = workspace();
    measure(directory, [
      pack("starchart", { mean: 17.1, max: 41.2, over32: 2, over50: 0 }),
      pack("dawn", { mean: 16.9, max: 33.4, over32: 1, over50: 0 }),
    ]);
    run(directory);
    const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    expect(Object.keys(report.packs).sort()).toEqual(["dawn", "starchart"]);
    expect(report.packs.starchart.create.mean).toBe(17.1);
  });

  it("says so plainly when there is no previous candidate, and takes no verdict", () => {
    const directory = workspace();
    measure(directory, [pack("starchart", { mean: 17.1, max: 41.2, over32: 2, over50: 0 })]);
    const output = run(directory);
    expect(output).toContain("No previous release candidate to compare with");
    expect(output).toContain("This run becomes the baseline");
    const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    expect(report.previousCandidate).toBeNull();
    expect(report.sincePreviousCandidate).toBeNull();
  });

  it("prints the drift against the previous candidate, signed", () => {
    const previous = workspace();
    measure(previous, [pack("starchart", { mean: 16.8, max: 34, over32: 1, over50: 0 })]);
    run(previous, { CI_COMMIT_SHA: "a".repeat(40) });

    const directory = workspace();
    measure(directory, [pack("starchart", { mean: 19.3, max: 61, over32: 4, over50: 1 })]);
    const output = run(directory, {
      CI_COMMIT_SHA: "b".repeat(40),
      ORBIT_LAUNCH_TIMING_BASELINE_FILE: join(previous, "report.json"),
    });

    expect(output).toContain(`Previous release candidate: ${"a".repeat(40)}`);
    // Worse on every axis, and each delta carries its sign so the direction
    // is readable without doing the subtraction.
    expect(output).toMatch(/19\.3 \(\+2\.5\)/u);
    expect(output).toMatch(/61 \(\+27\)/u);
    expect(output).toMatch(/4 \(\+3\)/u);
    expect(output).toMatch(/1 \(\+1\)/u);
  });

  it("names the commit range a regression would be bisected over", () => {
    const previous = workspace();
    measure(previous, [pack("starchart", { mean: 16.8, max: 34, over32: 1, over50: 0 })]);
    run(previous, { CI_COMMIT_SHA: "a".repeat(40) });

    const directory = workspace();
    measure(directory, [pack("starchart", { mean: 16.9, max: 35, over32: 1, over50: 0 })]);
    const output = run(directory, {
      CI_COMMIT_SHA: "b".repeat(40),
      // The pipeline's own diff is one merge deep; the comparison is not.
      CI_COMMIT_BEFORE_SHA: "d".repeat(40),
      ORBIT_LAUNCH_TIMING_BASELINE_FILE: join(previous, "report.json"),
    });

    expect(output).toContain(`${"a".repeat(40)}..${"b".repeat(40)}`);
    const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    expect(report.sincePreviousCandidate).toBe(`${"a".repeat(40)}..${"b".repeat(40)}`);
    expect(report.pipelineRange).toBe(`${"d".repeat(40)}..${"b".repeat(40)}`);
  });

  it("fails rather than carrying an empty report forward", () => {
    const directory = workspace();
    expect(() => run(directory)).toThrow(/the spec wrote nothing/u);
  });

  it("treats an unreadable previous candidate as no candidate, never as a failure", () => {
    const directory = workspace();
    measure(directory, [pack("starchart", { mean: 17.1, max: 41.2, over32: 2, over50: 0 })]);
    const output = run(directory, {
      ORBIT_LAUNCH_TIMING_BASELINE_FILE: join(directory, "nothing-here.json"),
    });
    expect(output).toContain("No previous release candidate to compare with");
  });
});
