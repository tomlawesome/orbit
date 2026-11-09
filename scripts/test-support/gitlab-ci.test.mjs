import { isAbsolute, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CI_PATH, effectiveRules, includesOf, jobBlock, jobBlocks, jobNamesOf, readCi, ruleEntries, stagesOf } from "./gitlab-ci.mjs";

// #1362: the one textual reader of .gitlab-ci.yml for script tests.
describe("jobBlocks", () => {
  it("returns top-level keys in file order with header lines included", () => {
    const text = "stages:\n  - a\n\njob_one:\n  script: x\n\njob_two:\n  script: y\n";
    const blocks = jobBlocks(text);
    expect([...blocks.keys()]).toEqual(["stages", "job_one", "job_two"]);
    expect(blocks.get("job_one")).toBe("job_one:\n  script: x\n\n");
    expect(blocks.get("job_one").startsWith("job_one:")).toBe(true);
  });

  it("reads hidden keys with an anchor", () => {
    const text = ".base: &base\n  image: node\n\njob:\n  <<: *base\n";
    const blocks = jobBlocks(text);
    expect([...blocks.keys()]).toEqual([".base", "job"]);
    expect(blocks.get(".base")).toBe(".base: &base\n  image: node\n\n");
  });

  it("reads a header with a trailing comment", () => {
    const text = "job: # a comment\n  script: x\nother:\n  script: y\n";
    const blocks = jobBlocks(text);
    expect([...blocks.keys()]).toEqual(["job", "other"]);
    expect(blocks.get("job")).toBe("job: # a comment\n  script: x\n");
  });

  it("reads a block-scalar anchor header", () => {
    const text = ".x: &x |\n  echo hi\n  echo there\njob:\n  script: y\n";
    const blocks = jobBlocks(text);
    expect([...blocks.keys()]).toEqual([".x", "job"]);
    expect(blocks.get(".x")).toBe(".x: &x |\n  echo hi\n  echo there\n");
  });

  it("runs the last block to the end of the file", () => {
    const text = "a:\n  k: 1\nb:\n  k: 2\n  m: 3";
    expect(jobBlocks(text).get("b")).toBe("b:\n  k: 2\n  m: 3");
  });

  it("does not treat indented keys as headers", () => {
    const text = "job:\n  script:\n    - x\n  inner:\n    k: 1\n";
    const blocks = jobBlocks(text);
    expect([...blocks.keys()]).toEqual(["job"]);
    expect(blocks.get("job")).toBe(text);
  });

  it("defaults to the real file's text", () => {
    expect(jobBlocks().size).toBe(jobBlocks(readCi()).size);
  });
});

describe("jobBlock", () => {
  it("returns one block's text", () => {
    const text = "a:\n  k: 1\nb:\n  k: 2\n";
    expect(jobBlock("a", text)).toBe("a:\n  k: 1\n");
  });

  it("throws an Error naming the job when there is none", () => {
    expect(() => jobBlock("no_such_job", "a:\n  k: 1\n")).toThrow(Error);
    expect(() => jobBlock("no_such_job", "a:\n  k: 1\n")).toThrow(/no_such_job/);
  });
});

describe("the real .gitlab-ci.yml", () => {
  it("is found by CI_PATH and read by readCi", () => {
    expect(isAbsolute(CI_PATH)).toBe(true);
    expect(basename(CI_PATH)).toBe(".gitlab-ci.yml");
    expect(existsSync(CI_PATH)).toBe(true);
    expect(readCi()).toBe(readFileSync(CI_PATH, "utf8"));
  });

  it("finds classify, smoke, smoke_webkit and record_image", () => {
    expect(jobBlock("classify").startsWith("classify:")).toBe(true);
    const blocks = jobBlocks();
    for (const name of ["smoke", "smoke_webkit", "record_image"]) {
      expect(blocks.has(name), name).toBe(true);
    }
  });
});

// #1698: `!reference [a, b]` and flattened rules lists.
describe("rules with !reference", () => {
  const template = [
    ".shared:",
    "  first:",
    "    - if: $A == \"1\"",
    "      when: never",
    "  second:",
    "    - if: >-",
    "        $B == \"1\" &&",
    "        $C == \"2\"",
    "    - when: manual",
    "",
  ].join("\n");
  const text = [
    "stages:",
    "  - test  # keep",
    "  - build",
    "",
    "include:",
    "  - project: group/shared",
    "    ref: abc123  # tool/v1",
    "    file: ci.yml",
    "",
    ".anchored: &anchored",
    "  - !reference [.shared, first]",
    "  - if: $X",
    "",
    ".single: &single",
    "  if: $S",
    "  when: manual",
    "",
    "workflow:",
    "  rules:",
    "    - !reference [.shared, first]",
    "    - when: always",
    "",
    "plain:",
    "  rules:",
    "    - !reference [.shared, second]",
    "    # a comment",
    "    - *single",
    "    - if: $P",
    "      when: never",
    "",
    "aliased:",
    "  rules: *anchored",
    "",
    "bare:",
    "  script: x",
    "",
  ].join("\n");

  it("reads a !reference entry as written", () => {
    expect(ruleEntries("workflow", text)[0]).toEqual({ reference: [".shared", "first"] });
    expect(ruleEntries("plain", text)[1]).toEqual({ alias: "single" });
  });

  it("resolves it against an included template, flattening nested lists", () => {
    expect(effectiveRules("workflow", text, [template])).toEqual([{ if: "$A == \"1\"", when: "never" }, { when: "always" }]);
    expect(effectiveRules("plain", text, [template])).toEqual([
      { if: "$B == \"1\" && $C == \"2\"" },
      { when: "manual" },
      { if: "$S", when: "manual" },
      { if: "$P", when: "never" },
    ]);
  });

  it("follows `rules: *anchor` to the anchored list, with a !reference inside it", () => {
    expect(effectiveRules("aliased", text, [template])).toEqual([{ if: "$A == \"1\"", when: "never" }, { if: "$X" }]);
  });

  it("gives a job with no rules none, and fails loudly on a reference nothing defines", () => {
    expect(effectiveRules("bare", text, [template])).toEqual([]);
    expect(() => effectiveRules("workflow", text, [])).toThrow(/!reference \[\.shared, first\]/u);
  });

  it("lists jobs (not hidden or reserved keys), stages and includes", () => {
    expect(jobNamesOf(text)).toEqual(["plain", "aliased", "bare"]);
    expect(stagesOf(text)).toEqual(["test", "build"]);
    expect(includesOf(text)).toEqual([{ project: "group/shared", ref: "abc123", comment: "tool/v1", file: "ci.yml" }]);
  });

  it("still reads the real .gitlab-ci.yml: every job's rules resolve", () => {
    const real = readCi();
    // the real file's !references point into the included back-merge-skip
    // (#1698) and dev-landing (#1737) templates, so resolve against their
    // pinned copies
    const templates = ["backmerge-skip-v1-ci-template.yml", "dev-landing-v1-ci-template.yml"]
      .map((f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
    expect(jobNamesOf(real).length).toBeGreaterThan(30);
    for (const name of [...jobNamesOf(real), "workflow"]) {
      expect(() => effectiveRules(name, real, templates)).not.toThrow();
    }
  });
});
