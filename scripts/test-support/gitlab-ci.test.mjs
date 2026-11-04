import { isAbsolute, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CI_PATH, jobBlock, jobBlocks, readCi } from "./gitlab-ci.mjs";

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
